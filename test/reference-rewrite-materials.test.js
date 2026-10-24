import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildContactSheets,
  buildSourceTranscript,
  demoContactSheets,
  formatReferenceTranscript,
  sourceTranscriptToolStatus
} from "../src/reference-rewrite-materials.js";
import { estimatedContactSheetFrameCount } from "../public/reference-rewrite.js";

// 参考视频的本机素材（2026-10-24）：AI 导演第一步的去配乐与转写、主题变体那一步的接触表。
// 子进程用替身，不跑真的 ffmpeg / Bandit / Mel-RoFormer / whisper；替身按真实程序的约定写出文件
// （单帧、接触表、分轨、捞回的人声轨、有声区间、whisper 的 JSON），模块照真实路径读回。

const sourceBytes = Buffer.from("synthetic reference video bytes");
const digest = createHash("sha256").update(sourceBytes).digest("hex");

async function fixture(t, { durationSeconds = 51.1, hasAudio = true, failOn = null } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mimo-reference-rewrite-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runDir = path.join(root, "run");
  await fs.mkdir(runDir);
  const lifetimeFile = path.join(runDir, "manifest.json");
  await fs.writeFile(lifetimeFile, "{}");
  const sourcePath = path.join(root, "source.bin");
  await fs.writeFile(sourcePath, sourceBytes);
  const tools = {
    banditDir: path.join(root, "bandit"),
    vocalRecoveryDir: path.join(root, "sam-audio-breath"),
    whisperBin: path.join(root, "whisper"),
    whisperModel: "small",
    whisperModelDir: path.join(root, "models")
  };
  const calls = [];
  const exec = async (file, args, options) => {
    calls.push({ file: path.basename(file), args, options });
    if (failOn && failOn(file, args)) {
      throw Object.assign(new Error("Command failed"), { killed: true, signal: "SIGKILL", cmd: `${file} ${args.join(" ")}` });
    }
    const after = (flag) => args[args.indexOf(flag) + 1];
    if (path.basename(file) === "ffprobe") {
      const streams = [{ codec_type: "video" }, ...(hasAudio ? [{ codec_type: "audio" }] : [])];
      return { stdout: JSON.stringify({ format: { duration: String(durationSeconds) }, streams }), stderr: "" };
    }
    if (path.basename(file) === "ffmpeg") {
      const vf = args.includes("-vf") ? after("-vf") : "";
      const output = args.at(-1);
      if (vf.startsWith("fps=")) {
        const fps = Number(vf.slice(4).split(",")[0]);
        const frames = Math.floor(durationSeconds * fps);
        for (let index = 1; index <= frames; index += 1) await fs.writeFile(output.replace("%04d", String(index).padStart(4, "0")), "jpg");
      } else if (vf.startsWith("tile=")) {
        const frames = (await fs.readdir(path.dirname(after("-i")))).length;
        for (let index = 1; index <= Math.ceil(frames / 24); index += 1) await fs.writeFile(output.replace("%02d", String(index).padStart(2, "0")), `sheet-${index}`);
      } else {
        await fs.writeFile(output, "wav");
      }
      return { stdout: "", stderr: "" };
    }
    if (path.basename(file) === "python" && args.includes("--activity-input")) {
      await fs.writeFile(after("--activity-output"), JSON.stringify({ cellSeconds: 0.25, thresholdDb: -30, spans: [[0.5, 1], [11, 14.75]] }));
      return { stdout: "{\"done\":true}", stderr: "" };
    }
    if (path.basename(file) === "python" && String(args[2] || "").endsWith("retain_vocalizations.py")) {
      await fs.writeFile(after("--output"), "wav");
      return { stdout: "{\"event\":\"complete\"}", stderr: "" };
    }
    if (path.basename(file) === "python") {
      const out = after("--output-dir");
      await fs.mkdir(out, { recursive: true });
      for (const name of ["speech", "music", "sfx", "no_bgm"]) await fs.writeFile(path.join(out, `${name}.wav`), "wav");
      await fs.writeFile(path.join(out, "intervals.json"), JSON.stringify({ cellSeconds: 0.25, thresholdDb: -30, speech: [[11.25, 12.25]], sfx: [[0, 1]] }));
      return { stdout: "{\"done\":true}", stderr: "" };
    }
    if (path.basename(file) === "whisper") {
      const audio = args[0];
      const segments = audio.includes("noBgm") ? [{ start: 0, end: 1, text: "咕嘎嘎嘎嘎" }, { start: 11.2, end: 14.7, text: "小咕嘎，怎么在外面啊？" }] : [{ start: 11.1, end: 14.7, text: "小菇哥,怎么在外面啊?" }];
      await fs.writeFile(path.join(after("--output_dir"), `${path.basename(audio, ".wav")}.json`), JSON.stringify({ segments }));
      return { stdout: "", stderr: "" };
    }
    throw new Error(`unexpected ${file}`);
  };
  const steps = [];
  const common = { sourcePath, expectedDigest: digest, workRoot: path.join(runDir, "media-work"), lifetimeFile, exec };
  const build = (overrides = {}) => buildSourceTranscript({
    ...common, tools, onStep: async (step) => { steps.push(step); }, ...overrides
  });
  const sheets = (overrides = {}) => buildContactSheets({ ...common, ...overrides });
  return { root, runDir, lifetimeFile, tools, calls, steps, build, sheets };
}

test("去配乐与转写：Bandit 分轨、捞回人声，三组转写加有声区间；不抽帧；临时目录用完删掉", async (t) => {
  const f = await fixture(t);
  const result = await f.build();
  assert.deepEqual(f.steps, ["separate", "transcribe"]);
  assert.equal(result.durationSeconds, 51.1);
  assert.equal(result.hasAudio, true);
  assert.equal(result.separator, "bandit-v2-multi");
  assert.equal(result.voiceRecovery, "mel-roformer-kim-vocal-2");
  assert.equal(result.whisperModel, "small");
  assert.match(result.text, /## A\. 原声直接转写（没去配乐）/u);
  assert.match(result.text, /## B\. 人声轨转写（Bandit 对白＋捞回的叫声、笑声）\n\n```\n00:11\.1–00:14\.7  小菇哥/u);
  assert.match(result.text, /## C\. 原声减去音乐轨（人声＋音效）转写\n\n```\n00:00\.0–00:01\.0  咕嘎嘎嘎嘎/u);
  assert.match(result.text, /- 人声轨：0\.50–1\.00、11\.00–14\.75/u, "人声区间按捞回后的人声轨算，不用 Bandit 对白轨的");
  assert.match(result.text, /- 音效轨：0\.00–1\.00/u);
  assert.equal(f.calls.some((call) => call.args.some((arg) => String(arg).startsWith("fps="))), false, "转写这一步不抽帧");
  assert.deepEqual(await fs.readdir(path.join(f.runDir, "media-work")), [], "临时目录已删");
  const whisperCalls = f.calls.filter((call) => call.file === "whisper");
  assert.equal(whisperCalls.length, 3);
  for (const call of whisperCalls) {
    assert.equal(call.args[call.args.indexOf("--model_dir") + 1], f.tools.whisperModelDir, "只用本机模型目录");
    assert.equal(call.args[call.args.indexOf("--word_timestamps") + 1], "True");
  }
  const pythonCalls = f.calls.filter((call) => call.file === "python");
  assert.equal(pythonCalls.length, 3, "分轨、捞回人声、算人声区间各一次");
  const [bandit, recovery, activity] = pythonCalls;
  assert.equal(bandit.file, "python");
  assert.equal(bandit.args[0], "-I");
  assert.ok(bandit.args[1].endsWith(path.join("tools", "reference-audio-stems.py")));
  assert.ok(f.calls.indexOf(bandit) < f.calls.indexOf(recovery) && f.calls.indexOf(recovery) < f.calls.indexOf(activity));
  assert.ok(f.calls.indexOf(activity) < f.calls.findIndex((call) => call.file === "whisper"), "先捞回人声再转写");
  assert.deepEqual(recovery.args.slice(0, 3), ["-I", "-B", path.join(f.tools.vocalRecoveryDir, "retain_vocalizations.py")]);
  assert.ok(recovery.args[recovery.args.indexOf("--speech") + 1].endsWith(path.join("stems", "speech.wav")), "从 Bandit 对白轨出发捞回");
  const voiceWav = recovery.args[recovery.args.indexOf("--output") + 1];
  assert.equal(activity.args[activity.args.indexOf("--activity-input") + 1], voiceWav);
  assert.equal(whisperCalls[1].args[0], path.join(path.dirname(voiceWav), "voice-16k.wav"), "B 组转写捞回后的人声轨");
  assert.equal(recovery.options.env.HF_HUB_OFFLINE, "1", "人声捞回不联网下载模型");
  assert.ok(Object.keys(recovery.options.env).every((key) => ["HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "PYTHONUNBUFFERED", "PATH", "HOME", "TMPDIR", "LANG"].includes(key)), "不把服务端环境变量（含密钥）传给外部脚本");
  assert.ok(f.calls.every((call) => call.options.killSignal === "SIGKILL" && call.options.timeout > 0), "每个子进程都有超时");
});

test("接触表：每秒 2 帧拼 6×4，最后一张写明只有前几格；不跑去配乐和转写", async (t) => {
  const f = await fixture(t);
  const result = await f.sheets();
  assert.equal(result.durationSeconds, 51.1);
  assert.equal(result.images.length, 5);
  assert.equal(result.frameCount, 102);
  assert.ok(result.images.every((frame) => frame.dataUrl.startsWith("data:image/jpeg;base64,")));
  assert.deepEqual(result.layout.sheets.at(-1), { startSeconds: 48, endSeconds: 50.5, cells: 6 });
  assert.equal(f.calls.some((call) => call.file === "python" || call.file === "whisper"), false);
  assert.deepEqual(await fs.readdir(path.join(f.runDir, "media-work")), []);
});

test("超过 120 秒改每秒 1 帧；超过 180 秒在抽帧、分轨之前就拒绝", async (t) => {
  const long = await fixture(t, { durationSeconds: 150 });
  const result = await long.sheets();
  assert.equal(result.layout.fps, 1);
  assert.equal(result.images.length, Math.ceil(150 / 24));
  const tooLong = await fixture(t, { durationSeconds: 181 });
  await assert.rejects(tooLong.sheets(), (error) => error.code === "REFERENCE_REWRITE_VIDEO_TOO_LONG" && error.httpStatus === 400);
  await assert.rejects(tooLong.build(), (error) => error.code === "REFERENCE_REWRITE_VIDEO_TOO_LONG" && error.httpStatus === 400);
  assert.equal(tooLong.calls.some((call) => call.file === "ffmpeg" || call.file === "python"), false);
});

test("页面「+N」的估算与服务端切图同一个帧率：51 秒 102 帧，150 秒每秒 1 帧；演示模式也按它", () => {
  assert.equal(estimatedContactSheetFrameCount(51), 102);
  assert.equal(estimatedContactSheetFrameCount(150), 150);
  assert.equal(estimatedContactSheetFrameCount(0), 0);
  const demo = demoContactSheets(45);
  assert.equal(demo.layout.fps, 2);
  assert.equal(demo.images.length, 1);
});

test("副本和 Run 记录的不是同一个文件：在调任何子进程之前失败，临时目录照样删掉", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.build({ expectedDigest: "0".repeat(64) }), (error) => error.code === "TASK_SOURCE_VIDEO_DIGEST_MISMATCH" && error.httpStatus === 409);
  await assert.rejects(f.sheets({ expectedDigest: "0".repeat(64) }), (error) => error.code === "TASK_SOURCE_VIDEO_DIGEST_MISMATCH" && error.httpStatus === 409);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await fs.readdir(path.join(f.runDir, "media-work")), []);
});

test("页面工作区已关闭（manifest 没了）：不建临时目录、不重建 Run 目录", async (t) => {
  const f = await fixture(t);
  await fs.rm(f.runDir, { recursive: true });
  await assert.rejects(f.build(), (error) => error.code === "BROWSER_WORKSPACE_MEDIA_CLOSED");
  await assert.rejects(fs.stat(f.runDir), { code: "ENOENT" });
});

test("没有音轨：不跑去配乐和转写，转写稿如实写没有声音", async (t) => {
  const f = await fixture(t, { hasAudio: false });
  const result = await f.build();
  assert.deepEqual(f.steps, []);
  assert.equal(f.calls.some((call) => call.file === "python" || call.file === "whisper"), false);
  assert.match(result.text, /没有音轨/u);
  assert.equal(result.hasAudio, false);
});

test("子进程超时：如实说哪个程序超时被终止，临时目录删掉", async (t) => {
  const f = await fixture(t, { failOn: (file) => path.basename(file) === "python" });
  await assert.rejects(f.build(), (error) => error.code === "REFERENCE_REWRITE_MATERIALS_FAILED" && /python.*超时被终止/u.test(error.message));
  assert.deepEqual(await fs.readdir(path.join(f.runDir, "media-work")), []);
  const recovery = await fixture(t, { failOn: (file, args) => String(args[2] || "").endsWith("retain_vocalizations.py") });
  await assert.rejects(recovery.build(), (error) => error.code === "REFERENCE_REWRITE_MATERIALS_FAILED" && /超时被终止/u.test(error.message));
  assert.equal(recovery.calls.some((call) => call.file === "whisper"), false, "人声捞回失败就不转写，不退回 Bandit 对白轨");
  assert.deepEqual(await fs.readdir(path.join(recovery.runDir, "media-work")), []);
});

test("工具检查：逐项写明缺什么，不会自动下载 whisper 模型", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mimo-reference-tools-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const ok = async () => ({ stdout: "", stderr: "" });
  const empty = await sourceTranscriptToolStatus({ banditDir: "", vocalRecoveryDir: "", whisperBin: "", whisperModel: "small", whisperModelDir: path.join(root, "models") }, { exec: ok });
  assert.equal(empty.available, false);
  assert.deepEqual(empty.missing.map((item) => item.split("：")[0].split(" ")[0]), ["REFERENCE_REWRITE_BANDIT_DIR", "REFERENCE_REWRITE_VOCAL_RECOVERY_DIR", "REFERENCE_REWRITE_WHISPER_BIN", "whisper"]);
  assert.match(empty.reason, /不会自动下载/u);

  const bandit = path.join(root, "bandit");
  await fs.mkdir(path.join(bandit, ".venv", "bin"), { recursive: true });
  await fs.mkdir(path.join(bandit, "models"));
  await fs.writeFile(path.join(bandit, ".venv", "bin", "python"), "");
  await fs.writeFile(path.join(bandit, "models", "checkpoint-multi.ckpt"), "");
  const whisper = path.join(root, "whisper");
  await fs.writeFile(whisper, "#!/bin/sh\n", { mode: 0o755 });
  await fs.mkdir(path.join(root, "models"));
  await fs.writeFile(path.join(root, "models", "small.pt"), "");
  const vocal = path.join(root, "sam-audio-breath");
  await fs.mkdir(path.join(vocal, ".venv", "bin"), { recursive: true });
  await fs.writeFile(path.join(vocal, ".venv", "bin", "python"), "");
  const noRecoveryModel = await sourceTranscriptToolStatus({ banditDir: bandit, vocalRecoveryDir: vocal, whisperBin: whisper, whisperModel: "small", whisperModelDir: path.join(root, "models") }, { exec: ok });
  assert.deepEqual(noRecoveryModel.missing, ["人声捞回脚本 retain_vocalizations.py 不在", "Mel-RoFormer 模型 model.safetensors 不在"]);
  await fs.writeFile(path.join(vocal, "retain_vocalizations.py"), "");
  await fs.mkdir(path.join(vocal, "models", "mel-roformer-kim-vocal-2"), { recursive: true });
  await fs.writeFile(path.join(vocal, "models", "mel-roformer-kim-vocal-2", "model.safetensors"), "");
  const ready = await sourceTranscriptToolStatus({ banditDir: bandit, vocalRecoveryDir: vocal, whisperBin: whisper, whisperModel: "small", whisperModelDir: path.join(root, "models") }, { exec: ok });
  assert.deepEqual(ready, { available: true, reason: "", missing: [] });
  const noFfmpeg = await sourceTranscriptToolStatus({ banditDir: bandit, vocalRecoveryDir: vocal, whisperBin: whisper, whisperModel: "small", whisperModelDir: path.join(root, "models") }, {
    exec: async (file) => { if (file === "ffmpeg") throw new Error("ENOENT"); return { stdout: "" }; }
  });
  assert.deepEqual(noFfmpeg.missing, ["ffmpeg（命令行里找不到）"]);
});

test("转写稿格式：没识别出字的组写明，空文字的片段不列", () => {
  const text = formatReferenceTranscript({
    transcripts: { original: [{ start: 0, end: 1.04, text: " 顾顾 " }, { start: 2, end: 3, text: " " }], voice: [], noBgm: [{ start: 61.2, end: 62, text: "咕嘎" }] },
    intervals: { cellSeconds: 0.25, thresholdDb: -30, speech: [[5, 6]], voice: [], sfx: [[0, 1]] },
    whisperModel: "small"
  });
  assert.match(text, /```\n00:00\.0–00:01\.0  顾顾\n```/u);
  assert.match(text, /## B\. 人声轨转写（Bandit 对白＋捞回的叫声、笑声）\n\n（没有识别出字）/u);
  assert.match(text, /01:01\.2–01:02\.0  咕嘎/u);
  assert.match(text, /- 人声轨：（没有）/u, "人声区间只看捞回后的人声轨");
  assert.match(text, /Mel-RoFormer 从对白以外的部分把人声捞回来/u);
  assert.match(text, /配乐里如果有人唱歌，歌词也会进人声轨/u);
  assert.match(text, /whisper（small 模型，中文）/u);
});
