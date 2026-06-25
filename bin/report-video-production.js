#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { formatProductionReportMarkdown, loadProductionReport } from "../src/video-production-report.js";

const options = parseArgs(process.argv.slice(2));

if (options.help || !options.root) {
  console.log(`用法：
  npm run report:video -- <production-root> [--json] [--out report.md]

选项：
  --json        输出 JSON 报告
  --out <file>  写入文件；不传则输出到终端`);
  process.exit(options.help ? 0 : 1);
}

try {
  const report = await loadProductionReport(options.root);
  const body = options.json ? `${JSON.stringify(report, null, 2)}\n` : formatProductionReportMarkdown(report);
  if (options.out) {
    await fs.mkdir(path.dirname(path.resolve(options.out)), { recursive: true });
    await fs.writeFile(options.out, body);
    console.log(`已生成视频生产报告：${options.out}`);
  } else {
    process.stdout.write(body);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

function parseArgs(args) {
  const options = { root: "", out: "", json: false, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--out") options.out = requireValue(args, ++index, arg);
    else if (arg.startsWith("--out=")) options.out = arg.slice("--out=".length);
    else if (!options.root) options.root = arg;
    else throw new Error(`未知参数：${arg}`);
  }
  return options;
}

function requireValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} 缺少参数`);
  return value;
}
