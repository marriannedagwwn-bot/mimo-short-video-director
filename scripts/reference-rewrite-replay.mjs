#!/usr/bin/env node
// 参考片仿写（2026-10-24）上线前回放：直接用服务端的素材模块与 workflow.createReferenceRewrite，
// 不经过页面与任务管理器，对一支参考视频真实地跑一次「抽帧 → 去配乐 → 转写 → Claude 写四稿」。
// 会真实调用模型并计费（Claude Opus 5.5 effort xhigh 一次约 1 美元）。
//
// 用法（.env 用主目录那份，代理要靠 --use-env-proxy；本机工具路径用环境变量给）：
//   REFERENCE_REWRITE_BANDIT_DIR=/Volumes/MacOS/AI/Bandit-v2-Multi REFERENCE_REWRITE_WHISPER_BIN=~/.local/bin/whisper \
//   node --env-file=<主目录>/.env --use-env-proxy scripts/reference-rewrite-replay.mjs \
//     --video <参考视频> --label <输出目录名> [--target 51]
// 固定角色用下面写死的咕嘎设定（与 10-23 对照实验一致）；输出在 reports/reference-rewrite-replay-2026-10-24/<label>/。

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig } from "../src/config.js";
import { ClaudeClient } from "../src/claude-client.js";
import { WorkflowService } from "../src/workflow.js";
import { buildReferenceRewriteMaterials, referenceRewriteToolStatus } from "../src/reference-rewrite-materials.js";
import { referenceRewriteMarkdown } from "../public/reference-rewrite.js";
import { runWithUsageAccounting } from "../src/token-usage.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, list) => (
  value.startsWith("--") ? [...pairs, [value.slice(2), list[index + 1]]] : pairs
), []));
if (!args.video || !args.label) {
  console.error("需要 --video 与 --label");
  process.exit(2);
}
const creatorProfile = {
  fixedCharacter: "咕嘎：穿黑白企鹅连体衣（帽子上有黄色的嘴）、斜挎绿色小包的短发小女孩",
  vertical: "治愈系日常动画短片",
  constraints: "咕嘎不说人话，只会发出「咕嘎」「咕咕嘎嘎」这类叫声，靠语气和动作表达"
};

const config = getConfig();
if (!config.claude.enabled) throw new Error("缺少 CLAUDE_API_KEY");
const status = await referenceRewriteToolStatus(config.referenceRewrite);
if (!status.available) throw new Error(status.reason);

const outDir = path.join(ROOT, "reports/reference-rewrite-replay-2026-10-24", args.label);
await fs.mkdir(outDir, { recursive: true });
// 照页面工作区的样子造一个临时 Run 目录：manifest 在，media-work 用完即删。
const runDir = path.join(outDir, "run");
await fs.mkdir(runDir, { recursive: true });
const lifetimeFile = path.join(runDir, "manifest.json");
await fs.writeFile(lifetimeFile, "{}");
const videoBytes = await fs.readFile(args.video);
const digest = createHash("sha256").update(videoBytes).digest("hex");

const started = Date.now();
const seconds = () => Math.round((Date.now() - started) / 100) / 10;
const materials = await buildReferenceRewriteMaterials({
  sourcePath: args.video,
  expectedDigest: digest,
  workRoot: path.join(runDir, "media-work"),
  lifetimeFile,
  tools: config.referenceRewrite,
  onStep: async (step) => console.log(`[${seconds()}s] ${step}`)
});
const materialsSeconds = seconds();
await fs.writeFile(path.join(outDir, "transcript.md"), materials.transcriptText);
for (const [index, frame] of materials.frames.entries()) {
  await fs.writeFile(path.join(outDir, `sheet-${index + 1}.jpg`), Buffer.from(frame.dataUrl.split(",")[1], "base64"));
}
console.log(`[${seconds()}s] write`);

// 逐次记下每一次 provider 调用的耗时与结局（成功的 finishReason / 失败的错误码），
// 用来分清「被校验拦下重做」和「传输失败重做」。只记元数据，不记提示词与正文。
const attempts = [];
const claudeClient = new ClaudeClient(config.claude);
const originalRequest = claudeClient.requestCompletion.bind(claudeClient);
claudeClient.requestCompletion = async (request) => {
  const begin = Date.now();
  try {
    const completion = await originalRequest(request);
    attempts.push({ seconds: (Date.now() - begin) / 1000, finishReason: completion.finishReason, usage: completion.usage, contentChars: completion.content?.length || 0 });
    return completion;
  } catch (error) {
    attempts.push({ seconds: (Date.now() - begin) / 1000, error: { code: error.code, name: error.name, message: String(error.message || "").slice(0, 400), status: error.status } });
    throw error;
  }
};
const workflow = new WorkflowService({ clients: { Claude: claudeClient } });
const target = Number(args.target) || Math.round(materials.durationSeconds);
const { result: called, usage } = await runWithUsageAccounting(() => workflow.createReferenceRewrite({
  frames: materials.frames,
  contactSheets: materials.contactSheets,
  transcriptText: materials.transcriptText,
  durationSeconds: materials.durationSeconds,
  targetDurationSeconds: Math.min(180, Math.max(20, target)),
  videoTitle: path.basename(args.video).replace(/\.[A-Za-z0-9]{1,5}$/u, ""),
  creatorProfile
}), { prices: config.modelPrices });
const { result, metadata, settings } = called;
const videoTitle = path.basename(args.video).replace(/\.[A-Za-z0-9]{1,5}$/u, "");
await fs.writeFile(path.join(outDir, "output.json"), JSON.stringify(result, null, 2));
await fs.writeFile(path.join(outDir, "output.md"), referenceRewriteMarkdown(result, { videoTitle }));
const meta = {
  video: path.basename(args.video),
  durationSeconds: materials.durationSeconds,
  materials: materials.materials,
  materialsSeconds,
  totalSeconds: seconds(),
  settings,
  call: metadata.referenceRewrite,
  attempts,
  usage
};
await fs.writeFile(path.join(outDir, "meta.json"), JSON.stringify(meta, null, 2));
await fs.rm(runDir, { recursive: true, force: true });
console.log(JSON.stringify(meta));
