import { AttemptStore } from "./attempt-store.js";
import {
  CastOperationError,
  CastPipelineDisabledError,
  CastProposalValidationError,
  CharacterRegistryError
} from "./cast-errors.js";
import { JimengImageConfigError, JimengImageProviderError } from "./jimeng-client.js";
import { ModelResponseError } from "./mimo-client.js";
import { ModelPipelineError, sanitizePublicMetadata } from "./model-errors.js";
import { describeProviderError } from "./provider-error-codes.js";
import { ShotVideoConfigError, ShotVideoProviderError } from "./shot-video-generator.js";
import { StaticFrameCompilerError } from "./static-frame-compiler.js";
import { readSystemProxyError } from "./system-proxy.js";
import { ProductionStateError } from "./production-lineage.js";
import { InputError, OutputContractError } from "./validation.js";

export function serializeServerError(error, {
  attemptStore = null
} = {}) {
  const store = attemptStore instanceof AttemptStore ? attemptStore : null;
  const proxyFailure = readSystemProxyError(error);
  if (proxyFailure) {
    return response(503, observabilityBody({
      error: proxyFailure.message,
      category: "transport",
      code: proxyFailure.code,
      origin: "system",
      retryable: false
    }));
  }

  if (error instanceof ModelPipelineError) {
    return response(error.httpStatus, {
      error: error.message,
      category: error.category,
      code: error.code,
      origin: error.origin,
      retryable: error.retryable,
      details: error.diagnostics,
      attempts: error.attempts,
      // 供应商原文此前在这条分支上被整个吞掉：下面的 ModelResponseError 分支
      // 带 providerError，这条不带，而 coordinator 抛的正是 ModelPipelineError——
      // 于是**凡是走 coordinator 的阶段**（定向修订、Full Story、Animation Plan、
      // 候选对照评审）供应商自己的那句话一律看不到。
      //
      // 实际代价：2026-09-07 一次重试被 HTTP 400 拒绝，350 字节的错误原文躺在内存
      // AttemptStore 里（attempts[].rawOutputRef 指着它），而响应里 details 是空数组、
      // 没有 providerError，根本判断不出 400 的原因，调查就此中断。这与 §5.1
      // 「原文必须真的显示出来」是同一条规则。
      //
      // **纯增字段**：上面七个逐字不变。原始错误由 coordinator 以 cause 传下来
      // （ModelPipelineError 用 super(message, {cause}) 保留），所以这里不重新记
      // attempt——原文已经在 error.attempts 的 rawOutput 里，再记一条是重复。
      // 匹配不到码表就是 null，调用方回退原文。
      providerError: describeServerProviderError(error)
    });
  }

  if (error instanceof InputError) {
    return response(400, observabilityBody({
      error: error.message,
      category: "input",
      code: "INPUT_INVALID",
      origin: "client",
      details: sanitizePublicMetadata(error.details) || []
    }));
  }

  if (error instanceof ProductionStateError) {
    return response(error.httpStatus, observabilityBody({
      error: error.message,
      category: "production-state",
      code: error.code,
      origin: error.httpStatus === 409 ? "conflict" : "client",
      details: sanitizePublicMetadata(error.details) || []
    }));
  }

  if (error instanceof CastPipelineDisabledError) {
    return response(error.httpStatus, observabilityBody({
      error: error.message,
      category: "feature-gate",
      code: error.code,
      origin: "server"
    }));
  }

  if (error instanceof CastProposalValidationError) {
    return response(error.httpStatus, observabilityBody({
      error: error.message,
      category: "cast-proposal",
      code: error.code,
      origin: "model",
      details: sanitizePublicMetadata(error.details) || []
    }));
  }

  if (error instanceof CharacterRegistryError) {
    return response(error.httpStatus, observabilityBody({
      error: error.message,
      category: "character-registry",
      code: error.code,
      origin: "server",
      details: sanitizePublicMetadata(error.details) || []
    }));
  }

  if (error instanceof CastOperationError) {
    return response(error.httpStatus, observabilityBody({
      error: error.message,
      category: "cast-operation",
      code: error.code,
      origin: "client"
    }));
  }

  if (error instanceof ShotVideoConfigError) {
    return response(400, observabilityBody({
      error: error.message,
      category: "config",
      code: "SHOT_VIDEO_CONFIG_INVALID",
      origin: "client"
    }));
  }

  if (error instanceof ShotVideoProviderError) {
    // detail 仍是供应商原文，一个字都不删；providerError 是额外的解释层。
    const providerError = describeServerProviderError(error);
    return response(502, observabilityBody({
      error: "视频生成服务调用失败",
      detail: error.message,
      category: "provider",
      code: "SHOT_VIDEO_PROVIDER_ERROR",
      origin: "provider",
      retryable: providerError ? providerError.retryable : false,
      providerError
    }));
  }

  if (error instanceof JimengImageConfigError) {
    return response(400, observabilityBody({
      error: error.message,
      category: "config",
      code: "IMAGE_PROVIDER_CONFIG_INVALID",
      origin: "client"
    }));
  }

  if (error instanceof JimengImageProviderError) {
    const attempts = providerRawAttempt(error, store, {
      stage: "imageGeneration",
      provider: "Jimeng",
      code: "IMAGE_PROVIDER_ERROR"
    });
    const providerError = describeServerProviderError(error);
    return response(502, observabilityBody({
      error: "即梦图片生成服务调用失败",
      detail: error.message,
      category: "provider",
      code: "IMAGE_PROVIDER_ERROR",
      origin: "provider",
      retryable: providerError ? providerError.retryable : isRetryableProviderStatus(error.status),
      attempts,
      providerError
    }));
  }

  const compilerStage = inferCompilerErrorStage(error);
  if (compilerStage) {
    const status = compilerErrorStatus(error);
    return response(status, observabilityBody({
      error: error.message,
      status,
      stage: compilerStage,
      category: compilerErrorCategory(error),
      code: String(error.code || error.errorCode || "COMPILER_ERROR"),
      origin: "model",
      retryable: Boolean(error.retryable),
      metadata: compilerErrorMetadata(error)
    }));
  }

  if (error instanceof OutputContractError) {
    return response(502, observabilityBody({
      error: `模型输出未通过校验：${error.message}`,
      category: "output-contract",
      code: "OUTPUT_CONTRACT_INVALID",
      origin: "model",
      details: sanitizePublicMetadata(error.details) || []
    }));
  }

  if (error instanceof ModelResponseError) {
    const attempts = providerRawAttempt(error, store, {
      stage: String(error.stage || ""),
      provider: String(error.provider || ""),
      code: "MODEL_RESPONSE_ERROR"
    });
    const providerError = describeServerProviderError(error);
    return response(502, observabilityBody({
      error: error.message,
      category: "provider",
      code: "MODEL_RESPONSE_ERROR",
      origin: "provider",
      retryable: providerError ? providerError.retryable : isRetryableProviderStatus(error.status),
      attempts,
      providerError
    }));
  }

  if (error?.name === "AbortError" || error?.name === "TimeoutError") {
    return response(504, observabilityBody({
      error: "模型响应超时",
      category: "transport",
      code: "MODEL_TIMEOUT",
      origin: "provider",
      retryable: true
    }));
  }

  return {
    ...response(500, observabilityBody({
      error: "服务器内部错误",
      category: "internal",
      code: "INTERNAL_ERROR",
      origin: "system"
    })),
    log: sanitizeErrorForLog(error)
  };
}

export function inferCompilerErrorStage(error = {}) {
  if (error instanceof StaticFrameCompilerError) return "staticFrameCompiler";
  for (const value of [
    error.stage,
    error.metadata?.stage,
    error.details?.stage,
    error.name,
    error.constructor?.name
  ]) {
    const normalized = String(value || "").replace(/[\s_-]+/gu, "").toLowerCase();
    if (normalized.includes("staticframecompiler")) return "staticFrameCompiler";
    if (normalized.includes("characterfeaturecompiler")) return "characterFeatureCompiler";
  }
  return "";
}

export function compilerErrorCategory(error = {}) {
  return String(error.category || error.details?.category || error.metadata?.category || "protocol");
}

export function compilerErrorMetadata(error = {}) {
  if (error.metadata && typeof error.metadata === "object" && !Array.isArray(error.metadata)) {
    return sanitizePublicMetadata(error.metadata);
  }
  if (error.details?.metadata && typeof error.details.metadata === "object" && !Array.isArray(error.details.metadata)) {
    return sanitizePublicMetadata(error.details.metadata);
  }
  return null;
}

export function compilerErrorStatus(error = {}) {
  const explicitStatus = Number(error.status || error.statusCode);
  if (Number.isInteger(explicitStatus) && explicitStatus >= 400 && explicitStatus <= 599) return explicitStatus;
  const category = compilerErrorCategory(error).toLowerCase();
  if (category === "config" || category === "input") return 400;
  if (category === "timeout") return 504;
  return 502;
}

export function sanitizeErrorForLog(error = {}) {
  const source = error && typeof error === "object" ? error : {};
  return {
    name: String(source.name || source.constructor?.name || "Error"),
    message: String(source.message || "服务器内部错误").slice(0, 2_000),
    ...(source.code ? { code: String(source.code) } : {}),
    ...(source.category ? { category: String(source.category) } : {}),
    ...(source.stage ? { stage: String(source.stage) } : {}),
    ...(Number.isFinite(Number(source.status)) ? { status: Number(source.status) } : {})
  };
}

function observabilityBody({
  error,
  detail,
  category,
  code,
  origin,
  retryable = false,
  details = [],
  attempts = [],
  ...extra
}) {
  return {
    error: String(error || "请求失败"),
    ...(detail ? { detail: String(detail) } : {}),
    category: String(category || "unknown"),
    code: String(code || "UNKNOWN_ERROR"),
    origin: String(origin || "system"),
    retryable: Boolean(retryable),
    details: Array.isArray(details) ? details : [],
    attempts: Array.isArray(attempts) ? attempts : [],
    ...extra
  };
}

/**
 * HTTP 出口与 Durable Task 共用同一份供应商识别，仅返回码表的展示字段。
 * 从 ModelPipelineError 的 cause 里取供应商原文并查码表。
 *
 * coordinator 把最后一次失败的原始错误作为 cause 传上来，所以只有当它确实是
 * ModelResponseError（带 raw 与 status）时才有原文可查。传输中断、budget 耗尽
 * 这类没有供应商响应体的失败一律返回 null，调用方回退原文——**编一句「可能是
 * 网络问题」比不解释更糟**（§5.1）。
 */
export function describeServerProviderError(error) {
  if (error instanceof ModelPipelineError) {
    return error.cause instanceof ModelResponseError ? describeServerProviderError(error.cause) : null;
  }
  if (error instanceof ShotVideoProviderError) {
    return describeProviderError({ provider: error.provider, httpStatus: error.status, payload: error.message });
  }
  if (error instanceof JimengImageProviderError) {
    return describeProviderError({ provider: "Jimeng", httpStatus: error.status, payload: error.raw || error.message });
  }
  if (!(error instanceof ModelResponseError)) return null;
  return describeProviderError({
    provider: error.provider || error.metadata?.provider,
    httpStatus: error.status,
    payload: error.raw
  });
}

function providerRawAttempt(error, store, {
  stage,
  provider,
  code
}) {
  if (!store) return [];
  return [store.recordAttempt({
    rawOutput: error.raw,
    stage,
    provider,
    reason: "server-error",
    status: "failed",
    category: "provider",
    code,
    retryable: isRetryableProviderStatus(error.status),
    metadata: {
      httpStatus: Number(error.status) || 0,
      errorName: String(error.name || "Error")
    }
  })];
}

function isRetryableProviderStatus(status) {
  const normalized = Number(status);
  return normalized === 0
    || normalized === 408
    || normalized === 429
    || normalized >= 500;
}

function response(status, body) {
  return {
    status,
    body: {
      ok: false,
      ...body
    }
  };
}
