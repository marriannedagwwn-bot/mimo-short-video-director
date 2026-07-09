import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv, getConfig } from "./src/config.js";
import { MimoClient, ModelResponseError } from "./src/mimo-client.js";
import { QwenClient } from "./src/qwen-client.js";
import { JimengImageClient, JimengImageConfigError, JimengImageProviderError, buildCharacterReferenceImagePrompt, buildShotFrameImagePrompt } from "./src/jimeng-client.js";
import { WorkflowService } from "./src/workflow.js";
import { InputError, OutputContractError } from "./src/validation.js";
import { generateShotVideo, ShotVideoConfigError, ShotVideoProviderError } from "./src/shot-video-generator.js";

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
const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, "public");

const routes = {
  "/api/analyze": (body) => workflow.analyze(body),
  "/api/reconstruct": (body) => workflow.reconstruct(body),
  "/api/brief": (body) => workflow.createBrief(body),
  "/api/visual-guardrails": (body) => workflow.createVisualGuardrails(body),
  "/api/variants": (body) => workflow.createVariants(body),
  "/api/full-story": (body) => workflow.createFullStory(body),
  "/api/animation-plan": (body) => workflow.createAnimationPlan(body),
  "/api/refine-character-reference": (body) => workflow.refineCharacterReference(body),
  "/api/generate-shot-video": (body) => generateShotVideo({
    ...body,
    videoModel: modelOverrideFor(body, "shotVideo") || body.videoModel
  }),
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
      const fullStageHealth = {
        ...stageHealth,
        imageGeneration: compactHealth(imageProvider),
        shotVideo: { reachable: videoGenerationConfigured(), modelAvailable: Boolean(videoHttpModel()), status: videoGenerationConfigured() ? 200 : 0 }
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
        nativeVideoMaxBytes: analysisMedia.nativeVideoMaxBytes
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
    if (error instanceof InputError) return json(response, 400, { ok: false, error: error.message, details: error.details });
    if (error instanceof ShotVideoConfigError) return json(response, 400, { ok: false, error: error.message });
    if (error instanceof ShotVideoProviderError) return json(response, 502, { ok: false, error: "视频生成服务调用失败", detail: error.message });
    if (error instanceof JimengImageConfigError) return json(response, 400, { ok: false, error: error.message });
    if (error instanceof JimengImageProviderError) return json(response, 502, { ok: false, error: "即梦图片生成服务调用失败", detail: error.raw || error.message });
    if (error instanceof OutputContractError) return json(response, 502, { ok: false, error: `模型输出不完整：${error.message}` });
    if (error instanceof ModelResponseError) return json(response, 502, { ok: false, error: error.message, detail: error.raw });
    if (error.name === "AbortError" || error.name === "TimeoutError") return json(response, 504, { ok: false, error: "模型响应超时" });
    console.error(error);
    return json(response, 500, { ok: false, error: "服务器内部错误" });
  }
});

server.listen(config.port, () => {
  console.log(`AI 短视频导演：http://localhost:${config.port}`);
  console.log(`运行模式：${workflow.mode === "live" ? `${stageDefaults.analysis.provider} (${stageDefaults.analysis.model}) / 剧情 ${stageDefaults.fullStory.provider} ${stageDefaults.fullStory.model} / 动画 ${stageDefaults.animationPlan.provider} ${stageDefaults.animationPlan.model}` : "演示数据（配置 .env 后接入模型服务）"}`);
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
    characterReference: stageSetting(provider, source.characterReferenceModel || source.videoModel || source.model, source.characterReferenceMaxCompletionTokens || source.maxCompletionTokens)
  };
}

function buildModelStages(stageDefaults, config) {
  return {
    ...stageDefaults,
    imageGeneration: stageSetting("Jimeng", config.jimeng.model, null),
    shotVideo: stageSetting("VideoHTTP", videoHttpModel(), null)
  };
}

function modelOverrideFor(body = {}, stage) {
  const value = body.modelOverrides?.[stage] || {};
  return typeof value === "object" ? String(value.model || "").trim() : "";
}

function videoHttpModel() {
  return process.env.VIDEO_HTTP_VIDEO_MODEL?.trim() || process.env.VIDEO_HTTP_MODEL?.trim() || "";
}

function videoGenerationConfigured() {
  return Boolean(process.env.VIDEO_HTTP_VIDEO_ENDPOINT || process.env.VIDEO_HTTP_ENDPOINT || process.env.VIDEO_HTTP_CONFIG);
}

function stageSetting(provider, model, maxCompletionTokens) {
  const tokenNumber = maxCompletionTokens === null || maxCompletionTokens === undefined || maxCompletionTokens === ""
    ? null
    : Number(maxCompletionTokens);
  return {
    provider,
    model,
    maxCompletionTokens: Number.isFinite(tokenNumber) ? Math.round(tokenNumber) : null
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
  return {
    ...Object.fromEntries(entries),
    Jimeng: {
      configured: config.jimeng.enabled,
      defaultModel: config.jimeng.model,
      reachable: false,
      modelAvailable: config.jimeng.enabled,
      status: 0
    },
    VideoHTTP: {
      configured: videoGenerationConfigured(),
      defaultModel: videoHttpModel(),
      reachable: videoGenerationConfigured(),
      modelAvailable: Boolean(videoHttpModel()),
      status: videoGenerationConfigured() ? 200 : 0
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
        send("image-error", {
          type: "image-error",
          imageIndex: Number(event.image_index) || 0,
          error: event.error?.message || event.error?.code || "单张图片生成失败",
          code: event.error?.code || ""
        });
        return;
      }
      if (event.type === "image_generation.completed") {
        send("completed", { type: "completed", usage: event.usage || {}, model: event.model || imageModel });
        return;
      }
      if (event.error) {
        send("error", { type: "error", error: event.error?.message || "即梦图片生成失败", code: event.error?.code || "" });
      }
    });
    send("done", { type: "done" });
  } catch (error) {
    send("error", { type: "error", error: error.message || "角色参考图生成失败", detail: error.raw || "" });
  } finally {
    response.end();
  }
}

async function generateShotFrameImage(body = {}) {
  if (!jimengClient) throw new JimengImageConfigError("未配置即梦文生图服务。请在 .env 中设置 JIMENG_API_KEY。");
  const frameKind = body.frameKind === "end" ? "end" : "start";
  const shot = body.shot || {};
	  const prompt = String(body.prompt || "").trim() || buildShotFrameImagePrompt({
	    frameKind,
	    shot,
	    visualBible: body.visualBible,
	    characterReferences: body.characterReferences,
	    sceneReference: body.sceneReference
	  });
  const count = clampFrameImageCount(body.count);
  const imageModel = modelOverrideFor(body, "imageGeneration") || config.jimeng.model;
  const uploadedReferences = referenceImages(body.characterReferences);
  const images = [];
  await jimengClient.generateImagesStream({
    count,
    prompt: buildShotFrameMultiImagePrompt(prompt, count),
    referenceImageDataUrls: uploadedReferences,
    model: imageModel
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
      referenceImageCount: uploadedReferences.length
    })),
    referenceImageCount: uploadedReferences.length,
    generatedAt: new Date().toISOString()
  };
}

function buildShotFrameMultiImagePrompt(prompt, totalCount) {
  if (totalCount <= 1) return prompt;
  return [
    prompt,
    `本次必须一次性输出 ${totalCount} 张候选图，作为同一镜头的备选首尾帧。`,
    `这 ${totalCount} 张图必须保持同一镜头目标、角色、道具、画风、画幅、景别、机位、主体位置和动作状态一致，只允许表情细节、手指细节或光影有极轻微差异。`,
    `不要把候选图画成不同分镜，不要改变角色站位、镜头距离、视角或动作阶段。`,
    `不要只输出 1 张图。最终返回图片数量必须等于 ${totalCount} 张。`
  ].join("\n\n");
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

function referenceImages(characterReferences = []) {
  return (Array.isArray(characterReferences) ? characterReferences : [])
    .map((item) => item?.referenceImageDataUrl)
    .filter(Boolean)
    .slice(0, 6);
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
