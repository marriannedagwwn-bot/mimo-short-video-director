import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const CAPTURE_VERSION = "animation-ai-prompt-capture-v1";
const CHAT_COMPLETIONS_PATH = /\/chat\/completions\/?$/u;

export class AnimationPromptCapture {
  constructor({
    outputRoot = "",
    modelOutputLogWriter = null,
    onWarning = (message) => console.warn(message)
  } = {}) {
    const configuredRoot = String(outputRoot || "").trim();
    this.outputRoot = configuredRoot ? path.resolve(configuredRoot) : "";
    this.modelOutputLogWriter = modelOutputLogWriter
      && typeof modelOutputLogWriter.recordAttempt === "function"
      ? modelOutputLogWriter
      : null;
    this.onWarning = typeof onWarning === "function" ? onWarning : () => {};
    this.storage = new AsyncLocalStorage();
  }

  get enabled() {
    return Boolean(this.outputRoot);
  }

  get modelOutputLoggingEnabled() {
    return Boolean(this.modelOutputLogWriter?.enabled);
  }

  get active() {
    return this.enabled || this.modelOutputLoggingEnabled;
  }

  wrapFetch(fetchImpl = globalThis.fetch) {
    if (typeof fetchImpl !== "function") throw new TypeError("prompt capture 需要合法 fetch 实现");
    if (!this.active) return fetchImpl;
    const capture = this;
    return async function capturedFetch(input, init = {}) {
      const call = capture.shouldCapture(input, init)
        ? await capture.captureOutboundRequest(input, init)
        : null;
      try {
        const response = await Reflect.apply(fetchImpl, this, [input, init]);
        if (call) await capture.captureInboundResponse(call, response);
        return response;
      } catch (error) {
        if (call) await capture.captureTransportFailure(call, error);
        throw error;
      }
    };
  }

  async run(metadata = {}, callback) {
    if (typeof callback !== "function") throw new TypeError("prompt capture callback 必须是函数");
    if (!this.active) return callback();

    const startedAt = new Date().toISOString();
    const captureId = `${compactTimestamp(startedAt)}-${randomUUID()}`;
    const directory = this.enabled ? path.join(this.outputRoot, captureId) : "";
    if (this.enabled) {
      await fs.mkdir(this.outputRoot, { recursive: true, mode: 0o700 });
      await fs.mkdir(directory, { mode: 0o700 });
    }
    const context = {
      captureId,
      directory,
      startedAt,
      sequence: 0,
      promptCount: 0,
      promptPhaseCounts: new Map(),
      modelOutputAttempts: [],
      traceContext: modelOutputTraceContext(metadata.traceContext, metadata.variantId),
      metadata: {
        route: String(metadata.route || "/api/animation-plan"),
        variantId: String(metadata.variantId || ""),
        animationPlanMode: String(metadata.animationPlanMode || ""),
        provider: String(metadata.provider || "")
      }
    };
    if (this.enabled) {
      await writeJsonAtomic(path.join(directory, "session-start.json"), {
        captureVersion: CAPTURE_VERSION,
        captureId,
        startedAt,
        route: context.metadata.route,
        variantId: context.metadata.variantId,
        animationPlanMode: context.metadata.animationPlanMode
      });
    }

    return this.storage.run(context, async () => {
      try {
        const result = await callback({ captureId, directory });
        await this.finalizeModelOutputAttempts(context, { status: "passed" });
        if (this.enabled) {
          await writeJsonAtomic(path.join(directory, "session-complete.json"), {
            captureVersion: CAPTURE_VERSION,
            captureId,
            completedAt: new Date().toISOString(),
            status: "fulfilled",
            promptCount: context.promptCount
          });
        }
        return result;
      } catch (error) {
        await this.finalizeModelOutputAttempts(context, { status: "failed", error });
        if (this.enabled) {
          const failure = modelOutputFailure(error);
          await writeJsonAtomic(path.join(directory, "session-complete.json"), {
            captureVersion: CAPTURE_VERSION,
            captureId,
            completedAt: new Date().toISOString(),
            status: "rejected",
            promptCount: context.promptCount,
            errorName: String(error?.name || "Error"),
            code: failure.code,
            diagnostics: failure.diagnostics
          });
        }
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
    if (!context) return null;
    let body;
    try {
      body = JSON.parse(init.body);
    } catch (error) {
      if (this.enabled) {
        throw new Error(`无法解析即将发送给 AI 的请求体，Prompt 未发送：${String(error?.message || error)}`);
      }
      body = {};
    }
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const systemPrompt = messageText(messages.find((message) => message?.role === "system")?.content);
    const userPrompt = messageText(messages.find((message) => message?.role === "user")?.content);
    const omittedNonTextParts = messages.reduce(
      (count, message) => count + nonTextPartCount(message?.content),
      0
    );
    const sequence = ++context.sequence;
    const label = classifyPromptPhase(classifyPrompt(userPrompt), context.promptPhaseCounts);
    const call = {
      sequence,
      label,
      model: String(body?.model || ""),
      startedAt: new Date().toISOString(),
      startedAtMs: Date.now()
    };
    if (!this.enabled) return call;

    context.promptCount += 1;
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
    return call;
  }

  async captureInboundResponse(call, response) {
    if (!this.modelOutputLoggingEnabled) return;
    try {
      const projection = await safeCompletionProjection(response);
      const recordRef = await this.writeModelOutputAttempt(call, projection);
      const context = this.storage.getStore();
      if (context && recordRef) context.modelOutputAttempts.push({ call, projection, recordRef });
    } catch {
      this.onWarning("Animation Plan 模型输出观测失败（日志已跳过）");
    }
  }

  async captureTransportFailure(call, error) {
    if (!this.modelOutputLoggingEnabled) return;
    try {
      const projection = {
        contentPresent: false,
        content: "",
        providerRequestId: "",
        finishReason: "",
        usage: null,
        status: "failed",
        category: "transport",
        code: "MODEL_TRANSPORT_ERROR"
      };
      const recordRef = await this.writeModelOutputAttempt(call, projection);
      const context = this.storage.getStore();
      if (context && recordRef) context.modelOutputAttempts.push({ call, projection, recordRef });
    } catch {
      this.onWarning("Animation Plan 模型输出观测失败（日志已跳过）");
    }
  }

  async writeModelOutputAttempt(call, projection) {
    const context = this.storage.getStore();
    if (!context || !this.modelOutputLoggingEnabled) return null;
    return this.modelOutputLogWriter.recordAttempt({
      context: context.traceContext,
      operationId: `animation-plan:${context.captureId}`,
      attemptId: `call:${context.captureId}:${call.sequence}`,
      callIndex: call.sequence - 1,
      sequence: call.sequence,
      phase: call.label,
      reason: call.label,
      status: projection.status,
      category: projection.category,
      code: projection.code,
      retryable: false,
      startedAt: call.startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Math.max(0, Date.now() - call.startedAtMs),
      provider: context.metadata.provider,
      model: call.model,
      providerRequestId: projection.providerRequestId,
      finishReason: projection.finishReason,
      usage: projection.usage,
      contentPresent: projection.contentPresent,
      content: projection.content
    });
  }

  async finalizeModelOutputAttempts(context, { status, error = null } = {}) {
    if (!this.modelOutputLoggingEnabled
      || typeof this.modelOutputLogWriter.finalizeAttempt !== "function") return;
    const attempts = Array.isArray(context?.modelOutputAttempts)
      ? context.modelOutputAttempts
      : [];
    for (let index = 0; index < attempts.length; index += 1) {
      const attempt = attempts[index];
      const next = attempts[index + 1] || null;
      let result;
      if (attempt.projection.status === "failed") {
        result = {
          validationStatus: "failed",
          errorName: "ModelResponseError",
          category: attempt.projection.category,
          code: attempt.projection.code,
          diagnostics: []
        };
      } else if (next && validationRetryTransition(next.call.label)) {
        const diagnostics = semanticAuditDiagnosticsFromCompletion(
          attempt.call.label,
          attempt.projection.content
        );
        result = {
          validationStatus: "failed",
          errorName: diagnostics.length ? "SemanticAuditFailure" : "OutputContractError",
          category: "output-contract",
          code: diagnostics[0]?.code || "OUTPUT_CONTRACT_INVALID",
          diagnostics
        };
      } else if (index === attempts.length - 1 && status === "failed") {
        result = modelOutputFailure(error);
      } else {
        result = {
          validationStatus: "passed",
          errorName: "",
          category: "success",
          code: "MODEL_COMPLETION_ACCEPTED",
          diagnostics: []
        };
      }
      await this.modelOutputLogWriter.finalizeAttempt(attempt.recordRef, result).catch(() => {});
    }
  }
}

async function safeCompletionProjection(response) {
  if (!response || typeof response.clone !== "function") {
    throw new TypeError("模型响应不支持安全克隆");
  }
  const clone = response.clone();
  const raw = await clone.text();
  const headerRequestId = typeof response.headers?.get === "function"
    ? response.headers.get("x-request-id") || response.headers.get("request-id") || ""
    : "";
  if (response.ok === false) {
    return {
      contentPresent: false,
      content: "",
      providerRequestId: String(headerRequestId || ""),
      finishReason: "",
      usage: null,
      status: "failed",
      category: "http",
      code: "MODEL_HTTP_ERROR"
    };
  }
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return {
      contentPresent: false,
      content: "",
      providerRequestId: String(headerRequestId || ""),
      finishReason: "",
      usage: null,
      status: "failed",
      category: "protocol",
      code: "MODEL_ENVELOPE_INVALID"
    };
  }
  const choice = envelope?.choices?.[0];
  const content = choice?.message?.content;
  const contentPresent = typeof content === "string";
  return {
    contentPresent,
    content: contentPresent ? content : "",
    providerRequestId: String(headerRequestId || envelope?.id || ""),
    finishReason: String(choice?.finish_reason || ""),
    usage: envelope?.usage && typeof envelope.usage === "object" ? envelope.usage : null,
    status: contentPresent ? "received" : "failed",
    category: contentPresent ? "unvalidated" : "protocol",
    code: contentPresent ? "MODEL_COMPLETION_RECEIVED" : "MODEL_CONTENT_MISSING"
  };
}

function modelOutputTraceContext(value, fallbackVariantId) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    verified: source.verified === true,
    projectId: String(source.projectId || ""),
    runId: String(source.runId || ""),
    artifactId: String(source.artifactId || ""),
    productionRequestId: String(source.productionRequestId || ""),
    variantId: String(source.variantId || fallbackVariantId || "").slice(0, 160)
  };
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
  if (value.includes("ANIMATION_VIDEO_PROMPT_INITIAL_SEMANTIC_AUDIT_V2")) {
    return "animation-video-prompt-initial-semantic-audit";
  }
  if (value.includes("ANIMATION_VIDEO_PROMPT_REWRITE_SEMANTIC_AUDIT_V2")) {
    return "animation-video-prompt-rewrite-semantic-audit";
  }
  if (value.includes("ANIMATION_VIDEO_PROMPT_SEMANTIC_REPAIR_V1")) {
    return "animation-video-prompt-semantic-repair";
  }
  if (value.includes("ARTIFACT_PARTIAL_REPAIR_V1")) {
    if (value.includes("videoPrompt")) return "animation-shot-prompt-partial-repair";
    if (value.includes("characterReferencePrompts")) return "animation-foundation-partial-repair";
    return "animation-artifact-partial-repair";
  }
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

function classifyPromptPhase(label, phaseCounts) {
  const occurrence = (phaseCounts.get(label) || 0) + 1;
  phaseCounts.set(label, occurrence);
  if (
    occurrence > 1
    && [
      "animation-video-prompt-initial-semantic-audit",
      "animation-video-prompt-rewrite-semantic-audit"
    ].includes(label)
  ) {
    return label.replace(/-semantic-audit$/u, "-semantic-re-audit");
  }
  return label;
}

function validationRetryTransition(nextLabel) {
  return [
    "provider-json-retry",
    "animation-foundation-validation-retry",
    "animation-foundation-partial-repair",
    "animation-shot-batch-second-pass",
    "animation-shot-prompt-partial-repair",
    "animation-artifact-partial-repair",
    "animation-video-prompt-semantic-repair"
  ].includes(String(nextLabel || ""));
}

function semanticAuditDiagnosticsFromCompletion(label, content) {
  if (!String(label || "").includes("semantic-audit")) return [];
  let value;
  try {
    value = JSON.parse(String(content || ""));
  } catch {
    return [];
  }
  if (!Array.isArray(value?.shots)) return [];
  return value.shots.flatMap((shot, shotIndex) => (
    Array.isArray(shot?.issues) ? shot.issues.map((issue) => ({
      code: String(issue?.relation || "ANIMATION_VIDEO_PROMPT_SEMANTIC_CONFLICT"),
      jsonPointer: `/shotPlan/${shotIndex}/${escapeJsonPointerToken(issue?.field)}`,
      reason: redactSensitiveDiagnosticText(
        issue?.productionImpact || issue?.relation || "视频提示词语义审计未通过"
      )
    })) : []
  ));
}

function modelOutputFailure(error) {
  const details = Array.isArray(error?.diagnostics)
    ? error.diagnostics
    : (Array.isArray(error?.details) ? error.details : []);
  const diagnostics = details.map((detail) => ({
    code: String(detail?.code || detail?.errorCode || "VALIDATION_ERROR"),
    jsonPointer: String(detail?.jsonPointer || (String(detail?.path || "").startsWith("/") ? detail.path : "")),
    reason: redactSensitiveDiagnosticText(
      detail?.reason || detail?.message || detail?.code || "校验失败"
    )
  }));
  return {
    validationStatus: "failed",
    errorName: String(error?.name || "Error"),
    category: String(error?.category || "output-contract"),
    code: String(diagnostics[0]?.code || error?.code || "OUTPUT_CONTRACT_INVALID"),
    diagnostics
  };
}

function escapeJsonPointerToken(value) {
  return String(value || "").replaceAll("~", "~0").replaceAll("/", "~1");
}

function redactSensitiveDiagnosticText(value) {
  return String(value || "")
    .replace(/data:[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gu, "[data-url-redacted]")
    .replace(/[A-Za-z0-9+/]{80,}={0,2}/gu, "[base64-redacted]")
    .slice(0, 2_000);
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
