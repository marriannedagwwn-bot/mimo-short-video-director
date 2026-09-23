import { SYSTEM_PROMPT } from "./prompts.js";
import { recordModelUsage } from "./token-usage.js";
import { afterDurableProviderCall, beforeDurableProviderCall, durableTaskHeartbeat, durableProviderAbortSignal, throwIfDurableTaskAborted } from "./durable-task-context.js";
import { SseStreamIncompleteError, readSseCompletion } from "./sse-stream.js";

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
      try {
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
    const effectiveTimeoutMs = requestTimeoutMs ?? this.config.requestTimeoutMs ?? 900_000;
    await beforeDurableProviderCall("model_provider_call", effectiveTimeoutMs);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {})
      },
      body: JSON.stringify(body),
      signal: durableProviderAbortSignal(effectiveTimeoutMs)
    }).catch((error) => {
      throwIfDurableTaskAborted();
      throw error;
    });
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
  const current = Number(value || 8192);
  if (!Number.isFinite(current)) return 12288;
  return Math.min(32768, Math.max(12288, Math.ceil(current * 1.5)));
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
