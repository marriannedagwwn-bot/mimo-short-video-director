import { SYSTEM_PROMPT } from "./prompts.js";

export class ModelResponseError extends Error {
  constructor(message, raw = "", status = 0) {
    super(message);
    this.name = "ModelResponseError";
    this.raw = raw;
    this.status = status;
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

  async generateJson({ prompt, frames = [], model = null, maxCompletionTokens = null } = {}) {
    return this.generateJsonWithMedia({ prompt, frames, model, maxCompletionTokens });
  }

  async generateJsonWithMedia({ prompt, frames = [], video = null, model = null, maxCompletionTokens = null }) {
    const canUseVideo = Boolean(video?.dataUrl) && this.config.mediaMode !== "frames";
    try {
      return await this.requestJson({ prompt, frames, video, useVideo: canUseVideo, model, maxCompletionTokens });
    } catch (error) {
      const canFallback = canUseVideo
        && this.config.mediaMode === "auto"
        && frames.length > 0
        && error instanceof ModelResponseError
        && [400, 415, 422].includes(error.status);
      if (!canFallback) throw error;
      return this.requestJson({ prompt, frames, useVideo: false, model, maxCompletionTokens });
    }
  }

  async requestJson({ prompt, frames = [], video = null, useVideo = false, model = null, maxCompletionTokens = null }) {
    const endpoint = `${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const body = buildRequestBody(this.config, { prompt, frames, video, useVideo }, { model, maxCompletionTokens });

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {})
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000)
    });
    const raw = await response.text();
    if (!response.ok) {
      throw new ModelResponseError(`MiMo 请求失败（${response.status}）`, raw.slice(0, 2000), response.status);
    }

    let envelope;
    try {
      envelope = JSON.parse(raw);
    } catch {
      throw new ModelResponseError("MiMo 返回了无法解析的响应包", raw.slice(0, 2000));
    }
    const content = envelope.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new ModelResponseError("MiMo 响应缺少 message.content", raw.slice(0, 2000));
    return parseModelJson(content);
  }
}

export function buildRequestBody(config, { prompt, frames = [], video = null, useVideo = false }, overrides = {}) {
  const visualContent = useVideo && video?.dataUrl
    ? [{ type: "video_url", video_url: { url: video.dataUrl }, fps: config.videoFps ?? 2, media_resolution: config.videoMediaResolution || "default" }]
    : frames.map((frame) => ({ type: "image_url", image_url: { url: frame.dataUrl } }));
  const body = {
    model: overrides.model || config.model,
    max_completion_tokens: overrides.maxCompletionTokens ?? config.maxCompletionTokens ?? 8192,
    temperature: 0.3,
    top_p: 0.95,
    stream: false,
    thinking: { type: config.thinking || "disabled" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: [...visualContent, { type: "text", text: `${prompt}\n/no_think` }] }
    ]
  };
  if (config.jsonMode) body.response_format = { type: "json_object" };
  return body;
}

export function parseModelJson(content) {
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
    throw new ModelResponseError("MiMo 未返回合法 JSON", content.slice(0, 3000));
  }
}
