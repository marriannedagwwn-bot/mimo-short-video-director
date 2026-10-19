#!/usr/bin/env node
// 母题导演台「一键 AI 导演 → 生成完整剧情」的命令行复刻：不经浏览器，直接用本地参考视频
// 跑 Analyze → Reconstruct → Brief → Visual Guardrails → Story Candidates
// → 展开前体检（可选：采纳修订）→ Full Story（full_story/1.2），并导出可读的剧情文本。
//
// 与浏览器路径对齐的地方（改这些之前先对照 public/app.js 与 server.js）：
//   - 抽帧：sampleVideo(file, 10) 的张数、时间点、720 长边与 JPEG 质量；
//   - 原生视频：文件不超过分析阶段 nativeVideoMaxBytes 且 mediaMode 不是 frames 时随帧一起送；
//   - 各阶段请求体：逐字沿用 server.js DIRECTOR_PIPELINE_STAGES 的 buildInput 白名单
//     （Brief / Variants 不带 transcript，Variants 带 targetDurationSeconds）；
//   - 阶段模型：默认读运行中服务 /api/health 的 modelStages，与页面实际使用的一致；
//   - 展开：/api/full-story 的候选再校验 + fullStorySchemaVersion "full_story/1.2"；
//   - 密钥：与服务端同一对持久化 grounding / 角色边界密钥，阶段产物可以续跑复用。
//
// 不做的事：不创建 Production Run、不写 Artifact、不进 Task Store；产物只落到 --out 目录。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { loadEnv, getConfig, resolveDefaultLlmProvider } from "../src/config.js";
import { initializeSystemProxy } from "../src/system-proxy.js";
import { MimoClient } from "../src/mimo-client.js";
import { QwenClient } from "../src/qwen-client.js";
import { DeepSeekClient } from "../src/deepseek-client.js";
import { ClaudeClient } from "../src/claude-client.js";
import { WorkflowService } from "../src/workflow.js";
import { loadOrCreatePersistentKey } from "../src/persistent-key.js";
import { runWithUsageAccounting, readModelUsageFromError } from "../src/token-usage.js";
import { probeVideo, mimeTypeFor } from "../src/video-file.js";
import { ensureStoryCandidateContract, ensureThemeVariantsMatchProfile } from "../src/validation.js";
import { resolveStoryDurationTarget, isValidStoryDurationSeconds } from "../public/story-duration.js";
import { FULL_STORY_CAST_SCHEMA_VERSION } from "../public/full-story-format.js";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv"]);
const TRANSCRIPT_EXTENSIONS = [".txt", ".srt", ".vtt", ".md", ".docx", ".rtf", ".doc"];
// 浏览器 sampleVideo(file, 10)：张数 = max(6, min(10, ceil(时长/4)))，时间点 3%–97% 均匀分布。
const BROWSER_FRAME_REQUEST = 10;

const USAGE = `用法：
  node --use-env-proxy scripts/director-full-story.mjs <视频文件或目录> [选项]

角色设定（与导演台「设定创作宇宙」同三项，二选一）：
  --profile <json>             {"fixedCharacter","vertical","constraints"}，可直接粘贴 localStorage.directorProfile
  --character <text>           固定角色
  --vertical <text>            垂直赛道
  --constraints <text>         创作限制（可空）

常用选项：
  --count <1-8>                候选数量，默认 3（导演台默认）
  --candidates <all|first|id,id>  展开哪些候选，默认 all
  --precheck <adopt|report|off>   展开前体检：adopt=报出问题就采纳修订再展开（页面主按钮），
                               report=只记录体检、按原候选展开，off=跳过；默认 adopt
  --duration <source|20-180>   目标时长，默认 source（跟原片）
  --transcript-file <path>     字幕/对白文件；目录模式下自动找同名 .docx/.rtf/.txt/.srt
  --no-transcript              不送字幕（等同页面字幕框留空）
  --out <dir>                  输出目录，默认 reports/director-full-story/<时间>
  --concurrency <n>            同时处理的视频数，默认 2
  --story-concurrency <n>      单个视频内同时展开的候选数，默认 3
  --server <url>               读取阶段模型配置的导演台服务，默认 http://127.0.0.1:4173；
                               连不上时按本地 .env 推导
  --no-resume                  忽略输出目录里已有的阶段产物，全部重跑
  --render-only                不调用模型，只按 --out 里已有的 JSON 重新导出 candidates.md / fullStory-*.md
  --demo                       不调用模型，走演示数据（只验证管线）
`;

function parseArgs(argv) {
  const options = {
    inputs: [],
    count: 3,
    candidates: "all",
    precheck: "adopt",
    duration: "source",
    concurrency: 2,
    storyConcurrency: 3,
    server: "http://127.0.0.1:4173",
    resume: true,
    transcript: true,
    demo: false
  };
  const valueFlags = new Map([
    ["profile", "profile"], ["character", "character"], ["vertical", "vertical"], ["constraints", "constraints"],
    ["count", "count"], ["candidates", "candidates"], ["precheck", "precheck"], ["duration", "duration"],
    ["transcript-file", "transcriptFile"], ["out", "out"], ["concurrency", "concurrency"],
    ["story-concurrency", "storyConcurrency"], ["server", "server"]
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "-h" || token === "--help") options.help = true;
    else if (token === "--no-resume") options.resume = false;
    else if (token === "--no-transcript") options.transcript = false;
    else if (token === "--demo") options.demo = true;
    else if (token === "--render-only") options.renderOnly = true;
    else if (token.startsWith("--")) {
      const [name, inline] = token.includes("=") ? token.slice(2).split(/=(.*)/s, 2) : [token.slice(2), null];
      const key = valueFlags.get(name);
      if (!key) throw new Error(`不支持的参数：--${name}`);
      const value = inline ?? argv[++index];
      if (value === undefined) throw new Error(`缺少 --${name} 的取值`);
      options[key] = value;
    } else options.inputs.push(token);
  }
  options.count = clampInteger(options.count, 3, 1, 8);
  options.concurrency = clampInteger(options.concurrency, 2, 1, 8);
  options.storyConcurrency = clampInteger(options.storyConcurrency, 3, 1, 8);
  if (!["adopt", "report", "off"].includes(options.precheck)) throw new Error("--precheck 只能是 adopt、report 或 off");
  if (options.duration !== "source") {
    const seconds = Number(options.duration);
    if (!isValidStoryDurationSeconds(seconds)) throw new Error("--duration 只能是 source 或 20-180 之间的整数秒");
    options.duration = seconds;
  }
  return options;
}

async function resolveProfile(options) {
  let profile = {};
  if (options.profile) {
    const raw = await fs.readFile(path.resolve(options.profile), "utf8").catch(() => options.profile);
    profile = JSON.parse(raw);
  }
  const result = {
    fixedCharacter: String(options.character ?? profile.fixedCharacter ?? "").trim(),
    vertical: String(options.vertical ?? profile.vertical ?? "").trim(),
    constraints: String(options.constraints ?? profile.constraints ?? "").trim()
  };
  if (!result.fixedCharacter || !result.vertical) throw new Error("必须提供固定角色与垂直赛道（--profile 或 --character/--vertical）");
  return result;
}

async function collectVideos(inputs) {
  const videos = [];
  for (const input of inputs) {
    const resolved = path.resolve(input);
    const stat = await fs.stat(resolved);
    if (stat.isDirectory()) {
      const names = (await fs.readdir(resolved)).filter((name) => VIDEO_EXTENSIONS.has(path.extname(name).toLowerCase())).sort();
      videos.push(...names.map((name) => path.join(resolved, name)));
    } else videos.push(resolved);
  }
  if (!videos.length) throw new Error("没有找到参考视频");
  return videos;
}

async function findTranscriptFile(videoPath) {
  const base = videoPath.slice(0, -path.extname(videoPath).length);
  for (const extension of TRANSCRIPT_EXTENSIONS) {
    const candidate = `${base}${extension}`;
    if (await fs.stat(candidate).then((stat) => stat.isFile(), () => false)) return candidate;
  }
  return null;
}

async function readTranscript(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if ([".docx", ".rtf", ".doc"].includes(extension)) {
    // macOS 自带 textutil；页面上是用户手动粘贴字幕，这里等价于把文档正文贴进字幕框。
    const { stdout } = await execFileAsync("textutil", ["-convert", "txt", "-stdout", filePath], { maxBuffer: 16 * 1024 * 1024 });
    return stdout.trim();
  }
  return (await fs.readFile(filePath, "utf8")).trim();
}

// 与 public/app.js sampleVideo 同一套张数与时间点；canvas JPEG 0.72 ≈ ffmpeg -q:v 5。
async function sampleBrowserFrames(videoPath, metadata) {
  const duration = metadata.duration;
  const count = Math.max(6, Math.min(BROWSER_FRAME_REQUEST, Math.ceil(duration / 4)));
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "director-full-story-"));
  try {
    const frames = [];
    for (let index = 0; index < count; index += 1) {
      const ratio = count === 1 ? .5 : .03 + (.94 * index / (count - 1));
      const timestamp = Math.min(duration - .02, Math.max(0, duration * ratio));
      const output = path.join(tempDir, `f${index}.jpg`);
      await execFileAsync("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y", "-ss", String(timestamp), "-i", videoPath,
        "-frames:v", "1", "-an",
        "-vf", "scale=w='if(gt(iw,ih),min(720,iw),-2)':h='if(gt(iw,ih),-2,min(720,ih))'",
        "-q:v", "5", output
      ]);
      const buffer = await fs.readFile(output);
      frames.push({ timestamp: Number(timestamp.toFixed(2)), dataUrl: `data:image/jpeg;base64,${buffer.toString("base64")}` });
    }
    return frames;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function loadStageDefaults(options, config) {
  if (!options.demo && options.server) {
    try {
      const response = await fetch(new URL("/api/health", options.server), { signal: AbortSignal.timeout(8000) });
      if (response.ok) {
        const health = await response.json();
        if (health?.modelStages && typeof health.modelStages === "object") {
          return { source: `${options.server}/api/health`, stageDefaults: health.modelStages, media: health.providers || {} };
        }
      }
    } catch {
      // 服务没开时退回本地推导，下面会如实打印来源。
    }
  }
  return { source: "本地 .env 推导", stageDefaults: localStageDefaults(config), media: {} };
}

// server.js buildStageDefaults 中本脚本会用到的阶段；只在连不上运行中服务时使用。
function localStageDefaults(config) {
  const provider = resolveDefaultLlmProvider(config);
  const source = provider === "Qwen" ? config.qwen : config.mimo;
  const stage = (model, tokens) => ({
    provider,
    model,
    maxCompletionTokens: Number.isFinite(Number(tokens)) ? Math.round(Number(tokens)) : null,
    requestTimeoutMs: null
  });
  const base = source.maxCompletionTokens;
  const variantsTokens = source.variantsMaxCompletionTokens || base;
  return {
    analysis: stage(source.analysisModel || source.videoModel || source.model, source.analysisMaxCompletionTokens || base),
    reconstruction: stage(source.reconstructionModel || source.videoModel || source.model, source.reconstructionMaxCompletionTokens || base),
    brief: stage(source.briefModel || source.model, source.briefMaxCompletionTokens || base),
    visualGuardrails: stage(source.visualModel || source.videoModel || source.model, source.visualMaxCompletionTokens || base),
    variants: stage(source.variantsModel || source.model, variantsTokens),
    storyCandidateReview: stage(source.variantsModel || source.model, Math.max(Number(variantsTokens) || 0, 32768)),
    storyCandidateRevision: stage(source.variantsModel || source.model, variantsTokens),
    fullStory: stage(source.storyModel || source.model, source.storyMaxCompletionTokens || base)
  };
}

function analysisMediaSettings(stageDefaults, media, config) {
  const provider = stageDefaults.analysis?.provider || resolveDefaultLlmProvider(config);
  const fromHealth = media?.[provider];
  const fromConfig = provider === "Qwen" ? config.qwen : config.mimo;
  return {
    mediaMode: fromHealth?.mediaMode || fromConfig.mediaMode || "auto",
    nativeVideoMaxBytes: Number(fromHealth?.nativeVideoMaxBytes || fromConfig.nativeVideoMaxBytes || 0)
  };
}

function slugFor(videoPath) {
  const base = path.basename(videoPath, path.extname(videoPath));
  return base.replace(/[#~💥\s/\\:*?"<>|]+/gu, "_").replace(/_+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "video";
}

class VideoRun {
  constructor({ videoPath, outDir, workflow, profile, options, prices, stageInfo, media }) {
    this.videoPath = videoPath;
    this.slug = slugFor(videoPath);
    this.dir = path.join(outDir, this.slug);
    this.workflow = workflow;
    this.profile = profile;
    this.options = options;
    this.prices = prices;
    this.stageInfo = stageInfo;
    this.media = media;
    this.summary = { video: path.basename(videoPath), slug: this.slug, stages: [], stories: [], errors: [] };
    this.startedAt = Date.now();
  }

  log(message) {
    const elapsed = ((Date.now() - this.startedAt) / 1000).toFixed(0).padStart(4);
    process.stdout.write(`[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}] ${this.slug} +${elapsed}s ${message}\n`);
  }

  file(name) {
    return path.join(this.dir, name);
  }

  async readJson(name) {
    if (!this.options.resume) return null;
    try {
      return JSON.parse(await fs.readFile(this.file(name), "utf8"));
    } catch {
      return null;
    }
  }

  async writeJson(name, value) {
    await fs.writeFile(this.file(name), `${JSON.stringify(value, null, 2)}\n`);
  }

  // 每个阶段一个记账作用域：成功、失败都把真实 token 用量记下来。
  async stage(label, fileName, fn) {
    const cached = await this.readJson(fileName);
    if (cached) {
      this.log(`${label}：复用已有产物 ${fileName}`);
      this.summary.stages.push({ stage: label, file: fileName, reused: true });
      return cached;
    }
    this.log(`${label}：开始`);
    const started = Date.now();
    try {
      const { result, usage } = await runWithUsageAccounting(fn, { prices: this.prices });
      const seconds = Math.round((Date.now() - started) / 1000);
      await this.writeJson(fileName, result);
      this.summary.stages.push({ stage: label, file: fileName, seconds, usage });
      this.log(`${label}：完成 ${seconds}s${formatUsage(usage)}`);
      return result;
    } catch (error) {
      const seconds = Math.round((Date.now() - started) / 1000);
      const usage = readModelUsageFromError(error);
      this.summary.stages.push({ stage: label, file: fileName, seconds, usage, error: errorMessage(error) });
      this.log(`${label}：失败 ${seconds}s${formatUsage(usage)} — ${errorMessage(error)}`);
      throw error;
    }
  }

  async prepareInput() {
    const metadataProbe = await probeVideo(this.videoPath);
    const stat = await fs.stat(this.videoPath);
    const type = mimeTypeFor(this.videoPath);
    const metadata = {
      name: path.basename(this.videoPath),
      size: stat.size,
      type,
      duration: metadataProbe.duration,
      width: metadataProbe.width,
      height: metadataProbe.height
    };
    const frames = await sampleBrowserFrames(this.videoPath, metadata);
    const canSendNativeVideo = !this.options.demo
      && this.media.mediaMode !== "frames"
      && this.media.nativeVideoMaxBytes > 0
      && stat.size <= this.media.nativeVideoMaxBytes;
    const video = canSendNativeVideo
      ? { dataUrl: `data:${type};base64,${(await fs.readFile(this.videoPath)).toString("base64")}`, mimeType: type, size: stat.size }
      : null;
    let transcript = "";
    let transcriptFile = null;
    if (this.options.transcript) {
      transcriptFile = this.options.transcriptFile ? path.resolve(this.options.transcriptFile) : await findTranscriptFile(this.videoPath);
      if (transcriptFile) transcript = await readTranscript(transcriptFile);
    }
    return { metadata, frames, video, transcript, transcriptFile };
  }

  async run() {
    await fs.mkdir(this.dir, { recursive: true });
    const { metadata, frames, video, transcript, transcriptFile } = await this.prepareInput();
    this.log(`读取视频 ${metadata.duration.toFixed(1)}s ${metadata.width}×${metadata.height}，抽帧 ${frames.length} 张，${video ? "附原生视频" : "仅关键帧"}，字幕 ${transcriptFile ? path.basename(transcriptFile) : "无"}`);
    await this.writeJson("00-input.json", {
      sourceVideo: metadata,
      videoPath: this.videoPath,
      frameTimestamps: frames.map((frame) => frame.timestamp),
      nativeVideo: Boolean(video),
      transcriptFile,
      transcript,
      creatorProfile: this.profile,
      count: this.options.count,
      durationSelection: this.options.duration,
      precheck: this.options.precheck,
      stageModels: this.stageInfo
    });

    // 等价于页面 directorPipeline 的 shared（modelOverrides 留空 = 用服务端阶段默认）。
    const raw = { frames, ...(video ? { video } : {}), metadata, transcript, creatorProfile: this.profile, count: this.options.count };
    const media = { frames: raw.frames, ...(raw.video ? { video: raw.video } : {}), metadata, transcript, creatorProfile: this.profile };
    const wf = this.workflow;

    const referenceAnalysis = await this.stage("1/5 参考分析", "01-referenceAnalysis.json", () => wf.analyze({ ...media }));
    const sourceScriptReconstruction = await this.stage("2/5 脚本还原", "02-sourceScriptReconstruction.json",
      () => wf.reconstruct({ ...media, referenceAnalysis }));
    const creativeBrief = await this.stage("3/5 创意 Brief", "03-creativeBrief.json",
      () => wf.createBrief({ referenceAnalysis, sourceScriptReconstruction, creatorProfile: this.profile }));
    const visualGuardrails = await this.stage("4/5 视觉护栏", "04-visualGuardrails.json",
      () => wf.createVisualGuardrails({ ...media, referenceAnalysis, sourceScriptReconstruction, creativeBrief }));
    const targetDurationSeconds = resolveStoryDurationTarget(this.options.duration, { metadata, sourceScriptReconstruction });
    this.summary.targetDurationSeconds = targetDurationSeconds;
    const themeVariants = await this.stage("5/5 剧情候选", "05-themeVariants.json",
      () => wf.createVariants({
        referenceAnalysis, sourceScriptReconstruction, creativeBrief, visualGuardrails,
        creatorProfile: this.profile, count: this.options.count, targetDurationSeconds
      }));
    await fs.writeFile(this.file("candidates.md"), renderCandidatesMarkdown(themeVariants, { video: metadata.name, targetDurationSeconds }));

    const upstream = { referenceAnalysis, sourceScriptReconstruction, creativeBrief, visualGuardrails };
    const variants = selectCandidates(themeVariants, this.options.candidates);
    this.log(`展开 ${variants.length} 个候选：${variants.map((variant) => variant.id).join("、")}`);
    await mapPool(variants, this.options.storyConcurrency, (variant) => this.expand(variant, themeVariants, upstream, targetDurationSeconds)
      .catch((error) => {
        this.summary.errors.push({ variantId: variant.id, error: errorMessage(error) });
      }));
    return this.summary;
  }

  // 页面「生成完整剧情」：startFullStory（体检）→ 需修订时 requestPrecheckRevision（scope:root）
  // → 主按钮「采纳修订并展开」→ generateFullStory。
  async expand(variant, themeVariants, upstream, targetDurationSeconds) {
    const id = variant.id;
    let batch = themeVariants;
    const record = { variantId: id, title: variant.title || variant.themeTitle || "", precheck: null, adoptedRevision: false };
    this.summary.stories.push(record);
    if (this.options.precheck !== "off") {
      try {
        const precheck = await this.stage(`体检 ${id}`, `06-precheck-${id}.json`, () => this.workflow.createFullStoryPrecheck({
          themeVariants: batch, candidateId: id, creatorProfile: this.profile, ...upstream
        }));
        record.precheck = { route: precheck.route, reasons: precheck.reasons || [] };
        if (precheck.route !== "expand" && this.options.precheck === "adopt") {
          const revision = await this.stage(`修订 ${id}`, `06-revision-${id}.json`, () => this.workflow.createStoryCandidateRevision({
            themeVariants: batch, review: precheck.review, promiseCheck: precheck.promiseCheck, candidateId: id,
            scope: "root", creatorProfile: this.profile, ...upstream, targetDurationSeconds
          }));
          if (revision?.themeVariants?.variants) {
            batch = revision.themeVariants;
            record.adoptedRevision = true;
          }
        }
      } catch (error) {
        // 页面上体检失败时给「按原候选展开」，这里同样按原候选继续。
        record.precheck = { route: "failed", error: errorMessage(error) };
      }
    }
    const candidate = batch.variants.find((item) => item.id === id);
    if (!candidate) throw new Error(`候选 ${id} 在修订后的批次里不存在`);
    record.title = candidate.title || record.title;
    // /api/full-story 在调用前对候选做的再校验。
    ensureStoryCandidateContract(candidate, { path: "selectedCandidate" });
    ensureThemeVariantsMatchProfile({ variants: [candidate] }, this.profile, upstream.creativeBrief, upstream.visualGuardrails);
    const fullStory = await this.stage(`完整剧情 ${id}`, `07-fullStory-${id}.json`, () => this.workflow.createFullStory({
      fullStorySchemaVersion: FULL_STORY_CAST_SCHEMA_VERSION,
      ...upstream,
      themeVariants: batch,
      variant: candidate,
      creatorProfile: this.profile,
      targetDurationSeconds
    }));
    record.fullStoryTitle = fullStory.title;
    record.fullStorySeconds = fullStory.targetDurationSeconds;
    record.sceneCount = (fullStory.sceneScript || []).length;
    const markdown = renderFullStoryMarkdown(fullStory, { candidate, video: path.basename(this.videoPath), precheck: record.precheck, adopted: record.adoptedRevision });
    await fs.writeFile(this.file(`fullStory-${id}.md`), markdown);
    record.markdown = `fullStory-${id}.md`;
  }
}

function selectCandidates(themeVariants, selection) {
  const variants = Array.isArray(themeVariants?.variants) ? themeVariants.variants : [];
  if (selection === "all") return variants;
  if (selection === "first") return variants.slice(0, 1);
  const ids = new Set(String(selection).split(",").map((item) => item.trim()).filter(Boolean));
  const chosen = variants.filter((variant) => ids.has(variant.id));
  if (!chosen.length) throw new Error(`--candidates 没有匹配到候选：${selection}`);
  return chosen;
}

// ---------- 可读导出 ----------

function text(value) {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join("；");
  if (typeof value === "object") return Object.entries(value).map(([key, item]) => `${key}：${text(item)}`).filter(Boolean).join("；");
  return String(value).trim();
}

function dialogueLines(items) {
  if (!Array.isArray(items) || !items.length) return [];
  return items.map((item) => {
    if (typeof item === "string") return item;
    const line = String(item.line || "").trim();
    // 模型常自带「」，再套一层会变成「「…」」。
    const quoted = /^[「“"]/u.test(line) ? line : `「${line}」`;
    return `${item.speaker || "角色"}：${quoted}${item.deliveryOrSubtext ? `（${item.deliveryOrSubtext}）` : ""}`;
  });
}

export function renderFullStoryMarkdown(story, { candidate = null, video = "", precheck = null, adopted = false } = {}) {
  const lines = [];
  lines.push(`# ${story.title || "完整剧情"}`);
  lines.push("");
  lines.push(`- 参考视频：${video}`);
  lines.push(`- 候选：${candidate?.id || ""} ${candidate?.title || ""}${adopted ? "（已采纳体检修订）" : ""}`);
  if (precheck) lines.push(`- 展开前体检：${precheck.route}${precheck.reasons?.length ? `（${precheck.reasons.join("、")}）` : ""}${precheck.error ? ` — ${precheck.error}` : ""}`);
  lines.push(`- 时长：${story.targetDurationSeconds || "?"} 秒 · ${(story.sceneScript || []).length} 场`);
  lines.push("");
  if (story.oneLinePremise) lines.push(`> ${story.oneLinePremise}`, "");
  if (story.shootingSynopsis) lines.push("## 剧情梗概", "", story.shootingSynopsis, "");
  const protagonist = story.characterBible?.protagonist;
  if (protagonist) lines.push("## 主角", "", text(protagonist), "");
  const supporting = story.characterBible?.supportingCharacters;
  if (Array.isArray(supporting) && supporting.length) {
    lines.push("## 配角", "");
    for (const row of supporting) lines.push(`- **${row.name || ""}** · ${row.identity || ""}${row.relationshipToProtagonist ? ` · ${row.relationshipToProtagonist}` : ""}`);
    lines.push("");
  }
  if (story.dialogueStyleGuide) lines.push("## 对白规则", "", text(story.dialogueStyleGuide), "");
  lines.push("## 剧情正文（按场次，动作 + 对白）", "");
  for (const scene of story.sceneScript || []) {
    lines.push(`### ${scene.sceneId || ""} · ${scene.location || ""} · ${scene.timeRange || ""}`);
    lines.push("");
    if (scene.visibleAction) lines.push(scene.visibleAction, "");
    for (const line of dialogueLines(scene.dialogue)) lines.push(`> ${line}`);
    if (Array.isArray(scene.dialogue) && scene.dialogue.length) lines.push("");
    const meta = [
      scene.characters?.length ? `人物：${scene.characters.join("、")}` : "",
      scene.emotionNode ? `情绪：${scene.emotionNode}` : "",
      scene.dramaticFunction ? `功能：${scene.dramaticFunction}` : "",
      scene.shotAndSound ? `声音：${scene.shotAndSound}` : "",
      scene.shootingNotes ? `备注：${scene.shootingNotes}` : ""
    ].filter(Boolean);
    if (meta.length) lines.push(`<sub>${meta.join(" ｜ ")}</sub>`, "");
  }
  if (Array.isArray(story.keyProps) && story.keyProps.length) {
    lines.push("## 关键道具", "");
    for (const item of story.keyProps) lines.push(`- **${item.prop || ""}**：${text([item.storyFunction, item.visualUse])}`);
    lines.push("");
  }
  if (story.uncertainties && text(story.uncertainties)) lines.push("## 不确定项", "", text(story.uncertainties), "");
  return `${lines.join("\n")}\n`;
}

export function renderCandidatesMarkdown(themeVariants, { video = "", targetDurationSeconds = null } = {}) {
  const lines = [`# 剧情候选 · ${video}`, "", `目标时长：${targetDurationSeconds || "?"} 秒`, ""];
  for (const variant of themeVariants?.variants || []) {
    lines.push(`## ${variant.id} · ${variant.title || ""}`, "");
    for (const [key, value] of Object.entries(variant)) {
      if (["id", "title"].includes(key)) continue;
      const rendered = text(value);
      if (rendered) lines.push(`- **${key}**：${rendered}`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

// ---------- 工具 ----------

function formatUsage(usage) {
  if (!usage || !usage.totalTokens) return "";
  const cost = Number.isFinite(usage.costCny) ? ` ≈¥${usage.costCny.toFixed(2)}` : "";
  return ` · ${usage.totalTokens} tokens${cost}`;
}

function errorMessage(error) {
  return String(error?.message || error || "未知错误").slice(0, 600);
}

function clampInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(number)));
}

async function mapPool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

// 只读已落盘的阶段产物重新导出可读文本；不加载模型客户端、不碰密钥。
async function renderOnly(videos, outDir) {
  let stories = 0;
  for (const videoPath of videos) {
    const dir = path.join(outDir, slugFor(videoPath));
    const read = async (name) => JSON.parse(await fs.readFile(path.join(dir, name), "utf8"));
    const themeVariants = await read("05-themeVariants.json").catch(() => null);
    if (!themeVariants) continue;
    const summary = await read("summary.json").catch(() => ({}));
    const video = path.basename(videoPath);
    await fs.writeFile(path.join(dir, "candidates.md"), renderCandidatesMarkdown(themeVariants, { video, targetDurationSeconds: summary.targetDurationSeconds }));
    for (const name of (await fs.readdir(dir)).filter((file) => /^07-fullStory-.+\.json$/.test(file))) {
      const id = name.slice("07-fullStory-".length, -".json".length);
      const precheckRaw = await read(`06-precheck-${id}.json`).catch(() => null);
      const revision = await read(`06-revision-${id}.json`).catch(() => null);
      const adopted = Boolean(precheckRaw && precheckRaw.route !== "expand" && revision?.themeVariants?.variants);
      const batch = adopted ? revision.themeVariants : themeVariants;
      const candidate = batch.variants.find((item) => item.id === id) || null;
      const precheck = precheckRaw ? { route: precheckRaw.route, reasons: precheckRaw.reasons || [] } : null;
      await fs.writeFile(path.join(dir, `fullStory-${id}.md`), renderFullStoryMarkdown(await read(name), { candidate, video, precheck, adopted }));
      stories += 1;
    }
  }
  return stories;
}

function timestampSlug() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.inputs.length) {
    process.stdout.write(USAGE);
    return options.help ? 0 : 1;
  }
  process.chdir(projectRoot);
  if (options.renderOnly) {
    if (!options.out) throw new Error("--render-only 需要 --out 指向已有输出目录");
    const outDir = path.resolve(options.out);
    const count = await renderOnly(await collectVideos(options.inputs), outDir);
    process.stdout.write(`已重新导出 ${count} 篇完整剧情：${outDir}\n`);
    return 0;
  }
  loadEnv();
  const systemProxy = await initializeSystemProxy();
  try {
    const config = getConfig();
    const profile = await resolveProfile(options);
    const videos = await collectVideos(options.inputs);
    const clients = options.demo ? {} : {
      MiMo: config.mimo.enabled ? new MimoClient(config.mimo) : null,
      Qwen: config.qwen.enabled ? new QwenClient(config.qwen) : null,
      DeepSeek: config.deepseek.enabled ? new DeepSeekClient(config.deepseek) : null,
      Claude: config.claude.enabled ? new ClaudeClient(config.claude) : null
    };
    const { source, stageDefaults, media } = await loadStageDefaults(options, config);
    const keyDirectory = config.workflowRuntime.productionStateDirectory;
    const groundingKey = (await loadOrCreatePersistentKey({
      directory: keyDirectory, fileName: ".grounding-key", byteLength: 32, label: "Grounding 密钥", envValue: process.env.WORKFLOW_GROUNDING_KEY
    })).key;
    const characterBoundaryKey = (await loadOrCreatePersistentKey({
      directory: keyDirectory, fileName: ".character-boundary-key", byteLength: 32, label: "全局角色边界密钥", envValue: process.env.WORKFLOW_CHARACTER_BOUNDARY_KEY
    })).key;
    const workflow = new WorkflowService({
      clients,
      stageDefaults,
      characterBoundarySignatureRequired: config.workflowRuntime.characterBoundarySignatureRequired,
      groundingKey,
      characterBoundaryKey
    });
    const stageInfo = Object.fromEntries(["analysis", "reconstruction", "brief", "visualGuardrails", "variants", "storyCandidateReview", "storyCandidateRevision", "fullStory"]
      .map((key) => [key, stageDefaults[key] ? `${stageDefaults[key].provider} ${stageDefaults[key].model}` : "未配置"]));
    const mediaSettings = analysisMediaSettings(stageDefaults, media, config);
    const outDir = path.resolve(options.out || path.join(projectRoot, "reports", "director-full-story", timestampSlug()));
    await fs.mkdir(outDir, { recursive: true });

    process.stdout.write([
      `运行模式：${workflow.mode === "live" ? "live" : "演示数据"}；阶段模型来源：${source}`,
      `阶段模型：${Object.entries(stageInfo).map(([key, value]) => `${key}=${value}`).join("，")}`,
      `原生视频：mediaMode=${mediaSettings.mediaMode}，上限 ${Math.round(mediaSettings.nativeVideoMaxBytes / 1048576)}MB`,
      `角色：${profile.fixedCharacter}`,
      `赛道：${profile.vertical}${profile.constraints ? `；限制：${profile.constraints}` : ""}`,
      `视频 ${videos.length} 个 → ${outDir}`,
      ""
    ].join("\n"));

    const summaries = await mapPool(videos, options.concurrency, async (videoPath) => {
      const run = new VideoRun({ videoPath, outDir, workflow, profile, options, prices: config.modelPrices, stageInfo, media: mediaSettings });
      try {
        return await run.run();
      } catch (error) {
        run.summary.errors.push({ stage: "pipeline", error: errorMessage(error) });
        return run.summary;
      } finally {
        await run.writeJson("summary.json", run.summary).catch(() => {});
      }
    });
    await fs.writeFile(path.join(outDir, "summary.json"), `${JSON.stringify({ generatedAt: new Date().toISOString(), profile, stageInfo, videos: summaries }, null, 2)}\n`);
    const okStories = summaries.flatMap((item) => item.stories.filter((story) => story.markdown));
    const failed = summaries.flatMap((item) => item.errors.map((error) => `${item.slug} ${error.variantId || error.stage}: ${error.error}`));
    process.stdout.write(`\n完成：${okStories.length} 篇完整剧情；失败 ${failed.length} 项${failed.length ? `\n${failed.join("\n")}` : ""}\n输出：${outDir}\n`);
    return failed.length && !okStories.length ? 1 : 0;
  } finally {
    await systemProxy.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("director-full-story.mjs")) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
