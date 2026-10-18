#!/usr/bin/env node
// 参考片分析接 MiMo json_schema 之后的真实回放（2026-10-18，docs/analysis-mimo-json-schema-2026-10-18.md）。
//
// 用一个浏览器 Run 留下的源视频副本与 Run 元数据，按页面 sampleVideo 的规则重算关键帧时间，
// 原样重建当时那次分析请求，再交给当前代码的 workflow.analyze。会真实调用 MiMo、真实计费。
//
//   node --use-env-proxy scripts/analysis-schema-replay.mjs --run <Run 目录> --source <源视频副本> \
//     --out <输出目录> [--video 3] [--frames 1]
//
// 每次调用记下：发的是视频还是抽帧、response_format、finish_reason、usage、原始输出，以及能否签发。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadEnv, getConfig } from "../src/config.js";
import { initializeSystemProxy } from "../src/system-proxy.js";
import { MimoClient } from "../src/mimo-client.js";
import { WorkflowService } from "../src/workflow.js";
import { loadOrCreatePersistentKey } from "../src/persistent-key.js";

const execFileAsync = promisify(execFile);

function parseArgs(argv) {
  const options = { video: 3, frames: 1 };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index].replace(/^--/, "");
    const value = argv[index + 1];
    index += 1;
    options[key] = ["video", "frames"].includes(key) ? Number(value) : value;
  }
  for (const key of ["run", "source", "out"]) if (!options[key]) throw new Error(`缺少 --${key}`);
  return options;
}

// 与 public/app.js sampleVideo 同一规则：count 固定传 10。
function frameTimestamps(duration, count = 10) {
  const actualCount = Math.max(6, Math.min(count, Math.ceil(duration / 4)));
  return Array.from({ length: actualCount }, (_, index) => {
    const ratio = actualCount === 1 ? 0.5 : 0.03 + (0.94 * index / (actualCount - 1));
    return Number(Math.min(duration - 0.02, Math.max(0, duration * ratio)).toFixed(2));
  });
}

async function extractFrames(sourcePath, timestamps) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "analysis-replay-"));
  try {
    const frames = [];
    for (const [index, timestamp] of timestamps.entries()) {
      const file = path.join(dir, `f${index}.jpg`);
      await execFileAsync("ffmpeg", ["-v", "error", "-ss", String(timestamp), "-i", sourcePath, "-frames:v", "1",
        "-vf", "scale='min(720,iw)':-2", "-q:v", "4", "-y", file]);
      frames.push({ timestamp, dataUrl: `data:image/jpeg;base64,${(await fs.readFile(file)).toString("base64")}` });
    }
    return frames;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  loadEnv();
  const systemProxy = await initializeSystemProxy();
  try {
    const config = getConfig();
    if (!config.mimo.enabled) throw new Error("MiMo 未配置");
    const manifest = JSON.parse(await fs.readFile(path.join(options.run, "manifest.json"), "utf8"));
    const { sourceVideo, sourceVideoDigest, transcript = "" } = manifest.metadata;
    const bytes = await fs.readFile(options.source);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== sourceVideoDigest) throw new Error(`源视频摘要不符：${digest} ≠ ${sourceVideoDigest}`);
    const metadata = {
      name: sourceVideo.name, size: sourceVideo.size, type: sourceVideo.type,
      duration: sourceVideo.duration, width: sourceVideo.width, height: sourceVideo.height
    };
    const frames = await extractFrames(options.source, frameTimestamps(metadata.duration));
    const video = { dataUrl: `data:${metadata.type};base64,${bytes.toString("base64")}`, mimeType: metadata.type, size: metadata.size };

    const client = new MimoClient(config.mimo);
    const calls = [];
    const requestCompletion = client.requestCompletion.bind(client);
    client.requestCompletion = async (args) => {
      const startedAt = Date.now();
      const record = {
        media: args.useVideo ? "video" : "frames",
        responseFormat: args.responseSchema ? "json_schema" : (config.mimo.jsonMode ? "json_object" : "none")
      };
      calls.push(record);
      try {
        const completion = await requestCompletion(args);
        Object.assign(record, {
          finishReason: completion.finishReason, usage: completion.usage,
          seconds: Math.round((Date.now() - startedAt) / 1000), content: completion.content
        });
        return completion;
      } catch (error) {
        Object.assign(record, { seconds: Math.round((Date.now() - startedAt) / 1000), error: String(error?.message || error) });
        throw error;
      }
    };
    const keyDirectory = config.workflowRuntime.productionStateDirectory;
    const groundingKey = (await loadOrCreatePersistentKey({
      directory: keyDirectory, fileName: ".grounding-key", byteLength: 32, label: "Grounding 密钥", envValue: process.env.WORKFLOW_GROUNDING_KEY
    })).key;
    // 与失败那两次的任务快照一致：MiMo mimo-v2.6-pro、上限 16384。
    const workflow = new WorkflowService({
      clients: { MiMo: client },
      stageDefaults: { analysis: { provider: "MiMo", model: "mimo-v2.6-pro", maxCompletionTokens: 16384, requestTimeoutMs: null } },
      groundingKey
    });

    await fs.mkdir(options.out, { recursive: true });
    const plan = [
      ...Array.from({ length: options.video }, (_, index) => ({ label: `video-${index + 1}`, input: { frames, metadata, transcript, video } })),
      ...Array.from({ length: options.frames }, (_, index) => ({ label: `frames-${index + 1}`, input: { frames, metadata, transcript } }))
    ];
    const results = [];
    for (const { label, input } of plan) {
      const before = calls.length;
      let outcome;
      try {
        const analysis = await workflow.analyze(input);
        const sources = [...new Set(analysis.observedFacts.flatMap((fact) => fact.evidenceRefs.map((ref) => ref.source)))];
        outcome = { ok: true, sealed: Boolean(analysis.groundingSeal?.signature), observedFacts: analysis.observedFacts.length, evidenceSources: sources };
        await fs.writeFile(path.join(options.out, `${label}.analysis.json`), `${JSON.stringify(analysis, null, 2)}\n`);
      } catch (error) {
        outcome = { ok: false, code: error?.code || "", error: String(error?.message || error) };
      }
      const attempts = calls.slice(before).map(({ content, ...rest }, index) => {
        fs.writeFile(path.join(options.out, `${label}.call${index + 1}.txt`), content || "").catch(() => {});
        return { ...rest, contentChars: (content || "").length };
      });
      const row = { label, ...outcome, attempts };
      results.push(row);
      process.stdout.write(`${JSON.stringify(row)}\n`);
    }
    await fs.writeFile(path.join(options.out, "summary.json"), `${JSON.stringify({
      generatedAt: new Date().toISOString(), sourceVideoDigest, frameTimestamps: frames.map((frame) => frame.timestamp), results
    }, null, 2)}\n`);
  } finally {
    await systemProxy?.close?.();
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
