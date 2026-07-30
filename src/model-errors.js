const DEFAULT_CATEGORY = "unknown";
const DEFAULT_CODE = "MODEL_PIPELINE_ERROR";
const DEFAULT_ORIGIN = "system";
const DEFAULT_HTTP_STATUS = 500;
const DIAGNOSTIC_SEVERITIES = new Set(["error", "warning", "info"]);
const SENSITIVE_METADATA_KEY = /^(?:raw|rawOutput|rawResponse|prompt|content|authorization|apiKey|token|secret)$/iu;

export class ValidationDiagnostic {
  constructor({
    code = "VALIDATION_ERROR",
    path = "",
    message = "",
    severity = "error",
    source = "validation",
    metadata = null
  } = {}) {
    this.code = nonEmptyString(code, "VALIDATION_ERROR");
    this.path = String(path || "");
    this.message = nonEmptyString(message, this.code);
    this.severity = DIAGNOSTIC_SEVERITIES.has(severity) ? severity : "error";
    this.source = nonEmptyString(source, "validation");
    this.metadata = sanitizePublicMetadata(metadata);
    Object.freeze(this);
  }

  toJSON() {
    return {
      code: this.code,
      path: this.path,
      message: this.message,
      severity: this.severity,
      source: this.source,
      ...(this.metadata === null ? {} : { metadata: this.metadata })
    };
  }
}

export class AttemptRecord {
  constructor({
    attemptId = "",
    operationId = "",
    stage = "",
    provider = "",
    model = "",
    reason = "",
    startedAt = "",
    finishedAt = "",
    durationMs = 0,
    status = "failed",
    category = DEFAULT_CATEGORY,
    code = "",
    finishReason = "",
    retryable = false,
    rawOutputRef = "",
    rawOutputBytes = 0,
    storedRawOutputBytes = 0,
    rawOutputTruncated = false,
    metadata = null
  } = {}) {
    this.attemptId = String(attemptId || "");
    this.operationId = String(operationId || "");
    this.stage = String(stage || "");
    this.provider = String(provider || "");
    this.model = String(model || "");
    this.reason = String(reason || "");
    this.startedAt = String(startedAt || "");
    this.finishedAt = String(finishedAt || "");
    this.durationMs = nonNegativeNumber(durationMs);
    this.status = nonEmptyString(status, "failed");
    this.category = nonEmptyString(category, DEFAULT_CATEGORY);
    this.code = String(code || "");
    this.finishReason = String(finishReason || "");
    this.retryable = Boolean(retryable);
    this.rawOutputRef = String(rawOutputRef || "");
    this.rawOutputBytes = nonNegativeInteger(rawOutputBytes);
    this.storedRawOutputBytes = nonNegativeInteger(storedRawOutputBytes);
    this.rawOutputTruncated = Boolean(rawOutputTruncated);
    this.metadata = sanitizePublicMetadata(metadata);
    Object.freeze(this);
  }

  toJSON() {
    return {
      attemptId: this.attemptId,
      operationId: this.operationId,
      stage: this.stage,
      provider: this.provider,
      model: this.model,
      reason: this.reason,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      durationMs: this.durationMs,
      status: this.status,
      category: this.category,
      code: this.code,
      finishReason: this.finishReason,
      retryable: this.retryable,
      rawOutputRef: this.rawOutputRef,
      rawOutputBytes: this.rawOutputBytes,
      storedRawOutputBytes: this.storedRawOutputBytes,
      rawOutputTruncated: this.rawOutputTruncated,
      ...(this.metadata === null ? {} : { metadata: this.metadata })
    };
  }
}

export class ModelPipelineError extends Error {
  constructor(message, {
    category = DEFAULT_CATEGORY,
    code = DEFAULT_CODE,
    origin = DEFAULT_ORIGIN,
    httpStatus = DEFAULT_HTTP_STATUS,
    retryable = false,
    diagnostics = [],
    attempts = [],
    cause
  } = {}) {
    super(nonEmptyString(message, "模型处理失败"), cause === undefined ? undefined : { cause });
    this.name = "ModelPipelineError";
    this.category = nonEmptyString(category, DEFAULT_CATEGORY);
    this.code = nonEmptyString(code, DEFAULT_CODE);
    this.origin = nonEmptyString(origin, DEFAULT_ORIGIN);
    this.httpStatus = normalizeHttpStatus(httpStatus);
    this.retryable = Boolean(retryable);
    this.diagnostics = Object.freeze(normalizeDiagnostics(diagnostics));
    this.attempts = Object.freeze(normalizeAttempts(attempts));
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      category: this.category,
      code: this.code,
      origin: this.origin,
      httpStatus: this.httpStatus,
      retryable: this.retryable,
      diagnostics: this.diagnostics,
      attempts: this.attempts
    };
  }
}

export function normalizeDiagnostics(diagnostics = []) {
  if (!Array.isArray(diagnostics)) return [];
  return diagnostics.map((diagnostic) => {
    if (diagnostic instanceof ValidationDiagnostic) return diagnostic;
    const source = diagnostic && typeof diagnostic === "object" ? diagnostic : {};
    return new ValidationDiagnostic({
      code: source.code || source.errorCode,
      path: source.path,
      message: source.message || source.reason || source.code || source.errorCode,
      severity: source.severity,
      source: source.source,
      metadata: diagnosticMetadata(source)
    });
  });
}

export function normalizeAttempts(attempts = []) {
  if (!Array.isArray(attempts)) return [];
  return attempts.map((attempt) => attempt instanceof AttemptRecord
    ? attempt
    : new AttemptRecord(attempt));
}

export function sanitizePublicMetadata(value, depth = 0) {
  if (value === null || value === undefined) return null;
  if (depth >= 5) return "[max-depth]";
  if (typeof value === "string") return value.slice(0, 2_000);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return String(value);
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => sanitizePublicMetadata(item, depth + 1));
  }
  if (typeof value !== "object") return String(value);
  const sanitized = {};
  for (const [key, item] of Object.entries(value).slice(0, 100)) {
    if (SENSITIVE_METADATA_KEY.test(key)) continue;
    sanitized[key] = sanitizePublicMetadata(item, depth + 1);
  }
  return sanitized;
}

function diagnosticMetadata(source) {
  const metadata = {};
  for (const [key, value] of Object.entries(source)) {
    if (["code", "errorCode", "path", "message", "reason", "severity", "source"].includes(key)) continue;
    metadata[key] = value;
  }
  return Object.keys(metadata).length ? metadata : null;
}

function nonEmptyString(value, fallback) {
  const normalized = String(value || "").trim();
  return normalized || fallback;
}

function normalizeHttpStatus(value) {
  const status = Number(value);
  return Number.isInteger(status) && status >= 400 && status <= 599
    ? status
    : DEFAULT_HTTP_STATUS;
}

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function nonNegativeInteger(value) {
  return Math.floor(nonNegativeNumber(value));
}
