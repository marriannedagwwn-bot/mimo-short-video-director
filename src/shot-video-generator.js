import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { compileShotNegativePrompt } from "../public/negative-prompts.js";
import { ANIMATION_DIRECT_PROMPT_SCHEMA_VERSION } from "./validation.js";
import {
  inferShotVideoProvider,
  isNonDomesticKlingApiEndpoint,
  isShotVideoGenerationModeSupported,
  isShotVideoModelAllowed,
  normalizeShotVideoGenerationMode,
  normalizeShotVideoProvider,
  resolveShotVideoSetting,
  shotVideoRuntimeConfig
} from "./shot-video-providers.js";

const execFileAsync = promisify(execFile);

export class ShotVideoConfigError extends Error {}
export class ShotVideoProviderError extends Error {}

const SHOT_VIDEO_ASPECT_RATIOS = Object.freeze(["9:16", "16:9"]);

export function normalizeShotVideoAspectRatio(value, { defaultValue = "9:16" } = {}) {
  const normalized = String(value || "").trim();
  if (!normalized) return defaultValue;
  if (!SHOT_VIDEO_ASPECT_RATIOS.includes(normalized)) {
    throw new ShotVideoConfigError(`aspectRatio 只允许 ${SHOT_VIDEO_ASPECT_RATIOS.join(" 或 ")}`);
  }
  return normalized;
}

export async function generateShotVideo(options = {}) {
  const shot = options.shot || {};
  const requestedSetting = resolveShotVideoSetting({
    provider: options.videoProvider,
    model: options.videoModel
  });
  const requestedRuntime = shotVideoRuntimeConfig(requestedSetting.provider, process.env, requestedSetting.model);
  const configPath = options.configPath
    || requestedRuntime.configPath
    || (requestedSetting.provider === "VideoHTTP" ? process.env.VIDEO_HTTP_CONFIG : "")
    || "";
  const config = await loadProviderConfig(configPath);
  const explicitProvider = normalizeShotVideoProvider(options.videoProvider);
  const configProvider = inferShotVideoProvider({
    model: options.videoModel || config.videoModel || config.model,
    preset: config.providerPreset || config.preset
  });
  const videoProvider = explicitProvider
    || configProvider
    || (options.configPath ? "VideoHTTP" : requestedSetting.provider);
  const providerDefaultModel = shotVideoRuntimeConfig(videoProvider).model;
  const videoModel = String(
    options.videoModel
    || config.videoModel
    || config.model
    || (videoProvider === "VideoHTTP" ? "" : providerDefaultModel || requestedSetting.model)
    || ""
  ).trim();
  const providerRuntime = shotVideoRuntimeConfig(videoProvider, process.env, videoModel);
  const generationMode = normalizeShotVideoGenerationMode(options.generationMode);
  const aspectRatio = normalizeShotVideoAspectRatio(options.aspectRatio);
  if (
    String(options.animationPromptSchemaVersion || "").trim() === ANIMATION_DIRECT_PROMPT_SCHEMA_VERSION
    && generationMode === "first_last_frame"
  ) {
    throw new ShotVideoConfigError(
      "promptSchemaVersion=3.0 的 direct_shot 镜头没有首尾端点，不能使用 first_last_frame；请显式选择受支持的 all_reference 模式并提供图片或视频参考。"
    );
  }
  assertProviderProtocolCompatibility(videoProvider, videoModel, config);
  if (videoProvider !== "VideoHTTP" && !isShotVideoModelAllowed(videoProvider, videoModel)) {
    throw new ShotVideoConfigError(`${videoProvider} 不支持视频模型“${videoModel}”。`);
  }
  if (!isShotVideoGenerationModeSupported(videoProvider, generationMode)) {
    if (videoProvider === "Kling" && generationMode === "all_reference") {
      throw new ShotVideoConfigError("当前可灵接入使用官方 image-to-video 首尾帧接口；尚未取得可验证的 Omni API 协议，不能使用全能参考模式。请选择 Seedance 2.0 或 MiniMax H3。");
    }
    throw new ShotVideoConfigError(`${videoProvider} 不支持${generationMode === "all_reference" ? "全能参考" : "首尾帧"}视频模式。`);
  }
  if (videoProvider !== "VideoHTTP" && !providerAuthConfigured(config, providerRuntime)) {
    throw new ShotVideoConfigError(`未配置 ${videoProvider} API Key。请设置对应 provider API Key，或在 provider config 中提供认证信息。`);
  }
  if (!videoEndpointConfigured(config, providerRuntime, videoProvider, generationMode)) {
    throw new ShotVideoConfigError(`未配置 ${videoProvider} ${generationMode === "all_reference" ? "全能参考" : "首尾帧"}视频生成服务。请设置对应 provider endpoint/API Key，或设置 provider config 指向有效 JSON。`);
  }
  if (generationMode === "first_last_frame" && !hasBothInputFrames(options) && !imageEndpointConfigured(config)) {
    throw new ShotVideoConfigError("未配置首尾帧图片生成服务。请设置 VIDEO_HTTP_IMAGE_ENDPOINT / VIDEO_HTTP_ENDPOINT，或设置 VIDEO_HTTP_CONFIG 指向 provider.json；如果已在外部生成图片，也可以传入 startFrameDataUrl 和 endFrameDataUrl。");
  }
  if (generationMode === "all_reference") assertAllReferenceRequestSize(options);

  const outputRoot = options.outputRoot || path.resolve("public/generated-videos");
  const publicBasePath = options.publicBasePath || "/generated-videos";
  const shotId = safeSegment(shot.shotId || "shot");
  const filenamePrefix = options.filenamePrefix ? `${safeSegment(options.filenamePrefix)}-` : "";
  const stamp = new Date().toISOString().replace(/[-:.]/gu, "").replace(/Z$/u, "");
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "shot-video-"));
  const count = clampVideoCount(options.count);

  try {
    await fs.mkdir(outputRoot, { recursive: true });
    const frames = generationMode === "first_last_frame"
      ? await prepareFrameArtifacts({
        shot,
        options,
        outputRoot,
        publicBasePath,
        workDir,
        configPath,
        stamp,
        filenamePrefix
      })
      : null;
    const inputArtifacts = generationMode === "first_last_frame"
      ? [frames.start, frames.end].map(({ url, receipt, ...artifact }) => artifact)
      : await prepareAllReferenceArtifacts(options.referenceAssets, workDir);
    const videos = [];
    for (let index = 0; index < count; index += 1) {
      const suffix = count > 1 ? `-${index + 1}` : "";
      const outputPath = path.join(outputRoot, `${filenamePrefix}${shotId}-${stamp}${suffix}.mp4`);
      const request = buildShotVideoRequest(shot, {
        outputPath,
        inputArtifacts,
        candidateIndex: index,
        candidateCount: count,
        provider: videoProvider,
        model: videoModel,
        generationMode,
        aspectRatio
      });
      const receipt = await runGenericWorker({ request, outputPath, workDir, configPath, workerRunner: options.workerRunner });
      await assertUsableVideoOutput(outputPath);
      videos.push({
        candidateIndex: index,
        provider: videoProvider,
        model: videoModel,
        taskId: request.taskId,
        outputUrl: `${publicBasePath}/${path.basename(outputPath)}`,
        outputPath,
        receipt,
        generatedAt: new Date().toISOString()
      });
    }
    const firstVideo = videos[0] || {};
    return {
      taskId: firstVideo.taskId || `${shot.shotId || "SHOT"}-VIDEO-PREVIEW`,
      shotId: shot.shotId || "",
      provider: videoProvider,
      model: videoModel,
      generationMode,
      startFrameUrl: frames?.start?.url || "",
      startFramePath: frames?.start?.path || "",
      endFrameUrl: frames?.end?.url || "",
      endFramePath: frames?.end?.path || "",
      referenceSummary: generationMode === "all_reference" ? summarizeReferenceArtifacts(inputArtifacts) : null,
      outputUrl: firstVideo.outputUrl || "",
      outputPath: firstVideo.outputPath || "",
      count,
      actualCount: videos.length,
      videos,
      frameReceipts: {
        start: frames?.start?.receipt || {},
        end: frames?.end?.receipt || {}
      },
      receipt: firstVideo.receipt || {},
      generatedAt: new Date().toISOString()
    };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

export function shotVideoGenerationPromptText(options = {}) {
  const shot = options.shot || {};
  const prompts = [shot.videoPrompt];
  if (normalizeShotVideoGenerationMode(options.generationMode) === "all_reference") {
    return prompts.map((item) => String(item || "").trim()).filter(Boolean).join("\n");
  }
  if (!options.startFrameDataUrl) prompts.push(shot.startFramePrompt || framePromptFallback(shot, "start"));
  if (!options.endFrameDataUrl) prompts.push(shot.endFramePrompt || framePromptFallback(shot, "end"));
  return prompts.map((item) => String(item || "").trim()).filter(Boolean).join("\n");
}

async function prepareFrameArtifacts(context) {
  const start = await prepareOneFrameArtifact({ ...context, frameKind: "start", dataUrl: context.options.startFrameDataUrl });
  const end = await prepareOneFrameArtifact({ ...context, frameKind: "end", dataUrl: context.options.endFrameDataUrl });
  return { start, end };
}

async function prepareOneFrameArtifact(context) {
  const { shot, outputRoot, publicBasePath, frameKind, stamp, dataUrl, workDir, configPath } = context;
  const shotId = safeSegment(shot.shotId || "shot");
  const filenamePrefix = context.filenamePrefix || "";
  const outputKey = `frames.${shotId}.${frameKind}`;
  const prompt = frameKind === "start" ? shot.startFramePrompt : shot.endFramePrompt;

  if (dataUrl) {
    return writeDataUrlArtifact({
      outputRoot,
      publicBasePath,
      outputKey,
      basename: `${filenamePrefix}${shotId}-${frameKind}-${stamp}`,
      dataUrl
    });
  }

  const outputPath = path.join(outputRoot, `${filenamePrefix}${shotId}-${frameKind}-${stamp}.png`);
  const request = buildFrameRequest(shot, { frameKind, outputPath, outputKey, prompt });
  const receipt = await runGenericWorker({ request, outputPath, workDir, configPath, workerRunner: context.options.workerRunner });
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
  const negativePrompt = compileShotNegativePrompt(shot, "image");
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
    negativePromptEntries: negativePrompt.negativePromptEntries,
    compiledNegativePrompt: negativePrompt.compiledNegativePrompt,
    negativePrompt: negativePrompt.compiledNegativePrompt,
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
  const candidateIndex = Number(context.candidateIndex) || 0;
  const candidateCount = Number(context.candidateCount) || 1;
  const candidateSuffix = candidateCount > 1 ? `-${candidateIndex + 1}` : "";
  const negativePrompt = compileShotNegativePrompt(shot, "video");
  const generationMode = normalizeShotVideoGenerationMode(context.generationMode);
  const allReference = generationMode === "all_reference";
  return {
    version: "1.0",
    providerMode: "provider_agnostic",
    taskId: `${shot.shotId || "SHOT"}-VIDEO-PREVIEW${candidateSuffix}`,
    type: allReference ? "all_reference_video" : "first_last_frame_video",
    capability: allReference ? "all_reference_video_generation" : "first_last_frame_video_generation",
    status: "ready",
    inputType: allReference ? "multimodal_reference_to_video" : "image_pair_to_video",
    outputKey: `preview.${safeSegment(shot.shotId || "shot")}`,
    outputPath: context.outputPath,
    provider: context.provider || "",
    model: context.model || "",
    prompt: shot.videoPrompt || "",
    negativePromptEntries: negativePrompt.negativePromptEntries,
    compiledNegativePrompt: negativePrompt.compiledNegativePrompt,
    negativePrompt: negativePrompt.compiledNegativePrompt,
    inputArtifacts: context.inputArtifacts || [],
    parameters: {
      aspectRatio: context.aspectRatio || "9:16",
      durationSeconds: Number(shot.durationSeconds) || 4,
      shotId: shot.shotId || "",
      sourceSceneId: shot.sourceSceneId || "",
      cameraMotion: shot.cameraMotion || "",
      characterAction: shot.characterAction || "",
      dialogueOrSubtitle: shot.dialogueOrSubtitle || "",
      soundDesign: shot.soundDesign || "",
      continuityNotes: shot.continuityNotes || "",
      candidateIndex,
      candidateCount,
      generationMode
    },
    acceptanceCriteria: shot.acceptanceCriteria || [],
    rawJob: shot
  };
}

async function assertUsableVideoOutput(outputPath) {
  let stat;
  try {
    stat = await fs.stat(outputPath);
  } catch {
    throw new ShotVideoProviderError("视频生成服务没有写入视频文件。");
  }
  if (!stat.isFile() || stat.size < 8) {
    throw new ShotVideoProviderError(`视频生成服务返回的文件过小，疑似不是可播放视频（${stat?.size || 0} bytes）。`);
  }
  const file = await fs.open(outputPath, "r");
  try {
    const buffer = Buffer.alloc(Math.min(256, stat.size));
    await file.read(buffer, 0, buffer.length, 0);
    const sample = buffer.toString("utf8").replace(/\0/gu, "").trim().toLowerCase();
    if (stat.size < 512 && /^(ok|success|done|accepted|created|queued|true)$/u.test(sample)) {
      throw new ShotVideoProviderError(`视频生成服务只返回了任务确认文本“${sample}”，没有返回视频文件。请配置轮询结果接口或正确的视频结果字段。`);
    }
    if (/^[{[]/u.test(sample)) {
      throw new ShotVideoProviderError("视频生成服务返回了 JSON 文本而不是视频文件。请配置 resultUrlPaths / resultBase64Paths / pollEndpointTemplate。");
    }
  } finally {
    await file.close();
  }
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

async function runGenericWorker({ request, outputPath, workDir, configPath, workerRunner = null }) {
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
    if (typeof workerRunner === "function") {
      await workerRunner({
        config: configPath,
        request: requestPath,
        output: outputPath,
        receipt: receiptPath,
        root: process.cwd()
      });
    } else {
      await execFileAsync(process.execPath, args, { maxBuffer: 10 * 1024 * 1024 });
    }
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

function clampVideoCount(value) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return 1;
  return Math.min(4, Math.max(1, number));
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

function videoEndpointConfigured(config = {}, runtime = {}, provider = "", generationMode = "first_last_frame") {
  const capability = normalizeShotVideoGenerationMode(generationMode) === "all_reference"
    ? "all_reference_video_generation"
    : "first_last_frame_video_generation";
  return Boolean(
    config.endpoints?.[capability]
    || config.videoEndpoint
    || config.endpoint
    || runtime.endpoint
    || (provider === "VideoHTTP" && (process.env.VIDEO_HTTP_VIDEO_ENDPOINT || process.env.VIDEO_HTTP_ENDPOINT))
  );
}

async function prepareAllReferenceArtifacts(referenceAssets, workDir) {
  const assets = Array.isArray(referenceAssets) ? referenceAssets : [];
  if (!assets.length) throw new ShotVideoConfigError("全能参考模式至少需要一张参考图片或一段参考视频。");
  const prepared = [];
  for (let index = 0; index < assets.length; index += 1) {
    const asset = assets[index] || {};
    const decoded = decodeDataUrl(asset.dataUrl, `referenceAssets[${index}].dataUrl`);
    const mediaType = normalizeReferenceMediaType(asset.mediaType || decoded.mimeType.split("/", 1)[0]);
    if (!decoded.mimeType.startsWith(`${mediaType}/`)) {
      throw new ShotVideoConfigError(`referenceAssets[${index}] 的媒体类型与 data URL 不一致。`);
    }
    const filePath = path.join(workDir, `reference-${String(index + 1).padStart(2, "0")}${extensionForMime(decoded.mimeType)}`);
    await fs.writeFile(filePath, decoded.buffer);
    const artifact = {
      outputKey: `references.${index + 1}`,
      path: filePath,
      status: "done",
      missing: false,
      mediaType,
      role: `reference_${mediaType}`,
      mimeType: decoded.mimeType,
      filename: safeReferenceName(asset.name, index, decoded.mimeType),
      sizeBytes: decoded.buffer.length,
      source: String(asset.source || "upload").trim() || "upload"
    };
    if (mediaType === "video" || mediaType === "audio") {
      artifact.durationSeconds = await probeMediaDuration(filePath, mediaType);
    }
    prepared.push(artifact);
  }
  validateAllReferenceArtifacts(prepared);
  return prepared;
}

function validateAllReferenceArtifacts(artifacts) {
  const grouped = Object.groupBy(artifacts, (item) => item.mediaType);
  const images = grouped.image || [];
  const videos = grouped.video || [];
  const audios = grouped.audio || [];
  if (!images.length && !videos.length) throw new ShotVideoConfigError("全能参考模式不能只上传音频；至少需要一张图片或一段视频。");
  if (images.length > 9) throw new ShotVideoConfigError(`全能参考图片最多 9 张，当前 ${images.length} 张。`);
  if (videos.length > 3) throw new ShotVideoConfigError(`全能参考视频最多 3 段，当前 ${videos.length} 段。`);
  if (audios.length > 3) throw new ShotVideoConfigError(`全能参考音频最多 3 段，当前 ${audios.length} 段。`);
  for (const item of [...videos, ...audios]) {
    if (item.durationSeconds < 2 || item.durationSeconds > 15) {
      throw new ShotVideoConfigError(`${item.filename} 时长必须在 2–15 秒之间，当前 ${formatDuration(item.durationSeconds)} 秒。`);
    }
  }
  if (videos.some((item) => item.sizeBytes > 50 * 1024 * 1024)) {
    throw new ShotVideoConfigError("单段参考视频不得超过 50MB。");
  }
  const videoDuration = videos.reduce((sum, item) => sum + item.durationSeconds, 0);
  const audioDuration = audios.reduce((sum, item) => sum + item.durationSeconds, 0);
  if (videoDuration > 15.05) throw new ShotVideoConfigError(`参考视频总时长不得超过 15 秒，当前 ${formatDuration(videoDuration)} 秒。`);
  if (audioDuration > 15.05) throw new ShotVideoConfigError(`参考音频总时长不得超过 15 秒，当前 ${formatDuration(audioDuration)} 秒。`);
}

function assertAllReferenceRequestSize(options) {
  const bytes = Buffer.byteLength(JSON.stringify(options), "utf8");
  if (bytes > 64 * 1024 * 1024) {
    throw new ShotVideoConfigError(`全能参考请求体不得超过 64MB，当前约 ${(bytes / 1024 / 1024).toFixed(1)}MB。`);
  }
}

function summarizeReferenceArtifacts(artifacts) {
  const counts = { image: 0, video: 0, audio: 0 };
  for (const artifact of artifacts) counts[artifact.mediaType] += 1;
  return counts;
}

function normalizeReferenceMediaType(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["image", "video", "audio"].includes(normalized)) return normalized;
  throw new ShotVideoConfigError(`不支持的全能参考媒体类型“${value || "空"}”。`);
}

function decodeDataUrl(dataUrl, fieldName) {
  const match = String(dataUrl || "").match(/^data:([^;,]+);base64,(.+)$/u);
  if (!match) throw new ShotVideoConfigError(`${fieldName} 不是有效的 base64 data URL。`);
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length) throw new ShotVideoConfigError(`${fieldName} 没有可用的媒体数据。`);
  return {
    mimeType: match[1].toLowerCase(),
    buffer
  };
}

async function probeMediaDuration(filePath, mediaType) {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration:stream=codec_type,duration",
      "-of", "json",
      filePath
    ]);
    const metadata = JSON.parse(String(stdout || "{}"));
    const streams = Array.isArray(metadata.streams) ? metadata.streams : [];
    if (!streams.some((stream) => stream.codec_type === mediaType)) {
      throw new Error(`缺少 ${mediaType} 流`);
    }
    const streamDuration = streams
      .filter((stream) => stream.codec_type === mediaType)
      .map((stream) => Number(stream.duration))
      .find((duration) => Number.isFinite(duration) && duration > 0);
    const duration = streamDuration || Number(metadata.format?.duration);
    if (!Number.isFinite(duration) || duration <= 0) throw new Error("时长无效");
    return duration;
  } catch {
    throw new ShotVideoConfigError(`无法读取参考${mediaType === "video" ? "视频" : "音频"}时长，请确认文件可播放并已安装 ffprobe。`);
  }
}

function safeReferenceName(name, index, mimeType) {
  const cleaned = String(name || "").trim().replace(/[\\/]+/gu, "_").slice(0, 120);
  return cleaned || `reference-${index + 1}${extensionForMime(mimeType)}`;
}

function formatDuration(value) {
  return Number(value).toFixed(2).replace(/\.00$/u, "");
}

function providerAuthConfigured(config = {}, runtime = {}) {
  return Boolean(
    config.apiKey
    || runtime.apiKey
    || config.headers?.Authorization
    || config.headers?.authorization
  );
}

function assertProviderProtocolCompatibility(provider, model, config = {}) {
  if (provider !== "Kling" || model !== "kling-v3") return;
  const preset = String(config.providerPreset || config.preset || "").trim().toLowerCase();
  const endpoint = String(config.videoEndpoint || config.endpoint || "").trim();
  if (isNonDomesticKlingApiEndpoint(endpoint)) {
    throw new ShotVideoConfigError("Kling 3.0 仅支持国内官方 API；请使用 api-beijing.klingai.com，并配置国内控制台签发的 KLING_API_KEY（兼容 KLING_V3_API_KEY）。");
  }
  if (["kling_image_to_video", "kling_image2video"].includes(preset) || /\/v1(?:\/|$)/u.test(endpoint)) {
    throw new ShotVideoConfigError("Kling 3.0 国内新版接口不能复用 2.1/Legacy provider config；请配置国内 KLING_API_KEY（兼容 KLING_V3_API_KEY），并使用 api-beijing.klingai.com/image-to-video/kling-3.0。");
  }
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
    "image/webp": ".webp",
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "video/webm": ".webm",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav"
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
