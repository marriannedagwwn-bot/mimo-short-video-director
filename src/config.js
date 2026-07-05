import fs from "node:fs";
import path from "node:path";

export function loadEnv(file = path.resolve(".env")) {
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

export function getConfig() {
  const baseUrl = process.env.MIMO_BASE_URL?.trim() || "";
  const requestedMediaMode = process.env.MIMO_MEDIA_MODE?.trim().toLowerCase() || "auto";
  const mediaMode = ["auto", "video", "frames"].includes(requestedMediaMode) ? requestedMediaMode : "auto";
  const nativeVideoMaxMb = clampNumber(process.env.MIMO_NATIVE_VIDEO_MAX_MB, 18, 1, 22);
  const videoFps = clampNumber(process.env.MIMO_VIDEO_FPS, 2, 0.1, 10);
  const requestedVideoResolution = process.env.MIMO_VIDEO_MEDIA_RESOLUTION?.trim().toLowerCase() || "default";
  const videoMediaResolution = ["default", "max"].includes(requestedVideoResolution) ? requestedVideoResolution : "default";
  const maxCompletionTokens = Math.round(clampNumber(process.env.MIMO_MAX_COMPLETION_TOKENS, 8192, 512, 32768));
  const requestedThinking = process.env.MIMO_THINKING?.trim().toLowerCase() || "disabled";
  const thinking = ["disabled", "enabled"].includes(requestedThinking) ? requestedThinking : "disabled";
  const storyMaxCompletionTokens = Math.round(clampNumber(process.env.MIMO_STORY_MAX_COMPLETION_TOKENS, 12288, 1024, 32768));
  const animationMaxCompletionTokens = Math.round(clampNumber(process.env.MIMO_ANIMATION_MAX_COMPLETION_TOKENS, 12288, 1024, 32768));
  const jsonRetryAttempts = Math.round(clampNumber(process.env.MIMO_JSON_RETRY_ATTEMPTS, 2, 0, 3));
  const qwenBaseUrl = process.env.QWEN_BASE_URL?.trim() || "";
  const qwenStoryModel = process.env.QWEN_STORY_MODEL?.trim() || process.env.QWEN_MODEL?.trim() || "qwen3.7-max";
  const qwenAnimationModel = process.env.QWEN_ANIMATION_MODEL?.trim() || process.env.QWEN_MODEL?.trim() || qwenStoryModel;
  const qwenMaxCompletionTokens = Math.round(clampNumber(process.env.QWEN_MAX_COMPLETION_TOKENS, 16384, 1024, 65536));
  const qwenStoryMaxCompletionTokens = Math.round(clampNumber(process.env.QWEN_STORY_MAX_COMPLETION_TOKENS, qwenMaxCompletionTokens, 1024, 65536));
  const qwenAnimationMaxCompletionTokens = Math.round(clampNumber(process.env.QWEN_ANIMATION_MAX_COMPLETION_TOKENS, qwenMaxCompletionTokens, 1024, 65536));
  const qwenJsonRetryAttempts = Math.round(clampNumber(process.env.QWEN_JSON_RETRY_ATTEMPTS, 2, 0, 3));
  const qwenEnableThinkingValue = process.env.QWEN_ENABLE_THINKING?.trim().toLowerCase();
  const qwenEnableThinking = qwenEnableThinkingValue === "true" ? true : qwenEnableThinkingValue === "false" ? false : false;
  const jimengBaseUrl = process.env.JIMENG_BASE_URL?.trim() || "https://ark.cn-beijing.volces.com/api/v3";
  const jimengApiKey = process.env.JIMENG_API_KEY?.trim() || process.env.ARK_API_KEY?.trim() || process.env.VOLCENGINE_ARK_API_KEY?.trim() || "";
  const jimengMaxImages = Math.round(clampNumber(process.env.JIMENG_MAX_IMAGES, 6, 1, 15));
  const jimengTimeoutMs = Math.round(clampNumber(process.env.JIMENG_TIMEOUT_MS, 300000, 30000, 900000));
  return {
    port: Number(process.env.PORT || 4173),
    mimo: {
      baseUrl,
      apiKey: process.env.MIMO_API_KEY?.trim() || "",
      model: process.env.MIMO_MODEL?.trim() || "mimo-v2.5",
      storyModel: process.env.MIMO_STORY_MODEL?.trim() || "mimo-v2.5-pro",
      animationModel: process.env.MIMO_ANIMATION_MODEL?.trim() || process.env.MIMO_STORY_MODEL?.trim() || "mimo-v2.5-pro",
      jsonMode: process.env.MIMO_JSON_MODE === "true",
      mediaMode,
      nativeVideoMaxBytes: Math.floor(nativeVideoMaxMb * 1024 * 1024),
      videoFps,
      videoMediaResolution,
      maxCompletionTokens,
      storyMaxCompletionTokens,
      animationMaxCompletionTokens,
      jsonRetryAttempts,
      thinking,
      enabled: Boolean(baseUrl)
    },
    qwen: {
      baseUrl: qwenBaseUrl,
      apiKey: process.env.QWEN_API_KEY?.trim() || process.env.DASHSCOPE_API_KEY?.trim() || "",
      model: process.env.QWEN_MODEL?.trim() || "qwen3.7-max",
      storyModel: qwenStoryModel,
      animationModel: qwenAnimationModel,
      maxCompletionTokens: qwenMaxCompletionTokens,
      storyMaxCompletionTokens: qwenStoryMaxCompletionTokens,
      animationMaxCompletionTokens: qwenAnimationMaxCompletionTokens,
      jsonRetryAttempts: qwenJsonRetryAttempts,
      enableThinking: qwenEnableThinking,
      jsonMode: process.env.QWEN_JSON_MODE === "true",
      enabled: Boolean(qwenBaseUrl && (process.env.QWEN_API_KEY?.trim() || process.env.DASHSCOPE_API_KEY?.trim()))
    },
    jimeng: {
      baseUrl: jimengBaseUrl,
      apiKey: jimengApiKey,
      model: process.env.JIMENG_IMAGE_MODEL?.trim() || "doubao-seedream-5-0-260128",
      size: process.env.JIMENG_IMAGE_SIZE?.trim() || "1728x2304",
      outputFormat: process.env.JIMENG_IMAGE_OUTPUT_FORMAT?.trim() || "png",
      imageField: process.env.JIMENG_IMAGE_FIELD?.trim() || "image",
      watermark: process.env.JIMENG_WATERMARK === "true",
      maxImages: jimengMaxImages,
      timeoutMs: jimengTimeoutMs,
      enabled: Boolean(jimengBaseUrl && jimengApiKey)
    }
  };
}

function clampNumber(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}
