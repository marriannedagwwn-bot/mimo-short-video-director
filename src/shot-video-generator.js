import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { compileShotNegativePrompt } from "../public/negative-prompts.js";
import {
  assertVideoPromptProfile,
  VIDEO_PROMPT_PROFILE_IDS
} from "../public/video-prompt-profiles.js";
import {
  ANIMATION_DIRECT_PROMPT_SCHEMA_VERSION,
  ensureCharacterPromptMatchesBoundary
} from "./validation.js";
import { assertMiniMaxH3Duration } from "./minimax-h3-prompt.js";
import {
  mediaFilenameSegment,
  normalizeShotVideoContinuityReferenceMode,
  SHOT_VIDEO_CONTINUITY_PREVIOUS_SHOT_FRAMES
} from "./shot-video-continuity.js";
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
  const continuityReferenceMode = normalizeShotVideoContinuityReferenceMode(options.continuityReferenceMode);
  const aspectRatio = normalizeShotVideoAspectRatio(options.aspectRatio);
  const miniMaxH3Runtime = videoProvider === "MiniMax" && videoModel === "MiniMax-H3";
  if (miniMaxH3Runtime) {
    try {
      assertMiniMaxH3Duration(shot.durationSeconds, "shot.durationSeconds");
    } catch (error) {
      throw new ShotVideoConfigError(error.message);
    }
  }
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
  if (
    continuityReferenceMode === SHOT_VIDEO_CONTINUITY_PREVIOUS_SHOT_FRAMES
    && generationMode !== "all_reference"
  ) {
    throw new ShotVideoConfigError("上一镜抽帧只能作为 all_reference 的普通参考图，不能用于首尾帧模式。");
  }
  if (
    continuityReferenceMode === SHOT_VIDEO_CONTINUITY_PREVIOUS_SHOT_FRAMES
    && !options.trustedPreviousShotReference
  ) {
    throw new ShotVideoConfigError("上一镜抽帧缺少当前 Plan 签发的受信视频来源。");
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
  const requestNonce = safeSegment(options.requestNonce || randomUUID());
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
    let continuityReference = null;
    const inputArtifacts = generationMode === "first_last_frame"
      ? [frames.start, frames.end].map(({ url, receipt, ...artifact }) => artifact)
      : await (async () => {
        const uploadedArtifacts = await prepareAllReferenceArtifacts(options.referenceAssets, workDir);
        continuityReference = continuityReferenceMode === SHOT_VIDEO_CONTINUITY_PREVIOUS_SHOT_FRAMES
          ? await preparePreviousShotFrameArtifacts({
            reference: options.trustedPreviousShotReference,
            workDir,
            extractor: options.previousShotFrameExtractor
          })
          : null;
        const combined = [
          ...uploadedArtifacts,
          ...(continuityReference?.artifacts || [])
        ];
        validateAllReferenceArtifacts(combined, {
          maxTotal: miniMaxH3Runtime ? 12 : Number.POSITIVE_INFINITY
        });
        return combined;
      })();
    let effectiveVideoPrompt = String(shot.videoPrompt || "").trim();
    const videos = [];
    for (let index = 0; index < count; index += 1) {
      const suffix = count > 1 ? `-${index + 1}` : "";
      const outputPath = path.join(outputRoot, `${filenamePrefix}${shotId}-${stamp}-${requestNonce}${suffix}.mp4`);
      const request = buildShotVideoRequest(shot, {
        outputPath,
        inputArtifacts,
        candidateIndex: index,
        candidateCount: count,
        provider: videoProvider,
        model: videoModel,
        generationMode,
        aspectRatio,
        prompt: effectiveVideoPrompt,
        videoPromptProfile: options.videoPromptProfile,
      });
      const receipt = await runGenericWorker({ request, outputPath, workDir, configPath, workerRunner: options.workerRunner });
      await assertUsableVideoOutput(outputPath, {
        outputProbe: options.videoOutputProbe,
        skipFfprobeForInjectedWorker: Boolean(options.workerRunner) && !options.videoOutputProbe
      });
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
      videoPromptSource: options.videoPromptSource === "runtime_override" ? "runtime_override" : "animation_plan",
      sourceVideoPrompt: String(shot.videoPrompt || ""),
      effectiveVideoPrompt,
      promptReceipt: null,
      continuityReferenceReceipt: continuityReference
        ? {
          mode: SHOT_VIDEO_CONTINUITY_PREVIOUS_SHOT_FRAMES,
          continuityType: continuityReference.reference.continuityType || "intentional_next_shot",
          sourceShotId: continuityReference.reference.sourceShotId,
          sourceSceneId: continuityReference.reference.sourceSceneId || "",
          sceneId: continuityReference.reference.sceneId || "",
          selectedIndex: continuityReference.reference.selectedIndex,
          sourceOutputUrl: continuityReference.reference.sourceOutputUrl,
          sourceArtifact: continuityReference.reference.sourceArtifact,
          sourceVideoSha256: continuityReference.sourceVideoSha256,
          frameIntervalSeconds: 1,
          frameCount: continuityReference.artifacts.length,
          sourceDurationSeconds: continuityReference.durationSeconds,
          frames: continuityReference.artifacts.map((artifact) => ({
            timestampSeconds: artifact.timestampSeconds,
            sha256: artifact.sha256
          }))
        }
        : null,
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
    prompt: Object.hasOwn(context, "prompt") ? String(context.prompt || "") : shot.videoPrompt || "",
    ...(context.videoPromptProfile ? { videoPromptProfile: structuredClone(context.videoPromptProfile) } : {}),
    ...(context.promptDialect ? { promptDialect: context.promptDialect } : {}),
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

async function assertUsableVideoOutput(outputPath, { outputProbe, skipFfprobeForInjectedWorker = false } = {}) {
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
  if (typeof outputProbe === "function") {
    await outputProbe(outputPath);
  } else if (!skipFfprobeForInjectedWorker) {
    await probePlayableVideoOutput(outputPath);
  }
}

async function probePlayableVideoOutput(outputPath) {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration,format_name:stream=codec_type,duration",
      "-of", "json",
      outputPath
    ], {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      killSignal: "SIGKILL"
    });
    const metadata = JSON.parse(String(stdout || "{}"));
    const streams = Array.isArray(metadata.streams) ? metadata.streams : [];
    if (!streams.some((stream) => stream.codec_type === "video")) throw new Error("缺少视频流");
    const duration = streams
      .filter((stream) => stream.codec_type === "video")
      .map((stream) => Number(stream.duration))
      .find((value) => Number.isFinite(value) && value > 0)
      || Number(metadata.format?.duration);
    if (!Number.isFinite(duration) || duration <= 0) throw new Error("视频时长无效");
  } catch (error) {
    throw new ShotVideoProviderError(`视频生成服务返回的文件无法通过 ffprobe 播放性校验：${error.message || "无有效视频流"}。`);
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
      logicalName: safeReferenceName(asset.name, index, decoded.mimeType),
      sizeBytes: decoded.buffer.length,
      sha256: sha256Bytes(decoded.buffer),
      source: String(asset.source || "upload").trim() || "upload",
      sourceCharacterName: String(asset.sourceCharacterName || "").trim()
    };
    if (mediaType === "video" || mediaType === "audio") {
      artifact.durationSeconds = await probeMediaDuration(filePath, mediaType);
    }
    prepared.push(artifact);
  }
  return prepared;
}

async function preparePreviousShotFrameArtifacts({ reference, workDir, extractor } = {}) {
  const frameExtractor = typeof extractor === "function" ? extractor : extractVideoFramesEverySecond;
  const sourceSnapshot = await snapshotTrustedPreviousVideo(reference, workDir);
  const extracted = await frameExtractor({
    sourcePath: sourceSnapshot.path,
    outputDirectory: workDir,
    sourceShotId: reference.sourceShotId
  });
  const frames = Array.isArray(extracted?.frames) ? extracted.frames : [];
  if (!frames.length) {
    throw new ShotVideoConfigError(`${reference.sourceShotId} 没有抽取到可用视频帧。`);
  }
  if (frames.length > 9) {
    throw new ShotVideoConfigError(`${reference.sourceShotId} 按每秒一帧抽取后得到 ${frames.length} 张，超过全能参考图片上限 9 张。`);
  }
  const artifacts = [];
  const trustedWorkDir = path.resolve(workDir);
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index] || {};
    const filePath = path.resolve(String(frame.path || ""));
    if (path.dirname(filePath) !== trustedWorkDir) {
      throw new ShotVideoConfigError(`${reference.sourceShotId} 的抽帧文件不在当前生成任务临时目录中。`);
    }
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size < 1) {
      throw new ShotVideoConfigError(`${reference.sourceShotId} 的第 ${index + 1} 张抽帧不可用。`);
    }
    const frameBytes = await fs.readFile(filePath);
    artifacts.push({
      outputKey: `references.previous-shot.${index + 1}`,
      path: filePath,
      status: "done",
      missing: false,
      mediaType: "image",
      role: "reference_image",
      mimeType: "image/jpeg",
      filename: `${safeSegment(reference.sourceShotId)}-${String(index + 1).padStart(2, "0")}.jpg`,
      sizeBytes: stat.size,
      source: "previous_shot_frame",
      sourceShotId: reference.sourceShotId,
      sha256: sha256Bytes(frameBytes),
      timestampSeconds: Number.isFinite(Number(frame.timestampSeconds))
        ? Number(frame.timestampSeconds)
        : index
    });
  }
  return {
    reference,
    sourceVideoSha256: sourceSnapshot.sha256,
    durationSeconds: Number(extracted.durationSeconds) || 0,
    artifacts
  };
}

async function snapshotTrustedPreviousVideo(reference = {}, workDir = "") {
  const sourcePath = String(reference.sourcePath || "");
  let sourceHandle;
  try {
    sourceHandle = await fs.open(sourcePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = await sourceHandle.stat();
    if (!before.isFile() || before.size < 8 || before.size > 50 * 1024 * 1024) {
      throw new Error("文件类型或大小无效");
    }
    const bytes = await sourceHandle.readFile();
    const after = await sourceHandle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size) {
      throw new Error("读取期间文件发生变化");
    }
    const snapshotPath = path.join(workDir, `previous-${safeSegment(reference.sourceShotId)}-source.mp4`);
    await fs.writeFile(snapshotPath, bytes, { flag: "wx" });
    return { path: snapshotPath, sha256: sha256Bytes(bytes) };
  } catch (error) {
    if (error instanceof ShotVideoConfigError) throw error;
    throw new ShotVideoConfigError(`${reference.sourceShotId || "上一镜"} 的受信视频无法冻结到当前生成任务：${error.message || "文件不可用"}。`);
  } finally {
    await sourceHandle?.close().catch(() => {});
  }
}

export async function extractVideoFramesEverySecond({
  sourcePath,
  outputDirectory,
  sourceShotId = "previous-shot",
  execFileRunner = execFileAsync,
  durationProbe = probeMediaDuration
} = {}) {
  const durationSeconds = await durationProbe(sourcePath, "video");
  if (durationSeconds > 9) {
    throw new ShotVideoConfigError(`${sourceShotId} 时长 ${formatDuration(durationSeconds)} 秒，按每秒一帧会超过全能参考图片上限 9 张。`);
  }
  const basename = `previous-${safeSegment(sourceShotId)}-frame`;
  const outputPattern = path.join(outputDirectory, `${basename}-%02d.jpg`);
  await execFileRunner("ffmpeg", [
    "-hide_banner",
    "-loglevel", "error",
    "-y",
    "-i", sourcePath,
    "-map", "0:v:0",
    "-an",
    "-vf", "fps=1,scale=w='if(gt(iw,ih),min(720,iw),-2)':h='if(gt(iw,ih),-2,min(720,ih))'",
    "-q:v", "4",
    outputPattern
  ], {
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
    killSignal: "SIGKILL"
  });
  const filenames = (await fs.readdir(outputDirectory))
    .filter((name) => name.startsWith(`${basename}-`) && name.endsWith(".jpg"))
    .sort();
  if (!filenames.length) {
    throw new ShotVideoConfigError(`${sourceShotId} 没有可解码的视频帧。`);
  }
  if (filenames.length > 9) {
    throw new ShotVideoConfigError(`${sourceShotId} 按每秒一帧抽取后得到 ${filenames.length} 张，超过全能参考图片上限 9 张。`);
  }
  return {
    durationSeconds,
    frames: filenames.map((name, index) => ({
      path: path.join(outputDirectory, name),
      timestampSeconds: index
    }))
  };
}

function validateAllReferenceArtifacts(artifacts, { maxTotal = Number.POSITIVE_INFINITY } = {}) {
  const grouped = Object.groupBy(artifacts, (item) => item.mediaType);
  const images = grouped.image || [];
  const videos = grouped.video || [];
  const audios = grouped.audio || [];
  if (!images.length && !videos.length) throw new ShotVideoConfigError("全能参考模式不能只上传音频；至少需要一张图片或一段视频。");
  if (images.length > 9) throw new ShotVideoConfigError(`全能参考图片最多 9 张，当前 ${images.length} 张。`);
  if (videos.length > 3) throw new ShotVideoConfigError(`全能参考视频最多 3 段，当前 ${videos.length} 段。`);
  if (audios.length > 3) throw new ShotVideoConfigError(`全能参考音频最多 3 段，当前 ${audios.length} 段。`);
  if (artifacts.length > maxTotal) {
    throw new ShotVideoConfigError(`MiniMax H3 混合参考素材总数最多 ${maxTotal} 项，当前 ${artifacts.length} 项。`);
  }
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
    ], {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      killSignal: "SIGKILL"
    });
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
  return mediaFilenameSegment(value);
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
