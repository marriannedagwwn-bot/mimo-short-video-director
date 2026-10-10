import {
  canonicalShotVideoResolution,
  isShotVideoResolutionOption,
  shotVideoCodeDefaultResolution,
  shotVideoResolutionOptions
} from "../public/shot-video-resolutions.js";

export const KLING_VIDEO_MODELS = Object.freeze([
  "kling-v3",
  "kling-v2-1"
]);

export const SEEDANCE_VIDEO_MODELS = Object.freeze([
  "doubao-seedance-2-0-260128",
  "doubao-seedance-2-0-fast-260128",
  "doubao-seedance-2-0-mini-260615"
]);

export const MINIMAX_VIDEO_MODELS = Object.freeze([
  "MiniMax-H3"
]);

export const KLING_CN_V3_ENDPOINT = "https://api-beijing.klingai.com/image-to-video/kling-3.0";
// 只是 MINIMAX_VIDEO_ENDPOINT 缺省时的默认值，取国内区域。MiniMax 的国内
// （api.minimaxi.com）与国际（api.minimax.io）两个区域路径与请求体完全一致，
// 但 API Key 各自只在本区域有效——用哪个区域由用户配置显式决定，不做推断。
export const MINIMAX_H3_ENDPOINT = "https://api.minimaxi.com/v2/video_generation";

const SHOT_VIDEO_PROVIDERS = Object.freeze(["Kling", "Seedance", "MiniMax"]);

export const SHOT_VIDEO_GENERATION_MODES = Object.freeze([
  "first_last_frame",
  "all_reference"
]);

export function normalizeShotVideoGenerationMode(value = "") {
  const normalized = String(value || "").trim().toLowerCase();
  if (["all_reference", "all-reference", "reference", "r2v"].includes(normalized)) return "all_reference";
  return "first_last_frame";
}

export function isShotVideoGenerationModeSupported(provider, mode) {
  const normalizedProvider = normalizeShotVideoProvider(provider);
  const normalizedMode = normalizeShotVideoGenerationMode(mode);
  if (normalizedMode === "first_last_frame") return ["Kling", "Seedance", "MiniMax", "VideoHTTP"].includes(normalizedProvider);
  return ["Seedance", "MiniMax"].includes(normalizedProvider);
}

export function normalizeShotVideoProvider(value = "") {
  const normalized = String(value || "").trim().toLowerCase();
  if (["kling", "klingai", "kuaishou"].includes(normalized)) return "Kling";
  if (["seedance", "volcengine", "ark", "modelark", "dreamina"].includes(normalized)) return "Seedance";
  if (["minmax", "minimax", "minimaxi", "hailuo", "hailuoai", "h3"].includes(normalized)) return "MiniMax";
  if (["videohttp", "video_http", "generic", "custom"].includes(normalized)) return "VideoHTTP";
  return "";
}

export function inferShotVideoProvider({ model = "", preset = "" } = {}) {
  const modelName = String(model || "").trim();
  const presetName = String(preset || "").trim().toLowerCase();
  if (/^kling(?:-|$)/iu.test(modelName) || /kling/u.test(presetName)) return "Kling";
  if (/^(?:doubao|dreamina)-seedance-/iu.test(modelName) || /(?:seedance|modelark|dreamina)/u.test(presetName)) return "Seedance";
  if (/^minimax-h3$/iu.test(modelName) || /(?:minimax|hailuo|h3_video)/u.test(presetName)) return "MiniMax";
  return "";
}

export function shotVideoDefaultSetting(env = process.env) {
  const explicitProvider = normalizeShotVideoProvider(env.SHOT_VIDEO_PROVIDER);
  const legacyModel = clean(env.VIDEO_HTTP_VIDEO_MODEL || env.VIDEO_HTTP_MODEL);
  if ((!explicitProvider || explicitProvider === "VideoHTTP") && !legacyModel && clean(env.VIDEO_HTTP_CONFIG)) {
    return {
      provider: "VideoHTTP",
      model: ""
    };
  }
  const inferredProvider = inferShotVideoProvider({
    model: legacyModel,
    preset: env.VIDEO_HTTP_PRESET
  });
  const provider = explicitProvider && explicitProvider !== "VideoHTTP"
    ? explicitProvider
    : inferredProvider || (hasSeedanceSpecificConfig(env)
      ? "Seedance"
      : hasMiniMaxSpecificConfig(env) ? "MiniMax" : "Kling");
  const runtime = shotVideoRuntimeConfig(provider, env);
  return {
    provider,
    model: runtime.model
  };
}

export function resolveShotVideoSetting(input = {}, env = process.env) {
  const defaults = shotVideoDefaultSetting(env);
  const model = clean(input.model);
  const requestedProvider = normalizeShotVideoProvider(input.provider);
  const inferredProvider = inferShotVideoProvider({
    model,
    preset: input.preset
  });
  const provider = requestedProvider === "VideoHTTP"
    ? inferredProvider || "VideoHTTP"
    : requestedProvider || inferredProvider || defaults.provider;
  const runtime = shotVideoRuntimeConfig(provider, env, model);
  return {
    provider,
    model: model || runtime.model || defaults.model
  };
}

export function shotVideoRuntimeConfig(provider, env = process.env, requestedModel = "") {
  const normalized = normalizeShotVideoProvider(provider);
  if (normalized === "MiniMax") {
    const model = clean(requestedModel || env.MINIMAX_VIDEO_MODEL) || MINIMAX_VIDEO_MODELS[0];
    return {
      provider: "MiniMax",
      configPath: clean(env.MINIMAX_VIDEO_CONFIG),
      endpoint: clean(env.MINIMAX_VIDEO_ENDPOINT || env.MINIMAX_BASE_URL) || MINIMAX_H3_ENDPOINT,
      model,
      apiKey: clean(env.MINIMAX_API_KEY),
      providerPreset: clean(env.MINIMAX_VIDEO_PRESET) || "minimax_h3_video_generation",
      timeoutMs: clean(env.MINIMAX_VIDEO_TIMEOUT_MS),
      pollIntervalMs: clean(env.MINIMAX_VIDEO_POLL_INTERVAL_MS),
      pollTimeoutMs: clean(env.MINIMAX_VIDEO_POLL_TIMEOUT_MS),
      pollEndpointTemplate: clean(env.MINIMAX_VIDEO_POLL_ENDPOINT_TEMPLATE),
      resolution: clean(env.MINIMAX_VIDEO_RESOLUTION) || shotVideoCodeDefaultResolution("MiniMax", model),
      duration: clean(env.MINIMAX_VIDEO_DURATION),
      ratio: clean(env.MINIMAX_VIDEO_ASPECT_RATIO),
      watermark: booleanEnv(env.MINIMAX_WATERMARK, false),
      promptMaxChars: clean(env.MINIMAX_PROMPT_MAX_CHARS) || "7000",
      maxRequestBodyBytes: clean(env.MINIMAX_MAX_REQUEST_BODY_BYTES) || String(64 * 1024 * 1024),
      maxInputDataUrlBytes: clean(env.MINIMAX_MAX_REFERENCE_BYTES) || String(50 * 1024 * 1024)
    };
  }
  if (normalized === "Seedance") {
    const model = clean(requestedModel || env.SEEDANCE_VIDEO_MODEL) || SEEDANCE_VIDEO_MODELS[0];
    return {
      provider: "Seedance",
      configPath: clean(env.SEEDANCE_VIDEO_CONFIG),
      endpoint: clean(env.SEEDANCE_VIDEO_ENDPOINT || env.SEEDANCE_BASE_URL || env.JIMENG_BASE_URL),
      model,
      apiKey: clean(env.SEEDANCE_API_KEY || env.JIMENG_API_KEY),
      providerPreset: clean(env.SEEDANCE_VIDEO_PRESET) || "modelark_content_generation",
      timeoutMs: clean(env.SEEDANCE_VIDEO_TIMEOUT_MS),
      pollIntervalMs: clean(env.SEEDANCE_VIDEO_POLL_INTERVAL_MS),
      pollTimeoutMs: clean(env.SEEDANCE_VIDEO_POLL_TIMEOUT_MS),
      resolution: clean(env.SEEDANCE_VIDEO_RESOLUTION) || shotVideoCodeDefaultResolution("Seedance", model),
      duration: clean(env.SEEDANCE_VIDEO_DURATION),
      ratio: clean(env.SEEDANCE_VIDEO_ASPECT_RATIO),
      generateAudio: booleanEnv(env.SEEDANCE_GENERATE_AUDIO, true),
      watermark: booleanEnv(env.SEEDANCE_WATERMARK, false),
      returnLastFrame: booleanEnv(env.SEEDANCE_RETURN_LAST_FRAME, false),
      serviceTier: clean(env.SEEDANCE_SERVICE_TIER),
      executionExpiresAfter: clean(env.SEEDANCE_EXECUTION_EXPIRES_AFTER),
      maxInputDataUrlBytes: clean(env.SEEDANCE_MAX_REFERENCE_BYTES) || String(50 * 1024 * 1024)
    };
  }
  if (normalized === "Kling") {
    const model = clean(requestedModel || env.KLING_VIDEO_MODEL || env.VIDEO_HTTP_VIDEO_MODEL || env.VIDEO_HTTP_MODEL) || KLING_VIDEO_MODELS[0];
    const isV3 = model === "kling-v3";
    return {
      provider: "Kling",
      configPath: isV3
        ? clean(env.KLING_V3_CONFIG || env.KLING_VIDEO_CONFIG)
        : clean(env.KLING_VIDEO_CONFIG || env.VIDEO_HTTP_CONFIG),
      endpoint: isV3
        ? KLING_CN_V3_ENDPOINT
        : clean(env.KLING_VIDEO_ENDPOINT || env.VIDEO_HTTP_VIDEO_ENDPOINT || env.VIDEO_HTTP_ENDPOINT),
      model,
      apiKey: isV3
        ? clean(env.KLING_API_KEY || env.KLING_V3_API_KEY)
        : clean(env.KLING_API_KEY || env.VIDEO_HTTP_API_KEY),
      providerPreset: isV3
        ? clean(env.KLING_V3_PRESET || env.KLING_VIDEO_PRESET) || "kling_3_0_image_to_video"
        : clean(env.KLING_VIDEO_PRESET || env.VIDEO_HTTP_PRESET) || "kling_image_to_video",
      pollEndpointTemplate: isV3
        ? clean(env.KLING_V3_POLL_ENDPOINT_TEMPLATE || env.KLING_VIDEO_POLL_ENDPOINT_TEMPLATE)
        : clean(env.KLING_VIDEO_POLL_ENDPOINT_TEMPLATE || env.VIDEO_HTTP_POLL_ENDPOINT_TEMPLATE),
      timeoutMs: clean(env.KLING_VIDEO_TIMEOUT_MS || env.VIDEO_HTTP_TIMEOUT_MS),
      pollIntervalMs: clean(env.KLING_VIDEO_POLL_INTERVAL_MS || env.VIDEO_HTTP_POLL_INTERVAL_MS),
      pollTimeoutMs: clean(env.KLING_VIDEO_POLL_TIMEOUT_MS || env.VIDEO_HTTP_POLL_TIMEOUT_MS),
      duration: clean(env.KLING_VIDEO_DURATION || env.VIDEO_HTTP_VIDEO_DURATION),
      mode: clean(env.KLING_VIDEO_MODE || env.VIDEO_HTTP_VIDEO_MODE) || "pro",
      aspectRatio: clean(env.KLING_VIDEO_ASPECT_RATIO || env.VIDEO_HTTP_VIDEO_ASPECT_RATIO),
      sound: clean(env.KLING_VIDEO_SOUND || env.VIDEO_HTTP_VIDEO_SOUND),
      audio: isV3 ? clean(env.KLING_V3_AUDIO || env.KLING_VIDEO_AUDIO) || "native" : "",
      resolution: clean(env.KLING_VIDEO_RESOLUTION) || shotVideoCodeDefaultResolution("Kling", model),
      multiShot: booleanEnv(env.KLING_VIDEO_MULTI_SHOT, false),
      cfgScale: clean(env.KLING_CFG_SCALE || env.VIDEO_HTTP_CFG_SCALE),
      promptMaxChars: clean(env.KLING_PROMPT_MAX_CHARS || env.VIDEO_HTTP_PROMPT_MAX_CHARS),
      negativePromptMaxChars: clean(env.KLING_NEGATIVE_PROMPT_MAX_CHARS || env.VIDEO_HTTP_NEGATIVE_PROMPT_MAX_CHARS)
    };
  }
  return {
    provider: "VideoHTTP",
    configPath: clean(env.VIDEO_HTTP_CONFIG),
    endpoint: clean(env.VIDEO_HTTP_VIDEO_ENDPOINT || env.VIDEO_HTTP_ENDPOINT),
    model: clean(env.VIDEO_HTTP_VIDEO_MODEL || env.VIDEO_HTTP_MODEL),
    apiKey: clean(env.VIDEO_HTTP_API_KEY),
    providerPreset: clean(env.VIDEO_HTTP_PRESET),
    timeoutMs: clean(env.VIDEO_HTTP_TIMEOUT_MS),
    pollIntervalMs: clean(env.VIDEO_HTTP_POLL_INTERVAL_MS),
    pollTimeoutMs: clean(env.VIDEO_HTTP_POLL_TIMEOUT_MS)
  };
}

// 分辨率从哪个环境变量读（2026-10-10）。
export const SHOT_VIDEO_RESOLUTION_ENV_NAMES = Object.freeze({
  Seedance: "SEEDANCE_VIDEO_RESOLUTION",
  Kling: "KLING_VIDEO_RESOLUTION",
  MiniMax: "MINIMAX_VIDEO_RESOLUTION"
});

// 某个视频模型在「没选分辨率」时会用哪个值、从哪来（2026-10-10）。优先级与 worker 合并配置的顺序一致：
// 供应商配置文件 > 环境变量 > 代码默认值。只知道配置文件路径、还没读到文件时报 config_file 且值留空，
// 要等生成时读到文件才知道。值对不上这个模型的清单时给出 error，不替换成别的值。
export function shotVideoConfiguredResolution(provider, model, { env = process.env, fileConfig = null, configPath = "" } = {}) {
  const normalized = normalizeShotVideoProvider(provider);
  const options = shotVideoResolutionOptions(normalized, model);
  if (!options.length) return { value: "", source: "unsupported", error: "" };
  const envName = SHOT_VIDEO_RESOLUTION_ENV_NAMES[normalized];
  let raw;
  let source;
  let origin;
  if (fileConfig && Object.hasOwn(fileConfig, "resolution")) {
    // 配置文件里写了空值，与 worker 一样按没写处理：用代码默认值。
    if (!clean(fileConfig.resolution)) return { value: shotVideoCodeDefaultResolution(normalized, model), source: "code_default", error: "" };
    raw = fileConfig.resolution;
    source = "config_file";
    origin = "供应商配置文件里的 resolution";
  } else if (!fileConfig && clean(configPath)) {
    return { value: "", source: "config_file", error: "" };
  } else if (clean(env?.[envName])) {
    raw = env[envName];
    source = "env";
    origin = envName;
  } else {
    return { value: shotVideoCodeDefaultResolution(normalized, model), source: "code_default", error: "" };
  }
  const value = canonicalShotVideoResolution(normalized, model, raw);
  if (value) return { value, source, error: "" };
  return { value: "", source, error: `${origin}=${clean(raw)} 不适用于 ${model}（只支持 ${options.join(" / ")}）` };
}

// 校验一次镜头视频请求的分辨率（2026-10-10）。请求带了 resolution 就必须逐字是这个模型清单里的写法；
// 没带就用配置值，配置值对不上这个模型时同样报错，不悄悄换成别的值。错误由调用方给的 createError 构造
// （服务端用 ProductionStateError），带上 code 与 httpStatus 400。
export function resolveShotVideoRequestResolution({
  provider,
  model,
  input = {},
  env = process.env,
  fileConfig = null,
  configPath = "",
  createError = (message, details) => Object.assign(new Error(message), details)
} = {}) {
  const normalized = normalizeShotVideoProvider(provider) || clean(provider);
  const options = shotVideoResolutionOptions(normalized, model);
  const fail = (message, code) => {
    throw createError(message, { code, httpStatus: 400 });
  };
  if (input && Object.hasOwn(input, "resolution")) {
    const requested = input.resolution;
    if (!options.length) {
      fail(`${clean(model) || normalized || "当前视频模型"} 没有分辨率参数，请求里不能带 resolution（收到「${String(requested)}」）。`, "SHOT_VIDEO_RESOLUTION_UNSUPPORTED");
    }
    if (!isShotVideoResolutionOption(normalized, model, requested)) {
      fail(`${clean(model) || normalized} 的分辨率只支持 ${options.join(" / ")}，本次请求为「${String(requested)}」；不会改写分辨率。`, "SHOT_VIDEO_RESOLUTION_INVALID");
    }
    return { value: requested, explicit: true, source: "request" };
  }
  const configured = shotVideoConfiguredResolution(normalized, model, { env, fileConfig, configPath });
  if (configured.error) {
    fail(`没有选分辨率，而服务端配置的默认值 ${configured.error}；请在弹窗里明确选择分辨率，或修正配置。`, "SHOT_VIDEO_RESOLUTION_DEFAULT_INVALID");
  }
  return { value: configured.value, explicit: false, source: configured.source };
}

export function shotVideoProviderCatalog(env = process.env) {
  return Object.fromEntries(SHOT_VIDEO_PROVIDERS.map((provider) => {
    const runtime = shotVideoRuntimeConfig(provider, env);
    const modelIds = provider === "Kling"
      ? KLING_VIDEO_MODELS
      : provider === "Seedance" ? SEEDANCE_VIDEO_MODELS : MINIMAX_VIDEO_MODELS;
    const directConfigured = Boolean(runtime.endpoint && runtime.apiKey && runtime.model);
    const configured = Boolean(runtime.configPath || directConfigured);
    return [provider, {
      configured,
      defaultModel: runtime.model,
      modelIds: [...modelIds],
      reachable: directConfigured,
      modelAvailable: modelIds.includes(runtime.model) || isShotVideoModelAllowed(provider, runtime.model),
      status: directConfigured ? 200 : 0,
      // 每个模型没选分辨率时用的值与来源（2026-10-10），页面据此显示默认值；配错时带 error，不替换。
      resolutionDefaults: Object.fromEntries(modelIds.map((modelId) => [modelId, shotVideoConfiguredResolution(provider, modelId, {
        env,
        configPath: shotVideoRuntimeConfig(provider, env, modelId).configPath
      })]))
    }];
  }));
}

// direct_shot 链路上两家供应商实际接受的镜头时长。项目不再另设 4–6 秒偏好：
// Plan 的 durationSeconds 由 Full Story 的 timeRange 确定性派生，这里只负责回答
// 「这个供应商能不能原样渲染这个时长」，不得钳制、补长或缩短。
// 可灵不在 direct_shot 链路内（3.0 镜头没有端点，可灵又不支持全能参考），
// 它的时长语义属于旧 v2 兼容路径，本表不覆盖，也不改动它既有的行为。
const SHOT_VIDEO_DURATION_SUPPORT = Object.freeze({
  MiniMax: Object.freeze({ min: 4, max: 15, integer: true }),
  Seedance: Object.freeze({ min: 4, max: 15, integer: true })
});

/** 返回该供应商/模型的时长能力；返回 null 表示项目层面不施加约束。 */
export function shotVideoDurationSupport(provider, model = "") {
  return SHOT_VIDEO_DURATION_SUPPORT[normalizeShotVideoProvider(provider)] || null;
}

/**
 * 时长不被供应商支持时明确失败。禁止拆镜、补长、缩短或静默改写——
 * 唯一正确的处理是换一个支持该时长的供应商，或回到 Full Story 改场次时长。
 */
export function assertShotVideoDurationSupported(provider, model, durationSeconds, {
  path = "shot.durationSeconds",
  ErrorType = Error
} = {}) {
  const support = shotVideoDurationSupport(provider, model);
  if (!support) return Number(durationSeconds);
  const duration = Number(durationSeconds);
  const label = `${normalizeShotVideoProvider(provider)}${clean(model) ? ` ${clean(model)}` : ""}`;
  const suffix = "，不得拆镜、补长、缩短或静默改写时长。";
  if (Array.isArray(support.discrete)) {
    if (!support.discrete.includes(duration)) {
      throw new ErrorType(`${path} 使用 ${label} 时只能是 ${support.discrete.join(" 或 ")} 秒${suffix}`);
    }
    return duration;
  }
  if (
    (support.integer && !Number.isInteger(duration))
    || !Number.isFinite(duration)
    || duration < support.min
    || duration > support.max
  ) {
    throw new ErrorType(
      `${path} 使用 ${label} 时必须是 ${support.min}–${support.max} 秒${support.integer ? "整数" : ""}${suffix}`
    );
  }
  return duration;
}

export function isShotVideoModelAllowed(provider, model) {
  const normalized = normalizeShotVideoProvider(provider);
  const modelName = clean(model);
  if (normalized === "Kling") return /^kling-v(?:2-1|3)$/iu.test(modelName);
  if (normalized === "Seedance") return /^doubao-seedance-2-0(?:-(?:fast|mini))?-\d{6}$/iu.test(modelName);
  if (normalized === "MiniMax") return modelName === "MiniMax-H3";
  return normalized === "VideoHTTP" && Boolean(modelName);
}

export function isNonDomesticKlingApiEndpoint(value = "") {
  let hostname = "";
  try {
    hostname = new URL(String(value || "")).hostname.toLowerCase();
  } catch {
    return false;
  }
  return /^api(?:-[a-z0-9-]+)?\.klingai\.com$/u.test(hostname)
    && hostname !== "api-beijing.klingai.com";
}

function hasSeedanceSpecificConfig(env = process.env) {
  return Boolean(env.SEEDANCE_VIDEO_ENDPOINT || env.SEEDANCE_BASE_URL || env.SEEDANCE_VIDEO_CONFIG || env.SEEDANCE_VIDEO_MODEL);
}

function hasMiniMaxSpecificConfig(env = process.env) {
  return Boolean(
    env.MINIMAX_API_KEY
    || env.MINIMAX_VIDEO_ENDPOINT
    || env.MINIMAX_BASE_URL
    || env.MINIMAX_VIDEO_CONFIG
    || env.MINIMAX_VIDEO_MODEL
  );
}

function booleanEnv(value, fallback) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function clean(value) {
  return String(value || "").trim();
}
