import { SYSTEM_PROMPT } from "./prompts.js";
import { ModelResponseError, parseModelJson } from "./mimo-client.js";

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

  async generateJson({ prompt, model = null, maxCompletionTokens = null } = {}) {
    return this.requestJson({ prompt, model, maxCompletionTokens });
  }

  async generateJsonWithMedia({ prompt, model = null, maxCompletionTokens = null } = {}) {
    return this.requestJson({ prompt, model, maxCompletionTokens });
  }

  async requestJson({ prompt, model = null, maxCompletionTokens = null, jsonRetryAttempts = null }) {
    const endpoint = `${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const retryAttempts = jsonRetryAttempts === null
      ? Number.isFinite(Number(this.config.jsonRetryAttempts)) ? Number(this.config.jsonRetryAttempts) : 2
      : Math.max(0, Number(jsonRetryAttempts) || 0);
    let activePrompt = prompt;
    let activeMaxTokens = maxCompletionTokens;
    let lastJsonError = null;

    for (let attempt = 0; attempt <= retryAttempts; attempt += 1) {
      const body = buildQwenRequestBody(this.config, { prompt: activePrompt }, { model, maxCompletionTokens: activeMaxTokens });
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {})
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(240_000)
      });
      const raw = await response.text();
      if (!response.ok) {
        throw new ModelResponseError(`Qwen 请求失败（${response.status}）`, raw.slice(0, 2000), response.status);
      }

      let envelope;
      try {
        envelope = JSON.parse(raw);
      } catch {
        throw new ModelResponseError("Qwen 返回了无法解析的响应包", raw.slice(0, 2000));
      }
      const content = envelope.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new ModelResponseError("Qwen 响应缺少 message.content", raw.slice(0, 2000));
      try {
        return parseModelJson(content, "Qwen");
      } catch (error) {
        if (!(error instanceof ModelResponseError) || attempt >= retryAttempts) throw error;
        lastJsonError = error;
        activePrompt = jsonRetryPrompt(prompt, content);
        activeMaxTokens = retryTokenLimit(activeMaxTokens ?? this.config.maxCompletionTokens);
      }
    }

    throw lastJsonError || new ModelResponseError("Qwen 未返回合法 JSON");
  }
}

export function buildQwenRequestBody(config, { prompt }, overrides = {}) {
  const body = {
    model: overrides.model || config.model,
    max_tokens: overrides.maxCompletionTokens ?? config.maxCompletionTokens ?? 12288,
    temperature: 0.3,
    top_p: 0.95,
    stream: false,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: prompt }
    ]
  };
  if (typeof config.enableThinking === "boolean") body.enable_thinking = config.enableThinking;
  if (config.jsonMode) body.response_format = { type: "json_object" };
  return body;
}

function jsonRetryPrompt(originalPrompt, failedContent) {
  return `${originalPrompt}

上一次 Qwen 输出不是完整合法 JSON，可能被截断或包含了无法解析的内容。请重新输出一次。

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
  const current = Number(value || 12288);
  if (!Number.isFinite(current)) return 16384;
  return Math.min(65536, Math.max(16384, Math.ceil(current * 1.35)));
}
