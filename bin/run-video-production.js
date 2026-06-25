#!/usr/bin/env node
import { executeProductionWorkspace } from "../src/video-production-executor.js";

const options = parseArgs(process.argv.slice(2));

if (options.help || !options.root) {
  console.log(`用法：
  npm run exec:video -- <production-root> [--provider mock|command] [--command ./worker.js] [--all] [--continue-on-error] [--retry-failed] [--limit 4] [--task TASK_ID]

选项：
  --provider <name>  支持 mock 和 command
  --command <path>   command provider 的可执行文件；也可用 VIDEO_PROVIDER_COMMAND
  --command-arg <x>  传给 command provider 的固定参数，可重复
  --all              循环执行 ready 任务，直到没有 ready 任务或达到 limit
  --continue-on-error 某个任务失败时写入失败回执并继续执行其它 ready 任务
  --retry-failed     先清理 failed 任务的失败回执，再重新计算 ready 任务
  --limit <n>        本次最多执行多少个任务，默认不限
  --task <id>        只执行指定任务，可重复
  --max-passes <n>   --all 模式最多刷新多少轮，默认 12`);
  process.exit(options.help ? 0 : 1);
}

try {
  const result = await executeProductionWorkspace(options);
  console.log(`执行模式：${result.provider} / ${result.mode}`);
  console.log(`执行任务：${result.executed.length}`);
  for (const item of result.executed) console.log(`- ${item.taskId} → ${item.outputPath}`);
  if (result.skipped.length) {
    console.log(`跳过任务：${result.skipped.length}`);
    for (const item of result.skipped) console.log(`- ${item.taskId}：${item.reason}`);
  }
  if (result.failed.length) {
    console.log(`失败任务：${result.failed.length}`);
    for (const item of result.failed) console.log(`- ${item.taskId}：${item.failurePath}`);
  }
  if (result.retried.length) {
    console.log(`重试任务：${result.retried.length}`);
    for (const item of result.retried) console.log(`- ${item.taskId}：已清理 ${item.failurePath}`);
  }
  console.log(`当前状态：ready=${result.run.counts.ready} blocked=${result.run.counts.blocked} done=${result.run.counts.done} failed=${result.run.counts.failed}`);
  console.log(`下一批：${result.run.nextTaskIds.length ? result.run.nextTaskIds.join(" / ") : "无"}`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

function parseArgs(args) {
  const options = { root: "", provider: "mock", command: "", commandArgs: [], all: false, continueOnError: false, retryFailed: false, limit: Number.POSITIVE_INFINITY, taskIds: [], maxPasses: 12, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg === "--all") options.all = true;
    else if (arg === "--continue-on-error") options.continueOnError = true;
    else if (arg === "--retry-failed") options.retryFailed = true;
    else if (arg === "--provider") options.provider = requireValue(args, ++index, arg);
    else if (arg.startsWith("--provider=")) options.provider = arg.slice("--provider=".length);
    else if (arg === "--command") options.command = requireValue(args, ++index, arg);
    else if (arg.startsWith("--command=")) options.command = arg.slice("--command=".length);
    else if (arg === "--command-arg") options.commandArgs.push(requireCommandArgValue(args, ++index, arg));
    else if (arg.startsWith("--command-arg=")) options.commandArgs.push(arg.slice("--command-arg=".length));
    else if (arg === "--limit") options.limit = Number(requireValue(args, ++index, arg));
    else if (arg.startsWith("--limit=")) options.limit = Number(arg.slice("--limit=".length));
    else if (arg === "--task") options.taskIds.push(requireValue(args, ++index, arg));
    else if (arg.startsWith("--task=")) options.taskIds.push(arg.slice("--task=".length));
    else if (arg === "--max-passes") options.maxPasses = Number(requireValue(args, ++index, arg));
    else if (arg.startsWith("--max-passes=")) options.maxPasses = Number(arg.slice("--max-passes=".length));
    else if (!options.root) options.root = arg;
    else throw new Error(`未知参数：${arg}`);
  }
  if (!Number.isFinite(options.limit) && options.limit !== Number.POSITIVE_INFINITY) options.limit = Number.POSITIVE_INFINITY;
  if (!Number.isFinite(options.maxPasses) || options.maxPasses < 1) options.maxPasses = 12;
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
