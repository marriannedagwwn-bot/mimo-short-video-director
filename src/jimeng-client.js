import { InputError } from "./validation.js";
import { buildShotFrameImagePrompt as buildSharedShotFrameImagePrompt } from "../public/shot-frame-prompt.js";
import { buildCharacterReferenceImagePrompt as buildSharedCharacterReferenceImagePrompt } from "../public/character-reference-prompt.js";

export class JimengImageConfigError extends Error {}
export class JimengImageProviderError extends Error {
  constructor(message, raw = "", status = 0) {
    super(message);
    this.name = "JimengImageProviderError";
    this.raw = raw;
    this.status = status;
  }
}

export class JimengImageClient {
  constructor(config) {
    this.config = config;
  }

  async checkHealth() {
    if (!this.config.baseUrl || !this.config.apiKey) return { reachable: false, modelAvailable: false, status: 0 };
    const endpoint = `${this.config.baseUrl.replace(/\/$/, "")}/models`;
    try {
      const response = await fetch(endpoint, {
        headers: this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {},
        signal: AbortSignal.timeout(5_000)
      });
      if (!response.ok) return { reachable: false, modelAvailable: false, status: response.status };
      const body = await response.json();
      const modelIds = Array.isArray(body.data) ? body.data.map((item) => item?.id).filter(Boolean) : [];
      const requested = this.config.model || "";
      const requestedTail = requested.split("/").pop();
      const modelAvailable = modelIds.length === 0 || modelIds.some((id) => id === requested || id.split("/").pop() === requestedTail);
      return { reachable: true, modelAvailable, status: response.status, modelIds };
    } catch {
      return { reachable: false, modelAvailable: false, status: 0 };
    }
  }

  async generateImagesStream(input = {}, onEvent = async () => {}) {
    if (!this.config.baseUrl || !this.config.apiKey) {
      throw new JimengImageConfigError("未配置即梦文生图服务。请设置 JIMENG_API_KEY，也可以用 JIMENG_BASE_URL / JIMENG_IMAGE_MODEL 覆盖默认配置。");
    }
    const endpoint = `${this.config.baseUrl.replace(/\/$/, "")}/images/generations`;
    const body = buildJimengImageRequestBody(this.config, input);
    const requestReceipt = buildJimengImageRequestReceipt(body, input.negativePromptDelivery);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.config.apiKey}`
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.config.timeoutMs || 300_000)
    });

    if (!response.ok) {
      const raw = await response.text();
      throw new JimengImageProviderError(`即梦图片生成请求失败（${response.status}）`, raw.slice(0, 2000), response.status);
    }
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/event-stream")) {
      const envelope = await response.json();
      await emitNonStreamingEnvelope(envelope, onEvent);
      return requestReceipt;
    }
    if (!response.body) throw new JimengImageProviderError("即梦没有返回可读取的流式响应");
    await parseSseStream(response.body, onEvent);
    return requestReceipt;
  }
}

export function buildCharacterReferenceImagePrompt(characterReference = {}, count = 1, visualBible = null) {
  const prompt = buildSharedCharacterReferenceImagePrompt({ characterReference, count, visualBible });
  if (!prompt) throw new InputError("角色参考提示词为空，无法生成参考图。");
  return prompt;
}

export function buildShotFrameImagePrompt(input = {}) {
  try {
    return buildSharedShotFrameImagePrompt(input);
  } catch (error) {
    throw new InputError(error.message || "镜头帧提示词为空，无法生成镜头图。");
  }
}

export function buildJimengImageRequestBody(config = {}, input = {}) {
  const count = clampInteger(input.count, 1, config.maxImages || 6);
  const prompt = input.prompt
    || buildCharacterReferenceImagePrompt(input.characterReference, count, input.visualBible);
  const body = {
    model: input.model || config.model,
    prompt,
    size: input.size || config.size || "1728x2304",
    stream: true,
    response_format: "b64_json",
    watermark: config.watermark === true,
    sequential_image_generation: count > 1 ? "auto" : "disabled",
    output_format: config.outputFormat || "png"
  };
  const referenceImages = Array.isArray(input.referenceImageDataUrls)
    ? input.referenceImageDataUrls.filter(Boolean)
    : input.referenceImageDataUrl ? [input.referenceImageDataUrl] : [];
  if (referenceImages.length) {
    if (config.imageField === "image") body.image = referenceImages.length === 1 ? referenceImages[0] : referenceImages;
    else body.images = referenceImages;
  }
  if (count > 1) body.sequential_image_generation_options = { max_images: count };
  return body;
}

export function buildJimengImageRequestReceipt(body = {}, delivery = null) {
  const source = delivery && typeof delivery === "object" ? delivery : {};
  const positiveConstraints = Array.isArray(source.positiveConstraints) ? source.positiveConstraints.filter(Boolean) : [];
  const ignoredEntries = Array.isArray(source.ignoredEntries) ? source.ignoredEntries : [];
  const negativePromptEntries = Array.isArray(source.negativePromptEntries) ? source.negativePromptEntries : [];
  return {
    negativePromptDelivery: {
      supported: false,
      appliedMode: positiveConstraints.length ? "positive_constraint" : "not_supported",
      providerField: positiveConstraints.length ? "prompt" : "",
      compiledNegativePrompt: String(source.compiledNegativePrompt || ""),
      appliedText: positiveConstraints.join("\n"),
      ignored: ignoredEntries.map((entry) => entry?.text || String(entry || "")).filter(Boolean),
      providerIgnored: ignoredEntries.length > 0
    },
    requestPreview: redactJimengRequestPreview(body),
    negativePromptEntries
  };
}

function redactJimengRequestPreview(body = {}) {
  const redact = (value) => {
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]));
    if (typeof value !== "string") return value;
    if (/^data:[^;,]+;base64,/u.test(value)) return "[REDACTED_DATA_URL]";
    if (value.length > 512 && /^[A-Za-z0-9+/=_-]+$/u.test(value)) return "[REDACTED_BASE64]";
    return value;
  };
  return redact(body);
}

async function parseSseStream(body, onEvent) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split(/\r?\n\r?\n/u);
    buffer = blocks.pop() || "";
    for (const block of blocks) {
      const event = parseSseBlock(block);
      if (event) await onEvent(event);
    }
  }
  buffer += decoder.decode();
  const tail = parseSseBlock(buffer);
  if (tail) await onEvent(tail);
}

function parseSseBlock(block) {
  const lines = String(block || "").split(/\r?\n/u);
  const data = [];
  let eventName = "";
  for (const line of lines) {
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (!data.length) return null;
  const raw = data.join("\n");
  if (!raw || raw === "[DONE]") return null;
  try {
    const parsed = JSON.parse(raw);
    if (eventName && !parsed.type) parsed.type = eventName;
    return parsed;
  } catch {
    return { type: eventName || "message", raw };
  }
}

async function emitNonStreamingEnvelope(envelope, onEvent) {
  const data = Array.isArray(envelope?.data) ? envelope.data : [];
  for (const [index, item] of data.entries()) {
    if (item?.error) {
      await onEvent({ type: "image_generation.partial_failed", image_index: index, error: item.error, model: envelope.model, created: envelope.created });
    } else {
      await onEvent({ type: "image_generation.partial_succeeded", image_index: index, url: item.url, b64_json: item.b64_json, size: item.size, model: envelope.model, created: envelope.created });
    }
  }
  await onEvent({ type: "image_generation.completed", model: envelope?.model, created: envelope?.created, usage: envelope?.usage || {} });
}

function clampInteger(value, fallback, maximum) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(1, number));
}
