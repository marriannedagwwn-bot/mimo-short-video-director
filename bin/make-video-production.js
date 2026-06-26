#!/usr/bin/env node
import { formatMakeVideoMarkdown, makeProductionVideo } from "../src/video-production-maker.js";

const options = parseArgs(process.argv.slice(2));

if (options.help || !options.root) {
  console.log(`用法：
  npm run make:video -- <production-root> [--config provider.json] [--ffmpeg /path/to/ffmpeg] [--json] [--continue-on-error] [--retry-failed]

用途：
  一键执行动画生产：
  1. preflight:video 预检
  2. generic-http-worker 生成图像和首尾帧视频
  3. local-postprocess-worker 做基础质检并合成最终视频
  4. 输出生产报告摘要`);
  process.exit(options.help ? 0 : 1);
}

try {
  const result = await makeProductionVideo(options);
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else process.stdout.write(formatMakeVideoMarkdown(result));
} catch (error) {
  if (options.json && error.preflight) {
    console.log(JSON.stringify({ error: error.message, preflight: error.preflight }, null, 2));
  } else {
    console.error(error.message);
    if (error.preflight) {
      for (const issue of error.preflight.issues || []) {
        console.error(`- [${issue.severity}] ${issue.code}${issue.taskId ? ` / ${issue.taskId}` : ""}: ${issue.message}`);
      }
    }
  }
  process.exit(error.preflight ? 2 : 1);
}

function parseArgs(args) {
  const options = { root: "", configPath: "", httpWorker: "./workers/generic-http-worker.mjs", postprocessWorker: "./workers/local-postprocess-worker.mjs", command: process.execPath, ffmpeg: "", json: false, continueOnError: false, retryFailed: false, skipPreflight: false, maxPasses: 12, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--continue-on-error") options.continueOnError = true;
    else if (arg === "--retry-failed") options.retryFailed = true;
    else if (arg === "--skip-preflight") options.skipPreflight = true;
    else if (arg === "--config") options.configPath = requireValue(args, ++index, arg);
    else if (arg.startsWith("--config=")) options.configPath = arg.slice("--config=".length);
    else if (arg === "--http-worker") options.httpWorker = requireValue(args, ++index, arg);
    else if (arg.startsWith("--http-worker=")) options.httpWorker = arg.slice("--http-worker=".length);
    else if (arg === "--postprocess-worker") options.postprocessWorker = requireValue(args, ++index, arg);
    else if (arg.startsWith("--postprocess-worker=")) options.postprocessWorker = arg.slice("--postprocess-worker=".length);
    else if (arg === "--command") options.command = requireValue(args, ++index, arg);
    else if (arg.startsWith("--command=")) options.command = arg.slice("--command=".length);
    else if (arg === "--ffmpeg") options.ffmpeg = requireValue(args, ++index, arg);
    else if (arg.startsWith("--ffmpeg=")) options.ffmpeg = arg.slice("--ffmpeg=".length);
    else if (arg === "--max-passes") options.maxPasses = Number(requireValue(args, ++index, arg));
    else if (arg.startsWith("--max-passes=")) options.maxPasses = Number(arg.slice("--max-passes=".length));
    else if (!options.root) options.root = arg;
    else throw new Error(`未知参数：${arg}`);
  }
  if (!Number.isFinite(options.maxPasses) || options.maxPasses < 1) options.maxPasses = 12;
  return options;
}

function requireValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} 缺少参数`);
  return value;
}
