#!/usr/bin/env node
import { executeProductionWorkspace } from "../src/video-production-executor.js";

const options = parseArgs(process.argv.slice(2));

if (options.help || !options.root) {
  console.log(`用法：
  npm run exec:video -- <production-root> [--provider mock] [--all] [--limit 4] [--task TASK_ID]

选项：
  --provider <name>  当前支持 mock；真实图像/视频 provider 后续接入同一入口
  --all              循环执行 ready 任务，直到没有 ready 任务或达到 limit
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
  console.log(`当前状态：ready=${result.run.counts.ready} blocked=${result.run.counts.blocked} done=${result.run.counts.done} failed=${result.run.counts.failed}`);
  console.log(`下一批：${result.run.nextTaskIds.length ? result.run.nextTaskIds.join(" / ") : "无"}`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

function parseArgs(args) {
  const options = { root: "", provider: "mock", all: false, limit: Number.POSITIVE_INFINITY, taskIds: [], maxPasses: 12, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg === "--all") options.all = true;
    else if (arg === "--provider") options.provider = requireValue(args, ++index, arg);
    else if (arg.startsWith("--provider=")) options.provider = arg.slice("--provider=".length);
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
