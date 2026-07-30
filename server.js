import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv, getConfig } from "./src/config.js";
import { MimoClient } from "./src/mimo-client.js";
import { QwenClient } from "./src/qwen-client.js";
import { JimengImageClient, JimengImageConfigError, JimengImageProviderError, buildCharacterReferenceImagePrompt, buildShotFrameImagePrompt } from "./src/jimeng-client.js";
import { buildFrameReferenceModeText, compileShotFrameNegativePrompt } from "./public/shot-frame-prompt.js";
import { buildFrameReferenceManifest } from "./public/shot-reference-images.js";
import { buildShotFrameMultiImagePrompt } from "./public/shot-frame-multi-image-prompt.js";
import { computeDependencyHash, computePromptHash } from "./src/frame-dependency.js";
import { assertFrameDependencyHash, normalizeEndpointReferenceImages } from "./src/frame-reference-request.js";
import { WorkflowService } from "./src/workflow.js";
import { ensureFrameReferenceModeCompatibility, InputError } from "./src/validation.js";
import { generateShotVideo, ShotVideoConfigError, ShotVideoProviderError } from "./src/shot-video-generator.js";
import {
  inferShotVideoProvider,
  isShotVideoModelAllowed,
  normalizeShotVideoProvider,
  resolveShotVideoSetting,
  shotVideoDefaultSetting,
  shotVideoProviderCatalog,
  shotVideoRuntimeConfig
} from "./src/shot-video-providers.js";
import { AttemptStore } from "./src/attempt-store.js";
import {
  compilerErrorMetadata,
  compilerErrorStatus,
  inferCompilerErrorStage,
  serializeServerError
} from "./src/server-error.js";

loadEnv();
const config = getConfig();
const mimoClient = config.mimo.enabled ? new MimoClient(config.mimo) : null;
const qwenClient = config.qwen.enabled ? new QwenClient(config.qwen) : null;
const jimengClient = config.jimeng.enabled ? new JimengImageClient(config.jimeng) : null;
const stageDefaults = buildStageDefaults(config, { mimoClient, qwenClient });
const modelStages = buildModelStages(stageDefaults, config);
const clients = { MiMo: mimoClient, Qwen: qwenClient };
const workflow = new WorkflowService({
  clients,
  stageDefaults
});
const attemptStore = new AttemptStore();
const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, "public");

const routes = {
  "/api/analyze": (body) => workflow.analyze(body),
  "/api/reconstruct": (body) => workflow.reconstruct(body),
  "/api/brief": (body) => workflow.createBrief(body),
  "/api/visual-guardrails": (body) => workflow.createVisualGuardrails(body),
  "/api/variants": (body) => workflow.createVariants(body),
  "/api/full-story": (body) => workflow.createFullStory(body),
  "/api/animation-plan": (body) => body?.includeCompilerMetadata
    ? workflow.createAnimationPlanWithMetadata(body)
    : workflow.createAnimationPlan(body),
  "/api/refine-character-reference": (body) => workflow.refineCharacterReference(body),
  "/api/generate-shot-video": (body) => {
    const setting = shotVideoRequestSetting(body);
    return generateShotVideo({
      ...body,
      videoProvider: setting.provider,
      videoModel: setting.model
    });
  },
  "/api/run": (body) => workflow.run(body)
};

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (request.method === "GET" && url.pathname === "/api/health") {
      const [providerHealth, stageHealth, imageProvider] = await Promise.all([
        healthByProvider(clients, config),
        healthByStage(clients, stageDefaults),
        jimengClient ? jimengClient.checkHealth() : { reachable: false, modelAvailable: false, status: 0 }
      ]);
      const analysisStage = stageDefaults.analysis || {};
      const storyStage = stageDefaults.fullStory || {};
      const animationStage = stageDefaults.animationPlan || {};
      const analysisHealth = stageHealth.analysis || { reachable: false, modelAvailable: false, status: 0 };
      const storyHealth = stageHealth.fullStory || { reachable: false, modelAvailable: false, status: 0 };
      const animationHealth = stageHealth.animationPlan || { reachable: false, modelAvailable: false, status: 0 };
      const analysisMedia = mediaSettingsForProvider(analysisStage.provider, config);
      const shotVideoStage = modelStages.shotVideo || {};
      const shotVideoHealth = providerHealth[shotVideoStage.provider] || {};
      const fullStageHealth = {
        ...stageHealth,
        imageGeneration: compactHealth(imageProvider),
        shotVideo: {
          reachable: Boolean(shotVideoHealth.reachable),
          modelAvailable: Boolean(
            shotVideoHealth.modelAvailable
            && isShotVideoModelAllowed(shotVideoStage.provider, shotVideoStage.model)
          ),
          status: Number(shotVideoHealth.status) || 0
        }
      };
      return json(response, 200, {
        ok: true,
        mode: workflow.mode,
        model: analysisStage.model,
        analysisModel: analysisStage.model,
        storyModel: storyStage.model,
        animationModel: animationStage.model,
        baseProvider: analysisStage.provider,
        analysisProvider: analysisStage.provider,
        storyProvider: storyStage.provider,
        animationProvider: animationStage.provider,
        providerConfigured: Boolean(clients[analysisStage.provider]),
        providerReachable: analysisHealth.reachable,
        modelAvailable: analysisHealth.modelAvailable,
        analysisModelAvailable: analysisHealth.modelAvailable,
        storyModelAvailable: storyHealth.modelAvailable,
        animationModelAvailable: animationHealth.modelAvailable,
        analysisProviderReachable: analysisHealth.reachable,
        storyProviderReachable: storyHealth.reachable,
        animationProviderReachable: animationHealth.reachable,
        providers: providerHealth,
        modelStages,
        stageHealth: fullStageHealth,
        imageProvider: "Jimeng",
        imageModel: config.jimeng.model,
        imageProviderConfigured: config.jimeng.enabled,
        imageProviderReachable: imageProvider.reachable,
        imageModelAvailable: imageProvider.modelAvailable,
        mediaMode: analysisMedia.mediaMode,
        nativeVideoMaxBytes: analysisMedia.nativeVideoMaxBytes,
        timeouts: {
          serverRequestMs: config.serverRequestTimeoutMs,
          qwenGenerationMs: config.qwen.requestTimeoutMs,
          mimoGenerationMs: config.mimo.requestTimeoutMs,
          staticFrameCompilerMs: config.staticFrameCompiler.requestTimeoutMs
        }
      });
    }
    if (request.method === "POST" && url.pathname === "/api/generate-character-reference-images") {
      return streamCharacterReferenceImages(request, response);
    }
    if (request.method === "POST" && url.pathname === "/api/generate-shot-frame-image") {
      const body = await readJson(request);
      const result = await generateShotFrameImage(body);
      return json(response, 200, { ok: true, mode: workflow.mode, result });
    }
    if (request.method === "POST" && routes[url.pathname]) {
      const body = await readJson(request);
      const result = await routes[url.pathname](body);
      return json(response, 200, { ok: true, mode: workflow.mode, result });
    }
    if (request.method === "GET" || request.method === "HEAD") return serveStatic(url.pathname, response, request.method === "HEAD");
    return json(response, 404, { ok: false, error: "接口不存在" });
  } catch (error) {
    const serialized = serializeServerError(error, { attemptStore });
    if (serialized.log) console.error(serialized.log);
    return json(response, serialized.status, serialized.body);
  }
});

server.requestTimeout = config.serverRequestTimeoutMs;

server.listen(config.port, () => {
  console.log(`AI 短视频导演：http://localhost:${config.port}`);
  console.log(`运行模式：${workflow.mode === "live" ? `${stageDefaults.analysis.provider} (${stageDefaults.analysis.model}) / 剧情 ${stageDefaults.fullStory.provider} ${stageDefaults.fullStory.model} / 动画 ${stageDefaults.animationPlan.provider} ${stageDefaults.animationPlan.model} / 静态帧编译 ${stageDefaults.staticFrameCompiler.provider || "未配置"} ${stageDefaults.staticFrameCompiler.model || ""}` : "演示数据（配置 .env 后接入模型服务）"}`);
  console.log(`生成请求超时：${Math.round(config.qwen.requestTimeoutMs / 60000)} 分钟（Qwen）/ ${Math.round(config.mimo.requestTimeoutMs / 60000)} 分钟（MiMo）`);
});

function buildStageDefaults(config, { mimoClient = null, qwenClient = null } = {}) {
  const provider = qwenClient ? "Qwen" : "MiMo";
  const source = provider === "Qwen" ? config.qwen : config.mimo;
  return {
    analysis: stageSetting(provider, source.analysisModel || source.videoModel || source.model, source.analysisMaxCompletionTokens || source.maxCompletionTokens),
    reconstruction: stageSetting(provider, source.reconstructionModel || source.videoModel || source.model, source.reconstructionMaxCompletionTokens || source.maxCompletionTokens),
    brief: stageSetting(provider, source.briefModel || source.model, source.briefMaxCompletionTokens || source.maxCompletionTokens),
    visualGuardrails: stageSetting(provider, source.visualModel || source.videoModel || source.model, source.visualMaxCompletionTokens || source.maxCompletionTokens),
    variants: stageSetting(provider, source.variantsModel || source.model, source.variantsMaxCompletionTokens || source.maxCompletionTokens),
    fullStory: stageSetting(provider, source.storyModel || source.model, source.storyMaxCompletionTokens || source.maxCompletionTokens),
    animationPlan: stageSetting(provider, source.animationModel || source.storyModel || source.model, source.animationMaxCompletionTokens || source.maxCompletionTokens),
    staticFrameCompiler: stageSetting(
      config.staticFrameCompiler.provider,
      config.staticFrameCompiler.model,
      config.staticFrameCompiler.maxCompletionTokens,
      config.staticFrameCompiler.requestTimeoutMs
    ),
    characterReference: stageSetting(provider, source.characterReferenceModel || source.videoModel || source.model, source.characterReferenceMaxCompletionTokens || source.maxCompletionTokens)
  };
}

function buildModelStages(stageDefaults, config) {
  const shotVideo = shotVideoDefaultSetting();
  return {
    ...stageDefaults,
    imageGeneration: stageSetting("Jimeng", config.jimeng.model, null),
    shotVideo: stageSetting(shotVideo.provider, shotVideo.model, null)
  };
}

function modelOverrideFor(body = {}, stage) {
  const value = body.modelOverrides?.[stage] || {};
  return typeof value === "object" ? String(value.model || "").trim() : "";
}

function shotVideoRequestSetting(body = {}) {
  const rawOverride = body.modelOverrides?.shotVideo;
  if (rawOverride !== undefined && (!rawOverride || typeof rawOverride !== "object" || Array.isArray(rawOverride))) {
    throw new ShotVideoConfigError("首尾帧视频模型覆盖必须同时包含 provider 和 model。");
  }
  const overrideProvider = String(rawOverride?.provider || "").trim();
  const overrideModel = String(rawOverride?.model || "").trim();
  if (rawOverride !== undefined && (!overrideProvider || !overrideModel)) {
    throw new ShotVideoConfigError("首尾帧视频模型覆盖必须同时包含 provider 和 model。");
  }

  const requestedProvider = overrideProvider || String(body.videoProvider || "").trim();
  const requestedModel = overrideModel || String(body.videoModel || "").trim();
  const normalizedProvider = normalizeShotVideoProvider(requestedProvider);
  if (requestedProvider && !normalizedProvider) {
    throw new ShotVideoConfigError(`不支持首尾帧视频提供商“${requestedProvider}”。`);
  }

  // Keep an explicitly configured legacy generic worker route intact. Named
  // providers still go through the strict provider/model compatibility check.
  if (body.configPath && !requestedProvider) {
    return { provider: "", model: requestedModel };
  }
  if (normalizedProvider === "VideoHTTP") {
    const inferredProvider = inferShotVideoProvider({ model: requestedModel });
    if (inferredProvider) {
      if (!isShotVideoModelAllowed(inferredProvider, requestedModel)) {
        throw new ShotVideoConfigError(`${inferredProvider} 不支持首尾帧视频模型“${requestedModel}”。`);
      }
      return { provider: inferredProvider, model: requestedModel };
    }
    return { provider: "VideoHTTP", model: requestedModel };
  }

  const setting = resolveShotVideoSetting({
    provider: requestedProvider,
    model: requestedModel
  });
  if (setting.provider === "VideoHTTP") return setting;
  if (!["Kling", "Seedance"].includes(setting.provider)) {
    throw new ShotVideoConfigError(`不支持首尾帧视频提供商“${setting.provider || requestedProvider}”。`);
  }
  if (!isShotVideoModelAllowed(setting.provider, setting.model)) {
    throw new ShotVideoConfigError(`${setting.provider} 不支持首尾帧视频模型“${setting.model}”。`);
  }
  return setting;
}

function videoHttpModel() {
  return process.env.VIDEO_HTTP_VIDEO_MODEL?.trim() || process.env.VIDEO_HTTP_MODEL?.trim() || "";
}

function stageSetting(provider, model, maxCompletionTokens, requestTimeoutMs = null) {
  const tokenNumber = maxCompletionTokens === null || maxCompletionTokens === undefined || maxCompletionTokens === ""
    ? null
    : Number(maxCompletionTokens);
  const timeoutNumber = requestTimeoutMs === null || requestTimeoutMs === undefined || requestTimeoutMs === ""
    ? null
    : Number(requestTimeoutMs);
  return {
    provider,
    model,
    maxCompletionTokens: Number.isFinite(tokenNumber) ? Math.round(tokenNumber) : null,
    requestTimeoutMs: Number.isFinite(timeoutNumber) ? Math.round(timeoutNumber) : null
  };
}

async function healthByProvider(clients, config) {
  const entries = await Promise.all(Object.entries({
    MiMo: { client: clients.MiMo, model: config.mimo.model, media: mediaSettingsForProvider("MiMo", config) },
    Qwen: { client: clients.Qwen, model: config.qwen.model, media: mediaSettingsForProvider("Qwen", config) }
  }).map(async ([provider, value]) => {
    const health = value.client
      ? await value.client.checkHealth(value.model)
      : { reachable: false, modelAvailable: false, status: 0 };
    return [provider, {
      configured: Boolean(value.client),
      defaultModel: value.model,
      ...value.media,
      reachable: health.reachable,
      modelAvailable: health.modelAvailable,
      status: health.status
    }];
  }));
  const shotVideoProviders = shotVideoProviderCatalog();
  const defaultShotVideo = shotVideoDefaultSetting();
  const genericVideoRuntime = shotVideoRuntimeConfig("VideoHTTP");
  const genericVideoConfigured = Boolean(genericVideoRuntime.configPath || genericVideoRuntime.endpoint);
  const genericVideoHealth = {
    configured: genericVideoConfigured,
    defaultModel: genericVideoRuntime.model,
    reachable: Boolean(genericVideoRuntime.endpoint),
    modelAvailable: Boolean(genericVideoRuntime.model),
    status: genericVideoRuntime.endpoint ? 200 : 0
  };
  return {
    ...Object.fromEntries(entries),
    Jimeng: {
      configured: config.jimeng.enabled,
      defaultModel: config.jimeng.model,
      reachable: false,
      modelAvailable: config.jimeng.enabled,
      status: 0
    },
    ...shotVideoProviders,
    VideoHTTP: {
      ...genericVideoHealth,
      defaultModel: defaultShotVideo.provider === "VideoHTTP"
        ? defaultShotVideo.model || genericVideoRuntime.model
        : videoHttpModel()
    }
  };
}

async function healthByStage(clients, stageDefaults) {
  const cache = new Map();
  const entries = await Promise.all(Object.entries(stageDefaults).map(async ([stage, setting]) => {
    const key = `${setting.provider}:${setting.model}`;
    if (!cache.has(key)) {
      const client = clients[setting.provider];
      cache.set(key, client
        ? client.checkHealth(setting.model)
        : Promise.resolve({ reachable: false, modelAvailable: false, status: 0 }));
    }
    return [stage, compactHealth(await cache.get(key))];
  }));
  return Object.fromEntries(entries);
}

function compactHealth(health = {}) {
  return {
    reachable: Boolean(health.reachable),
    modelAvailable: Boolean(health.modelAvailable),
    status: Number(health.status) || 0
  };
}

function mediaSettingsForProvider(provider, config) {
  if (provider === "Qwen") {
    return {
      mediaMode: config.qwen.mediaMode,
      nativeVideoMaxBytes: config.qwen.nativeVideoMaxBytes,
      videoFps: config.qwen.videoFps
    };
  }
  return {
    mediaMode: config.mimo.mediaMode,
    nativeVideoMaxBytes: config.mimo.nativeVideoMaxBytes,
    videoFps: config.mimo.videoFps
  };
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  const limit = 32 * 1024 * 1024;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new InputError("请求过大，请减少采样画面数量或尺寸");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new InputError("请求 JSON 格式无效");
  }
}

async function streamCharacterReferenceImages(request, response) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive"
  });
  const send = (event, data) => {
    response.write(`event: ${event}\n`);
    response.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  try {
    const body = await readJson(request);
    if (!jimengClient) throw new JimengImageConfigError("未配置即梦文生图服务。请在 .env 中设置 JIMENG_API_KEY。");
    const count = Math.max(1, Math.min(config.jimeng.maxImages, Math.round(Number(body.count) || 1)));
    const imageModel = modelOverrideFor(body, "imageGeneration") || config.jimeng.model;
    const prompt = String(body.prompt || "").trim() || buildCharacterReferenceImagePrompt(body.characterReference, count);
    send("progress", {
      type: "start",
      message: `正在调用即梦 ${imageModel} 生成 ${count} 张角色参考图…`,
      model: imageModel,
      count,
      prompt
    });
    await jimengClient.generateImagesStream({
      referenceImageDataUrl: body.referenceImageDataUrl,
      characterReference: body.characterReference,
      count,
      prompt,
      model: imageModel
    }, async (event) => {
      if (event.type === "image_generation.partial_succeeded") {
        const image = await persistGeneratedImage(event, body.characterReference);
        send("image", {
          type: "image",
          imageIndex: Number(event.image_index) || 0,
          characterName: body.characterReference?.characterName || "",
          model: event.model || imageModel,
          created: event.created || Math.round(Date.now() / 1000),
          size: event.size || image.size || "",
          url: image.url,
          filename: image.filename,
          prompt
        });
        return;
      }
      if (event.type === "image_generation.partial_failed") {
        send("image-error", streamErrorPayload(event.error, "单张图片生成失败", {
          type: "image-error",
          imageIndex: Number(event.image_index) || 0,
          code: event.error?.code || ""
        }));
        return;
      }
      if (event.type === "image_generation.completed") {
        send("completed", { type: "completed", usage: event.usage || {}, model: event.model || imageModel });
        return;
      }
      if (event.error) {
        send("error", streamErrorPayload(event.error, "即梦图片生成失败"));
      }
    });
    send("done", { type: "done" });
  } catch (error) {
    send("error", streamErrorPayload(error, "角色参考图生成失败"));
  } finally {
    response.end();
  }
}

async function generateShotFrameImage(body = {}) {
  if (!jimengClient) throw new JimengImageConfigError("未配置即梦文生图服务。请在 .env 中设置 JIMENG_API_KEY。");
  const frameKind = body.frameKind === "end" ? "end" : "start";
  const shot = body.shot || {};
  const frameReferenceMode = String(body.frameReferenceMode || "").trim();
  if (frameReferenceMode && frameKind !== "end") {
    throw new InputError("frameReferenceMode 只允许用于尾帧生成");
  }
  const endpointReferences = normalizeEndpointReferenceImages(body.referenceImages, {
    frameKind,
    frameReferenceMode,
    shotId: shot.shotId
  });
  if (frameReferenceMode) {
    ensureFrameReferenceModeCompatibility(shot, frameReferenceMode, {
      hasStartFrame: endpointReferences.length === 1,
      hasStartFrameReference: endpointReferences.length === 1
    });
  }
  let manifest;
  try {
    manifest = await buildFrameReferenceManifest({
      frameKind: frameReferenceMode ? frameKind : "start",
      frameReferenceMode: frameReferenceMode || undefined,
      endpointReference: endpointReferences[0] || null,
      characterReferences: body.characterReferences,
      maxProviderImages: 6
    });
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError(error.message || "参考图清单无效");
  }
  const negativePromptDelivery = compileShotFrameNegativePrompt(shot);
  const basePrompt = String(body.prompt || "").trim() || buildShotFrameImagePrompt({
    frameKind,
    shot,
    visualBible: body.visualBible,
    characterReferences: body.characterReferences,
    sceneReference: body.sceneReference,
    referenceManifest: manifest,
    frameReferenceMode
  });
  const prompt = appendMissingLines(basePrompt, [
    ...frameReferenceManifestPromptLines(manifest, frameReferenceMode, {
      shot,
      frameKind,
      sceneReference: body.sceneReference
    }),
    ...negativePromptDelivery.positiveConstraints
  ]);
  let authoritativeDependencyHash = "";
  try {
    authoritativeDependencyHash = frameReferenceMode
      ? await computeDependencyHash({
        startImageDataUrl: manifest.endpointReference?.dataUrl || "",
        endState: shot.endFrame,
        referenceImages: manifest.additionalReferences,
        frameReferenceMode
      })
      : "";
  } catch (error) {
    throw new InputError(error.message || "尾帧依赖哈希无法计算");
  }
  if (frameReferenceMode) assertFrameDependencyHash(body.dependencyHash, authoritativeDependencyHash);
  const count = clampFrameImageCount(body.count);
  const providerPrompt = buildShotFrameMultiImagePrompt(prompt, count);
  const authoritativePromptHash = frameReferenceMode ? await computePromptHash(providerPrompt) : "";
  const imageModel = modelOverrideFor(body, "imageGeneration") || config.jimeng.model;
  const uploadedReferences = manifest.providerImages.map((item) => item.dataUrl);
  const images = [];
  const requestReceipt = await jimengClient.generateImagesStream({
    count,
    prompt: providerPrompt,
    referenceImageDataUrls: uploadedReferences,
    model: imageModel,
    negativePromptDelivery
  }, async (event) => {
    if (event.type === "image_generation.partial_succeeded") {
      images.push(await persistGeneratedImage(event, {
        characterName: `${shot.shotId || "shot"}-${frameKind}-frame`
      }));
    }
    if (event.type === "image_generation.partial_failed") {
      throw new JimengImageProviderError(event.error?.message || event.error?.code || "镜头帧图片生成失败", JSON.stringify(event.error || {}));
    }
    if (event.error) throw new JimengImageProviderError(event.error?.message || "镜头帧图片生成失败", JSON.stringify(event.error || {}));
  });
  const image = images[0];
  if (!image) throw new JimengImageProviderError("即梦没有返回可用的镜头帧图片");
  if (images.length !== count) {
    throw new JimengImageProviderError(
      `镜头帧图片数量不足：请求 ${count} 张，实际返回 ${images.length} 张`,
      JSON.stringify({ requested: count, actual: images.length })
    );
  }
  return {
    frameKind,
    shotId: shot.shotId || "",
    prompt,
    providerPrompt,
    model: imageModel,
    url: image.url,
    filename: image.filename,
    size: image.size || "",
    count,
    actualCount: images.length,
    images: images.map((item) => ({
      url: item.url,
      filename: item.filename,
      size: item.size || "",
      model: imageModel,
      referenceImageCount: uploadedReferences.length,
      ...(frameReferenceMode ? {
        frameReferenceMode,
        dependencyHash: authoritativeDependencyHash,
        promptHash: authoritativePromptHash,
        usedStartFrameReference: Boolean(manifest.endpointReference?.usedByProvider)
      } : {})
    })),
    referenceImageCount: uploadedReferences.length,
    referenceImageManifest: manifest.providerImages.map(({ index, token, role, contentHash, characterName = "", sourceShotId = "" }) => ({
      index,
      token,
      role,
      contentHash,
      characterName,
      sourceShotId
    })),
    ...(frameReferenceMode ? {
      frameReferenceMode,
      dependencyHash: authoritativeDependencyHash,
      promptHash: authoritativePromptHash,
      usedStartFrameReference: Boolean(manifest.endpointReference?.usedByProvider),
      clientPromptHashMatched: !body.promptHash || body.promptHash === authoritativePromptHash
    } : {}),
    negativePromptDelivery: requestReceipt?.negativePromptDelivery || {},
    requestPreview: requestReceipt?.requestPreview || {},
    generatedAt: new Date().toISOString()
  };
}

function frameReferenceManifestPromptLines(manifest = {}, frameReferenceMode = "", context = {}) {
  const bindings = Array.isArray(manifest.promptBindings) ? manifest.promptBindings : [];
  const lines = bindings.map((binding) => `${binding.token}：${binding.description}`);
  const modeText = buildFrameReferenceModeText({
    shot: context.shot,
    frameKind: context.frameKind,
    frameReferenceMode,
    referenceManifest: manifest,
    sceneReference: context.sceneReference
  });
  return [...lines, ...String(modeText || "").split("\n").map((line) => line.trim()).filter(Boolean)];
}

function appendMissingLines(prompt, lines = []) {
  const additions = (Array.isArray(lines) ? lines : [])
    .map((line) => String(line || "").trim())
    .filter((line) => line && !String(prompt || "").includes(line));
  return additions.length ? [String(prompt || "").trim(), ...additions].filter(Boolean).join("\n") : String(prompt || "").trim();
}

function clampFrameImageCount(value) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return 1;
  return Math.min(6, Math.max(1, number));
}

async function persistGeneratedImage(event, characterReference = {}) {
  const outputRoot = path.join(publicDir, "generated-images");
  await fs.mkdir(outputRoot, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:.]/gu, "").replace(/Z$/u, "");
  const name = safeSegment(characterReference.characterName || "character");
  const index = Number(event.image_index) || 0;
  const extension = extensionForImage(config.jimeng.outputFormat || "png");
  const filename = `${name}-reference-${stamp}-${index + 1}${extension}`;
  const file = path.join(outputRoot, filename);
  if (event.b64_json) {
    await fs.writeFile(file, Buffer.from(stripDataUrlPrefix(event.b64_json), "base64"));
  } else if (event.url) {
    const imageResponse = await fetch(event.url, { signal: AbortSignal.timeout(60_000) });
    if (!imageResponse.ok) throw new JimengImageProviderError(`下载即梦图片失败（${imageResponse.status}）`);
    await fs.writeFile(file, Buffer.from(await imageResponse.arrayBuffer()));
  } else {
    throw new JimengImageProviderError("即梦流式事件没有返回图片数据");
  }
  return {
    filename,
    url: `/generated-images/${filename}`,
    path: file,
    size: event.size || ""
  };
}

async function serveStatic(pathname, response, headOnly) {
  const relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  const file = path.resolve(publicDir, relative);
  if (!file.startsWith(`${publicDir}${path.sep}`) && file !== path.join(publicDir, "index.html")) return json(response, 403, { ok: false, error: "禁止访问" });
  try {
    const body = await fs.readFile(file);
    response.writeHead(200, { "content-type": mime(path.extname(file)), "cache-control": "no-cache" });
    response.end(headOnly ? undefined : body);
  } catch {
    try {
      const body = await fs.readFile(path.join(publicDir, "index.html"));
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(headOnly ? undefined : body);
    } catch {
      json(response, 404, { ok: false, error: "页面不存在" });
    }
  }
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function streamErrorPayload(error = {}, fallbackMessage, extra = {}) {
  const source = error && typeof error === "object" ? error : {};
  const stage = inferCompilerErrorStage(source) || String(source.stage || "");
  const status = streamErrorStatus(source, stage);
  const metadata = compilerErrorMetadata(source);
  return {
    type: "error",
    ...extra,
    error: source.message || source.code || fallbackMessage,
    ...(status ? { status } : {}),
    ...(stage ? { stage } : {}),
    ...(source.category ? { category: String(source.category) } : {}),
    ...(metadata ? { metadata } : {}),
    ...(source.code ? { code: String(source.code) } : {})
  };
}

function streamErrorStatus(error = {}, compilerStage = "") {
  const explicitStatus = Number(error.status || error.statusCode);
  if (Number.isInteger(explicitStatus) && explicitStatus >= 400 && explicitStatus <= 599) return explicitStatus;
  if (compilerStage) return compilerErrorStatus(error);
  if (
    error instanceof InputError
    || error instanceof JimengImageConfigError
    || error instanceof ShotVideoConfigError
  ) return 400;
  if (error.name === "AbortError" || error.name === "TimeoutError") return 504;
  return 502;
}

function mime(extension) {
  return ({
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm"
  })[extension] || "application/octet-stream";
}

function safeSegment(value) {
  return String(value || "item")
    .trim()
    .replace(/\s+/gu, "-")
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48) || "item";
}

function stripDataUrlPrefix(value) {
  return String(value || "").replace(/^data:[^;,]+;base64,/u, "");
}

function extensionForImage(format) {
  const normalized = String(format || "png").toLowerCase().replace(/^\./u, "");
  if (normalized === "jpg" || normalized === "jpeg") return ".jpg";
  if (normalized === "webp") return ".webp";
  return ".png";
}
