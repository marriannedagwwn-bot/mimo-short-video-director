import { SYSTEM_PROMPT } from "./prompts.js";
import { ModelResponseError, parseModelJson, parseStrictModelJson } from "./mimo-client.js";
import { recordModelUsage } from "./token-usage.js";

export class DeepSeekClient {
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
      const modelAvailable = modelIds.length === 0
        || modelIds.some((id) => id === requested || id.split("/").pop() === requestedTail);
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

  async generateJsonWithMedia() {
    throw new ModelResponseError(
      "DeepSeek-V4 仅支持纯文本阶段，不能接收图片或视频输入",
      "",
      0,
      {
        provider: "DeepSeek",
        code: "MODEL_MEDIA_UNSUPPORTED"
      }
    );
  }

  async requestJson({
    prompt,
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
    let activeMaxTokens = maxCompletionTokens;
    let lastJsonError = null;

    for (let attempt = 0; attempt <= retryAttempts; attempt += 1) {
      const completion = await this.requestCompletion({
        prompt: activePrompt,
        model,
        maxCompletionTokens: activeMaxTokens,
        systemPrompt,
        requestTimeoutMs
      });
      await notifyCompletion(onCompletion, completion);
      const content = completion.content;
      try {
        return strictJson
          ? parseStrictModelJson(content, "DeepSeek")
          : parseModelJson(content, "DeepSeek");
      } catch (error) {
        if (!(error instanceof ModelResponseError) || attempt >= retryAttempts) throw error;
        lastJsonError = error;
        activePrompt = jsonRetryPrompt(prompt, content);
        activeMaxTokens = retryTokenLimit(activeMaxTokens ?? this.config.maxCompletionTokens);
      }
    }

    throw lastJsonError || new ModelResponseError("DeepSeek 未返回合法 JSON");
  }

  async requestCompletion({
    prompt,
    model = null,
    maxCompletionTokens = null,
    systemPrompt = null,
    requestTimeoutMs = null
  } = {}) {
    const endpoint = `${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const body = buildDeepSeekRequestBody(
      this.config,
      { prompt },
      { model, maxCompletionTokens, systemPrompt }
    );
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {})
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(requestTimeoutMs ?? this.config.requestTimeoutMs ?? 900_000)
    });
    const raw = await response.text();
    const headerRequestId = response.headers.get("x-request-id")
      || response.headers.get("request-id")
      || "";
    if (!response.ok) {
      throw new ModelResponseError(
        `DeepSeek 请求失败（${response.status}）`,
        raw,
        response.status,
        {
          provider: "DeepSeek",
          code: "MODEL_HTTP_ERROR",
          requestId: headerRequestId
        }
      );
    }

    let envelope;
    try {
      envelope = JSON.parse(raw);
    } catch {
      throw new ModelResponseError(
        "DeepSeek 返回了无法解析的响应包",
        raw,
        0,
        {
          provider: "DeepSeek",
          code: "MODEL_ENVELOPE_INVALID",
          requestId: headerRequestId
        }
      );
    }
    const choice = envelope.choices?.[0];
    const content = choice?.message?.content;
    const requestId = headerRequestId || String(envelope.id || "");
    const usage = envelope.usage && typeof envelope.usage === "object"
      ? envelope.usage
      : null;
    // 记入当前请求的 token 记账作用域；作用域外是 no-op，异常内部吞掉。
    recordModelUsage({ provider: "DeepSeek", model: body.model, usage });
    const finishReason = String(choice?.finish_reason || "");
    if (typeof content !== "string") {
      throw new ModelResponseError(
        "DeepSeek 响应缺少 message.content",
        raw,
        0,
        {
          provider: "DeepSeek",
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
      raw
    };
  }
}

export function buildDeepSeekRequestBody(config, { prompt }, overrides = {}) {
  const body = {
    model: overrides.model || config.model,
    max_tokens: overrides.maxCompletionTokens ?? config.maxCompletionTokens ?? 16384,
    temperature: config.temperature ?? 1,
    top_p: config.topP ?? 1,
    stream: false,
    thinking: { type: config.thinking || "disabled" },
    messages: [
      {
        role: "system",
        content: typeof overrides.systemPrompt === "string" && overrides.systemPrompt.trim()
          ? overrides.systemPrompt
          : SYSTEM_PROMPT
      },
      { role: "user", content: prompt }
    ]
  };
  if (config.jsonMode) body.response_format = { type: "json_object" };
  return body;
}

function jsonRetryPrompt(originalPrompt, failedContent) {
  return `${originalPrompt}

上一次 DeepSeek 输出不是完整合法 JSON，可能为空、被截断或包含了无法解析的内容。请重新输出一次。

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
  const current = Number(value || 16384);
  if (!Number.isFinite(current)) return 24576;
  return Math.min(65536, Math.max(24576, Math.ceil(current * 1.35)));
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
