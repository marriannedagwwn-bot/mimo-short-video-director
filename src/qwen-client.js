import { SYSTEM_PROMPT } from "./prompts.js";
import { ModelResponseError, assertCompletionNotContentFiltered, assertCompletionNotTruncated, parseModelJson, parseStrictModelJson, streamIdleTimeoutError } from "./mimo-client.js";
import { recordModelUsage } from "./token-usage.js";
import { afterDurableProviderCall, beforeDurableProviderCall, durableTaskHeartbeat, durableProviderAbortSignal, throwIfDurableTaskAborted } from "./durable-task-context.js";
import { SseStreamIncompleteError, readSseCompletion } from "./sse-stream.js";
import { createStreamIdleTimer, resolveStreamIdleTimeoutMs } from "./stream-idle-timeout.js";

export class QwenClient {
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
      const modelAvailable = modelIds.length === 0 || modelIds.some((id) => id === requested || id.split("/").pop() === requestedTail);
      return { reachable: true, modelAvailable, status: response.status, modelIds };
    } catch {
      return { reachable: false, modelAvailable: false, status: 0 };
    }
  }

  async generateJson({
    prompt,
    model = null,
    maxCompletionTokens = null,
    systemPrompt = null,
    requestTimeoutMs = null,
    jsonRetryAttempts = null,
    strictJson = false,
    onCompletion = null
  } = {}) {
    return this.requestJson({
      prompt,
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
  } = {}) {
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
        && ([400, 413, 415, 422].includes(error.status) || isRecoverableVideoJsonError(error));
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
    const providerName = qwenCompatibleProviderName(model || this.config.model);
    const retryAttempts = jsonRetryAttempts === null
      ? Number.isFinite(Number(this.config.jsonRetryAttempts)) ? Number(this.config.jsonRetryAttempts) : 2
      : Math.max(0, Number(jsonRetryAttempts) || 0);
    let activePrompt = prompt;
    let activeMaxTokens = maxCompletionTokens;
    let lastJsonError = null;

    for (let attempt = 0; attempt <= retryAttempts; attempt += 1) {
      const completion = await this.requestCompletion({
        prompt: activePrompt,
        frames,
        video,
        useVideo,
        model,
        maxCompletionTokens: activeMaxTokens,
        systemPrompt,
        requestTimeoutMs
      });
      await notifyCompletion(onCompletion, completion);
      const content = completion.content;
      assertCompletionNotContentFiltered(completion, providerName);
      try {
        assertCompletionNotTruncated(completion, providerName);
        return strictJson
          ? parseStrictModelJson(content, providerName)
          : parseModelJson(content, providerName);
      } catch (error) {
        if (!(error instanceof ModelResponseError) || attempt >= retryAttempts) throw error;
        lastJsonError = error;
        activePrompt = jsonRetryPrompt(prompt, content, providerName);
        activeMaxTokens = retryTokenLimit(activeMaxTokens ?? this.config.maxCompletionTokens);
      }
    }

    throw lastJsonError || new ModelResponseError(`${providerName} 未返回合法 JSON`);
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
    const body = buildQwenRequestBody(
      this.config,
      { prompt, frames, video, useVideo },
      { model, maxCompletionTokens, systemPrompt }
    );
    const providerName = qwenCompatibleProviderName(body.model);
    // 流式请求不设总时长上限，只判空闲：连续 streamIdleTimeoutMs 没收到任何数据才中断。
    // requestTimeoutMs 在流式客户端上不再生效（参数保留给调用方的统一签名）。
    const idleTimeoutMs = resolveStreamIdleTimeoutMs(this.config);
    await beforeDurableProviderCall("model_provider_call", idleTimeoutMs);
    const idle = createStreamIdleTimer(idleTimeoutMs);
    try {
      return await this.streamCompletion({ endpoint, body, providerName, idle });
    } finally {
      idle.clear();
    }
  }

  async streamCompletion({ endpoint, body, providerName, idle }) {
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
    // 错误响应体是普通 JSON 而不是 SSE，所以这一分支必须留在读流之前。
    if (!response.ok) {
      const errorBody = await response.text().catch((error) => {
        throwIfDurableTaskAborted();
        throw error;
      });
      await afterDurableProviderCall("model_provider_response");
      throw new ModelResponseError(
        `${providerName} 请求失败（${response.status}）`,
        errorBody,
        response.status,
        {
          provider: providerName,
          code: "MODEL_HTTP_ERROR",
          requestId: headerRequestId
        }
      );
    }

    // 流读取期间定期更新 Durable Task 进度，让界面看得到「还在出字」。
    // 每收到一块数据都重置空闲计时器；心跳本身按 10 秒节流。
    let lastHeartbeatAt = 0;
    const onProgress = ({ contentLength }) => {
      idle.touch();
      const now = Date.now();
      if (now - lastHeartbeatAt < 10_000) return;
      lastHeartbeatAt = now;
      // fire-and-forget：观测失败不得改变传输结论
      Promise.resolve(durableTaskHeartbeat({ streamedChars: contentLength })).catch(() => {});
    };

    let stream;
    try {
      stream = await readSseCompletion(response.body, { onProgress });
    } catch (error) {
      // Only account structured usage actually received before disconnection.
      // The success path below cannot also run after this catch throws.
      recordModelUsage({ provider: providerName, model: body.model, usage: error?.partialUsage });
      throwIfDurableTaskAborted();
      await afterDurableProviderCall("model_provider_response");
      if (idle.fired) throw streamIdleTimeoutError(providerName, idle, error, headerRequestId);
      // 连接被对端切断（undici 的 TypeError: terminated）时，已收到的内容挂在
      // error.partialRaw 上。把规模带进错误消息，让日志能区分「刚开始就断」与
      // 「快写完才断」——前者重试即可，后者说明该换策略（拆分请求或换模型）。
      // 正文本身不进消息，只进 detail，避免把半截 JSON 混进人类可读的错误里。
      //
      // 判据是**收到过任何数据块**，不是「收到过正文」。reasoning_content 按 §2.7
      // 单独收集、不算正文，而 qwen3.8-max 实测 82% 的 completion token 是推理，
      // 所以推理期断线时正文长度仍是 0——旧判据让它漏出包装，裸 TypeError 一路
      // 冒到 HTTP 层变成不可重试的 500。实测两次终审失败（158 秒、649 秒）都是
      // 这个形状：流一直活着、模型一直在推理，只是还没吐正文。
      // 中途被对端切断就是传输故障，与已经吐了多少正文无关。
      if (typeof error?.partialChunks === "number" && error.partialChunks > 0) {
        const kept = String(error.partialRaw || "");
        throw new ModelResponseError(
          `${providerName} 流式传输在收到 ${error.partialContentLength} 字正文（${error.partialChunks} 个数据块）后中断：${error.message}`,
          kept,
          0,
          {
            provider: providerName,
            code: "MODEL_STREAM_ABORTED",
            requestId: headerRequestId
          }
        );
      }
      if (error instanceof SseStreamIncompleteError) {
        // 半截内容绝不当成结果返回：否则残缺 JSON 会被下游报成「JSON 格式错误」，
        // 把传输中断伪装成模型输出问题。
        throw new ModelResponseError(
          `${providerName} ${error.message}`,
          error.raw,
          0,
          {
            provider: providerName,
            code: "MODEL_STREAM_INCOMPLETE",
            requestId: headerRequestId
          }
        );
      }
      throw error;
    }
    const raw = stream.raw;
    const content = stream.content;
    const requestId = headerRequestId || String(stream.id || "");
    const usage = stream.usage && typeof stream.usage === "object"
      ? stream.usage
      : null;
    // 已完成响应的用量先记账；随后冻结复检失败也不能抹掉已发生的消耗。
    recordModelUsage({ provider: providerName, model: body.model, usage });
    await afterDurableProviderCall("model_provider_response");
    const finishReason = String(stream.finishReason || "");
    if (typeof content !== "string") {
      throw new ModelResponseError(
        `${providerName} 响应缺少 message.content`,
        raw,
        0,
        {
          provider: providerName,
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
      providerName,
      model: body.model,
      raw
    };
  }
}

function notifyResolvedMediaMode(callback, mode) {
  if (typeof callback === "function") callback(mode);
}

// 网关按模型拒绝 temperature 的清单。与 provider-error-codes.js 同规格：只登记供应商
// 实测返回的事实，不猜测、不按模型名前缀推断——kimi-k2.7-code 就正常接受 temperature，
// 所以「kimi 系列都不支持」是错的。
// 来源：2026-08-30 对 baseUrl/chat/completions 的实测响应
//   kimi-k3 -> HTTP 400 "Parameter 'temperature'=0.3 is not supported for kimi-k3 model."
// 只影响 temperature；同一模型的 top_p、response_format、max_tokens 均正常。
// 不在清单里的模型一律照常发送 temperature，供应商拒绝就如实抛错，不静默重试、不降级。
const MODELS_REJECTING_TEMPERATURE = new Set(["kimi-k3"]);

export function modelAcceptsTemperature(model) {
  return !MODELS_REJECTING_TEMPERATURE.has(String(model || "").trim());
}

export function buildQwenRequestBody(config, { prompt, frames = [], video = null, useVideo = false }, overrides = {}) {
  const visualContent = buildQwenVisualContent(config, { frames, video, useVideo });
  const userContent = visualContent.length ? [...visualContent, { type: "text", text: prompt }] : prompt;
  const model = overrides.model || config.model;
  const body = {
    model,
    max_tokens: overrides.maxCompletionTokens ?? config.maxCompletionTokens ?? 12288,
    ...(modelAcceptsTemperature(model) ? { temperature: 0.3 } : {}),
    top_p: 0.95,
    // 流式传输。非流式长请求会在约 306 秒被上游掐断（2026-09-05 实测：kimi-k3 与
    // qwen3.8-max-0902 各两次，306503/306696/306704/306861ms，跨模型同一个数字，
    // 四次全部零字节输出），而成功调用最慢 234 秒——余量只剩 72 秒。悬崖在传输层，
    // 与模型无关，所以这里对全部模型开启，不维护按模型的清单。
    stream: true,
    // usage 只在最后一个数据块里返回，不带这个选项就拿不到 token 记账。
    stream_options: { include_usage: true },
    messages: [
      {
        role: "system",
        content: typeof overrides.systemPrompt === "string" && overrides.systemPrompt.trim()
          ? overrides.systemPrompt
          : SYSTEM_PROMPT
      },
      { role: "user", content: userContent }
    ]
  };
  if (isZhipuGlm53Model(model)) {
    // GLM 5.3/5.3-Flash cannot disable thinking and defaults to max reasoning.
    // This client only performs JSON workflow calls, so low reasoning preserves
    // enough of the output budget for the final answer.
    body.enable_thinking = true;
    body.reasoning_effort = "low";
  } else if (typeof config.enableThinking === "boolean") {
    body.enable_thinking = config.enableThinking;
  }
  // Zhipu GLM 5.3 does not support OpenAI structured output. The workflow still
  // enforces strict JSON locally after the completion is returned.
  if (config.jsonMode && !isZhipuGlm53Model(model)) body.response_format = { type: "json_object" };
  return body;
}

export function qwenCompatibleProviderName(model = "") {
  return /^ZHIPU\//iu.test(String(model).trim()) ? "Zhipu" : "Qwen";
}

export function isZhipuGlm53Model(model = "") {
  return /^ZHIPU\/GLM-5\.3(?:-Flash)?$/iu.test(String(model).trim());
}

function buildQwenVisualContent(config, { frames = [], video = null, useVideo = false } = {}) {
  const options = qwenVisionOptions(config);
  if (useVideo && video?.dataUrl) {
    return [{
      type: "video_url",
      video_url: { url: video.dataUrl },
      ...options
    }];
  }
  const imageUrls = frames.map((frame) => frame?.dataUrl).filter(Boolean);
  if (imageUrls.length >= 4) {
    return [{
      type: "video",
      video: imageUrls,
      ...options
    }];
  }
  return imageUrls.map((url) => ({
    type: "image_url",
    image_url: { url },
    ...qwenImageOptions(config)
  }));
}

function qwenVisionOptions(config = {}) {
  return compactObject({
    fps: config.videoFps ?? 2,
    min_pixels: config.minPixels,
    max_pixels: config.maxPixels,
    total_pixels: config.totalPixels
  });
}

function qwenImageOptions(config = {}) {
  return compactObject({
    min_pixels: config.minPixels,
    max_pixels: config.maxPixels
  });
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== undefined && item !== ""));
}

function jsonRetryPrompt(originalPrompt, failedContent, providerName = "Qwen") {
  return `${originalPrompt}

上一次 ${providerName} 输出不是完整合法 JSON，可能被截断或包含了无法解析的内容。请重新输出一次。

纠偏要求：
- 只输出一个完整 JSON 对象，不要 Markdown，不要解释。
- 必须保留原任务要求的所有顶层字段和数组字段。
- 内容可以更精炼，但不能省略结构字段。
- 每个字符串尽量控制在 80 个汉字以内，避免长段落导致再次截断。
- 不要复述上一次错误输出；直接重新生成完整 JSON。

上一次错误输出开头仅供诊断，不要照抄：
${String(failedContent || "").slice(0, 800)}`;
}

function isRecoverableVideoJsonError(error) {
  return error instanceof ModelResponseError && error.message.includes("未返回合法 JSON");
}

function retryTokenLimit(value) {
  const current = Number(value || 12288);
  if (!Number.isFinite(current)) return 16384;
  return Math.min(65536, Math.max(16384, Math.ceil(current * 1.35)));
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
