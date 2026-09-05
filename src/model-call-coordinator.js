import { randomUUID } from "node:crypto";
import { AttemptStore } from "./attempt-store.js";
import { ModelResponseError, parseSingleJsonObject } from "./mimo-client.js";
import { ModelPipelineError } from "./model-errors.js";
import { OutputContractError } from "./validation.js";

const DEFAULT_FULL_STORY_PROVIDER_CALLS = 2;

export class ModelCallCoordinator {
  constructor({
    attemptStore = new AttemptStore(),
    maxProviderCalls = DEFAULT_FULL_STORY_PROVIDER_CALLS,
    now = () => Date.now(),
    idFactory = () => randomUUID()
  } = {}) {
    if (!(attemptStore instanceof AttemptStore)) {
      throw new TypeError("attemptStore 必须是 AttemptStore");
    }
    if (!Number.isInteger(maxProviderCalls) || maxProviderCalls < 1) {
      throw new TypeError("maxProviderCalls 必须是正整数");
    }
    this.attemptStore = attemptStore;
    this.maxProviderCalls = maxProviderCalls;
    this.now = typeof now === "function" ? now : () => Date.now();
    this.idFactory = typeof idFactory === "function" ? idFactory : () => randomUUID();
  }

  async runJson({
    client,
    request,
    provider = "",
    stage = "",
    validate,
    retryPrompt,
    shouldRetry,
    attemptObserver = null,
    retryTokenLimit = defaultRetryTokenLimit,
    maxProviderCalls = this.maxProviderCalls
  } = {}) {
    if (!client || typeof client !== "object") throw new TypeError("client 必须是对象");
    if (typeof validate !== "function") throw new TypeError("validate 必须是函数");
    if (!Number.isInteger(maxProviderCalls) || maxProviderCalls < 1) {
      throw new TypeError("本次 maxProviderCalls 必须是正整数");
    }
    const providerCallBudget = Math.min(this.maxProviderCalls, maxProviderCalls);

    const operationId = `operation:${this.idFactory()}`;
    const attempts = [];
    let activeRequest = { ...(request || {}), jsonRetryAttempts: 0, strictJson: true };

    for (let callIndex = 0; callIndex < providerCallBudget; callIndex += 1) {
      const startedAtMs = this.now();
      let completion = null;
      let candidate = null;
      try {
        completion = await requestSingleCompletion(client, activeRequest, provider);
        const completionProvider = completion.providerName || provider || "模型";
        if (completion.finishReason === "length") {
          throw new ModelResponseError(
            `${completionProvider} 输出因 token 上限被截断`,
            completion.raw,
            0,
            {
              provider: completionProvider,
              code: "MODEL_OUTPUT_TRUNCATED",
              requestId: completion.requestId,
              finishReason: completion.finishReason,
              usage: completion.usage
            }
          );
        }
        candidate = completion.parsed === undefined
          ? parseSingleJsonObject(completion.content, completionProvider)
          : completion.parsed;
        const value = await validate(candidate);
        const attempt = this.recordAttempt({
          operationId,
          callIndex,
          stage,
          provider: completionProvider,
          model: activeRequest.model,
          reason: callIndex === 0 ? "primary" : "coordinator-retry",
          startedAtMs,
          status: "succeeded",
          category: "success",
          code: "MODEL_COMPLETION_ACCEPTED",
          finishReason: completion.finishReason,
          retryable: false,
          rawOutput: completion.raw,
          requestId: completion.requestId,
          usage: completion.usage
        });
        attempts.push(attempt);
        await notifyAttemptObserver(attemptObserver, {
          ...attempt.toJSON(),
          callIndex,
          content: completion.content,
          contentPresent: typeof completion.content === "string",
          providerRequestId: completion.requestId,
          usage: completion.usage
        });
        return value;
      } catch (error) {
        const issue = classifyAttemptError(error);
        const attempt = this.recordAttempt({
          operationId,
          callIndex,
          stage,
          provider: completion?.providerName || error?.provider || provider,
          model: activeRequest.model,
          reason: callIndex === 0 ? "primary" : "coordinator-retry",
          startedAtMs,
          status: "failed",
          category: issue.category,
          code: issue.code,
          finishReason: completion?.finishReason || error?.finishReason,
          retryable: issue.retryable,
          rawOutput: completion?.raw || error?.raw || "",
          requestId: completion?.requestId || error?.requestId,
          usage: completion?.usage || error?.usage
        });
        attempts.push(attempt);
        await notifyAttemptObserver(attemptObserver, {
          ...attempt.toJSON(),
          callIndex,
          content: typeof completion?.content === "string" ? completion.content : "",
          contentPresent: typeof completion?.content === "string",
          providerRequestId: completion?.requestId || error?.requestId || "",
          usage: completion?.usage || error?.usage || null
        });

        const retryAllowed = typeof shouldRetry !== "function" || shouldRetry({
          error,
          issue,
          candidate,
          callIndex,
          attempts: [...attempts]
        }) !== false;
        const canRetry = issue.retryable && retryAllowed && callIndex + 1 < providerCallBudget;
        if (!canRetry) {
          throw new ModelPipelineError(issue.message, {
            category: issue.category,
            code: issue.code,
            origin: issue.origin,
            httpStatus: issue.httpStatus,
            retryable: issue.retryable,
            diagnostics: issue.diagnostics,
            attempts,
            cause: error
          });
        }

        activeRequest = {
          ...activeRequest,
          prompt: typeof retryPrompt === "function"
            ? retryPrompt({
              originalPrompt: request?.prompt || "",
              error,
              issue,
              candidate
            })
            : request?.prompt,
          maxCompletionTokens: retryTokenLimit(
            activeRequest.maxCompletionTokens
          ),
          jsonRetryAttempts: 0,
          strictJson: true
        };
      }
    }

    throw new ModelPipelineError("模型调用预算已耗尽", {
      category: "budget",
      code: "MODEL_CALL_BUDGET_EXHAUSTED",
      origin: "system",
      httpStatus: 502,
      attempts
    });
  }

  recordAttempt({
    operationId,
    callIndex,
    stage,
    provider,
    model,
    reason,
    startedAtMs,
    status,
    category,
    code,
    finishReason,
    retryable,
    rawOutput,
    requestId,
    usage
  }) {
    const finishedAtMs = this.now();
    return this.attemptStore.recordAttempt({
      rawOutput,
      attemptId: `attempt:${this.idFactory()}`,
      operationId,
      stage: String(stage || ""),
      provider: String(provider || ""),
      model: String(model || ""),
      reason,
      startedAt: new Date(startedAtMs).toISOString(),
      finishedAt: new Date(finishedAtMs).toISOString(),
      durationMs: Math.max(0, finishedAtMs - startedAtMs),
      status,
      category,
      code,
      finishReason: String(finishReason || ""),
      retryable,
      metadata: {
        callIndex,
        requestId: String(requestId || ""),
        usage: usage && typeof usage === "object" ? usage : null
      }
    });
  }
}

async function notifyAttemptObserver(observer, payload) {
  if (typeof observer !== "function") return;
  try {
    await observer(payload);
  } catch (error) {
    console.warn(`模型输出观测写入失败：${String(error?.message || "未知错误").slice(0, 500)}`);
  }
}

async function requestSingleCompletion(client, request, provider) {
  if (typeof client.requestCompletion === "function") {
    return client.requestCompletion(request);
  }
  if (typeof client.generateJson !== "function") {
    throw new TypeError("client 缺少 requestCompletion/generateJson");
  }
  const parsed = await client.generateJson({
    ...request,
    jsonRetryAttempts: 0,
    strictJson: true
  });
  return {
    parsed,
    content: JSON.stringify(parsed),
    finishReason: "",
    requestId: "",
    usage: null,
    raw: JSON.stringify(parsed)
  };
}

export function classifyAttemptError(error) {
  if (error instanceof OutputContractError) {
    const diagnostics = Array.isArray(error.details) ? error.details : [];
    const schemaFailure = diagnostics.some((detail) => (
      String(detail?.code || "").startsWith("FULL_STORY_SCHEMA_")
    ));
    return {
      message: error.message,
      category: schemaFailure ? "schema" : "output-contract",
      code: schemaFailure ? "FULL_STORY_SCHEMA_INVALID" : "OUTPUT_CONTRACT_INVALID",
      origin: "model",
      httpStatus: 502,
      retryable: true,
      diagnostics
    };
  }

  if (error instanceof ModelResponseError) {
    if (error.code === "MODEL_OUTPUT_TRUNCATED") {
      return {
        message: error.message,
        category: "truncation",
        code: error.code,
        origin: "model",
        httpStatus: 502,
        retryable: true,
        diagnostics: []
      };
    }
    // 流式响应在收到结束标志前中断，是传输失败而不是协议错误。不单独分类的话
    // 它会落到本分支末尾的兜底（status=0 → category "protocol"、retryable false），
    // 把一个本该重试的网络中断变成不可重试的协议错误。
    if (error.code === "MODEL_STREAM_INCOMPLETE") {
      return {
        message: error.message,
        category: "transport",
        code: error.code,
        origin: "provider",
        httpStatus: 502,
        retryable: true,
        diagnostics: []
      };
    }
    if (["MODEL_ENVELOPE_INVALID", "MODEL_CONTENT_MISSING"].includes(error.code)) {
      return {
        message: error.message,
        category: "protocol",
        code: error.code,
        origin: "provider",
        httpStatus: 502,
        retryable: true,
        diagnostics: []
      };
    }
    if (["MODEL_JSON_OBJECT_REQUIRED"].includes(error.code)
      || error.message.includes("严格 JSON")) {
      return {
        message: error.message,
        category: "json-syntax",
        code: error.code || "MODEL_JSON_INVALID",
        origin: "model",
        httpStatus: 502,
        retryable: true,
        diagnostics: []
      };
    }
    const status = Number(error.status) || 0;
    return {
      message: error.message,
      category: status ? "provider" : "protocol",
      code: error.code || "MODEL_RESPONSE_ERROR",
      origin: "provider",
      httpStatus: 502,
      retryable: status === 408 || status === 429 || status >= 500,
      diagnostics: []
    };
  }

  if (error?.name === "AbortError" || error?.name === "TimeoutError") {
    return {
      message: "模型响应超时",
      category: "transport",
      code: "MODEL_TIMEOUT",
      origin: "provider",
      httpStatus: 504,
      retryable: true,
      diagnostics: []
    };
  }

  if (error instanceof TypeError) {
    return {
      message: String(error.message || "模型网络请求失败"),
      category: "transport",
      code: "MODEL_TRANSPORT_ERROR",
      origin: "provider",
      httpStatus: 502,
      retryable: true,
      diagnostics: []
    };
  }

  return {
    message: "模型处理失败",
    category: "internal",
    code: "MODEL_PIPELINE_INTERNAL_ERROR",
    origin: "system",
    httpStatus: 500,
    retryable: false,
    diagnostics: []
  };
}

function defaultRetryTokenLimit(value) {
  const current = Number(value || 8192);
  if (!Number.isFinite(current)) return 12288;
  return Math.min(32768, Math.max(12288, Math.ceil(current * 1.5)));
}
