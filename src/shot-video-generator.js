import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class ShotVideoConfigError extends Error {}
export class ShotVideoProviderError extends Error {}

export async function generateShotVideo(options = {}) {
  const shot = options.shot || {};
  const configPath = options.configPath || process.env.VIDEO_HTTP_CONFIG || "";
  const config = await loadProviderConfig(configPath);
  if (!videoEndpointConfigured(config)) {
    throw new ShotVideoConfigError("未配置首尾帧视频生成服务。请设置 VIDEO_HTTP_VIDEO_ENDPOINT / VIDEO_HTTP_ENDPOINT，或设置 VIDEO_HTTP_CONFIG 指向 provider.json。");
  }
  if (!hasBothInputFrames(options) && !imageEndpointConfigured(config)) {
    throw new ShotVideoConfigError("未配置首尾帧图片生成服务。请设置 VIDEO_HTTP_IMAGE_ENDPOINT / VIDEO_HTTP_ENDPOINT，或设置 VIDEO_HTTP_CONFIG 指向 provider.json；如果已在外部生成图片，也可以传入 startFrameDataUrl 和 endFrameDataUrl。");
  }

  const outputRoot = options.outputRoot || path.resolve("public/generated-videos");
  const publicBasePath = options.publicBasePath || "/generated-videos";
  const shotId = safeSegment(shot.shotId || "shot");
  const stamp = new Date().toISOString().replace(/[-:.]/gu, "").replace(/Z$/u, "");
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "shot-video-"));
  const outputPath = path.join(outputRoot, `${shotId}-${stamp}.mp4`);

  try {
    await fs.mkdir(outputRoot, { recursive: true });
    const frames = await prepareFrameArtifacts({
      shot,
      options,
      outputRoot,
      publicBasePath,
      workDir,
      configPath,
      stamp
    });
    const inputArtifacts = [frames.start, frames.end].map(({ url, receipt, ...artifact }) => artifact);
    const request = buildShotVideoRequest(shot, { outputPath, inputArtifacts });
    const receipt = await runGenericWorker({ request, outputPath, workDir, configPath });
    return {
      taskId: request.taskId,
      shotId: shot.shotId || "",
      startFrameUrl: frames.start.url,
      startFramePath: frames.start.path,
      endFrameUrl: frames.end.url,
      endFramePath: frames.end.path,
      outputUrl: `${publicBasePath}/${path.basename(outputPath)}`,
      outputPath,
      frameReceipts: {
        start: frames.start.receipt || {},
        end: frames.end.receipt || {}
      },
      receipt,
      generatedAt: new Date().toISOString()
    };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

async function prepareFrameArtifacts(context) {
  const start = await prepareOneFrameArtifact({ ...context, frameKind: "start", dataUrl: context.options.startFrameDataUrl });
  const end = await prepareOneFrameArtifact({ ...context, frameKind: "end", dataUrl: context.options.endFrameDataUrl });
  return { start, end };
}

async function prepareOneFrameArtifact(context) {
  const { shot, outputRoot, publicBasePath, frameKind, stamp, dataUrl, workDir, configPath } = context;
  const shotId = safeSegment(shot.shotId || "shot");
  const outputKey = `frames.${shotId}.${frameKind}`;
  const prompt = frameKind === "start" ? shot.startFramePrompt : shot.endFramePrompt;

  if (dataUrl) {
    return writeDataUrlArtifact({
      outputRoot,
      publicBasePath,
      outputKey,
      basename: `${shotId}-${frameKind}-${stamp}`,
      dataUrl
    });
  }

  const outputPath = path.join(outputRoot, `${shotId}-${frameKind}-${stamp}.png`);
  const request = buildFrameRequest(shot, { frameKind, outputPath, outputKey, prompt });
  const receipt = await runGenericWorker({ request, outputPath, workDir, configPath });
  return {
    outputKey,
    path: outputPath,
    status: "done",
    missing: false,
    url: `${publicBasePath}/${path.basename(outputPath)}`,
    receipt
  };
}

function buildFrameRequest(shot = {}, context = {}) {
  const label = context.frameKind === "start" ? "START" : "END";
  return {
    version: "1.0",
    providerMode: "provider_agnostic",
    taskId: `${shot.shotId || "SHOT"}-${label}-FRAME-PREVIEW`,
    type: context.frameKind === "start" ? "start_frame_image" : "end_frame_image",
    capability: "image_generation",
    status: "ready",
    inputType: "text_to_image",
    outputKey: context.outputKey,
    outputPath: context.outputPath,
    prompt: context.prompt || framePromptFallback(shot, context.frameKind),
    negativePrompt: shot.negativePrompt || "",
    inputArtifacts: [],
    parameters: {
      aspectRatio: shot.aspectRatio || "9:16",
      shotId: shot.shotId || "",
      sourceSceneId: shot.sourceSceneId || "",
      frameKind: context.frameKind,
      cameraMotion: shot.cameraMotion || "",
      characterAction: shot.characterAction || "",
      dialogueOrSubtitle: shot.dialogueOrSubtitle || "",
      continuityNotes: shot.continuityNotes || ""
    },
    acceptanceCriteria: shot.acceptanceCriteria || [],
    rawJob: shot
  };
}

function buildShotVideoRequest(shot = {}, context = {}) {
  return {
    version: "1.0",
    providerMode: "provider_agnostic",
    taskId: `${shot.shotId || "SHOT"}-VIDEO-PREVIEW`,
    type: "first_last_frame_video",
    capability: "first_last_frame_video_generation",
    status: "ready",
    inputType: "image_pair_to_video",
    outputKey: `preview.${safeSegment(shot.shotId || "shot")}`,
    outputPath: context.outputPath,
    prompt: shot.videoPrompt || "",
    negativePrompt: shot.negativePrompt || "",
    inputArtifacts: context.inputArtifacts || [],
    parameters: {
      aspectRatio: shot.aspectRatio || "9:16",
      durationSeconds: Number(shot.durationSeconds) || 4,
      shotId: shot.shotId || "",
      sourceSceneId: shot.sourceSceneId || "",
      cameraMotion: shot.cameraMotion || "",
      characterAction: shot.characterAction || "",
      dialogueOrSubtitle: shot.dialogueOrSubtitle || "",
      soundDesign: shot.soundDesign || "",
      continuityNotes: shot.continuityNotes || ""
    },
    acceptanceCriteria: shot.acceptanceCriteria || [],
    rawJob: shot
  };
}

async function writeDataUrlArtifact({ outputRoot, publicBasePath, outputKey, basename, dataUrl }) {
  const match = String(dataUrl || "").match(/^data:([^;,]+);base64,(.+)$/u);
  if (!match) throw new ShotVideoConfigError(`${basename} 不是有效的 base64 data URL`);
  const [, mimeType, payload] = match;
  await fs.mkdir(outputRoot, { recursive: true });
  const filePath = path.join(outputRoot, `${basename}${extensionForMime(mimeType)}`);
  await fs.writeFile(filePath, Buffer.from(payload, "base64"));
  return {
    outputKey,
    path: filePath,
    status: "done",
    missing: false,
    url: `${publicBasePath}/${path.basename(filePath)}`
  };
}

async function runGenericWorker({ request, outputPath, workDir, configPath }) {
  const requestPath = path.join(workDir, `${safeSegment(request.taskId)}.request.json`);
  const receiptPath = path.join(workDir, `${safeSegment(request.taskId)}.receipt.json`);
  await fs.writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`);
  const args = [
    path.resolve("workers/generic-http-worker.mjs"),
    ...(configPath ? ["--config", configPath] : []),
    "--request", requestPath,
    "--output", outputPath,
    "--receipt", receiptPath,
    "--root", process.cwd()
  ];
  try {
    await execFileAsync(process.execPath, args, { maxBuffer: 10 * 1024 * 1024 });
  } catch (error) {
    const message = String(error.stderr || error.message || "生成失败").trim();
    throw new ShotVideoProviderError(message);
  }
  return readJsonIfExists(receiptPath);
}

async function loadProviderConfig(configPath) {
  if (!configPath) return {};
  try {
    return JSON.parse(await fs.readFile(configPath, "utf8"));
  } catch (error) {
    throw new ShotVideoConfigError(`${configPath} 无法读取或不是有效 JSON：${error.message}`);
  }
}

function hasBothInputFrames(options = {}) {
  return Boolean(options.startFrameDataUrl && options.endFrameDataUrl);
}

function imageEndpointConfigured(config = {}) {
  return Boolean(
    config.endpoints?.image_generation
    || config.imageEndpoint
    || config.endpoint
    || process.env.VIDEO_HTTP_IMAGE_ENDPOINT
    || process.env.VIDEO_HTTP_ENDPOINT
  );
}

function videoEndpointConfigured(config = {}) {
  return Boolean(
    config.endpoints?.first_last_frame_video_generation
    || config.videoEndpoint
    || config.endpoint
    || process.env.VIDEO_HTTP_VIDEO_ENDPOINT
    || process.env.VIDEO_HTTP_ENDPOINT
  );
}

function framePromptFallback(shot = {}, frameKind = "start") {
  const frameLabel = frameKind === "start" ? "首帧" : "尾帧";
  return [
    `为该镜头生成${frameLabel}关键帧。`,
    shot.videoPrompt ? `视频动作：${shot.videoPrompt}` : "",
    shot.characterAction ? `人物动作：${shot.characterAction}` : "",
    shot.dialogueOrSubtitle ? `对白/字幕：${shot.dialogueOrSubtitle}` : "",
    shot.continuityNotes ? `连续性：${shot.continuityNotes}` : ""
  ].filter(Boolean).join("\n");
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return {};
  }
}

function extensionForMime(mimeType) {
  return ({
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp"
  })[mimeType] || ".bin";
}

function safeSegment(value) {
  return String(value || "item")
    .trim()
    .replace(/\s+/gu, "_")
    .replace(/[^\p{L}\p{N}_-]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 60) || "item";
}
