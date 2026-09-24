import { SYSTEM_PROMPT } from "./prompts.js";
import { recordModelUsage } from "./token-usage.js";
import { afterDurableProviderCall, beforeDurableProviderCall, durableTaskHeartbeat, durableProviderAbortSignal, throwIfDurableTaskAborted } from "./durable-task-context.js";
import { SseStreamDegenerateError, SseStreamIncompleteError, readSseCompletion } from "./sse-stream.js";
import { MIMO_OUTPUT_TOKEN_CEILING, growOutputTokenLimit } from "./output-token-ceilings.js";
import { createStreamIdleTimer, resolveStreamIdleTimeoutMs } from "./stream-idle-timeout.js";

export class ModelResponseError extends Error {
  constructor(message, raw = "", status = 0, metadata = {}) {
    super(message);
    this.name = "ModelResponseError";
    this.raw = raw;
    this.status = status;
    this.provider = String(metadata.provider || "");
    this.code = String(metadata.code || "");
    this.requestId = String(metadata.requestId || "");
    this.finishReason = String(metadata.finishReason || "");
    this.usage = metadata.usage && typeof metadata.usage === "object"
      ? metadata.usage
      : null;
  }
}

export class MimoClient {
  constructor(config) {
    this.config = config;
  }

  async checkHealth(requestedModel = this.config.model) {
    const endpoint = `${this.config.baseUrl.replace(/\/$/, "")}/models`;
    try {
      const response = await fetch(endpoint, {
        headers: this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {},
        signal: AbortSignal.timeout(5_000)
      });
      if (!response.ok) return { reachable: false, modelAvailable: false, status: response.status };
      const body = await response.json();
      const modelIds = Array.isArray(body.data) ? body.data.map((item) => item?.id).filter(Boolean) : [];
      const requested = requestedModel || this.config.model;
      const requestedTail = requested.split("/").pop();
      const modelAvailable = modelIds.some((id) => id === requested || id.split("/").pop() === requestedTail);
      return { reachable: true, modelAvailable, status: response.status, modelIds };
    } catch {
      return { reachable: false, modelAvailable: false, status: 0 };
    }
  }

  async generateJson({
    prompt,
    frames = [],
    model = null,
    maxCompletionTokens = null,
    systemPrompt = null,
    requestTimeoutMs = null,
    jsonRetryAttempts = null,
    strictJson = false,
    onCompletion = null
  } = {}) {
    return this.generateJsonWithMedia({
      prompt,
      frames,
      model,
      maxCompletionTokens,
      systemPrompt,
      requestTimeoutMs,
      jsonRetryAttempts,
      strictJson,
      onCompletion
    });
  }

  async generateJsonWithMedia({
    prompt,
    frames = [],
    video = null,
    model = null,
    maxCompletionTokens = null,
    systemPrompt = null,
    onResolvedMediaMode = null,
    requestTimeoutMs = null,
    jsonRetryAttempts = null,
    strictJson = false,
    onCompletion = null
  }) {
    const canUseVideo = Boolean(video?.dataUrl) && this.config.mediaMode !== "frames";
    try {
      const result = await this.requestJson({
        prompt,
        frames,
        video,
        useVideo: canUseVideo,
        model,
        maxCompletionTokens,
        systemPrompt,
        requestTimeoutMs,
        strictJson,
        onCompletion,
        jsonRetryAttempts: jsonRetryAttempts === null && canUseVideo && this.config.mediaMode === "auto" && frames.length > 0
          ? 0
          : jsonRetryAttempts
      });
      notifyResolvedMediaMode(onResolvedMediaMode, canUseVideo ? "video" : frames.length ? "frames" : "text");
      return result;
    } catch (error) {
      const canFallback = canUseVideo
        && this.config.mediaMode === "auto"
        && frames.length > 0
        && error instanceof ModelResponseError
        && ([400, 415, 422].includes(error.status) || isRecoverableVideoJsonError(error));
      if (!canFallback) throw error;
      const result = await this.requestJson({
        prompt,
        frames,
        useVideo: false,
        model,
        maxCompletionTokens,
        systemPrompt,
        requestTimeoutMs,
        jsonRetryAttempts,
        strictJson,
        onCompletion
      });
      notifyResolvedMediaMode(onResolvedMediaMode, "frames");
      return result;
    }
  }

  async requestJson({
    prompt,
    frames = [],
    video = null,
    useVideo = false,
    model = null,
    maxCompletionTokens = null,
    systemPrompt = null,
    requestTimeoutMs = null,
    jsonRetryAttempts = null,
    strictJson = false,
    onCompletion = null
  }) {
    const retryAttempts = jsonRetryAttempts === null
      ? Number.isFinite(Number(this.config.jsonRetryAttempts)) ? Number(this.config.jsonRetryAttempts) : 2
      : Math.max(0, Number(jsonRetryAttempts) || 0);
    let activePrompt = prompt;
    let activeMaxCompletionTokens = maxCompletionTokens;
    let lastJsonError = null;

    for (let attempt = 0; attempt <= retryAttempts; attempt += 1) {
      const completion = await this.requestCompletion({
        prompt: activePrompt,
        frames,
        video,
        useVideo,
        model,
        maxCompletionTokens: activeMaxCompletionTokens,
        systemPrompt,
        requestTimeoutMs
      });
      await notifyCompletion(onCompletion, completion);
      const content = completion.content;
      assertCompletionNotContentFiltered(completion, "MiMo");
      try {
        assertCompletionNotTruncated(completion, "MiMo");
        return strictJson
          ? parseStrictModelJson(content, "MiMo")
          : parseModelJson(content, "MiMo");
      } catch (error) {
        if (!(error instanceof ModelResponseError) || attempt >= retryAttempts) throw error;
        lastJsonError = error;
        activePrompt = jsonRetryPrompt(prompt, content);
        activeMaxCompletionTokens = retryTokenLimit(activeMaxCompletionTokens ?? this.config.maxCompletionTokens);
      }
    }

    throw lastJsonError || new ModelResponseError("MiMo 未返回合法 JSON");
  }

  async requestCompletion({
    prompt,
    frames = [],
    video = null,
    useVideo = false,
    model = null,
    maxCompletionTokens = null,
    systemPrompt = null,
    requestTimeoutMs = null
  } = {}) {
    const endpoint = `${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const body = buildRequestBody(
      this.config,
      { prompt, frames, video, useVideo },
      { model, maxCompletionTokens, systemPrompt }
    );
    // 流式请求不设总时长上限，只判空闲：连续 streamIdleTimeoutMs 没收到任何数据才中断。
    // requestTimeoutMs 在流式客户端上不再生效（参数保留给调用方的统一签名）。
    const idleTimeoutMs = resolveStreamIdleTimeoutMs(this.config);
    await beforeDurableProviderCall("model_provider_call", idleTimeoutMs);
    const idle = createStreamIdleTimer(idleTimeoutMs);
    try {
      return await this.streamCompletion({ endpoint, body, idle });
    } finally {
      idle.clear();
    }
  }

  async streamCompletion({ endpoint, body, idle }) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {})
      },
      body: JSON.stringify(body),
      signal: durableProviderAbortSignal(null, idle.signal)
    }).catch((error) => {
      throwIfDurableTaskAborted();
      throw error;
    });
    idle.touch();
    const headerRequestId = response.headers.get("x-request-id")
      || response.headers.get("request-id")
      || "";
    if (!response.ok) {
      // HTTP 错误仍读普通响应体，不能作为 SSE 吞掉供应商错误原文。
      const raw = await response.text().catch((error) => {
        throwIfDurableTaskAborted();
        throw error;
      });
      await afterDurableProviderCall("model_provider_response");
      throw new ModelResponseError(
        `MiMo 请求失败（${response.status}）`,
        raw,
        response.status,
        {
          provider: "MiMo",
          code: "MODEL_HTTP_ERROR",
          requestId: headerRequestId
        }
      );
    }

    let lastHeartbeatAt = 0;
    const onProgress = ({ contentLength }) => {
      idle.touch();
      const now = Date.now();
      if (now - lastHeartbeatAt < 10_000) return;
      lastHeartbeatAt = now;
      // 推理期间也续报进度；观测失败不改变传输结论。
      Promise.resolve(durableTaskHeartbeat({ streamedChars: contentLength })).catch(() => {});
    };
    let stream;
    try {
      stream = await readSseCompletion(response.body, { onProgress });
    } catch (error) {
      // 仅记录实际收到的结构化用量；取消、断流或冻结复检失败也不能丢账。
      recordModelUsage({ provider: "MiMo", model: body.model, usage: error?.partialUsage });
      throwIfDurableTaskAborted();
      await afterDurableProviderCall("model_provider_response");
      if (idle.fired) throw streamIdleTimeoutError("MiMo", idle, error, headerRequestId);
      // 必须排在「中途断开」之前：主动叫停的死循环同样带着 partialChunks，
      // 顺序反了它会被当成网络中断、归为可重试的 transport。
      if (error instanceof SseStreamDegenerateError) throw outputDegenerateError("MiMo", error, headerRequestId);
      if (typeof error?.partialChunks === "number" && error.partialChunks > 0) {
        throw new ModelResponseError(
          `MiMo 流式传输在收到 ${error.partialContentLength} 字正文（${error.partialChunks} 个数据块）后中断：${error.message}`,
          String(error.partialRaw || ""),
          0,
          { provider: "MiMo", code: "MODEL_STREAM_ABORTED", requestId: headerRequestId, usage: error.partialUsage }
        );
      }
      if (error instanceof SseStreamIncompleteError) {
        throw new ModelResponseError(
          `MiMo ${error.message}`,
          error.raw,
          0,
          { provider: "MiMo", code: "MODEL_STREAM_INCOMPLETE", requestId: headerRequestId, usage: error.partialUsage }
        );
      }
      throw error;
    }
    const raw = stream.raw;
    const usage = stream.usage && typeof stream.usage === "object"
      ? stream.usage
      : null;
    // 已完成响应的用量先记账；随后冻结复检失败也不能抹掉已发生的消耗。
    recordModelUsage({ provider: "MiMo", model: body.model, usage });
    await afterDurableProviderCall("model_provider_response");
    const content = stream.content;
    const requestId = headerRequestId || String(stream.id || "");
    const finishReason = String(stream.finishReason || "");
    if (typeof content !== "string") {
      throw new ModelResponseError(
        "MiMo 响应缺少 message.content",
        raw,
        0,
        {
          provider: "MiMo",
          code: "MODEL_CONTENT_MISSING",
          requestId,
          finishReason,
          usage
        }
      );
    }
    return {
      content,
      finishReason,
      requestId,
      usage,
      providerName: "MiMo",
      model: body.model,
      raw
    };
  }
}

function notifyResolvedMediaMode(callback, mode) {
  if (typeof callback === "function") callback(mode);
}

function jsonRetryPrompt(originalPrompt, failedContent) {
  return `${originalPrompt}

上一次模型输出不是完整合法 JSON，可能被截断或包含了无法解析的内容。请重新输出一次。

纠偏要求：
- 只输出一个完整 JSON 对象，不要 Markdown，不要解释。
- 必须保留原任务要求的所有顶层字段和数组字段。
- 内容可以更精炼，但不能省略结构字段。
- 每个字符串尽量控制在 80 个汉字以内，避免长段落导致再次截断。
- 不要复述上一次错误输出；直接重新生成完整 JSON。

上一次错误输出开头仅供诊断，不要照抄：
${String(failedContent || "").slice(0, 800)}`;
}

function retryTokenLimit(value) {
  return growOutputTokenLimit(value, { factor: 1.5, ceiling: MIMO_OUTPUT_TOKEN_CEILING });
}

function isRecoverableVideoJsonError(error) {
  return error instanceof ModelResponseError && error.message.includes("未返回合法 JSON");
}

export function buildRequestBody(config, { prompt, frames = [], video = null, useVideo = false }, overrides = {}) {
  const visualContent = useVideo && video?.dataUrl
    ? [{ type: "video_url", video_url: { url: video.dataUrl }, fps: config.videoFps ?? 2, media_resolution: config.videoMediaResolution || "default" }]
    : frames.map((frame) => ({ type: "image_url", image_url: { url: frame.dataUrl } }));
  const thinkingType = config.thinking || "disabled";
  const promptText = thinkingType === "enabled" ? prompt : `${prompt}\n/no_think`;
  const body = {
    model: overrides.model || config.model,
    max_completion_tokens: overrides.maxCompletionTokens ?? config.maxCompletionTokens ?? 8192,
    temperature: 0.3,
    top_p: 0.95,
    // MiMo 原生 SSE 尾块包含 usage，无需依赖未文档化的 stream_options。
    // https://mimo.mi.com/docs/en-US/api/chat/openai-api (实测 2026-09-22)
    stream: true,
    thinking: { type: thinkingType },
    messages: [
      {
        role: "system",
        content: typeof overrides.systemPrompt === "string" && overrides.systemPrompt.trim()
          ? overrides.systemPrompt
          : SYSTEM_PROMPT
      },
      { role: "user", content: [...visualContent, { type: "text", text: promptText }] }
    ]
  };
  if (config.jsonMode) body.response_format = { type: "json_object" };
  return body;
}

export function parseModelJson(content, providerName = "模型") {
  const cleaned = content
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {}
    }
    throw new ModelResponseError(`${providerName} 未返回合法 JSON`, content.slice(0, 3000));
  }
}

// finish_reason 为 length 时输出被 max tokens 截断。必须在解析 JSON 之前判定：
// 否则截断会被报成「未返回严格 JSON」，把额度问题伪装成模型格式错误。
// 2026-09-23 实测 MiMo 候选阶段 16384 额度全部用在推理上、正文 0 字，
// 用户看到的却是「MiMo 未返回严格 JSON」。
export function assertCompletionNotTruncated(completion, providerName = "模型") {
  if (completion?.finishReason !== "length") return;
  const contentLength = typeof completion.content === "string" ? completion.content.length : 0;
  const completionTokens = Number(completion.usage?.completion_tokens);
  const budget = Number.isFinite(completionTokens) ? `，本次输出 ${completionTokens} token` : "";
  const detail = contentLength === 0
    ? "正文一个字都没写出来，额度很可能全部用在了推理上"
    : `截断前写出 ${contentLength} 字正文`;
  throw new ModelResponseError(
    `${providerName} 输出因 token 上限被截断（${detail}${budget}）`,
    typeof completion.raw === "string" ? completion.raw : "",
    0,
    {
      provider: providerName,
      code: "MODEL_OUTPUT_TRUNCATED",
      requestId: completion.requestId,
      finishReason: completion.finishReason,
      usage: completion.usage
    }
  );
}

// finish_reason 为 content_filter 时是供应商内容审核拦截了输出，不是模型格式错误。
// 必须在解析 JSON 之前判定：2026-09-23 MiMo 候选阶段推理 10534 token 后被审核拦截，
// 正文只有一句「The request was rejected because it was considered high risk」，
// 用户看到的却是「MiMo 未返回严格 JSON」。审核是非确定性的（同一提示词另两次都通过），
// 但按 CLAUDE.md 不得自动重试——那等于在第三方安全闸门上「问到放行为止」，
// 所以这里抛出的错误被分类为不可重试，由用户显式决定要不要再跑。
export function assertCompletionNotContentFiltered(completion, providerName = "模型") {
  if (completion?.finishReason !== "content_filter") return;
  const providerText = typeof completion.content === "string" ? completion.content.trim().slice(0, 200) : "";
  const completionTokens = Number(completion.usage?.completion_tokens);
  const spent = Number.isFinite(completionTokens) ? `，本次已输出 ${completionTokens} token` : "";
  throw new ModelResponseError(
    `${providerName} 的内容审核拦截了这次输出（finish_reason=content_filter${spent}）${providerText ? `，供应商原文：${providerText}` : ""}。审核结果不稳定，同一提示词重试常能通过；系统不会自动重试`,
    typeof completion.raw === "string" ? completion.raw : "",
    0,
    {
      provider: providerName,
      code: "MODEL_CONTENT_FILTERED",
      requestId: completion.requestId,
      finishReason: completion.finishReason,
      usage: completion.usage
    }
  );
}

// 输出陷入逐字重复、被读取流程主动叫停后的统一错误（判定在 src/output-degeneration.js）。
// 半截内容只进 detail 供排查，绝不当结果返回；用量只有中断前实际收到的（通常没有，不估算）。
export function outputDegenerateError(providerName, cause, requestId = "") {
  return new ModelResponseError(
    `${providerName} ${cause.message}`,
    String(cause?.partialRaw || ""),
    0,
    {
      provider: providerName,
      code: "MODEL_OUTPUT_DEGENERATE",
      requestId,
      usage: cause?.partialUsage
    }
  );
}

// 空闲超时触发后的统一错误：可重试的传输错误，消息说明多久没收到数据、此前收到多少。
export function streamIdleTimeoutError(providerName, idle, cause, requestId = "") {
  const seconds = Math.round(idle.timeoutMs / 1000);
  const chunks = Number(cause?.partialChunks) || 0;
  const contentLength = Number(cause?.partialContentLength) || 0;
  return new ModelResponseError(
    `${providerName} 流式传输连续 ${seconds} 秒没有收到任何数据，已中断（此前收到 ${contentLength} 字正文、${chunks} 个数据块）`,
    String(cause?.partialRaw || ""),
    0,
    {
      provider: providerName,
      code: "MODEL_STREAM_IDLE_TIMEOUT",
      requestId,
      usage: cause?.partialUsage
    }
  );
}

export function parseStrictModelJson(content, providerName = "模型") {
  const raw = typeof content === "string" ? content : "";
  try {
    return JSON.parse(raw.trim());
  } catch {
    throw new ModelResponseError(`${providerName} 未返回严格 JSON`, raw.slice(0, 3000));
  }
}

export function parseSingleJsonObject(content, providerName = "模型") {
  const value = parseStrictModelJson(content, providerName);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    const raw = typeof content === "string" ? content : "";
    throw new ModelResponseError(
      `${providerName} 必须只返回一个 JSON 对象`,
      raw,
      0,
      {
        provider: providerName,
        code: "MODEL_JSON_OBJECT_REQUIRED"
      }
    );
  }
  return value;
}

// 只观测，不参与控制流：回调抛错或 reject 一律吞掉，日志 sidecar 不得改变模型调用的成败。
async function notifyCompletion(onCompletion, completion) {
  if (typeof onCompletion !== "function") return;
  try {
    await onCompletion(completion);
  } catch {
    // 观测失败必须 fail-open。
  }
}
