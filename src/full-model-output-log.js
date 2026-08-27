import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export const FULL_MODEL_OUTPUT_LOG_SCHEMA_VERSION = "full-model-output-log/1.0";
export const MODEL_OUTPUT_LOG_SCOPES = Object.freeze({
  FULL_STORY: "fullStory",
  ANIMATION_PLAN: "animationPlan",
  ANALYSIS: "analysis",
  RECONSTRUCTION: "reconstruction",
  BRIEF: "brief",
  VARIANTS: "variants",
  VISUAL_GUARDRAILS: "visualGuardrails",
  CHARACTER_REFERENCE: "characterReference"
});

export async function resolvePrivateModelOutputLogRoot({
  workspaceRoot,
  configuredValue,
  servedRoot,
  environmentVariableName = "FULL_STORY_MODEL_OUTPUT_LOG_DIR",
  logLabel = "模型全量输出",
  onWarning = (message) => console.warn(message)
} = {}) {
  const configured = String(configuredValue || "").trim();
  if (!configured) return "";
  const baseRoot = path.resolve(String(workspaceRoot || "."));
  const resolved = path.resolve(baseRoot, configured);
  const resolvedServedRoot = path.resolve(String(servedRoot || path.join(baseRoot, "public")));
  const warn = typeof onWarning === "function" ? onWarning : () => {};
  const variableName = nonEmptyText(environmentVariableName) || "MODEL_OUTPUT_LOG_DIR";
  const label = nonEmptyText(logLabel) || "模型全量输出";
  if (pathsOverlap(resolved, resolvedServedRoot)) {
    warn(`${variableName} 不能位于 public/ 或其祖先目录；${label}日志保持禁用`);
    return "";
  }
  try {
    await fs.mkdir(resolved, { recursive: true, mode: 0o700 });
    const [realOutputRoot, realServedRoot] = await Promise.all([
      fs.realpath(resolved),
      fs.realpath(resolvedServedRoot)
    ]);
    if (pathsOverlap(realOutputRoot, realServedRoot)) {
      warn(`${variableName} 的实际路径位于 public/ 或其祖先目录；${label}日志保持禁用`);
      return "";
    }
    return realOutputRoot;
  } catch (error) {
    warn(`${variableName} 无法安全初始化；${label}日志保持禁用：${safeErrorMessage(error)}`);
    return "";
  }
}

export class FullModelOutputLogWriter {
  constructor({
    outputRoot = "",
    scope = MODEL_OUTPUT_LOG_SCOPES.FULL_STORY,
    gitCommit = "",
    buildId = "",
    now = () => new Date(),
    idFactory = () => randomUUID(),
    onWarning = (message) => console.warn(message)
  } = {}) {
    this.outputRoot = String(outputRoot || "").trim()
      ? path.resolve(String(outputRoot).trim())
      : "";
    this.scope = requireModelOutputLogScope(scope);
    this.gitCommit = safeIdentity(gitCommit);
    this.buildId = safeIdentity(buildId);
    this.now = typeof now === "function" ? now : () => new Date();
    this.idFactory = typeof idFactory === "function" ? idFactory : () => randomUUID();
    this.onWarning = typeof onWarning === "function" ? onWarning : () => {};
  }

  get enabled() {
    return Boolean(this.outputRoot);
  }

  async recordAttempt(payload = {}) {
    if (!this.enabled) return null;
    let temporaryPath = "";
    let finalizedOutputPath = "";
    let attemptDirectory = "";
    try {
      const recordedAt = timestamp(this.now());
      const context = logContext(payload.context, this.scope);
      const operationId = nonEmptyText(payload.operationId) || `operation:${this.idFactory()}`;
      const callIndex = nonNegativeInteger(payload.callIndex);
      const contentPresent = payload.contentPresent === true
        || (payload.contentPresent !== false && Boolean(exactOutputText(payload.content)));
      const modelContent = contentPresent ? exactOutputText(payload.content) : "";
      const directory = path.join(
        this.outputRoot,
        context.verified ? safeSegment(context.projectId) : "unbound",
        context.verified ? safeSegment(context.runId) : safeSegment(context.variantId || "unknown-variant"),
        context.verified ? safeSegment(context.artifactId) : this.scope,
        context.verified ? safeSegment(context.productionRequestId) : "unbound-request",
        safeSegment(operationId)
      );
      const attemptName = `attempt-${String(callIndex + 1).padStart(2, "0")}`;
      const metadataFilename = "metadata.json";
      const outputFilename = "model-output.txt";
      const record = {
        schemaVersion: FULL_MODEL_OUTPUT_LOG_SCHEMA_VERSION,
        recordedAt,
        scope: this.scope,
        gitCommit: this.gitCommit,
        buildId: this.buildId,
        production: context,
        attempt: {
          operationId,
          attemptId: String(payload.attemptId || ""),
          callIndex,
          stage: String(payload.stage || ""),
          phase: String(payload.phase || payload.reason || payload.stage || ""),
          sequence: positiveIntegerOrNull(payload.sequence),
          batchIndex: nonNegativeIntegerOrNull(payload.batchIndex),
          reason: String(payload.reason || ""),
          status: String(payload.status || ""),
          category: String(payload.category || ""),
          code: safeDiagnosticCode(payload.code, ""),
          validationStatus: validationStatus(payload.validationStatus, payload.status),
          errorName: safeErrorName(payload.errorName),
          diagnostics: safeValidationDiagnostics(payload.diagnostics),
          retryable: Boolean(payload.retryable),
          startedAt: String(payload.startedAt || ""),
          finishedAt: String(payload.finishedAt || ""),
          durationMs: nonNegativeNumber(payload.durationMs)
        },
        provider: {
          name: String(payload.provider || ""),
          model: String(payload.model || ""),
          providerRequestId: String(payload.providerRequestId || ""),
          finishReason: String(payload.finishReason || ""),
          usage: usageSummary(payload.usage)
        },
        output: {
          present: contentPresent,
          file: contentPresent ? outputFilename : "",
          bytes: Buffer.byteLength(modelContent, "utf8"),
          sha256: sha256(modelContent)
        }
      };

      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      attemptDirectory = await fs.mkdtemp(path.join(directory, `${attemptName}-`));
      await fs.chmod(attemptDirectory, 0o700);
      const finalPath = path.join(attemptDirectory, metadataFilename);
      temporaryPath = path.join(
        attemptDirectory,
        `.${metadataFilename}.${safeSegment(this.idFactory())}.tmp`
      );
      let outputPath = "";
      if (contentPresent) {
        outputPath = path.join(attemptDirectory, outputFilename);
        const temporaryOutputPath = path.join(
          attemptDirectory,
          `.${outputFilename}.${safeSegment(this.idFactory())}.tmp`
        );
        try {
          await fs.writeFile(temporaryOutputPath, modelContent, {
            encoding: "utf8",
            mode: 0o600,
            flag: "wx"
          });
          await fs.rename(temporaryOutputPath, outputPath);
          finalizedOutputPath = outputPath;
        } catch (error) {
          await fs.unlink(temporaryOutputPath).catch(() => {});
          throw error;
        }
      }
      await fs.writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx"
      });
      await fs.rename(temporaryPath, finalPath);
      temporaryPath = "";
      return { metadataPath: finalPath, outputPath };
    } catch (error) {
      if (temporaryPath) await fs.unlink(temporaryPath).catch(() => {});
      if (finalizedOutputPath) await fs.unlink(finalizedOutputPath).catch(() => {});
      if (attemptDirectory) await fs.rmdir(attemptDirectory).catch(() => {});
      this.onWarning(`${this.scope} 全量模型输出日志写入失败：${safeErrorMessage(error)}`);
      return null;
    }
  }

  async finalizeAttempt(recordRef, payload = {}) {
    if (!this.enabled) return null;
    const metadataPath = path.resolve(String(recordRef?.metadataPath || ""));
    if (!metadataPath || !pathIsWithin(metadataPath, this.outputRoot)) return null;
    let temporaryPath = "";
    try {
      const record = JSON.parse(await fs.readFile(metadataPath, "utf8"));
      if (record?.schemaVersion !== FULL_MODEL_OUTPUT_LOG_SCHEMA_VERSION || record?.scope !== this.scope) {
        throw new TypeError("模型输出 metadata 与当前 writer 不匹配");
      }
      const status = validationStatus(payload.validationStatus || payload.status, "");
      const diagnostics = safeValidationDiagnostics(payload.diagnostics || payload.details);
      record.gitCommit = this.gitCommit || safeIdentity(record.gitCommit);
      record.buildId = this.buildId || safeIdentity(record.buildId);
      record.attempt = {
        ...record.attempt,
        status: status === "passed" ? "succeeded" : "failed",
        validationStatus: status,
        errorName: safeErrorName(payload.errorName),
        diagnostics,
        category: String(payload.category || record.attempt?.category || "").slice(0, 120),
        code: safeDiagnosticCode(
          payload.code
          || diagnostics[0]?.code
          || record.attempt?.code
          || (status === "passed" ? "MODEL_COMPLETION_ACCEPTED" : "OUTPUT_CONTRACT_INVALID"),
          status === "passed" ? "MODEL_COMPLETION_ACCEPTED" : "OUTPUT_CONTRACT_INVALID"
        )
      };
      temporaryPath = path.join(
        path.dirname(metadataPath),
        `.metadata.json.${safeSegment(this.idFactory())}.tmp`
      );
      await fs.writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx"
      });
      await fs.rename(temporaryPath, metadataPath);
      return { metadataPath, outputPath: String(recordRef?.outputPath || "") };
    } catch (error) {
      if (temporaryPath) await fs.unlink(temporaryPath).catch(() => {});
      this.onWarning(`${this.scope} 模型输出校验元数据写入失败：${safeErrorMessage(error)}`);
      return null;
    }
  }
}

function logContext(value, scope) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const variantId = String(source.variantId || "").slice(0, 160);
  const expectedArtifactId = variantId ? `${scope}:${variantId}` : "";
  const verified = source.verified === true
    && String(source.artifactId || "") === expectedArtifactId;
  return {
    verified,
    projectId: verified ? String(source.projectId || "") : "",
    runId: verified ? String(source.runId || "") : "",
    artifactId: verified ? String(source.artifactId || "") : "",
    productionRequestId: verified ? String(source.productionRequestId || "") : "",
    variantId
  };
}

function requireModelOutputLogScope(value) {
  const scope = String(value || "").trim();
  if (!Object.values(MODEL_OUTPUT_LOG_SCOPES).includes(scope)) {
    throw new TypeError(`模型全量输出日志 scope 只允许 ${Object.values(MODEL_OUTPUT_LOG_SCOPES).join(" / ")}`);
  }
  return scope;
}

function exactOutputText(value) {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function usageSummary(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const allowed = [
    "prompt_tokens",
    "completion_tokens",
    "total_tokens",
    "input_tokens",
    "output_tokens",
    "promptTokens",
    "completionTokens",
    "totalTokens",
    "inputTokens",
    "outputTokens"
  ];
  const summary = {};
  for (const key of allowed) {
    const number = Number(value[key]);
    if (Number.isFinite(number) && number >= 0) summary[key] = number;
  }
  return Object.keys(summary).length ? summary : null;
}

function safeSegment(value) {
  const segment = String(value || "").trim().replace(/[^A-Za-z0-9_-]+/gu, "_").slice(0, 180);
  return segment && segment !== "." && segment !== ".." ? segment : "unknown";
}

function timestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function nonEmptyText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function safeIdentity(value) {
  return String(value || "").trim().replace(/[^A-Za-z0-9._-]+/gu, "").slice(0, 128);
}

function validationStatus(explicit, attemptStatus) {
  const normalized = String(explicit || "").trim().toLowerCase();
  if (["passed", "failed", "pending"].includes(normalized)) return normalized;
  const status = String(attemptStatus || "").trim().toLowerCase();
  if (["succeeded", "fulfilled", "passed"].includes(status)) return "passed";
  if (["failed", "rejected"].includes(status)) return "failed";
  return "pending";
}

function safeErrorName(value) {
  return String(value || "").trim().replace(/[^A-Za-z0-9_.:-]+/gu, "").slice(0, 160);
}

function safeValidationDiagnostics(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).map((item) => {
    const source = item && typeof item === "object" && !Array.isArray(item) ? item : {};
    const pointer = String(source.jsonPointer || (String(source.path || "").startsWith("/") ? source.path : ""));
    return {
      code: safeDiagnosticCode(source.code || source.errorCode, "VALIDATION_ERROR"),
      jsonPointer: pointer.startsWith("/") ? pointer.slice(0, 1_000) : "",
      reason: redactSensitiveMetadataText(
        source.reason || source.message || source.code || "校验失败",
        2_000
      )
    };
  });
}

function safeDiagnosticCode(value, fallback) {
  const normalized = String(value || "").trim().replace(/[^A-Za-z0-9_.:/-]+/gu, "_");
  return (normalized || fallback).slice(0, 160);
}

function redactSensitiveMetadataText(value, limit) {
  return String(value || "")
    .replace(/data:[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gu, "[data-url-redacted]")
    .replace(/[A-Za-z0-9+/]{80,}={0,2}/gu, "[base64-redacted]")
    .slice(0, limit);
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

function nonNegativeIntegerOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function positiveIntegerOrNull(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function safeErrorMessage(error) {
  return String(error?.message || "未知写入错误").slice(0, 500);
}

function pathIsWithin(candidate, parent) {
  const foldCase = process.platform === "darwin" || process.platform === "win32";
  const resolvedParent = path.resolve(parent);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(
    foldCase ? resolvedParent.toLocaleLowerCase("en-US") : resolvedParent,
    foldCase ? resolvedCandidate.toLocaleLowerCase("en-US") : resolvedCandidate
  );
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function pathsOverlap(left, right) {
  return pathIsWithin(left, right) || pathIsWithin(right, left);
}
