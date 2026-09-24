#!/usr/bin/env node
// 参考视频批量真实回放：每个参考视频从头跑一遍，到完整剧情的评审与修订为止。
//
//   上传参考视频（抽帧 + 原生视频 + 字幕）
//   → AI 导演五阶段（分析 → 脚本还原 → 创意简报 → 角色边界 → 主题候选）
//   → 候选对照评审，选加权分最高的候选
//   → 展开前体检；判「需修订」就按体检修订候选并采纳
//   → 完整剧情
//   → 剧情体检 → 按问题修改（勾选全部可修条目）并采纳
//   → 封成测试包
//
// 整条流程走开发服务器的生产接口，与页面上逐步点击是同一条路径：Run、Durable Task、
// Artifact 提交与封包全部由服务端完成，导出的 JSON 就是页面「导出测试包」的同一种签名包，
// 可以直接在页面「导入测试包」打开。评审报告、修订稿这些页面上刷新即失的东西，
// 另存一份「评审与修订记录」。
//
// 与页面操作的差别，只有这三处：
//   1. 抽帧用 ffmpeg 复刻浏览器的 sampleVideo()：帧数 max(6, min(10, ceil(时长/4)))、
//      时间点 3%–97% 均匀、长边缩到 720、JPEG；原生视频同样只在不超过服务端上限时才送。
//   2. 建 Run 不绑定浏览器工作区（接口允许）。这些 Run 没有页面归属，不会被自动清理。
//   3. 页面上要人点的「采纳」一律自动采纳；修订或修改失败时照原稿继续，并在记录里写明。
//
// 中途被打断的视频（供应商欠费、传输中断、手动停止）再跑同一条命令，会接着原来的 Run、
// 从第一个没做完的步骤继续，已经付过钱的步骤不重跑；已经做完的视频默认跳过。
//
// 用法（开发服务器须在运行；只连本机，不需要 --use-env-proxy）：
//   node scripts/batch-reference-video-review.mjs                  全部视频
//   node scripts/batch-reference-video-review.mjs --only 打枣       文件名里含「打枣」的视频
//   node scripts/batch-reference-video-review.mjs --concurrency 1   同时跑几个视频（默认 2）
//   node scripts/batch-reference-video-review.mjs --dry-run         只抽帧、读字幕、查服务，不调模型
//   node scripts/batch-reference-video-review.mjs --fresh           之前失败过的视频也新建 Run（默认接着原 Run 续跑）
//   node scripts/batch-reference-video-review.mjs --exclude 累了就歇会,打枣   跳过这些视频（逗号分隔）
//   node scripts/batch-reference-video-review.mjs --rerun           连已经成功的视频也重跑（默认跳过，免得重复花钱）
// 环境变量：DIRECTOR_URL（默认 http://localhost:4173）、REFERENCE_VIDEO_DIR、BATCH_OUTPUT_DIR、
//           CREATOR_PROFILE_PACKAGE（从哪份导出包取创作设定）、VARIANT_COUNT（默认 4）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { storyQualityRepairableItems } from "../public/story-review-metrics.js";
import { STORY_DURATION_SOURCE, resolveStoryDurationTarget } from "../public/story-duration.js";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DOWNLOADS = path.join(os.homedir(), "Downloads");
const BASE = process.env.DIRECTOR_URL || "http://localhost:4173";
const VIDEO_DIR = process.env.REFERENCE_VIDEO_DIR || path.join(DOWNLOADS, "剧情及视频字幕");
const PROFILE_PACKAGE = process.env.CREATOR_PROFILE_PACKAGE || path.join(DOWNLOADS, "剧情", "糖浆泡泡糖葫芦.json");
const VARIANT_COUNT = Number(process.env.VARIANT_COUNT || 4);
const TODAY = new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD，本地时区
const OUTPUT_DIR = process.env.BATCH_OUTPUT_DIR || path.join(DOWNLOADS, `参考视频批量评审-${TODAY}`);

// 视频与字幕的对应关系写死：文件名本身对不严（「娟/捐」「嘎/噶」），不做模糊匹配。
const VIDEOS = [
  { label: "一份长途的录取通知书", video: "一份长途的录取通知书.MP4", transcript: "一份长途的录取通知书.rtf" },
  { label: "奶奶的录音", video: "奶奶的录音.MP4", transcript: "奶奶的录音.rtf" },
  { label: "帮奶奶捐旧衣服", video: "帮奶奶娟旧衣服_ _咕咕嘎嘎 _弗糯糯 _可爱到爆炸__ _治愈系 _治愈系动画.mp4", transcript: "帮奶奶捐旧衣服字幕 .txt.rtf" },
  { label: "打枣", video: "打枣.mp4", transcript: "打枣字幕.rtf" },
  { label: "活泼嘎安静糯", video: "活泼嘎_安静糯_ _咕咕嘎嘎创作征集 _明日方舟终末地 _治愈系 _寻遗散记.mp4", transcript: "活泼噶.rtf" },
  { label: "累了就歇会", video: "累了就歇会_ _咕咕嘎嘎 _可爱到爆炸__ _治愈系 _治愈动画 _doro.mp4", transcript: "累了就歇会字幕.rtf" },
  { label: "这一站先别难过", video: "这一站_先别难过_咕嘎_ _咕咕嘎嘎 _治愈系 _可爱到爆炸__ _明日方舟终末地  _治愈动画.mp4", transcript: "这一站请先别难过字幕.txt.rtf" },
  { label: "小咕嘎送的是一段回忆", video: "这次_小咕嘎送的是一段回忆_ _咕咕嘎嘎 _治愈系 _治愈动画 _可爱到爆炸__ _菲比啾比_菲比啾比.mp4", transcript: "这次_小咕嘎送的是一段回忆字幕.rtf" }
];

const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "conflicted", "interrupted", "abandoned"]);
const UPSTREAM_IDS = ["referenceAnalysis", "sourceScriptReconstruction", "creativeBrief", "visualGuardrails"];
// 与页面 fullStoryDependencyIds() 同一份依赖清单（public/app.js）。
const fullStoryDependencyIds = (variantId) => [...UPSTREAM_IDS, "themeVariants", `variant:${variantId}`];

// ---------------------------------------------------------------- 参数

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const DRY_RUN = flag("--dry-run");
const FRESH = flag("--fresh");
const RERUN = flag("--rerun");
const EXCLUDE = option("--exclude", "").split(",").map((item) => item.trim()).filter(Boolean);
const ONLY = option("--only", "");
const CONCURRENCY = Math.max(1, Number(option("--concurrency", "2")) || 2);

// ---------------------------------------------------------------- 本机 HTTP（不设超时：评审一次就要几分钟）

function requestJson(method, route, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(route, BASE);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(url, {
      method,
      headers: payload ? { "content-type": "application/json", "content-length": payload.length } : {}
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          data = { ok: false, error: text.slice(0, 500) };
        }
        if (res.statusCode >= 400 || !data.ok) {
          const message = typeof data.error === "string" ? data.error : JSON.stringify(data.error || data).slice(0, 500);
          const error = new Error(`${route} ${res.statusCode}：${message}`);
          error.status = res.statusCode;
          error.code = data.code || data.error?.code || "";
          error.data = data;
          reject(error);
          return;
        }
        resolve(data);
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round2 = (value) => Math.round(Number(value || 0) * 100) / 100;
const lineageRef = (lineage) => ({
  artifactId: lineage.artifactId,
  revision: lineage.revision,
  contentDigest: lineage.contentDigest
});
const safeFileName = (name) => String(name || "未命名").replace(/[\\/:*?"<>|\n\r\t]/gu, "_").trim().slice(0, 80);

// ---------------------------------------------------------------- 素材准备（复刻浏览器 sampleVideo）

function probeVideo(file) {
  const out = execFileSync("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height:format=duration",
    "-of", "json", file
  ], { encoding: "utf8" });
  const data = JSON.parse(out);
  const stream = data.streams?.[0] || {};
  const duration = Number(data.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`读不出视频时长：${file}`);
  return { duration, width: Number(stream.width), height: Number(stream.height) };
}

function sampleFrames(file, { duration, width, height }) {
  const count = Math.max(6, Math.min(10, Math.ceil(duration / 4)));
  const scale = Math.min(1, 720 / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const frames = [];
  for (let index = 0; index < count; index += 1) {
    const ratio = count === 1 ? 0.5 : 0.03 + (0.94 * index / (count - 1));
    const timestamp = Math.min(duration - 0.02, Math.max(0, duration * ratio));
    const jpeg = execFileSync("ffmpeg", [
      "-v", "error", "-ss", timestamp.toFixed(2), "-i", file,
      "-frames:v", "1", "-vf", `scale=${w}:${h}`, "-q:v", "5", "-f", "image2pipe", "-c:v", "mjpeg", "pipe:1"
    ], { maxBuffer: 32 * 1024 * 1024 });
    frames.push({ timestamp: Number(timestamp.toFixed(2)), dataUrl: `data:image/jpeg;base64,${jpeg.toString("base64")}` });
  }
  return frames;
}

function readTranscript(file) {
  return execFileSync("textutil", ["-convert", "txt", "-stdout", file], { encoding: "utf8" })
    .replace(/\r\n?/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function prepareSource(entry, health) {
  const videoPath = path.join(VIDEO_DIR, entry.video);
  const transcriptPath = path.join(VIDEO_DIR, entry.transcript);
  for (const file of [videoPath, transcriptPath]) {
    if (!fs.existsSync(file)) throw new Error(`找不到文件：${file}`);
  }
  const bytes = fs.readFileSync(videoPath);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const probe = probeVideo(videoPath);
  const frames = sampleFrames(videoPath, probe);
  const metadata = {
    name: entry.video,
    size: bytes.length,
    type: "video/mp4",
    duration: probe.duration,
    width: probe.width,
    height: probe.height
  };
  // 与页面同一条规则：媒体模式不是 frames、且文件不超过服务端上限，才送原生视频。
  const sendNativeVideo = health.mediaMode !== "frames" && bytes.length <= Number(health.nativeVideoMaxBytes || 0);
  const video = sendNativeVideo
    ? { dataUrl: `data:video/mp4;base64,${bytes.toString("base64")}`, mimeType: "video/mp4", size: bytes.length }
    : null;
  return { videoPath, transcriptPath, digest, metadata, frames, video, transcript: readTranscript(transcriptPath) };
}

// ---------------------------------------------------------------- 单个视频

function createContext(entry) {
  const logFile = path.join(OUTPUT_DIR, "logs", `${safeFileName(entry.label)}.log`);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const ctx = {
    entry,
    projectId: "",
    runId: "",
    calls: [],
    tasks: [],
    notes: [],
    costCny: 0,
    // 续跑时 costCny 从上一次的花费接着累加；这里记下起点，汇总时才能分出「这次新花的」。
    resumedFromCny: 0,
    log(message) {
      const line = `[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}] [${entry.label}] ${message}`;
      console.log(line);
      fs.appendFileSync(logFile, `${line}\n`);
    }
  };
  return ctx;
}

// 失败响应上的 usage 也是真实花掉的钱，与页面 api() 同样先记账再判成败。
function addUsage(ctx, label, usage) {
  if (!usage) return;
  const cost = Number(usage.costCny);
  if (Number.isFinite(cost)) ctx.costCny += cost;
  const last = ctx.calls.at(-1);
  if (last && last.label === label) last.usage = usage;
}

async function loadRun(ctx) {
  const data = await requestJson("POST", "/api/production/run/load", { projectId: ctx.projectId, runId: ctx.runId });
  return data.result;
}

const content = (run, artifactId) => run.latestArtifacts?.[artifactId]?.content ?? null;
const lineage = (run, artifactId) => run.latestArtifacts?.[artifactId]?.lineage ?? null;

async function commitArtifact(ctx, run, { artifactId, artifactType, value, dependencyIds }) {
  const dependencies = dependencyIds.map((id) => {
    const entry = lineage(run, id);
    if (!entry || entry.status !== "current") throw new Error(`上游 ${id} 不是 current，不能提交 ${artifactId}`);
    return lineageRef(entry);
  });
  const data = await requestJson("POST", "/api/production/artifact/commit", {
    projectId: ctx.projectId,
    runId: ctx.runId,
    artifactId,
    requestId: `batch-${randomUUID()}`,
    expectedCurrentRevision: lineage(run, artifactId)?.revision || null,
    artifactType,
    content: value,
    dependencies,
    createMediaNamespace: false
  });
  ctx.log(`已提交 ${artifactId} → ${data.result.lineage.revision}${data.result.staleArtifactIds?.length ? `（失效：${data.result.staleArtifactIds.join("、")}）` : ""}`);
  return data.result;
}

async function createTask(ctx, kind, input) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const data = await requestJson("POST", "/api/tasks/create", { projectId: ctx.projectId, runId: ctx.runId, kind, input });
      return data.task;
    } catch (error) {
      if (error.code === "TASK_CAPACITY_EXCEEDED" && attempt < 120) {
        if (attempt === 1) ctx.log(`任务池已满，等待空位后再建 ${kind} 任务…`);
        await sleep(30_000);
        continue;
      }
      throw error;
    }
  }
}

async function waitTask(ctx, task) {
  const query = new URLSearchParams({ projectId: ctx.projectId, runId: ctx.runId }).toString();
  let last = "";
  for (;;) {
    const data = await requestJson("GET", `/api/tasks/${encodeURIComponent(task.taskId)}?${query}`);
    const current = data.task;
    const stage = current.progress?.currentStage;
    const marker = stage
      ? `${current.status} · ${stage}（${current.progress.completedStages ?? "?"}/${current.progress.totalStages ?? "?"}）`
      : current.status;
    if (marker !== last) {
      ctx.log(`  ${current.kind}：${marker}`);
      last = marker;
    }
    if (TERMINAL_TASK_STATUSES.has(current.status)) return current;
    await sleep(5_000);
  }
}

// 失败的任务再建一次就是「从第一个没完成的阶段续跑」：已提交的 current Artifact 服务端会直接复用，
// 与页面上点「重试」相同。单个阶段是一次调用、校验不过即失败（实测：分析阶段在只送原生视频时
// 引用了关键帧证据；角色边界把固定搭档也写进 characterName，而校验只认固定角色一个名字），
// 所以这里给几次续跑机会，每次只重跑失败的那一阶段。
async function runTask(ctx, kind, input, label, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const started = Date.now();
    const created = await createTask(ctx, kind, input);
    const done = await waitTask(ctx, created);
    const cost = Number(done.usage?.costCny);
    if (Number.isFinite(cost)) ctx.costCny += cost;
    ctx.tasks.push({
      label, kind, attempt, taskId: done.taskId, status: done.status,
      seconds: Math.round((Date.now() - started) / 1000),
      error: done.error || null, usage: done.usage || null
    });
    if (done.status === "completed") return done;
    ctx.log(`${label} 第 ${attempt} 次结束于 ${done.status}：${done.error?.message || done.error?.code || ""}`);
  }
  throw new Error(`${label} 重试 ${maxAttempts} 次仍未完成`);
}

// 评审类接口只出报告、不建任务。失败时和页面上再点一次一样：整次重来，最多 attempts 次。
async function callReport(ctx, label, route, body, attempts = 2) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const started = Date.now();
    ctx.log(`${label}…`);
    try {
      const data = await requestJson("POST", route, body);
      ctx.calls.push({ label, attempt, ok: true, seconds: Math.round((Date.now() - started) / 1000), metadata: data.result?.metadata || null });
      addUsage(ctx, label, data.usage);
      return data.result;
    } catch (error) {
      ctx.calls.push({
        label, attempt, ok: false, seconds: Math.round((Date.now() - started) / 1000),
        error: String(error.message).slice(0, 800), code: error.code || ""
      });
      addUsage(ctx, label, error.data?.usage);
      ctx.log(`${label} 第 ${attempt} 次失败：${String(error.message).slice(0, 200)}`);
      if (attempt === attempts) throw error;
    }
  }
  return null;
}

// ---------------------------------------------------------------- 续跑：每个视频的记录就是它的状态
//
// 记录里写着已经做完的每一步（候选评审与选中、展开前体检与修订、修改前的剧情、剧情体检、按问题修改）。
// 再跑同一个视频时，只要记录里的 Run 还在、且源视频 SHA-256、创作设定、字幕都与这次一致，
// 就从第一个没做完的步骤接着做——已经付过钱的步骤不重跑。中途被打断（供应商欠费、传输中断、
// 手动停止）也一样：每做完一步就写一次进度文件（.进度/<视频>.json）。

const readIndex = () => {
  const file = path.join(OUTPUT_DIR, "目录.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
};
const progressFileFor = (entry) => path.join(OUTPUT_DIR, ".进度", `${safeFileName(entry.label)}.json`);
const failureFileFor = (entry) => path.join(OUTPUT_DIR, `失败-${safeFileName(entry.label)}-记录.json`);

function saveProgress(entry, record) {
  const file = progressFileFor(entry);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(record, null, 2));
}

// 剧情体检与按问题修改都做了（或体检没有可修条目），这个视频才算做完。
const stepsComplete = (record) => Boolean(record?.剧情体检?.review && record?.按问题修改 && !record.按问题修改.失败);
const firstIncompleteStep = (record) => {
  if (!record?.完整剧情_修改前) return "完整剧情";
  if (!record?.剧情体检?.review) return "剧情体检";
  if (!record?.按问题修改 || record.按问题修改.失败) return "按问题修改";
  return "";
};
function isComplete(record) {
  return stepsComplete(record)
    && Boolean(record?.测试包文件 && fs.existsSync(path.join(OUTPUT_DIR, record.测试包文件)));
}

// 一份记录做到了哪一步：步骤越靠后分越高。
const progressRank = (record) => (record?.剧情体检?.review ? 16 : 0) + (record?.完整剧情_修改前 ? 8 : 0)
  + (record?.候选对照评审?.选中 ? 4 : 0) + (record?.主题候选_原始 ? 2 : 0) + (record?.Run?.runId ? 1 : 0);

// 这个视频上一次留下的记录。进度文件、失败记录、各份「评审与修订记录」都可能有它，
// 取**做得最靠后**的那一份——不能只信目录：批量被中途停掉时目录还没来得及写，
// 而一次失败的新 Run 也不能盖过另一个已经做到剧情体检的旧 Run。
function readPreviousRecord(entry) {
  const files = new Set([progressFileFor(entry), failureFileFor(entry)]);
  const row = readIndex().find((item) => item.参考视频 === entry.video);
  if (row?.记录) files.add(path.join(OUTPUT_DIR, row.记录));
  if (fs.existsSync(OUTPUT_DIR)) {
    for (const name of fs.readdirSync(OUTPUT_DIR)) {
      if (name.endsWith("-评审与修订记录.json")) files.add(path.join(OUTPUT_DIR, name));
    }
  }
  let best = null;
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    let record;
    try {
      record = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    if (record?.参考视频?.文件 !== entry.video) continue;
    const rank = progressRank(record);
    const time = String(record.结束时间 || record.开始时间 || "");
    if (!best || rank > best.rank || (rank === best.rank && time > best.time)) best = { record, rank, time };
  }
  return best?.record || null;
}

// 上一次的 Run 还在，且服务端那个 Run 的源视频 SHA-256、创作设定、字幕都与这次一致，才续用；
// 任何一项对不上都新建 Run，不猜。
async function resumableRecord(entry, source, creatorProfile) {
  const previous = readPreviousRecord(entry);
  const run = previous?.Run;
  if (!run?.projectId || !run?.runId) return null;
  try {
    const data = await requestJson("POST", "/api/production/run/load", {
      projectId: run.projectId, runId: run.runId, includeContent: false
    });
    const metadata = data.result?.metadata || {};
    const same = metadata.sourceVideoDigest === source.digest
      && JSON.stringify(metadata.creatorProfile) === JSON.stringify(creatorProfile)
      && metadata.transcript === source.transcript;
    return same ? previous : null;
  } catch {
    return null;
  }
}

function candidateScoreTable(review, themeVariants) {
  const titles = new Map((themeVariants?.variants || []).map((variant) => [variant.id, variant.title]));
  return (review?.candidateChecks || []).map((check) => ({
    id: check.candidateId,
    title: titles.get(check.candidateId) || check.title,
    overallScore: check.overallScore,
    tier: check.tier?.label || check.tier,
    effectiveVerdict: check.effectiveVerdict,
    verdictOverrideReasons: check.verdictOverrideReasons || [],
    dominantDefect: check.dominantDefect || null
  }));
}

const sameCurrent = (run, artifactId, value) => lineage(run, artifactId)?.status === "current"
  && JSON.stringify(content(run, artifactId)) === JSON.stringify(value);

async function runOne(entry, shared) {
  const ctx = createContext(entry);
  const startedAt = new Date();
  let record = {
    说明: "参考视频批量真实回放：上传参考视频 → AI 导演五阶段 → 候选对照评审选高分候选 → 展开前体检（需修订则采纳修订）"
      + " → 完整剧情 → 剧情体检 → 按问题修改（勾选全部可修条目并采纳）→ 封成测试包。"
      + "页面上刷新即失的评审报告与修订稿都在这里；测试包见同目录同名文件。",
    参考视频: { 文件: entry.video, 字幕文件: entry.transcript },
    创作设定来源: PROFILE_PACKAGE,
    开始时间: startedAt.toISOString()
  };
  const save = () => {
    Object.assign(record, { 调用记录: ctx.calls, 任务记录: ctx.tasks, 花费约元: round2(ctx.costCny) });
    saveProgress(entry, record);
  };
  try {
    const source = prepareSource(entry, shared.health);
    Object.assign(record.参考视频, {
      sha256: source.digest,
      时长秒: round2(source.metadata.duration),
      分辨率: `${source.metadata.width}×${source.metadata.height}`,
      大小字节: source.metadata.size,
      抽帧数: source.frames.length,
      送原生视频: Boolean(source.video),
      字幕字数: source.transcript.length
    });
    ctx.log(`素材就绪：${source.frames.length} 帧，${source.video ? "送原生视频" : "只送关键帧（超过原生视频上限）"}，字幕 ${source.transcript.length} 字`);
    if (DRY_RUN) return { entry, ok: true, dryRun: true, record };

    const creatorProfile = shared.creatorProfile;
    const targetDurationSeconds = resolveStoryDurationTarget(STORY_DURATION_SOURCE, { metadata: source.metadata });

    // 0. Run：能续用上一次的就续用（见上面「续跑」一节），否则新建。新建的 Run 不绑定浏览器工作区，
    //    所以不会被自动清理。
    const previous = (FRESH || RERUN) ? null : await resumableRecord(entry, source, creatorProfile);
    if (previous) {
      record = { ...previous, 参考视频: { ...previous.参考视频, ...record.参考视频 } };
      delete record.失败;
      record.续跑 = [...(previous.续跑 || []), startedAt.toISOString()];
      ctx.calls.push(...(previous.调用记录 || []));
      ctx.tasks.push(...(previous.任务记录 || []));
      ctx.costCny = Number(previous.花费约元) || 0;
      ctx.resumedFromCny = ctx.costCny;
      ctx.projectId = previous.Run.projectId;
      ctx.runId = previous.Run.runId;
      ctx.log(`接着上一次的 Run 续跑：${ctx.projectId}/${ctx.runId}，从第一个没做完的步骤接着做`);
    } else {
      const started = await requestJson("POST", "/api/production/run/start", {
        metadata: {
          sourceVideo: { ...source.metadata, digest: source.digest },
          sourceVideoDigest: source.digest,
          creatorProfile,
          transcript: source.transcript
        }
      });
      ctx.projectId = started.result.projectId;
      ctx.runId = started.result.runId;
      record.Run = { projectId: ctx.projectId, runId: ctx.runId };
      ctx.log(`Run 已建：${ctx.projectId}/${ctx.runId}`);
    }
    record.时长目标秒 = targetDurationSeconds;
    save();

    // 1. AI 导演五阶段（与页面 runWorkflow() 送的是同一组字段）。五份都已 current 就不建任务。
    let run = await loadRun(ctx);
    if ([...UPSTREAM_IDS, "themeVariants"].every((id) => lineage(run, id)?.status === "current")) {
      ctx.log("五阶段已完成，跳过");
    } else {
      await runTask(ctx, "directorPipeline", {
        frames: source.frames,
        ...(source.video ? { video: source.video } : {}),
        metadata: source.metadata,
        transcript: source.transcript,
        creatorProfile,
        count: VARIANT_COUNT,
        targetDurationSeconds,
        sourceVideoDigest: source.digest
      }, "AI 导演五阶段", 4);
      run = await loadRun(ctx);
    }
    const upstream = () => Object.fromEntries(UPSTREAM_IDS.map((id) => [id, content(run, id)]));
    record.主题候选_原始 ??= content(run, "themeVariants");
    save();

    // 2. 候选对照评审 → 选加权分最高的候选
    if (record.候选对照评审?.选中) {
      ctx.log(`候选对照评审已完成（选中 ${record.候选对照评审.选中}），跳过`);
    } else {
      const reviewed = content(run, "themeVariants");
      const candidateReview = await callReport(ctx, "候选对照评审", "/api/story-candidate-review", {
        themeVariants: reviewed,
        sourceScriptReconstruction: content(run, "sourceScriptReconstruction"),
        visualGuardrails: content(run, "visualGuardrails"),
        creatorProfile,
        creativeBrief: content(run, "creativeBrief"),
        referenceAnalysis: content(run, "referenceAnalysis")
      }, 3);
      const review = candidateReview.review;
      const chosen = review.recommendedWinner || review.scoreOrder?.[0];
      if (!chosen) throw new Error("候选对照评审没有给出任何可选候选");
      record.候选对照评审 = {
        各候选得分: candidateScoreTable(review, reviewed),
        scoreOrder: review.scoreOrder,
        recommendedWinner: review.recommendedWinner,
        选中: chosen,
        选中理由: review.recommendedWinner
          ? "加权分最高（scoreOrder 第一名，即服务端派生的 recommendedWinner）"
          : "全部候选都被判淘汰，recommendedWinner 为空；仍按加权分取最高的一个",
        报告: review,
        metadata: candidateReview.metadata || null
      };
      ctx.log(`选中 ${chosen}（${candidateScoreTable(review, reviewed).map((row) => `${row.id} ${row.overallScore}`).join("、")}）`);
      save();
    }
    const variantId = record.候选对照评审.选中;

    // 3. 选中候选：提交 variant:<id>（与页面 ensureSelectedVariantArtifact() 相同）；已是 current 同内容就不重复提交
    let variant = content(run, "themeVariants").variants.find((item) => item.id === variantId);
    if (!variant) throw new Error(`当前主题候选里没有 ${variantId}`);
    if (!sameCurrent(run, `variant:${variantId}`, variant)) {
      await commitArtifact(ctx, run, { artifactId: `variant:${variantId}`, artifactType: "selectedVariant", value: variant, dependencyIds: ["themeVariants"] });
      run = await loadRun(ctx);
    }

    // 4. 展开前体检；判「需修订」就按体检修订候选并采纳（页面上的「采纳修订并展开」）。剧情已经展开过就不再体检。
    if (!record.完整剧情_修改前) {
      if (!record.展开前体检?.route) {
        try {
          const precheck = await callReport(ctx, "展开前体检", "/api/full-story-precheck", {
            themeVariants: content(run, "themeVariants"),
            candidateId: variantId,
            creatorProfile,
            ...upstream()
          });
          record.展开前体检 = { route: precheck.route, reasons: precheck.reasons, review: precheck.review, promiseCheck: precheck.promiseCheck, metadata: precheck.metadata };
          ctx.log(`展开前体检：${precheck.route}${precheck.reasons?.length ? `（${precheck.reasons.join("、")}）` : ""}`);
        } catch (error) {
          record.展开前体检 = { 失败: String(error.message).slice(0, 800), 处理: "按原候选展开（页面上的「按原候选展开」）" };
        }
        save();
      }
      if (record.展开前体检?.route === "revise" && !record.展开前修订?.已采纳) {
        try {
          const revision = await callReport(ctx, "展开前修订", "/api/story-candidate-revision", {
            themeVariants: content(run, "themeVariants"),
            review: record.展开前体检.review,
            promiseCheck: record.展开前体检.promiseCheck,
            candidateId: variantId,
            scope: "root",
            creatorProfile,
            ...upstream(),
            targetDurationSeconds
          });
          const before = content(run, "themeVariants").variants.find((item) => item.id === variantId);
          await commitArtifact(ctx, run, {
            artifactId: "themeVariants", artifactType: "themeVariants", value: revision.themeVariants, dependencyIds: UPSTREAM_IDS
          });
          run = await loadRun(ctx);
          variant = content(run, "themeVariants").variants.find((item) => item.id === variantId);
          await commitArtifact(ctx, run, { artifactId: `variant:${variantId}`, artifactType: "selectedVariant", value: variant, dependencyIds: ["themeVariants"] });
          run = await loadRun(ctx);
          record.展开前修订 = {
            已采纳: true,
            修订说明: revision.revision?.changeSummary ?? null,
            修订: revision.revision,
            修订前候选: before,
            修订后候选: variant,
            metadata: revision.metadata || null
          };
        } catch (error) {
          record.展开前修订 = { 已采纳: false, 失败: String(error.message).slice(0, 800), 处理: "按原候选展开" };
        }
        save();
      }
    }

    // 5. 完整剧情（与页面 generateFullStory() 送的是同一组字段）。已经生成过、且那一版仍是 current 就沿用。
    const storyId = `fullStory:${variantId}`;
    if (record.完整剧情_修改前 && lineage(run, storyId)?.status === "current") {
      ctx.log(`完整剧情已生成（《${record.完整剧情_修改前.title}》），跳过`);
    } else {
      await runTask(ctx, "fullStory", {
        ...upstream(),
        themeVariants: content(run, "themeVariants"),
        variant,
        candidateBinding: lineageRef(lineage(run, `variant:${variantId}`)),
        creatorProfile,
        targetDurationSeconds,
        variantId
      }, "完整剧情");
      run = await loadRun(ctx);
      record.完整剧情_修改前 = content(run, storyId);
      // 新剧情让针对旧剧情的体检与修改一并作废。
      delete record.剧情体检;
      delete record.按问题修改;
      ctx.log(`完整剧情：《${record.完整剧情_修改前.title}》${record.完整剧情_修改前.targetDurationSeconds} 秒，${record.完整剧情_修改前.sceneScript?.length || 0} 场`);
      save();
    }
    const originalStory = record.完整剧情_修改前;

    // 6. 剧情体检
    if (!record.剧情体检?.review) {
      try {
        const storyReview = await callReport(ctx, "剧情体检", "/api/story-quality-review", {
          fullStory: originalStory,
          themeVariants: content(run, "themeVariants"),
          candidateId: variantId,
          creatorProfile
        });
        record.剧情体检 = { review: storyReview.review, metadata: storyReview.metadata || null };
        ctx.log(`剧情体检：${(storyReview.review.issues || []).length} 条编辑诊断，承诺核对 ${storyReview.review.promisePreservation?.status || "?"}`);
      } catch (error) {
        record.剧情体检 = { 失败: String(error.message).slice(0, 800) };
      }
      save();
    }

    // 7. 按问题修改（勾选全部可修条目，页面默认也是全选）并采纳
    if (record.剧情体检?.review && (!record.按问题修改 || record.按问题修改.失败)) {
      const items = storyQualityRepairableItems(record.剧情体检.review);
      if (!items.length) {
        record.按问题修改 = { 跳过: "体检没有可修的条目" };
      } else {
        try {
          const repair = await callReport(ctx, "按问题修改", "/api/story-quality-repair", {
            fullStory: originalStory,
            review: record.剧情体检.review,
            selectedRefs: items.map((item) => item.ref),
            themeVariants: content(run, "themeVariants"),
            creatorProfile,
            ...upstream()
          });
          const applied = (repair.results || []).filter((row) => row.status === "applied").length;
          if (repair.changed) {
            await commitArtifact(ctx, run, {
              artifactId: storyId, artifactType: "fullStory", value: repair.fullStory, dependencyIds: fullStoryDependencyIds(variantId)
            });
            run = await loadRun(ctx);
          }
          record.按问题修改 = { 勾选: items.map((item) => item.ref), changed: repair.changed, 已采纳条数: applied, results: repair.results, metadata: repair.metadata || null };
          ctx.log(`按问题修改：勾选 ${items.length} 条，采纳 ${applied} 条`);
        } catch (error) {
          record.按问题修改 = { 失败: String(error.message).slice(0, 800), 处理: "保留体检前的剧情" };
        }
      }
      save();
    }

    // 8. 封成测试包（与页面 selectedStoryPackage() 同一组字段、同一个顺序）。没做完也封：包里是当前那一版剧情。
    const finalStory = content(run, storyId);
    const payload = {
      packageType: "story-production-test-package",
      packageVersion: "3.0",
      exportedAt: new Date().toISOString(),
      mode: shared.health.mode,
      modelInfo: shared.modelInfo,
      sourceVideo: { ...source.metadata, digest: source.digest },
      creatorProfile,
      referenceAnalysis: content(run, "referenceAnalysis"),
      sourceScriptReconstruction: content(run, "sourceScriptReconstruction"),
      selectedVariant: content(run, `variant:${variantId}`),
      themeVariants: content(run, "themeVariants"),
      creativeBrief: content(run, "creativeBrief"),
      visualGuardrails: content(run, "visualGuardrails"),
      fullStory: finalStory,
      animationPlan: null,
      shotFrameResults: {},
      shotVideoResults: {}
    };
    const sealed = (await requestJson("POST", "/api/production/package/seal", { projectId: ctx.projectId, runId: ctx.runId, payload })).result;

    // 同一个视频续跑时沿用上一次的文件名；只有不同视频撞了标题才加视频名区分。
    const title = safeFileName(finalStory.title || entry.label);
    const baseName = record.测试包文件
      ? record.测试包文件.replace(/\.json$/u, "")
      : shared.usedTitles.has(title) || fs.existsSync(path.join(OUTPUT_DIR, `${title}.json`))
        ? `${title}（${safeFileName(entry.label)}）`
        : title;
    shared.usedTitles.add(title);
    const packageFile = `${baseName}.json`;
    const reportFile = `${baseName}-评审与修订记录.json`;
    fs.writeFileSync(path.join(OUTPUT_DIR, packageFile), JSON.stringify(sealed, null, 2));
    const complete = stepsComplete(record);
    Object.assign(record, {
      最终剧情版本: lineage(run, storyId),
      测试包文件: packageFile,
      ...(complete ? {} : { 未完成步骤: firstIncompleteStep(record) }),
      结束时间: new Date().toISOString(),
      用时分钟: round2((Date.now() - startedAt.getTime()) / 60_000)
    });
    if (complete) delete record.未完成步骤;
    save();
    fs.writeFileSync(path.join(OUTPUT_DIR, reportFile), JSON.stringify(record, null, 2));
    fs.rmSync(failureFileFor(entry), { force: true });
    if (complete) fs.rmSync(progressFileFor(entry), { force: true });
    ctx.log(complete
      ? `完成：${packageFile}（累计约 ¥${round2(ctx.costCny)}）`
      : `已封包但「${record.未完成步骤}」没做成：${packageFile}（累计约 ¥${round2(ctx.costCny)}；再跑一次会只补这一步）`);
    return {
      entry, ok: complete, title: finalStory.title, variantId, packageFile, reportFile,
      incompleteStep: complete ? "" : record.未完成步骤,
      precheckRoute: record.展开前体检?.route || (record.展开前体检?.失败 ? "失败" : null),
      revised: Boolean(record.展开前修订?.已采纳),
      repairApplied: record.按问题修改?.已采纳条数 ?? 0, costCny: round2(ctx.costCny),
      newCostCny: round2(ctx.costCny - ctx.resumedFromCny), minutes: record.用时分钟,
      projectId: ctx.projectId, runId: ctx.runId
    };
  } catch (error) {
    Object.assign(record, {
      失败: String(error?.stack || error).slice(0, 2000),
      Run: ctx.projectId ? { projectId: ctx.projectId, runId: ctx.runId } : null,
      结束时间: new Date().toISOString()
    });
    save();
    const reportFile = path.basename(failureFileFor(entry));
    fs.writeFileSync(failureFileFor(entry), JSON.stringify(record, null, 2));
    ctx.log(`失败：${String(error?.message || error).slice(0, 300)}`);
    return {
      entry, ok: false, error: String(error?.message || error).slice(0, 500), reportFile,
      costCny: round2(ctx.costCny), newCostCny: round2(ctx.costCny - ctx.resumedFromCny),
      projectId: ctx.projectId, runId: ctx.runId
    };
  }
}

// ---------------------------------------------------------------- 主流程

const matches = (entry, text) => entry.label.includes(text) || entry.video.includes(text);
// 已经做完的视频（记录里剧情体检与按问题修改都做了、测试包文件还在）默认跳过：每跑一个视频要花
// 几块钱，重跑必须是显式决定。没做完的会从第一个未完成步骤续跑。
const alreadyDone = (entry) => isComplete(readPreviousRecord(entry));
const selected = VIDEOS.filter((entry) => (!ONLY || matches(entry, ONLY))
  && !EXCLUDE.some((text) => matches(entry, text))
  && (RERUN || DRY_RUN || !alreadyDone(entry)));
const skippedDone = VIDEOS.filter((entry) => !RERUN && !DRY_RUN && alreadyDone(entry)
  && (!ONLY || matches(entry, ONLY)));
if (skippedDone.length) console.log(`已经成功、跳过（要重跑加 --rerun）：${skippedDone.map((entry) => entry.label).join("、")}`);
if (!selected.length) {
  console.error(`没有要跑的视频。可选：${VIDEOS.map((entry) => entry.label).join("、")}`);
  process.exit(2);
}
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const health = await requestJson("GET", "/api/health");
if (health.mode !== "live" && !DRY_RUN) {
  console.error(`开发服务器处于 ${health.mode} 模式，不是 live：结果不会有任何参考价值，停止。`);
  process.exit(2);
}
const profilePackage = JSON.parse(fs.readFileSync(PROFILE_PACKAGE, "utf8"));
const shared = {
  health,
  creatorProfile: structuredClone(profilePackage.creatorProfile),
  modelInfo: {
    stages: health.modelStages,
    overrides: {},
    analysisProvider: health.analysisProvider,
    analysisModel: health.analysisModel,
    storyProvider: health.storyProvider,
    storyModel: health.storyModel,
    animationProvider: health.animationProvider,
    animationModel: health.animationModel,
    staticFrameCompilerProvider: health.modelStages?.staticFrameCompiler?.provider,
    staticFrameCompilerModel: health.modelStages?.staticFrameCompiler?.model
  },
  usedTitles: new Set()
};
// 用来跑出这批结果的脚本原样复制一份放在结果旁边，数据与生成它的代码不会对不上。
fs.copyFileSync(SCRIPT_PATH, path.join(OUTPUT_DIR, path.basename(SCRIPT_PATH)));

console.log(`开发服务器：${BASE}（${health.mode}，原生视频上限 ${health.nativeVideoMaxBytes} 字节）`);
console.log(`创作设定：${PROFILE_PACKAGE}；候选 ${VARIANT_COUNT} 个；时长与原片对齐`);
console.log(`视频 ${selected.length} 个，并发 ${CONCURRENCY}${DRY_RUN ? "（空跑，不调模型）" : ""}；结果目录：${OUTPUT_DIR}`);

const order = new Map(VIDEOS.map((entry, index) => [entry.label, index]));
const indexFile = path.join(OUTPUT_DIR, DRY_RUN ? "目录-空跑.json" : "目录.json");
const indexRow = (result) => ({
  参考视频: result.entry.video,
  ok: result.ok,
  ...(result.dryRun ? { 空跑: true } : {}),
  剧情标题: result.title || null,
  选中候选: result.variantId || null,
  展开前体检: result.precheckRoute || null,
  采纳了展开前修订: result.revised ?? null,
  采纳的修改条数: result.repairApplied ?? null,
  测试包: result.packageFile || null,
  记录: result.reportFile || null,
  花费约元: result.costCny ?? 0,
  用时分钟: result.minutes ?? null,
  Run: result.projectId ? `${result.projectId}/${result.runId}` : null,
  ...(result.incompleteStep ? { 未完成步骤: result.incompleteStep } : {}),
  ...(result.ok || result.incompleteStep ? {} : { 失败: result.error || null })
});
// 每个视频一结束就更新目录，批量被中途停掉也不会丢登记。
function recordInIndex(result) {
  const rows = DRY_RUN
    ? (fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, "utf8")) : [])
    : readIndex();
  const merged = [...rows.filter((row) => row.参考视频 !== result.entry.video), indexRow(result)];
  merged.sort((a, b) => order.get(VIDEOS.find((entry) => entry.video === a.参考视频)?.label)
    - order.get(VIDEOS.find((entry) => entry.video === b.参考视频)?.label));
  fs.writeFileSync(indexFile, JSON.stringify(merged, null, 2));
}

const results = [];
let next = 0;
async function worker() {
  while (next < selected.length) {
    const entry = selected[next++];
    const result = await runOne(entry, shared);
    results.push(result);
    recordInIndex(result);
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, selected.length) }, worker));

// 续跑的视频花费是从上一次接着累加的，所以两个数分开报：只报合计会把之前几次运行花的钱算成「这次」。
const total = results.reduce((sum, result) => sum + (result.costCny || 0), 0);
const newTotal = results.reduce((sum, result) => sum + (result.newCostCny || 0), 0);
const done = results.filter((result) => result.ok).length;
const partial = results.filter((result) => !result.ok && result.incompleteStep).length;
const costText = round2(total) === round2(newTotal)
  ? `这次花费约 ¥${round2(newTotal)}`
  : `这次新花约 ¥${round2(newTotal)}；连同之前几次运行，这几个视频累计约 ¥${round2(total)}`;
console.log(`\n全部结束：做完 ${done}/${results.length}${partial ? `，已封包但有步骤没做成 ${partial}` : ""}，${costText}。目录：${indexFile}`);
