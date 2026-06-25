#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const options = parseArgs(process.argv.slice(2));

if (options.help || !options.request || !options.output) {
  console.log(`用法：
  node workers/command-worker-template.mjs --request <request.json> --output <target-file> --receipt <receipt.json> --root <production-root>

这是 command provider 的 worker 模板。默认只写占位产物，用于验证协议。
接入真实供应商时，在 executeRequest() 内按 request.capability 分派：
  image_generation
  first_last_frame_video_generation
  video_quality_review
  video_assembly`);
  process.exit(options.help ? 0 : 1);
}

try {
  const request = JSON.parse(await fs.readFile(options.request, "utf8"));
  await executeRequest(request, options);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

async function executeRequest(request, options) {
  await fs.mkdir(path.dirname(path.resolve(options.output)), { recursive: true });
  await fs.writeFile(options.output, renderPlaceholderArtifact(request));
  const receipt = {
    provider: "command-worker-template",
    taskId: request.taskId,
    capability: request.capability,
    outputKey: request.outputKey,
    outputPath: options.output,
    root: options.root || "",
    generatedAt: new Date().toISOString(),
    note: "Placeholder output. Replace executeRequest() with real image/video API calls."
  };
  if (options.receipt) {
    await fs.mkdir(path.dirname(path.resolve(options.receipt)), { recursive: true });
    await fs.writeFile(options.receipt, `${JSON.stringify(receipt, null, 2)}\n`);
  }
}

function renderPlaceholderArtifact(request) {
  if (request.capability === "video_quality_review") {
    return `${JSON.stringify({
      taskId: request.taskId,
      passed: true,
      provider: "command-worker-template",
      acceptanceCriteria: request.acceptanceCriteria || []
    }, null, 2)}\n`;
  }
  return [
    `PLACEHOLDER ARTIFACT: ${request.taskId}`,
    `capability=${request.capability}`,
    `outputKey=${request.outputKey}`,
    "",
    "Input artifacts:",
    ...(request.inputArtifacts || []).map((item) => `- ${item.outputKey}: ${item.path}`),
    "",
    "Prompt:",
    request.prompt || "",
    "",
    "Negative prompt:",
    request.negativePrompt || ""
  ].join("\n");
}

function parseArgs(args) {
  const options = { request: "", output: "", receipt: "", root: "", help: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg === "--request") options.request = requireValue(args, ++index, arg);
    else if (arg.startsWith("--request=")) options.request = arg.slice("--request=".length);
    else if (arg === "--output") options.output = requireValue(args, ++index, arg);
    else if (arg.startsWith("--output=")) options.output = arg.slice("--output=".length);
    else if (arg === "--receipt") options.receipt = requireValue(args, ++index, arg);
    else if (arg.startsWith("--receipt=")) options.receipt = arg.slice("--receipt=".length);
    else if (arg === "--root") options.root = requireValue(args, ++index, arg);
    else if (arg.startsWith("--root=")) options.root = arg.slice("--root=".length);
    else throw new Error(`未知参数：${arg}`);
  }
  return options;
}

function requireValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} 缺少参数`);
  return value;
}
