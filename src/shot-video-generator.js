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

  const outputRoot = options.outputRoot || path.resolve("public/generated-videos");
  const publicBasePath = options.publicBasePath || "/generated-videos";
  const shotId = safeSegment(shot.shotId || "shot");
  const stamp = new Date().toISOString().replace(/[-:.]/gu, "").replace(/Z$/u, "");
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "shot-video-"));
  const outputPath = path.join(outputRoot, `${shotId}-${stamp}.mp4`);
  const requestPath = path.join(workDir, "request.json");
  const receiptPath = path.join(workDir, "receipt.json");

  try {
    const inputArtifacts = await writeInputFrameArtifacts(workDir, options);
    const request = buildShotVideoRequest(shot, { outputPath, inputArtifacts });
    await fs.mkdir(outputRoot, { recursive: true });
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
      const message = String(error.stderr || error.message || "视频生成失败").trim();
      throw new ShotVideoProviderError(message);
    }
    const receipt = await readJsonIfExists(receiptPath);
    return {
      taskId: request.taskId,
      shotId: shot.shotId || "",
      outputUrl: `${publicBasePath}/${path.basename(outputPath)}`,
      outputPath,
      receipt,
      generatedAt: new Date().toISOString()
    };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
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

async function writeInputFrameArtifacts(workDir, options = {}) {
  const artifacts = [];
  if (options.startFrameDataUrl) {
    artifacts.push(await writeDataUrlArtifact(workDir, "frames.start", "start", options.startFrameDataUrl));
  }
  if (options.endFrameDataUrl) {
    artifacts.push(await writeDataUrlArtifact(workDir, "frames.end", "end", options.endFrameDataUrl));
  }
  return artifacts;
}

async function writeDataUrlArtifact(workDir, outputKey, name, dataUrl) {
  const match = String(dataUrl || "").match(/^data:([^;,]+);base64,(.+)$/u);
  if (!match) throw new ShotVideoConfigError(`${name}FrameDataUrl 不是有效的 base64 data URL`);
  const [, mimeType, payload] = match;
  const filePath = path.join(workDir, `${name}${extensionForMime(mimeType)}`);
  await fs.writeFile(filePath, Buffer.from(payload, "base64"));
  return {
    outputKey,
    path: filePath,
    status: "done",
    missing: false
  };
}

async function loadProviderConfig(configPath) {
  if (!configPath) return {};
  try {
    return JSON.parse(await fs.readFile(configPath, "utf8"));
  } catch (error) {
    throw new ShotVideoConfigError(`${configPath} 无法读取或不是有效 JSON：${error.message}`);
  }
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
