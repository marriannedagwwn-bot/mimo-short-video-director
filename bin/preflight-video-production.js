#!/usr/bin/env node
import { formatProductionPreflightMarkdown, loadProductionPreflight } from "../src/video-production-preflight.js";

const options = parseArgs(process.argv.slice(2));

if (options.help || !options.root) {
  console.log(`用法：
  npm run preflight:video -- <production-root> [--command node] [--command-arg ./worker.mjs] [--config provider.json] [--json]

用途：
  在真实图像/首尾帧视频 API 执行前检查 workspace 是否可安全开跑。
  重点检查 mock/占位产物是否被标记 done、ready 任务是否会吃到 mock 输入、generic HTTP worker endpoint/API key 是否配置。`);
  process.exit(options.help ? 0 : 1);
}

try {
  const report = await loadProductionPreflight(options.root, options);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatProductionPreflightMarkdown(report));
  }
  if (!report.passed && options.strict) process.exit(2);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

function parseArgs(args) {
  const options = { root: "", provider: "command", command: "node", commandArgs: ["./workers/generic-http-worker.mjs"], configPath: "", json: false, strict: false, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--strict") options.strict = true;
    else if (arg === "--provider") options.provider = requireValue(args, ++index, arg);
    else if (arg.startsWith("--provider=")) options.provider = arg.slice("--provider=".length);
    else if (arg === "--command") options.command = requireValue(args, ++index, arg);
    else if (arg.startsWith("--command=")) options.command = arg.slice("--command=".length);
    else if (arg === "--command-arg") options.commandArgs.push(requireCommandArgValue(args, ++index, arg));
    else if (arg.startsWith("--command-arg=")) options.commandArgs.push(arg.slice("--command-arg=".length));
    else if (arg === "--config") options.configPath = requireValue(args, ++index, arg);
    else if (arg.startsWith("--config=")) options.configPath = arg.slice("--config=".length);
    else if (!options.root) options.root = arg;
    else throw new Error(`未知参数：${arg}`);
  }
  if (options.configPath && !options.commandArgs.includes("--config")) {
    options.commandArgs.push("--config", options.configPath);
  }
  return options;
}

function requireValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} 缺少参数`);
  return value;
}

function requireCommandArgValue(args, index, flag) {
  const value = args[index];
  if (!value) throw new Error(`${flag} 缺少参数`);
  return value;
}
