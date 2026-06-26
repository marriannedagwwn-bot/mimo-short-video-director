#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const options = parseArgs(process.argv.slice(2));

if (options.help || !options.request || !options.output) {
  console.log(`用法：
  node workers/local-postprocess-worker.mjs --request <request.json> --output <target-file> --receipt <receipt.json> --root <production-root>

用途：
  本地处理视频生产后半段：
  - video_quality_review：基础文件/占位产物检查，输出 JSON 质检结果
  - video_assembly：用 ffmpeg 按 request.inputArtifacts 顺序合成最终视频

环境变量：
  LOCAL_POSTPROCESS_FFMPEG=ffmpeg
  LOCAL_POSTPROCESS_REENCODE=1  # 可选，使用重编码而非 -c copy`);
  process.exit(options.help ? 0 : 1);
}

try {
  const request = JSON.parse(await fs.readFile(options.request, "utf8"));
  const result = await executeRequest(request, options);
  if (options.receipt) {
    await fs.mkdir(path.dirname(path.resolve(options.receipt)), { recursive: true });
    await fs.writeFile(options.receipt, `${JSON.stringify(result, null, 2)}\n`);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

async function executeRequest(request, options) {
  if (request.capability === "video_quality_review") return reviewVideo(request, options);
  if (request.capability === "video_assembly") return assembleVideo(request, options);
  throw new Error(`local-postprocess-worker 不支持 ${request.capability || "unknown"}；请只用 --capability video_quality_review / video_assembly 调用。`);
}

async function reviewVideo(request, options) {
  const inputs = request.inputArtifacts || [];
  const checks = [];
  for (const artifact of inputs) {
    const stat = await fileStat(artifact.path);
    const sample = stat.exists ? await readFilePrefix(artifact.path) : "";
    const mockLike = /^\s*MOCK ARTIFACT:/u.test(sample) || /^\s*PLACEHOLDER ARTIFACT:/u.test(sample);
    checks.push({
      outputKey: artifact.outputKey || "",
      path: artifact.path || "",
      exists: stat.exists,
      size: stat.size,
      mockLike,
      passed: stat.exists && stat.size > 0 && !mockLike
    });
  }
  const passed = checks.length > 0 && checks.every((check) => check.passed);
  const review = {
    provider: "local-postprocess-worker",
    taskId: request.taskId,
    capability: request.capability,
    passed,
    checks,
    acceptanceCriteria: request.acceptanceCriteria || [],
    reviewedAt: new Date().toISOString()
  };
  if (!passed) throw new Error(`本地质检未通过：${checks.filter((check) => !check.passed).map((check) => check.outputKey || check.path).join(" / ")}`);
  await fs.mkdir(path.dirname(path.resolve(options.output)), { recursive: true });
  await fs.writeFile(options.output, `${JSON.stringify(review, null, 2)}\n`);
  return receiptFor(request, options, { resultKind: "quality_review", passed });
}

async function assembleVideo(request, options) {
  const videoInputs = (request.inputArtifacts || []).filter((artifact) => isVideoArtifact(artifact));
  if (!videoInputs.length) throw new Error("最终剪辑缺少视频输入。");
  for (const artifact of videoInputs) {
    const stat = await fileStat(artifact.path);
    if (!stat.exists || stat.size <= 0) throw new Error(`视频输入不存在或为空：${artifact.path}`);
    const sample = await readFilePrefix(artifact.path);
    if (/^\s*MOCK ARTIFACT:/u.test(sample) || /^\s*PLACEHOLDER ARTIFACT:/u.test(sample)) {
      throw new Error(`视频输入是 mock/占位产物，不能参与最终剪辑：${artifact.path}`);
    }
  }
  await fs.mkdir(path.dirname(path.resolve(options.output)), { recursive: true });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "video-assembly-"));
  const listPath = path.join(tempDir, "concat.txt");
  await fs.writeFile(listPath, videoInputs.map((artifact) => `file '${escapeConcatPath(path.resolve(artifact.path))}'`).join("\n"));
  const ffmpeg = process.env.LOCAL_POSTPROCESS_FFMPEG || "ffmpeg";
  const args = ffmpegArgs(listPath, options.output);
  try {
    await execFileAsync(ffmpeg, args, { maxBuffer: 10 * 1024 * 1024 });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
  const outputStat = await fileStat(options.output);
  if (!outputStat.exists || outputStat.size <= 0) throw new Error(`ffmpeg 没有生成最终成片：${options.output}`);
  return receiptFor(request, options, {
    resultKind: "video_assembly",
    inputCount: videoInputs.length,
    ffmpeg,
    ffmpegArgs: args
  });
}

function ffmpegArgs(listPath, outputPath) {
  const common = ["-y", "-f", "concat", "-safe", "0", "-i", listPath];
  if (process.env.LOCAL_POSTPROCESS_REENCODE === "1") {
    return [...common, "-vf", "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2", "-r", "30", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", outputPath];
  }
  return [...common, "-c", "copy", outputPath];
}

function isVideoArtifact(artifact = {}) {
  const key = artifact.outputKey || "";
  const ext = path.extname(artifact.path || "").toLowerCase();
  return key.startsWith("videos.") || [".mp4", ".mov", ".m4v", ".webm"].includes(ext);
}

function receiptFor(request, options, extra = {}) {
  return {
    provider: "local-postprocess-worker",
    taskId: request.taskId,
    capability: request.capability,
    outputKey: request.outputKey,
    outputPath: options.output,
    root: options.root || "",
    generatedAt: new Date().toISOString(),
    ...extra
  };
}

async function fileStat(filePath) {
  try {
    const stat = await fs.stat(path.resolve(filePath));
    return { exists: stat.isFile(), size: stat.isFile() ? stat.size : 0 };
  } catch {
    return { exists: false, size: 0 };
  }
}

async function readFilePrefix(filePath, maxBytes = 256) {
  let handle;
  try {
    handle = await fs.open(filePath, "r");
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return "";
  } finally {
    await handle?.close();
  }
}

function escapeConcatPath(filePath) {
  return String(filePath).replace(/'/gu, "'\\''");
}

function parseArgs(args) {
  const parsed = { request: "", output: "", receipt: "", root: "", help: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-h" || arg === "--help") parsed.help = true;
    else if (arg === "--request") parsed.request = requireValue(args, ++index, arg);
    else if (arg.startsWith("--request=")) parsed.request = arg.slice("--request=".length);
    else if (arg === "--output") parsed.output = requireValue(args, ++index, arg);
    else if (arg.startsWith("--output=")) parsed.output = arg.slice("--output=".length);
    else if (arg === "--receipt") parsed.receipt = requireValue(args, ++index, arg);
    else if (arg.startsWith("--receipt=")) parsed.receipt = arg.slice("--receipt=".length);
    else if (arg === "--root") parsed.root = requireValue(args, ++index, arg);
    else if (arg.startsWith("--root=")) parsed.root = arg.slice("--root=".length);
    else throw new Error(`未知参数：${arg}`);
  }
  return parsed;
}

function requireValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} 缺少参数`);
  return value;
}
