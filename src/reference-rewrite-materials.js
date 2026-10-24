// 参考视频的本机素材（2026-10-24）：AI 导演第一步「去配乐与转写」用 buildSourceTranscript，
// 主题变体那一步用 buildContactSheets 切接触表给 Claude 看。设计见 docs/reference-rewrite-2026-10-24.md。
//
// 做法照 10-23 对照实验（reports/reference-rewrite-ab-2026-10-23/）：每秒 2 帧、6×4、每格 320 宽的接触表；
// 原声、人声轨、「原声减音乐」三组 whisper 转写，加人声轨与音效轨的有声区间。实验里手挑的两张关键帧
// 放大图与手截复核的那组无法自动化，去掉了。
//
// 两个入口都先把页面工作区里的副本复制进 Run 的 media-work 并核对 SHA-256，与 Run 记录的不符就 409。
// 所有子进程都有超时并用 SIGKILL 收尾；执行器可注入，测试不跑真的 ffmpeg / Bandit / whisper。
// 临时目录在 Run 目录的 media-work/ 下（页面关闭时随 Run 一起清掉），用完就删；
// 每一步开始前复核页面工作区还活着（manifest 还在），不往已清理的 Run 里写东西。
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createUniqueDirectory } from "./unique-directory.js";
import { assertWorkspaceMediaLifetime, requireWorkspaceMediaDirectory } from "./workspace-media-lifetime.js";
import {
  REFERENCE_REWRITE_MAX_VIDEO_SECONDS,
  contactSheetFps
} from "../public/reference-rewrite.js";

const defaultExec = promisify(execFileCallback);
const STEMS_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "tools", "reference-audio-stems.py");

export const CONTACT_SHEET_COLUMNS = 6;
export const CONTACT_SHEET_ROWS = 4;
export const CONTACT_SHEET_CELL_WIDTH = 320;
const WHISPER_INITIAL_PROMPT = "以下是普通话的句子，使用简体中文。";

// 超时：抽帧、解音轨各 2 分钟；Bandit 与每一次 whisper 各 10 分钟（51 秒的片子实测各 1 分钟左右）。
const TIMEOUTS = Object.freeze({ probe: 30_000, ffmpeg: 120_000, bandit: 600_000, whisper: 600_000, version: 10_000 });
// 子进程跑着时每 20 秒续一次看门狗；每一步给 15 分钟的无进展窗口，比最长的子进程超时多 5 分钟。
const HEARTBEAT_INTERVAL_MS = 20_000;
export const REFERENCE_REWRITE_STEP_STALL_MS = 900_000;

export class ReferenceRewriteMaterialsError extends Error {
  constructor(message, { code = "REFERENCE_REWRITE_MATERIALS_FAILED", httpStatus = 500, cause = null } = {}) {
    super(message);
    this.name = "ReferenceRewriteMaterialsError";
    this.code = code;
    this.httpStatus = httpStatus;
    if (cause) this.cause = cause;
  }
}

/**
 * 本机工具是否齐全。只查存在与可执行，不跑模型；Bandit checkpoint 的 SHA-256 在分轨脚本里核对。
 * @returns {Promise<{available:boolean, reason:string, missing:string[]}>}
 */
export async function sourceTranscriptToolStatus(tools = {}, { exec = defaultExec } = {}) {
  const missing = [];
  for (const binary of ["ffmpeg", "ffprobe"]) {
    try {
      await exec(binary, ["-version"], { timeout: TIMEOUTS.version, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 });
    } catch {
      missing.push(`${binary}（命令行里找不到）`);
    }
  }
  if (!tools.banditDir) missing.push("REFERENCE_REWRITE_BANDIT_DIR 没有设置");
  else {
    if (!(await isFile(banditPython(tools)))) missing.push(`Bandit 的 Python 不在：${banditPython(tools)}（外置盘没挂上？）`);
    if (!(await isFile(path.join(tools.banditDir, "models", "checkpoint-multi.ckpt")))) missing.push("Bandit 的 checkpoint-multi.ckpt 不在");
  }
  if (!tools.whisperBin) missing.push("REFERENCE_REWRITE_WHISPER_BIN 没有设置");
  else if (!(await isExecutable(tools.whisperBin))) missing.push(`whisper 不在或不能执行：${tools.whisperBin}`);
  const modelFile = whisperModelFile(tools);
  if (!(await isFile(modelFile))) missing.push(`whisper 模型文件不在：${modelFile}（不会自动下载）`);
  return {
    available: missing.length === 0,
    reason: missing.length ? `去配乐与转写用不了：${missing.join("；")}` : "",
    missing
  };
}

/**
 * AI 导演第一步：去配乐与转写。返回转写稿正文与处理参数。
 * @param {object} options
 * @param {string} options.sourcePath 页面工作区里的参考视频副本
 * @param {string} options.expectedDigest Run 元数据记的 sourceVideoDigest
 * @param {string} options.workRoot Run 目录下的 media-work
 * @param {string} options.lifetimeFile Run 的 manifest；它不在了就说明页面已关闭
 * @param {object} options.tools config.referenceRewrite
 * @param {(stepKey:string)=>Promise<void>} [options.onStep] 每步开始时调用（写进度、续看门狗）
 * @param {()=>Promise<void>} [options.heartbeat] 子进程跑着时定期调用
 */
export async function buildSourceTranscript({ tools, onStep = async () => {}, ...options }) {
  return withVerifiedSource(options, async ({ videoPath, probe, workDir, run, lifetimeFile }) => {
    if (!probe.hasAudio) {
      return { durationSeconds: probe.durationSeconds, hasAudio: false, text: NO_AUDIO_TRANSCRIPT, separator: "", whisperModel: "" };
    }
    await onStep("separate");
    await assertWorkspaceMediaLifetime(lifetimeFile);
    const audioDir = path.join(workDir, "audio");
    await fs.mkdir(audioDir);
    const originalWav = path.join(audioDir, "original.wav");
    await run("ffmpeg", ["-nostdin", "-v", "error", "-n", "-i", videoPath, "-map", "0:a:0", "-vn", "-ar", "48000", "-ac", "2", "-c:a", "pcm_f32le", originalWav], TIMEOUTS.ffmpeg);
    const stemsDir = path.join(audioDir, "stems");
    await run(banditPython(tools), ["-I", STEMS_SCRIPT, "--bandit-dir", tools.banditDir, "--input", originalWav, "--output-dir", stemsDir], TIMEOUTS.bandit);
    const intervals = JSON.parse(await fs.readFile(path.join(stemsDir, "intervals.json"), "utf8"));

    await onStep("transcribe");
    await assertWorkspaceMediaLifetime(lifetimeFile);
    const transcripts = {};
    for (const [key, file] of [["original", originalWav], ["speech", path.join(stemsDir, "speech.wav")], ["noBgm", path.join(stemsDir, "no_bgm.wav")]]) {
      const mono = path.join(audioDir, `${key}-16k.wav`);
      await run("ffmpeg", ["-nostdin", "-v", "error", "-n", "-i", file, "-ar", "16000", "-ac", "1", mono], TIMEOUTS.ffmpeg);
      transcripts[key] = await transcribe(run, tools, mono, path.join(audioDir, `whisper-${key}`));
    }
    await assertWorkspaceMediaLifetime(lifetimeFile);
    return {
      durationSeconds: probe.durationSeconds,
      hasAudio: true,
      text: formatReferenceTranscript({ transcripts, intervals, whisperModel: tools.whisperModel }),
      separator: "bandit-v2-multi",
      whisperModel: tools.whisperModel
    };
  });
}

/**
 * 主题变体那一步：把整支视频按每秒 2 帧（超过 120 秒改 1 帧）拼成 6×4 的接触表，给模型看。
 * 参数与 buildSourceTranscript 相同（不需要 tools）。
 */
export async function buildContactSheets(options) {
  return withVerifiedSource(options, async ({ videoPath, probe, workDir, run, lifetimeFile }) => {
    const sheets = await makeContactSheets(run, videoPath, workDir, probe.durationSeconds, lifetimeFile);
    await assertWorkspaceMediaLifetime(lifetimeFile);
    return { durationSeconds: probe.durationSeconds, ...sheets };
  });
}

// 两个入口共用：建临时目录 → 复制副本并核 SHA-256 → ffprobe 与时长上限 → 做事 → 删临时目录。
async function withVerifiedSource({ sourcePath, expectedDigest, workRoot, lifetimeFile, heartbeat = async () => {}, exec = defaultExec }, action) {
  const workDir = await createWorkDirectory(workRoot, lifetimeFile);
  const run = (file, args, timeout) => withHeartbeat(heartbeat, () => exec(file, args, {
    timeout, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024
  }));
  try {
    const videoPath = path.join(workDir, "source.bin");
    const digest = await copyWithDigest(sourcePath, videoPath);
    if (digest !== String(expectedDigest || "").toLowerCase()) {
      throw new ReferenceRewriteMaterialsError("参考视频副本和这个 Run 记录的不是同一个文件，请重新上传同一支视频。", {
        code: "TASK_SOURCE_VIDEO_DIGEST_MISMATCH", httpStatus: 409
      });
    }
    const probe = await probeVideo(run, videoPath);
    if (probe.durationSeconds > REFERENCE_REWRITE_MAX_VIDEO_SECONDS) {
      throw new ReferenceRewriteMaterialsError(`参考视频 ${Math.round(probe.durationSeconds)} 秒，超过 ${REFERENCE_REWRITE_MAX_VIDEO_SECONDS} 秒的上限。`, {
        code: "REFERENCE_REWRITE_VIDEO_TOO_LONG", httpStatus: 400
      });
    }
    return await action({ videoPath, probe, workDir, run, lifetimeFile });
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

const NO_AUDIO_TRANSCRIPT = "# 音频转写资料\n\n这支参考视频没有音轨，没有可转写的声音。";

/** 转写稿：与实验的 materials/transcript.md 同一结构（A/B/C 三组转写＋E 组有声区间），去掉了手截复核的 D 组。 */
export function formatReferenceTranscript({ transcripts, intervals, whisperModel }) {
  const block = (segments) => {
    const lines = (segments || []).map((segment) => `${clock(segment.start)}–${clock(segment.end)}  ${String(segment.text || "").trim()}`)
      .filter((line) => !/\s$/u.test(line));
    return lines.length ? `\`\`\`\n${lines.join("\n")}\n\`\`\`` : "（没有识别出字）";
  };
  const spans = (list) => (list || []).map(([start, end]) => `${start.toFixed(2)}–${end.toFixed(2)}`).join("、") || "（没有）";
  return `# 音频转写资料

处理方法：原片音轨用 Bandit v2 Multi 分成人声、音乐、音效三轨，再用 whisper（${whisperModel} 模型，中文）转写。whisper 只出文字和时间，**不标说话人**；同音错字和凭空编出来的句子都可能有。

## A. 原声直接转写（没去配乐）

${block(transcripts.original)}

## B. 只用人声轨转写

${block(transcripts.speech)}

## C. 原声减去音乐轨（人声＋音效）转写

${block(transcripts.noBgm)}

## E. 各轨有明显声音的时间段（每 ${intervals?.cellSeconds ?? 0.25} 秒一格，响度高于 ${intervals?.thresholdDb ?? -30} dB）

- 人声轨：${spans(intervals?.speech)}
- 音效轨：${spans(intervals?.sfx)}`;
}

async function createWorkDirectory(workRoot, lifetimeFile) {
  if (!workRoot || !lifetimeFile) throw new ReferenceRewriteMaterialsError("处理参考视频必须在页面工作区的 Run 里运行");
  const root = path.resolve(workRoot);
  await assertWorkspaceMediaLifetime(lifetimeFile);
  if (path.dirname(root) !== path.dirname(path.resolve(lifetimeFile))) {
    throw new ReferenceRewriteMaterialsError("临时目录必须位于当前 Run 目录内");
  }
  try {
    // 不递归：Run 目录被清掉后绝不顺手重建。
    await fs.mkdir(root, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  await requireWorkspaceMediaDirectory(root, lifetimeFile);
  return createUniqueDirectory(path.join(root, "reference-video-"));
}

// 照 snapshotTrustedPreviousVideo 的写法：O_NOFOLLOW 打开、边读边算 SHA-256、独占写出。
async function copyWithDigest(sourcePath, targetPath) {
  let handle;
  try {
    handle = await fs.open(String(sourcePath || ""), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile() || before.size < 8) throw new Error("不是有效的文件");
    const hash = createHash("sha256");
    const output = await fs.open(targetPath, "wx", 0o600);
    try {
      const buffer = Buffer.alloc(8 * 1024 * 1024);
      let position = 0;
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (!bytesRead) break;
        const chunk = buffer.subarray(0, bytesRead);
        hash.update(chunk);
        await output.write(chunk);
        position += bytesRead;
      }
      const after = await handle.stat();
      if (position !== after.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("读取期间文件发生变化");
    } finally {
      await output.close();
    }
    return hash.digest("hex");
  } catch (error) {
    if (error instanceof ReferenceRewriteMaterialsError) throw error;
    throw new ReferenceRewriteMaterialsError(`参考视频副本读不出来：${error.message || "文件不可用"}。请重新上传同一支视频。`, {
      code: "TASK_SOURCE_MEDIA_REQUIRED", httpStatus: 409, cause: error
    });
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function probeVideo(run, videoPath) {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", videoPath], TIMEOUTS.probe);
  let parsed;
  try { parsed = JSON.parse(stdout); } catch { parsed = null; }
  const durationSeconds = Number(parsed?.format?.duration);
  const streams = Array.isArray(parsed?.streams) ? parsed.streams : [];
  if (!(durationSeconds > 0) || !streams.some((stream) => stream.codec_type === "video")) {
    throw new ReferenceRewriteMaterialsError("读不出参考视频的时长或画面。", { code: "REFERENCE_REWRITE_VIDEO_INVALID", httpStatus: 400 });
  }
  return { durationSeconds, hasAudio: streams.some((stream) => stream.codec_type === "audio") };
}

// 先按帧率抽出单帧、数清楚有几帧，再拼成 6×4 的接触表：最后一张不满时才能如实写「只有前 N 格有画面」。
async function makeContactSheets(run, videoPath, workDir, durationSeconds, lifetimeFile) {
  const fps = contactSheetFps(durationSeconds);
  const framesDir = path.join(workDir, "frames");
  const sheetsDir = path.join(workDir, "sheets");
  await assertWorkspaceMediaLifetime(lifetimeFile);
  await fs.mkdir(framesDir);
  await fs.mkdir(sheetsDir);
  await run("ffmpeg", ["-nostdin", "-v", "error", "-i", videoPath, "-vf", `fps=${fps},scale=${CONTACT_SHEET_CELL_WIDTH}:-2`, "-q:v", "3", path.join(framesDir, "f_%04d.jpg")], TIMEOUTS.ffmpeg);
  const frameCount = (await fs.readdir(framesDir)).filter((name) => /^f_\d{4}\.jpg$/u.test(name)).length;
  if (!frameCount) throw new ReferenceRewriteMaterialsError("没能从参考视频里抽出画面。", { code: "REFERENCE_REWRITE_VIDEO_INVALID", httpStatus: 400 });
  await run("ffmpeg", ["-nostdin", "-v", "error", "-framerate", "1", "-i", path.join(framesDir, "f_%04d.jpg"), "-vf", `tile=${CONTACT_SHEET_COLUMNS}x${CONTACT_SHEET_ROWS}`, "-q:v", "3", path.join(sheetsDir, "s_%02d.jpg")], TIMEOUTS.ffmpeg);
  const perSheet = CONTACT_SHEET_COLUMNS * CONTACT_SHEET_ROWS;
  const sheetFiles = (await fs.readdir(sheetsDir)).filter((name) => /^s_\d{2}\.jpg$/u.test(name)).sort();
  const expected = Math.ceil(frameCount / perSheet);
  if (sheetFiles.length !== expected) {
    throw new ReferenceRewriteMaterialsError(`接触表张数不对：${frameCount} 帧应拼成 ${expected} 张，实际 ${sheetFiles.length} 张。`);
  }
  const images = [];
  const sheets = [];
  for (const [index, name] of sheetFiles.entries()) {
    const bytes = await fs.readFile(path.join(sheetsDir, name));
    images.push({ dataUrl: `data:image/jpeg;base64,${bytes.toString("base64")}` });
    const first = index * perSheet;
    const cells = Math.min(perSheet, frameCount - first);
    sheets.push({ startSeconds: first / fps, endSeconds: (first + cells - 1) / fps, cells });
  }
  return { images, frameCount, layout: { fps, columns: CONTACT_SHEET_COLUMNS, rows: CONTACT_SHEET_ROWS, sheets } };
}

async function transcribe(run, tools, audioPath, outputDir) {
  await fs.mkdir(outputDir);
  await run(tools.whisperBin, [
    audioPath,
    "--model", tools.whisperModel,
    "--model_dir", tools.whisperModelDir,
    "--language", "zh",
    "--fp16", "False",
    "--condition_on_previous_text", "False",
    // 按词对时间：10-24 本机回放里不开它，人声轨那组整段时间戳往前错了十几秒，静音处还编出一串「好」；
    // 10-23 实验里人声轨与去配乐两组开着它，时间都对得上画面。
    "--word_timestamps", "True",
    "--initial_prompt", WHISPER_INITIAL_PROMPT,
    "--output_dir", outputDir,
    "--output_format", "json"
  ], TIMEOUTS.whisper);
  const file = path.join(outputDir, `${path.basename(audioPath, path.extname(audioPath))}.json`);
  const parsed = JSON.parse(await fs.readFile(file, "utf8"));
  return (Array.isArray(parsed?.segments) ? parsed.segments : []).map((segment) => ({
    start: Number(segment.start) || 0,
    end: Number(segment.end) || 0,
    text: String(segment.text || "")
  }));
}

async function withHeartbeat(heartbeat, action) {
  const timer = setInterval(() => { Promise.resolve(heartbeat()).catch(() => {}); }, HEARTBEAT_INTERVAL_MS);
  try {
    return await action();
  } catch (error) {
    if (error instanceof ReferenceRewriteMaterialsError) throw error;
    const detail = String(error?.stderr || error?.message || "").trim().slice(-600);
    const reason = error?.killed || error?.signal === "SIGKILL" ? "超时被终止" : detail || "失败";
    throw new ReferenceRewriteMaterialsError(`本机处理参考视频时出错（${path.basename(String(error?.cmd || error?.path || "子进程").split(" ")[0])}）：${reason}`, { cause: error });
  } finally {
    clearInterval(timer);
  }
}

function banditPython(tools) {
  return path.join(tools.banditDir || "", ".venv", "bin", "python");
}

function whisperModelFile(tools) {
  return path.join(tools.whisperModelDir || "", `${tools.whisperModel || "small"}.pt`);
}

async function isFile(file) {
  try { return (await fs.stat(file)).isFile(); } catch { return false; }
}

async function isExecutable(file) {
  try {
    await fs.access(file, fsConstants.X_OK);
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

function clock(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(value / 60);
  const rest = (value - minutes * 60).toFixed(1).padStart(4, "0");
  return `${String(minutes).padStart(2, "0")}:${rest}`;
}

// 演示模式（没有配置任何模型）：不跑本机工具，给一张 16×16 的灰色占位图和一句说明，
// 让页面能免费走完 AI 导演的六步。
const DEMO_SHEET_DATA_URL = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAgAAAQABAAD//gAPTGF2YzYzLjEuMTAyAP/bAEMACAoKCwoLDQ0NDQ0NEA8QEBAQEBAQEBAQEBISEhUVFRISEhAQEhIUFBUVFxcXFRUVFRcXGRkZHh4cHCMjJCsrM//EAEoAAQAAAAAAAAAAAAAAAAAAAAABAQAAAAAAAAAAAAAAAAAAAAAQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAAQABADASIAAhEAAxEA/9oADAMBAAIRAxEAPwAAD//Z";

function demoDuration(durationSeconds) {
  return Math.min(REFERENCE_REWRITE_MAX_VIDEO_SECONDS, Math.max(1, Number(durationSeconds) || 45));
}

export function demoSourceTranscript(durationSeconds = 45) {
  return {
    durationSeconds: demoDuration(durationSeconds),
    hasAudio: false,
    text: "# 音频转写资料\n\n（演示模式，没有做去配乐和转写。）",
    separator: "",
    whisperModel: "",
    demo: true
  };
}

export function demoContactSheets(durationSeconds = 45) {
  const seconds = demoDuration(durationSeconds);
  const fps = contactSheetFps(seconds);
  const cells = CONTACT_SHEET_COLUMNS * CONTACT_SHEET_ROWS;
  return {
    durationSeconds: seconds,
    images: [{ dataUrl: DEMO_SHEET_DATA_URL }],
    frameCount: cells,
    layout: { fps, columns: CONTACT_SHEET_COLUMNS, rows: CONTACT_SHEET_ROWS, sheets: [{ startSeconds: 0, endSeconds: (cells - 1) / fps, cells }] },
    demo: true
  };
}
