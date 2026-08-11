import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const CAPTURE_VERSION = "animation-ai-prompt-capture-v1";
const CHAT_COMPLETIONS_PATH = /\/chat\/completions\/?$/u;

export class AnimationPromptCapture {
  constructor({ outputRoot = "" } = {}) {
    const configuredRoot = String(outputRoot || "").trim();
    this.outputRoot = configuredRoot ? path.resolve(configuredRoot) : "";
    this.storage = new AsyncLocalStorage();
  }

  get enabled() {
    return Boolean(this.outputRoot);
  }

  wrapFetch(fetchImpl = globalThis.fetch) {
    if (typeof fetchImpl !== "function") throw new TypeError("prompt capture 需要合法 fetch 实现");
    if (!this.enabled) return fetchImpl;
    const capture = this;
    return async function capturedFetch(input, init = {}) {
      if (capture.shouldCapture(input, init)) {
        await capture.captureOutboundRequest(input, init);
      }
      return Reflect.apply(fetchImpl, this, [input, init]);
    };
  }

  async run(metadata = {}, callback) {
    if (typeof callback !== "function") throw new TypeError("prompt capture callback 必须是函数");
    if (!this.enabled) return callback();

    await fs.mkdir(this.outputRoot, { recursive: true, mode: 0o700 });
    const startedAt = new Date().toISOString();
    const captureId = `${compactTimestamp(startedAt)}-${randomUUID()}`;
    const directory = path.join(this.outputRoot, captureId);
    await fs.mkdir(directory, { mode: 0o700 });
    const context = {
      captureId,
      directory,
      startedAt,
      sequence: 0,
      promptCount: 0,
      metadata: {
        route: String(metadata.route || "/api/animation-plan"),
        variantId: String(metadata.variantId || ""),
        animationPlanMode: String(metadata.animationPlanMode || "")
      }
    };
    await writeJsonAtomic(path.join(directory, "session-start.json"), {
      captureVersion: CAPTURE_VERSION,
      captureId,
      startedAt,
      ...context.metadata
    });

    return this.storage.run(context, async () => {
      try {
        const result = await callback({ captureId, directory });
        await writeJsonAtomic(path.join(directory, "session-complete.json"), {
          captureVersion: CAPTURE_VERSION,
          captureId,
          completedAt: new Date().toISOString(),
          status: "fulfilled",
          promptCount: context.promptCount
        });
        return result;
      } catch (error) {
        await writeJsonAtomic(path.join(directory, "session-complete.json"), {
          captureVersion: CAPTURE_VERSION,
          captureId,
          completedAt: new Date().toISOString(),
          status: "rejected",
          promptCount: context.promptCount,
          errorName: String(error?.name || "Error"),
          errorMessage: String(error?.message || error)
        });
        throw error;
      }
    });
  }

  shouldCapture(input, init = {}) {
    const context = this.storage.getStore();
    if (!context) return false;
    if (String(init?.method || "GET").toUpperCase() !== "POST") return false;
    const url = requestUrl(input);
    if (!url || !CHAT_COMPLETIONS_PATH.test(url.pathname)) return false;
    return typeof init?.body === "string";
  }

  async captureOutboundRequest(input, init = {}) {
    const context = this.storage.getStore();
    if (!context) return;
    let body;
    try {
      body = JSON.parse(init.body);
    } catch (error) {
      throw new Error(`无法解析即将发送给 AI 的请求体，Prompt 未发送：${String(error?.message || error)}`);
    }
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const systemPrompt = messageText(messages.find((message) => message?.role === "system")?.content);
    const userPrompt = messageText(messages.find((message) => message?.role === "user")?.content);
    const omittedNonTextParts = messages.reduce(
      (count, message) => count + nonTextPartCount(message?.content),
      0
    );
    const sequence = ++context.sequence;
    context.promptCount += 1;
    const label = classifyPrompt(userPrompt);
    const prefix = `${String(sequence).padStart(3, "0")}-${label}`;
    const systemFile = `${prefix}-system.prompt.txt`;
    const userFile = `${prefix}-user.prompt.txt`;
    const metadataFile = `${prefix}-request.json`;
    await Promise.all([
      writeTextAtomic(path.join(context.directory, systemFile), systemPrompt),
      writeTextAtomic(path.join(context.directory, userFile), userPrompt)
    ]);
    const url = requestUrl(input);
    await writeJsonAtomic(path.join(context.directory, metadataFile), {
      captureVersion: CAPTURE_VERSION,
      captureId: context.captureId,
      sequence,
      capturedAt: new Date().toISOString(),
      label,
      endpoint: url ? `${url.origin}${url.pathname}` : "",
      model: String(body?.model || ""),
      maxTokens: finiteNumber(body?.max_tokens ?? body?.max_completion_tokens),
      responseFormat: body?.response_format?.type ? String(body.response_format.type) : "",
      thinking: body?.thinking?.type ? String(body.thinking.type) : "",
      enableThinking: typeof body?.enable_thinking === "boolean" ? body.enable_thinking : null,
      systemPromptFile: systemFile,
      userPromptFile: userFile,
      omittedNonTextParts
    });
  }
}

function requestUrl(input) {
  try {
    if (typeof input === "string" || input instanceof URL) return new URL(input);
    if (input && typeof input.url === "string") return new URL(input.url);
  } catch {
    return null;
  }
  return null;
}

function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

function nonTextPartCount(content) {
  if (!Array.isArray(content)) return 0;
  return content.filter((part) => part?.type !== "text").length;
}

function classifyPrompt(prompt) {
  const value = String(prompt || "");
  if (/上一次(?: Qwen| DeepSeek|模型)?输出不是完整合法 JSON/u.test(value)) return "provider-json-retry";
  if (value.includes("ANIMATION_SHOT_BATCH_RETRY_V1")) return "animation-shot-batch-second-pass";
  if (value.includes("直接视频镜头基础锁定")) {
    return value.includes("上一次输出已经是 JSON")
      ? "animation-foundation-validation-retry"
      : "animation-foundation";
  }
  if (value.includes("直接视频镜头批次")) return "animation-shot-batch";
  if (value.includes("ACTION_STATE_SEMANTIC_AUDIT_V1")) return "animation-action-state-audit";
  return "animation-model-call";
}

function compactTimestamp(value) {
  return String(value || "").replace(/[-:.]/gu, "").replace("Z", "Z");
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function writeTextAtomic(file, value) {
  const temporary = path.join(path.dirname(file), `.tmp-${randomUUID()}`);
  await fs.writeFile(temporary, String(value ?? ""), { encoding: "utf8", flag: "wx", mode: 0o600 });
  await fs.rename(temporary, file);
}

async function writeJsonAtomic(file, value) {
  await writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}
