import {
  ANALYSIS_OUTPUT_TOKEN_DEFAULT,
  CLAUDE_OUTPUT_TOKEN_CEILING,
  MIMO_OUTPUT_TOKEN_CEILING,
  QWEN_OUTPUT_TOKEN_CEILING
} from "./output-token-ceilings.js";
import { CLAUDE_DEFAULT_BASE_URL, CLAUDE_DEFAULT_MODEL } from "./claude-client.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseModelPrices } from "./token-usage.js";

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
  const serverRequestTimeoutMs = Math.round(clampNumber(process.env.SERVER_REQUEST_TIMEOUT_MS, 900000, 30000, 3600000));
  const durableTaskGlobalConcurrency = optionalInteger(process.env.DURABLE_TASK_MAX_CONCURRENCY, 1, 64);
  const durableTaskWorkflowConcurrency = Math.round(clampNumber(
    process.env.DURABLE_TASK_WORKFLOW_CONCURRENCY,
    durableTaskGlobalConcurrency || 2,
    1,
    64
  ));
  const durableTaskMediaConcurrency = Math.round(clampNumber(
    process.env.DURABLE_TASK_MEDIA_CONCURRENCY,
    durableTaskGlobalConcurrency || 4,
    1,
    64
  ));
  const productionStateDirectory = path.resolve(
    process.env.WORKFLOW_PRODUCTION_STATE_DIR?.trim() || "runtime/production-runs"
  );
  const workflowRuntimeEnvironment = String(
    process.env.WORKFLOW_RUNTIME_ENVIRONMENT
      || process.env.NODE_ENV
      || "development"
  ).trim().toLowerCase();
  const requestedWorkflowSignaturePolicy = String(
    process.env.WORKFLOW_SIGNATURE_POLICY || "signed"
  ).trim().toLowerCase();
  const workflowSignaturePolicy = requestedWorkflowSignaturePolicy === "test_package_unverified"
    ? "test_package_unverified"
    : "signed";
  const characterBoundarySignatureRequired = !(
    ["test", "development"].includes(workflowRuntimeEnvironment)
    && workflowSignaturePolicy === "test_package_unverified"
  );
  const baseUrl = process.env.MIMO_BASE_URL?.trim() || "";
  const requestedMediaMode = process.env.MIMO_MEDIA_MODE?.trim().toLowerCase() || "auto";
  const mediaMode = ["auto", "video", "frames"].includes(requestedMediaMode) ? requestedMediaMode : "auto";
  const nativeVideoMaxMb = clampNumber(process.env.MIMO_NATIVE_VIDEO_MAX_MB, 18, 1, 22);
  const videoFps = clampNumber(process.env.MIMO_VIDEO_FPS, 2, 0.1, 10);
  const requestedVideoResolution = process.env.MIMO_VIDEO_MEDIA_RESOLUTION?.trim().toLowerCase() || "default";
  const videoMediaResolution = ["default", "max"].includes(requestedVideoResolution) ? requestedVideoResolution : "default";
  // 输出上限（2026-09-24）：流式的 MiMo / Qwen 放到各家实测接受的最大值，死循环改由
  // src/output-degeneration.js 边收边查截停，上限只剩「不重复但极长」这一种情况的兜底。
  // 数值与依据只有一份，在 src/output-token-ceilings.js。MiMo 的上限包含推理 token。
  // DeepSeek 非流式、中途看不到内容，仍是 32768。
  const maxCompletionTokens = Math.round(clampNumber(process.env.MIMO_MAX_COMPLETION_TOKENS, MIMO_OUTPUT_TOKEN_CEILING, 512, MIMO_OUTPUT_TOKEN_CEILING));
  const requestedThinking = process.env.MIMO_THINKING?.trim().toLowerCase() || "disabled";
  const thinking = ["disabled", "enabled"].includes(requestedThinking) ? requestedThinking : "disabled";
  const storyMaxCompletionTokens = Math.round(clampNumber(process.env.MIMO_STORY_MAX_COMPLETION_TOKENS, MIMO_OUTPUT_TOKEN_CEILING, 1024, MIMO_OUTPUT_TOKEN_CEILING));
  const animationMaxCompletionTokens = Math.round(clampNumber(process.env.MIMO_ANIMATION_MAX_COMPLETION_TOKENS, MIMO_OUTPUT_TOKEN_CEILING, 1024, MIMO_OUTPUT_TOKEN_CEILING));
  // 参考片分析单独收紧到 16384，依据见 src/output-token-ceilings.js。
  const analysisMaxCompletionTokens = Math.round(clampNumber(process.env.MIMO_ANALYSIS_MAX_COMPLETION_TOKENS, ANALYSIS_OUTPUT_TOKEN_DEFAULT, 1024, MIMO_OUTPUT_TOKEN_CEILING));
  const jsonRetryAttempts = Math.round(clampNumber(process.env.MIMO_JSON_RETRY_ATTEMPTS, 2, 0, 3));
  const mimoRequestTimeoutMs = Math.round(clampNumber(process.env.MIMO_REQUEST_TIMEOUT_MS, 900000, 30000, 900000));
  // 流式客户端只判空闲，不设总时长：连续这么久没收到任何数据才中断（src/stream-idle-timeout.js）。
  const mimoStreamIdleTimeoutMs = Math.round(clampNumber(process.env.MIMO_STREAM_IDLE_TIMEOUT_MS, 120000, 10000, 900000));
  const qwenBaseUrl = process.env.QWEN_BASE_URL?.trim() || "";
  const qwenBaseModel = process.env.QWEN_MODEL?.trim() || "qwen3.7-max";
  const qwenVisionFallbackModel = "qwen3.7-plus";
  const qwenVideoModel = qwenMediaModel(process.env.QWEN_VIDEO_MODEL?.trim(), qwenVisionFallbackModel);
  const qwenAnalysisModel = qwenMediaModel(process.env.QWEN_ANALYSIS_MODEL?.trim(), qwenVideoModel);
  const qwenReconstructionModel = qwenMediaModel(process.env.QWEN_RECONSTRUCTION_MODEL?.trim(), qwenVideoModel);
  const qwenBriefModel = process.env.QWEN_BRIEF_MODEL?.trim() || qwenBaseModel;
  const qwenVisualModel = qwenMediaModel(process.env.QWEN_VISUAL_MODEL?.trim(), qwenVideoModel);
  const qwenVariantsModel = process.env.QWEN_VARIANTS_MODEL?.trim() || qwenBaseModel;
  const qwenStoryModel = process.env.QWEN_STORY_MODEL?.trim() || qwenBaseModel;
  const qwenAnimationModel = process.env.QWEN_ANIMATION_MODEL?.trim() || qwenBaseModel || qwenStoryModel;
  const qwenCharacterReferenceModel = qwenMediaModel(process.env.QWEN_CHARACTER_REFERENCE_MODEL?.trim(), qwenVideoModel);
  const requestedQwenMediaMode = process.env.QWEN_MEDIA_MODE?.trim().toLowerCase() || "auto";
  const qwenMediaMode = ["auto", "video", "frames"].includes(requestedQwenMediaMode) ? requestedQwenMediaMode : "auto";
  const qwenNativeVideoMaxMb = clampNumber(process.env.QWEN_NATIVE_VIDEO_MAX_MB, 7, 1, 7.3);
  const qwenVideoFps = clampNumber(process.env.QWEN_VIDEO_FPS, 2, 0.1, 10);
  const qwenMinPixels = optionalInteger(process.env.QWEN_VIDEO_MIN_PIXELS, 4096, 16777216);
  const qwenMaxPixels = optionalInteger(process.env.QWEN_VIDEO_MAX_PIXELS, 4096, 2048000);
  const qwenTotalPixels = optionalInteger(process.env.QWEN_VIDEO_TOTAL_PIXELS, 4096, 819200000);
  const qwenMaxCompletionTokens = Math.round(clampNumber(process.env.QWEN_MAX_COMPLETION_TOKENS, QWEN_OUTPUT_TOKEN_CEILING, 1024, QWEN_OUTPUT_TOKEN_CEILING));
  // 参考片分析不跟随全局上限，单独默认 16384，依据见 src/output-token-ceilings.js。
  const qwenAnalysisMaxCompletionTokens = Math.round(clampNumber(process.env.QWEN_ANALYSIS_MAX_COMPLETION_TOKENS, ANALYSIS_OUTPUT_TOKEN_DEFAULT, 1024, 65536));
  const qwenReconstructionMaxCompletionTokens = Math.round(clampNumber(process.env.QWEN_RECONSTRUCTION_MAX_COMPLETION_TOKENS, qwenMaxCompletionTokens, 1024, 65536));
  const qwenBriefMaxCompletionTokens = Math.round(clampNumber(process.env.QWEN_BRIEF_MAX_COMPLETION_TOKENS, qwenMaxCompletionTokens, 1024, 65536));
  const qwenVisualMaxCompletionTokens = Math.round(clampNumber(process.env.QWEN_VISUAL_MAX_COMPLETION_TOKENS, qwenMaxCompletionTokens, 1024, 65536));
  const qwenVariantsMaxCompletionTokens = Math.round(clampNumber(process.env.QWEN_VARIANTS_MAX_COMPLETION_TOKENS, qwenMaxCompletionTokens, 1024, 65536));
  const qwenStoryMaxCompletionTokens = Math.round(clampNumber(process.env.QWEN_STORY_MAX_COMPLETION_TOKENS, qwenMaxCompletionTokens, 1024, 65536));
  const qwenAnimationMaxCompletionTokens = Math.round(clampNumber(process.env.QWEN_ANIMATION_MAX_COMPLETION_TOKENS, qwenMaxCompletionTokens, 1024, 65536));
  const qwenCharacterReferenceMaxCompletionTokens = Math.round(clampNumber(process.env.QWEN_CHARACTER_REFERENCE_MAX_COMPLETION_TOKENS, qwenMaxCompletionTokens, 1024, 65536));
  const qwenJsonRetryAttempts = Math.round(clampNumber(process.env.QWEN_JSON_RETRY_ATTEMPTS, 2, 0, 3));
  const qwenRequestTimeoutMs = Math.round(clampNumber(process.env.QWEN_REQUEST_TIMEOUT_MS, 900000, 30000, 900000));
  const qwenStreamIdleTimeoutMs = Math.round(clampNumber(process.env.QWEN_STREAM_IDLE_TIMEOUT_MS, 120000, 10000, 900000));
  const qwenEnableThinkingValue = process.env.QWEN_ENABLE_THINKING?.trim().toLowerCase();
  const qwenEnableThinking = qwenEnableThinkingValue === "true" ? true : qwenEnableThinkingValue === "false" ? false : false;
  const deepseekBaseUrl = process.env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com";
  const deepseekApiKey = process.env.DEEPSEEK_API_KEY?.trim() || "";
  const deepseekModel = process.env.DEEPSEEK_MODEL?.trim() || "deepseek-v4-flash";
  const deepseekMaxCompletionTokens = Math.round(clampNumber(process.env.DEEPSEEK_MAX_COMPLETION_TOKENS, 32768, 1024, 65536));
  const deepseekJsonRetryAttempts = Math.round(clampNumber(process.env.DEEPSEEK_JSON_RETRY_ATTEMPTS, 2, 0, 3));
  const deepseekRequestTimeoutMs = Math.round(clampNumber(process.env.DEEPSEEK_REQUEST_TIMEOUT_MS, 900000, 30000, 900000));
  const requestedDeepseekThinking = process.env.DEEPSEEK_THINKING?.trim().toLowerCase() || "disabled";
  const deepseekThinking = ["disabled", "enabled"].includes(requestedDeepseekThinking) ? requestedDeepseekThinking : "disabled";
  const deepseekTemperature = clampNumber(process.env.DEEPSEEK_TEMPERATURE, 1, 0, 2);
  const deepseekTopP = clampNumber(process.env.DEEPSEEK_TOP_P, 1, 0, 1);
  // Claude（2026-10-19）：纯文本、流式，只判空闲。环境变量一律用 CLAUDE_API_ 前缀：
  // Claude Code 会给它启动的进程导出 CLAUDE_EFFORT、ANTHROPIC_BASE_URL（也可能有 ANTHROPIC_API_KEY），
  // 从 Claude 会话里启动的服务（.claude/launch.json 的预览服务）会继承它们。所以这里不读
  // ANTHROPIC_* / CLAUDE_EFFORT，免得把 Claude Code 自己的密钥或设置当成本工作流的配置。
  // CLAUDE_API_EFFORT 由客户端按官方五档校验，写错时启动就报错。
  const claudeApiKey = process.env.CLAUDE_API_KEY?.trim() || "";
  const claudeBaseUrl = process.env.CLAUDE_API_BASE_URL?.trim() || CLAUDE_DEFAULT_BASE_URL;
  const claudeMaxCompletionTokens = Math.round(clampNumber(process.env.CLAUDE_API_MAX_COMPLETION_TOKENS, CLAUDE_OUTPUT_TOKEN_CEILING, 1024, CLAUDE_OUTPUT_TOKEN_CEILING));
  const claudeJsonRetryAttempts = Math.round(clampNumber(process.env.CLAUDE_API_JSON_RETRY_ATTEMPTS, 2, 0, 3));
  const claudeStreamIdleTimeoutMs = Math.round(clampNumber(process.env.CLAUDE_API_STREAM_IDLE_TIMEOUT_MS, 120000, 10000, 900000));
  const fullStoryV2CastConfirmationTtlMs = Math.round(clampNumber(
    process.env.FULL_STORY_V2_CAST_CONFIRMATION_TTL_MS,
    30 * 60 * 1000,
    60 * 1000,
    24 * 60 * 60 * 1000
  ));
  const jimengBaseUrl = process.env.JIMENG_BASE_URL?.trim() || "https://ark.cn-beijing.volces.com/api/v3";
  const jimengApiKey = process.env.JIMENG_API_KEY?.trim() || process.env.ARK_API_KEY?.trim() || process.env.VOLCENGINE_ARK_API_KEY?.trim() || "";
  const jimengMaxImages = Math.round(clampNumber(process.env.JIMENG_MAX_IMAGES, 6, 1, 15));
  const jimengTimeoutMs = Math.round(clampNumber(process.env.JIMENG_TIMEOUT_MS, 300000, 30000, 900000));
  // 单价由用户在 .env 里按模型 ID 配置；没配的模型只报 token，不报金额。
  // 单条格式错误只跳过该条并告警，不因为一个笔误拖垮启动。
  const { prices: modelPrices, invalid: invalidModelPrices } = parseModelPrices(
    process.env.MODEL_PRICE_CNY_PER_MILLION
  );
  if (invalidModelPrices.length) {
    console.warn(`MODEL_PRICE_CNY_PER_MILLION 有 ${invalidModelPrices.length} 条无法解析，已跳过：${invalidModelPrices.join("、")}`);
  }
  return {
    port: Number(process.env.PORT || 4173),
    serverRequestTimeoutMs,
    modelPrices,
    // 默认工作流 provider，由 resolveDefaultLlmProvider() 裁决；留空保持「配了 Qwen 就用 Qwen」。
    defaultLlmProvider: process.env.DEFAULT_LLM_PROVIDER?.trim() || "",
    durableTasks: {
      localStallMs: Math.round(clampNumber(process.env.DURABLE_TASK_LOCAL_STALL_MS, 300_000, 25, 3_600_000)),
      providerGraceMs: Math.round(clampNumber(process.env.DURABLE_TASK_PROVIDER_GRACE_MS, 120_000, 0, 600_000)),
      maxQueuedBytes: Math.round(clampNumber(
        process.env.DURABLE_TASK_MAX_QUEUED_BYTES,
        140 * 1024 * 1024,
        1024,
        2 * 1024 * 1024 * 1024
      )),
      pools: {
        workflow: {
          limit: durableTaskWorkflowConcurrency,
          queueLimit: Math.round(clampNumber(process.env.DURABLE_TASK_WORKFLOW_QUEUE_LIMIT, 8, 0, 1_000))
        },
        media: {
          limit: durableTaskMediaConcurrency,
          queueLimit: Math.round(clampNumber(process.env.DURABLE_TASK_MEDIA_QUEUE_LIMIT, 8, 0, 1_000))
        }
      }
    },
    workflowRuntime: {
      environment: workflowRuntimeEnvironment,
      signaturePolicy: workflowSignaturePolicy,
      characterBoundarySignatureRequired,
      productionStateDirectory
    },
    mimo: {
      baseUrl,
      apiKey: process.env.MIMO_API_KEY?.trim() || "",
      model: process.env.MIMO_MODEL?.trim() || "mimo-v2.5",
      analysisModel: process.env.MIMO_ANALYSIS_MODEL?.trim() || process.env.MIMO_MODEL?.trim() || "mimo-v2.5",
      reconstructionModel: process.env.MIMO_RECONSTRUCTION_MODEL?.trim() || process.env.MIMO_MODEL?.trim() || "mimo-v2.5",
      briefModel: process.env.MIMO_BRIEF_MODEL?.trim() || process.env.MIMO_MODEL?.trim() || "mimo-v2.5",
      visualModel: process.env.MIMO_VISUAL_MODEL?.trim() || process.env.MIMO_MODEL?.trim() || "mimo-v2.5",
      variantsModel: process.env.MIMO_VARIANTS_MODEL?.trim() || process.env.MIMO_MODEL?.trim() || "mimo-v2.5",
      storyModel: process.env.MIMO_STORY_MODEL?.trim() || "mimo-v2.5-pro",
      animationModel: process.env.MIMO_ANIMATION_MODEL?.trim() || process.env.MIMO_STORY_MODEL?.trim() || "mimo-v2.5-pro",
      characterReferenceModel: process.env.MIMO_CHARACTER_REFERENCE_MODEL?.trim() || process.env.MIMO_MODEL?.trim() || "mimo-v2.5",
      jsonMode: process.env.MIMO_JSON_MODE === "true",
      // 调用方给了 Schema 时改发 json_schema 约束解码（文档外行为，实测可用），写 false 关闭。
      jsonSchema: process.env.MIMO_JSON_SCHEMA?.trim().toLowerCase() !== "false",
      mediaMode,
      nativeVideoMaxBytes: Math.floor(nativeVideoMaxMb * 1024 * 1024),
      videoFps,
      videoMediaResolution,
      maxCompletionTokens,
      analysisMaxCompletionTokens,
      storyMaxCompletionTokens,
      animationMaxCompletionTokens,
      jsonRetryAttempts,
      requestTimeoutMs: mimoRequestTimeoutMs,
      streamIdleTimeoutMs: mimoStreamIdleTimeoutMs,
      thinking,
      enabled: Boolean(baseUrl)
    },
    qwen: {
      baseUrl: qwenBaseUrl,
      apiKey: process.env.QWEN_API_KEY?.trim() || process.env.DASHSCOPE_API_KEY?.trim() || "",
      model: qwenBaseModel,
      videoModel: qwenVideoModel,
      analysisModel: qwenAnalysisModel,
      reconstructionModel: qwenReconstructionModel,
      briefModel: qwenBriefModel,
      visualModel: qwenVisualModel,
      variantsModel: qwenVariantsModel,
      storyModel: qwenStoryModel,
      animationModel: qwenAnimationModel,
      characterReferenceModel: qwenCharacterReferenceModel,
      maxCompletionTokens: qwenMaxCompletionTokens,
      analysisMaxCompletionTokens: qwenAnalysisMaxCompletionTokens,
      reconstructionMaxCompletionTokens: qwenReconstructionMaxCompletionTokens,
      briefMaxCompletionTokens: qwenBriefMaxCompletionTokens,
      visualMaxCompletionTokens: qwenVisualMaxCompletionTokens,
      variantsMaxCompletionTokens: qwenVariantsMaxCompletionTokens,
      storyMaxCompletionTokens: qwenStoryMaxCompletionTokens,
      animationMaxCompletionTokens: qwenAnimationMaxCompletionTokens,
      characterReferenceMaxCompletionTokens: qwenCharacterReferenceMaxCompletionTokens,
      jsonRetryAttempts: qwenJsonRetryAttempts,
      requestTimeoutMs: qwenRequestTimeoutMs,
      streamIdleTimeoutMs: qwenStreamIdleTimeoutMs,
      enableThinking: qwenEnableThinking,
      jsonMode: process.env.QWEN_JSON_MODE === "true",
      mediaMode: qwenMediaMode,
      nativeVideoMaxBytes: Math.floor(qwenNativeVideoMaxMb * 1024 * 1024),
      videoFps: qwenVideoFps,
      minPixels: qwenMinPixels,
      maxPixels: qwenMaxPixels,
      totalPixels: qwenTotalPixels,
      enabled: Boolean(qwenBaseUrl && (process.env.QWEN_API_KEY?.trim() || process.env.DASHSCOPE_API_KEY?.trim()))
    },
    deepseek: {
      baseUrl: deepseekBaseUrl,
      apiKey: deepseekApiKey,
      model: deepseekModel,
      maxCompletionTokens: deepseekMaxCompletionTokens,
      jsonRetryAttempts: deepseekJsonRetryAttempts,
      requestTimeoutMs: deepseekRequestTimeoutMs,
      thinking: deepseekThinking,
      temperature: deepseekTemperature,
      topP: deepseekTopP,
      jsonMode: process.env.DEEPSEEK_JSON_MODE !== "false",
      enabled: Boolean(deepseekBaseUrl && deepseekApiKey)
    },
    claude: {
      baseUrl: claudeBaseUrl,
      apiKey: claudeApiKey,
      model: process.env.CLAUDE_API_MODEL?.trim() || CLAUDE_DEFAULT_MODEL,
      maxCompletionTokens: claudeMaxCompletionTokens,
      effort: process.env.CLAUDE_API_EFFORT?.trim() || "",
      jsonRetryAttempts: claudeJsonRetryAttempts,
      streamIdleTimeoutMs: claudeStreamIdleTimeoutMs,
      enabled: Boolean(claudeBaseUrl && claudeApiKey)
    },
    // 参考片仿写（2026-10-24）用到的本机工具。都不设就是「这一步不可用」，页面写明缺什么；
    // 不回退到不去配乐的转写，也不让 whisper 自己去下载模型（src/reference-rewrite-tools.js）。
    referenceRewrite: {
      banditDir: expandHome(process.env.REFERENCE_REWRITE_BANDIT_DIR),
      vocalRecoveryDir: expandHome(process.env.REFERENCE_REWRITE_VOCAL_RECOVERY_DIR),
      whisperBin: expandHome(process.env.REFERENCE_REWRITE_WHISPER_BIN),
      whisperModel: process.env.REFERENCE_REWRITE_WHISPER_MODEL?.trim() || "small",
      whisperModelDir: expandHome(process.env.REFERENCE_REWRITE_WHISPER_MODEL_DIR) || expandHome("~/.cache/whisper")
    },
    fullStoryV2Pipeline: {
      enabled: process.env.FULL_STORY_V2_PIPELINE_ENABLED === "true",
      environment: process.env.FULL_STORY_V2_ENVIRONMENT?.trim()
        || process.env.NODE_ENV?.trim()
        || "development",
      audience: process.env.FULL_STORY_V2_AUDIENCE?.trim() || "full-story-v2",
      castConfirmationTtlMs: fullStoryV2CastConfirmationTtlMs
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

// 默认阶段路由用哪一家：未设置 DEFAULT_LLM_PROVIDER 时保持原行为（配了 Qwen 就用 Qwen，否则 MiMo）。
// 显式指定的那家没配置就直接启动失败，不静默换成另一家（CLAUDE.md §2.7「不得静默切换 provider」）。
// 两家都没配置时是演示模式，没有真实 provider 可选，偏好不生效，沿用原来的 MiMo 标签。
// DeepSeek 与 Claude 不能做默认：默认路由覆盖需要图片/视频输入的阶段，而它们在本工作流只接纯文本。
export function resolveDefaultLlmProvider(config) {
  const fallback = config.qwen?.enabled ? "Qwen" : "MiMo";
  const requested = String(config.defaultLlmProvider || "").trim();
  if (!requested) return fallback;
  const provider = normalizeCompilerProvider(requested);
  if (provider !== "Qwen" && provider !== "MiMo") {
    throw new Error(`DEFAULT_LLM_PROVIDER 只能是 Qwen 或 MiMo，收到「${requested}」。DeepSeek 与 Claude 在本工作流只接纯文本，不能作为默认 provider。`);
  }
  if (!config.qwen?.enabled && !config.mimo?.enabled) return fallback;
  if (!config[provider === "Qwen" ? "qwen" : "mimo"]?.enabled) {
    const missing = provider === "Qwen" ? "QWEN_BASE_URL 或 QWEN_API_KEY" : "MIMO_BASE_URL";
    throw new Error(`DEFAULT_LLM_PROVIDER=${provider}，但 ${provider} 没有配置（缺少 ${missing}）。补全配置，或删掉 DEFAULT_LLM_PROVIDER 恢复原默认路由。`);
  }
  return provider;
}

// 路径里的 ~ 换成本机用户目录；空值返回空串。
function expandHome(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (text === "~") return os.homedir();
  return text.startsWith("~/") ? path.join(os.homedir(), text.slice(2)) : text;
}

function clampNumber(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

function optionalInteger(value, minimum, maximum) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return null;
  return Math.min(maximum, Math.max(minimum, number));
}

function qwenMediaModel(value, fallback) {
  const model = String(value || "").trim();
  if (!model || isKnownQwenTextOnlyModel(model)) return fallback;
  return model;
}

function isKnownQwenTextOnlyModel(model = "") {
  return /^qwen(?:\d+(?:\.\d+)?)?-max(?:-|$)/iu.test(String(model).trim());
}

function normalizeCompilerProvider(value) {
  const provider = String(value || "").trim();
  if (provider.toLowerCase() === "qwen") return "Qwen";
  if (provider.toLowerCase() === "mimo") return "MiMo";
  if (provider.toLowerCase() === "deepseek") return "DeepSeek";
  if (["claude", "anthropic"].includes(provider.toLowerCase())) return "Claude";
  return provider;
}
