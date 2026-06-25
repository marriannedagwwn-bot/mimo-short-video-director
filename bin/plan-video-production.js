#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { buildArtifactsFromExistingOutputs, buildProductionRun, buildProductionWorkspaceFiles, parseQueueJsonl } from "../src/video-production-run.js";

const options = parseArgs(process.argv.slice(2));

if (options.help || !options.input) {
  console.log(`用法：
  npm run plan:video -- <queue-or-package.json|queue.jsonl> [--out production-run.json] [--root production/V1] [--workspace] [--scan-existing]

选项：
  --out <file>          写入生产运行状态 JSON；不传则输出到终端
  --root <dir>          产物根目录，默认 production
  --workspace           在 root 下生成 README、production-run.json、prompt 卡、请求包和 outputs 目录
  --scan-existing       扫描 root/outputs 下已存在的非空产物文件，并自动标记为 done
  --done <outputKey>    标记某个产物已完成，可重复
  --artifact <key=path> 标记某个产物已完成并记录路径，可重复

输入可以是：
  1. 浏览器导出的完整生产包 JSON，包含 videoGenerationQueue
  2. 直接导出的视频任务队列 JSONL
  3. 只包含 jobs 字段的队列 JSON`);
  process.exit(options.help ? 0 : 1);
}

try {
  const text = await fs.readFile(options.input, "utf8");
  const queue = loadQueue(text);
  const scannedArtifacts = options.scanExisting ? await scanExistingArtifacts(queue, options.root) : {};
  const artifacts = { ...scannedArtifacts, ...options.artifacts };
  const run = buildProductionRun(queue, {
    outputRoot: options.root,
    completedOutputs: options.done,
    artifacts
  });
  const body = `${JSON.stringify(run, null, 2)}\n`;
  if (options.out) {
    await fs.mkdir(path.dirname(path.resolve(options.out)), { recursive: true });
    await fs.writeFile(options.out, body);
    console.log(`已生成视频生产运行状态：${options.out}`);
    console.log(`ready=${run.counts.ready} blocked=${run.counts.blocked} done=${run.counts.done} failed=${run.counts.failed}`);
    if (options.scanExisting) console.log(`扫描识别已完成产物：${Object.keys(scannedArtifacts).length} 个`);
  } else if (!options.workspace) {
    process.stdout.write(body);
  }
  if (options.workspace) {
    const files = buildProductionWorkspaceFiles(queue, run);
    await writeWorkspace(files, run);
    console.log(`已生成视频生产工作区：${run.outputRoot}`);
    console.log(`prompt 卡：${files.filter((file) => file.path.endsWith(".md") && file.path.includes("/prompts/")).length} 个`);
    console.log(`请求包：${files.filter((file) => file.path.endsWith(".json") && file.path.includes("/requests/")).length} 个`);
    if (options.scanExisting) console.log(`扫描识别已完成产物：${Object.keys(scannedArtifacts).length} 个`);
    console.log(`当前可执行：${run.nextTaskIds.length ? run.nextTaskIds.join(" / ") : "无"}`);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

function loadQueue(text) {
  try {
    const payload = JSON.parse(text);
    if (payload?.videoGenerationQueue?.jobs) return payload.videoGenerationQueue;
    if (payload?.jobs) return payload;
    if (Array.isArray(payload)) return { version: "json-array", providerMode: "provider_agnostic", jobs: payload };
    throw new Error("JSON 中没有找到 videoGenerationQueue 或 jobs 字段");
  } catch (error) {
    if (!looksLikeJsonl(text)) throw error;
    return parseQueueJsonl(text);
  }
}

function looksLikeJsonl(text) {
  const lines = String(text).split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  return lines.length > 0 && lines.every((line) => line.startsWith("{") && line.endsWith("}"));
}

function parseArgs(args) {
  const options = { input: "", out: "", root: "production", done: [], artifacts: {}, workspace: false, scanExisting: false, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg === "--workspace") options.workspace = true;
    else if (arg === "--scan-existing") options.scanExisting = true;
    else if (arg === "--out") options.out = requireValue(args, ++index, arg);
    else if (arg.startsWith("--out=")) options.out = arg.slice("--out=".length);
    else if (arg === "--root") options.root = requireValue(args, ++index, arg);
    else if (arg.startsWith("--root=")) options.root = arg.slice("--root=".length);
    else if (arg === "--done") options.done.push(requireValue(args, ++index, arg));
    else if (arg.startsWith("--done=")) options.done.push(arg.slice("--done=".length));
    else if (arg === "--artifact") addArtifact(options, requireValue(args, ++index, arg));
    else if (arg.startsWith("--artifact=")) addArtifact(options, arg.slice("--artifact=".length));
    else if (!options.input) options.input = arg;
    else throw new Error(`未知参数：${arg}`);
  }
  return options;
}

function addArtifact(options, pair) {
  const splitAt = pair.indexOf("=");
  if (splitAt <= 0 || splitAt === pair.length - 1) throw new Error(`--artifact 需要使用 outputKey=path 格式：${pair}`);
  const outputKey = pair.slice(0, splitAt);
  const artifactPath = pair.slice(splitAt + 1);
  options.artifacts[outputKey] = { status: "done", path: artifactPath };
}

function requireValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} 缺少参数`);
  return value;
}

async function writeWorkspace(files, run) {
  const outputDirs = new Set((run.jobs || []).map((job) => path.dirname(path.resolve(job.outputPath))));
  for (const dir of outputDirs) await fs.mkdir(dir, { recursive: true });
  for (const file of files) {
    const target = path.resolve(file.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file.content);
  }
}

async function scanExistingArtifacts(queue, outputRoot) {
  const expectedRun = buildProductionRun(queue, { outputRoot });
  const existingOutputPaths = [];
  const existingFailurePaths = [];
  for (const job of expectedRun.jobs || []) {
    if (await isNonEmptyFile(job.outputPath)) existingOutputPaths.push(job.outputPath);
    else if (await isNonEmptyFile(job.failurePath)) existingFailurePaths.push(job.failurePath);
  }
  return buildArtifactsFromExistingOutputs(queue, { outputRoot, existingOutputPaths, existingFailurePaths });
}

async function isNonEmptyFile(filePath) {
  try {
    const stat = await fs.stat(path.resolve(filePath));
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}
