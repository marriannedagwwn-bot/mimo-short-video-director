import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const PARTIAL_REPAIR_DEBUG_SCHEMA_VERSION = "partial-repair-debug/1.0";
export const DEFAULT_PARTIAL_REPAIR_DEBUG_MAX_FILE_BYTES = 256 * 1024;

const secretFieldPattern = /^(?:api[_-]?key|x-api-key|authorization|cookie|set-cookie|password|secret|clientSecret|privateKey|accessToken|refreshToken|sessionToken|boundarySignature|groundingSeal|image_url|video_url|audio_url|.*DataUrl|base64)$/iu;
const dangerousFileTokenPattern = /[^A-Za-z0-9._-]+/gu;
const embeddedArtifactRootPattern = /"(?:shotPlan|sceneScript|characterBible|characterReferencePrompts|sceneReferencePrompts|productionStrategy)"\s*:/u;
const sessions = new WeakMap();

/**
 * Non-authoritative, best-effort observability for bounded model repairs.
 *
 * Workflow callers invoke the writer only after their private planner has
 * issued a repair plan. This filesystem sidecar projects that plan and the
 * local response; it never receives a complete Story/Foundation/Plan request.
 * Filesystem failures are warned about but never replace the business result.
 */
export class PartialRepairDebugWriter {
  constructor({
    outputRoot = "",
    now = () => new Date(),
    idFactory = () => randomUUID(),
    warningSink = (message) => console.warn(message),
    maxFileBytes = DEFAULT_PARTIAL_REPAIR_DEBUG_MAX_FILE_BYTES
  } = {}) {
    const configuredRoot = String(outputRoot || "").trim();
    this.outputRoot = configuredRoot ? path.resolve(configuredRoot) : "";
    this.now = typeof now === "function" ? now : () => new Date();
    this.idFactory = typeof idFactory === "function" ? idFactory : () => randomUUID();
    this.warningSink = typeof warningSink === "function" ? warningSink : () => {};
    this.maxFileBytes = normalizeFileByteLimit(maxFileBytes);
  }

  get enabled() {
    return Boolean(this.outputRoot);
  }

  async begin({
    stage,
    provider = "",
    model = "",
    variantId = "",
    batchIndex = null,
    originalError,
    repairPlan,
    repairPrompt
  } = {}) {
    if (!this.enabled) return null;
    if (!repairPlan || typeof repairPlan !== "object" || Array.isArray(repairPlan)) {
      throw new TypeError("局部纠错 debug 必须接收 repairPlan");
    }
    const createdAt = timestamp(this.now());
    const repairSessionId = String(this.idFactory() || randomUUID());
    const directoryName = [
      compactTimestamp(createdAt),
      safeFileToken(stage || "partial-repair"),
      safeFileToken(repairSessionId)
    ].join("-");
    const directory = path.join(this.outputRoot, directoryName);
    const session = Object.freeze({ repairSessionId });
    const promptText = sanitizeText(repairPrompt);
    const state = {
      directory,
      finalized: false,
      repairPlan: projectRepairPlan(repairPlan),
      responseProjection: null
    };
    sessions.set(session, state);

    try {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await this.writeJson(path.join(directory, "01-trigger.json"), {
        schemaVersion: PARTIAL_REPAIR_DEBUG_SCHEMA_VERSION,
        repairSessionId,
        createdAt,
        status: "triggered",
        stage: String(stage || ""),
        provider: String(provider || ""),
        model: String(model || ""),
        variantId: String(variantId || ""),
        ...(Number.isInteger(batchIndex) ? { batchIndex } : {}),
        originalError: projectError(originalError),
        repairPlan: state.repairPlan,
        repairPrompt: {
          file: "02-repair-prompt.txt",
          byteLength: Buffer.byteLength(promptText),
          sha256: sha256(promptText)
        }
      });
      await this.writeText(path.join(directory, "02-repair-prompt.txt"), promptText);
    } catch (error) {
      this.warn("无法创建局部纠错 debug 记录", error);
    }
    return session;
  }

  async recordResponse(session, response) {
    const state = sessions.get(session);
    if (!state || state.finalized) return;
    try {
      state.responseProjection = projectRepairResponse(response, state.repairPlan);
      await this.writeJson(path.join(state.directory, "03-model-response.json"), {
        schemaVersion: PARTIAL_REPAIR_DEBUG_SCHEMA_VERSION,
        repairSessionId: session.repairSessionId,
        receivedAt: timestamp(this.now()),
        ...state.responseProjection
      });
    } catch (error) {
      this.warn("无法写入局部纠错模型响应 debug", error);
    }
  }

  async recordResult(session, { status, error = null } = {}) {
    const state = sessions.get(session);
    if (!state || state.finalized) return;
    state.finalized = true;
    const normalizedStatus = status === "repaired" ? "repaired" : "rejected";
    try {
      await this.writeJson(path.join(state.directory, "04-result.json"), {
        schemaVersion: PARTIAL_REPAIR_DEBUG_SCHEMA_VERSION,
        repairSessionId: session.repairSessionId,
        completedAt: timestamp(this.now()),
        status: normalizedStatus,
        ...(error ? { error: projectError(error) } : {}),
        acceptedRepairs: normalizedStatus === "repaired"
          ? structuredClone(state.responseProjection?.repairs || [])
          : []
      });
    } catch (writeError) {
      this.warn("无法写入局部纠错结果 debug", writeError);
    }
  }

  async writeJson(filename, value) {
    const safeValue = sanitizeValue(value);
    const serialized = `${boundedJson(safeValue, this.maxFileBytes - 1)}\n`;
    await writeAtomic(filename, serialized, this.idFactory);
  }

  async writeText(filename, value) {
    const safeText = sanitizeText(value);
    const bounded = boundedText(safeText, this.maxFileBytes);
    await writeAtomic(filename, bounded, this.idFactory);
  }

  warn(message, error) {
    const reason = sanitizeText(error?.message || error || "未知写入错误").slice(0, 500);
    this.warningSink(`[partial-repair-debug] ${message}：${reason}`);
  }
}

function projectRepairPlan(plan) {
  return sanitizeValue({
    schemaVersion: String(plan.schemaVersion || ""),
    artifactType: String(plan.artifactType || "fullStory"),
    adapterId: String(plan.adapterId || "fullStory/subtree"),
    baseDigest: String(plan.baseDigest || ""),
    authorityDigest: String(plan.authorityDigest || ""),
    authority: structuredClone(plan.authority || {}),
    targets: Array.isArray(plan.targets) ? plan.targets.map((target) => ({
      repairId: String(target?.repairId || ""),
      path: String(target?.path || ""),
      targetLabel: String(target?.targetLabel || target?.path || ""),
      currentDigest: String(target?.currentDigest || ""),
      currentValue: structuredClone(target?.currentValue),
      expectedFields: structuredClone(target?.expectedFields || {}),
      diagnostics: structuredClone(target?.diagnostics || []),
      mutablePointers: structuredClone(target?.mutablePointers || []),
      mutableFields: structuredClone(target?.mutableFields || []),
      repairInstruction: String(target?.repairInstruction || target?.instruction || ""),
      modelContext: structuredClone(target?.modelContext || {})
    })) : []
  });
}

function projectRepairResponse(response, repairPlan) {
  const rawJson = safeJsonStringify(response);
  if (!isRecord(response)) {
    return {
      responseDigest: sha256(rawJson),
      responseType: jsonKind(response),
      responseByteLength: Buffer.byteLength(rawJson),
      responseShape: valueShape(response),
      repairs: []
    };
  }
  const allowedTopLevel = new Set(["schemaVersion", "baseDigest", "repairs"]);
  const targetsById = new Map((repairPlan.targets || []).map((target) => [target.repairId, target]));
  const repairs = Array.isArray(response.repairs)
    ? response.repairs.map((repair, index) => {
      if (!isRecord(repair)) return {
        index,
        responseType: jsonKind(repair),
        responseByteLength: Buffer.byteLength(safeJsonStringify(repair)),
        responseDigest: sha256(safeJsonStringify(repair)),
        responseShape: valueShape(repair)
      };
      const repairId = String(repair.repairId || "");
      const target = targetsById.get(repairId) || repairPlan.targets?.[index] || null;
      return {
        index,
        repairId,
        replacement: projectReplacement(repair.replacement, target),
        extraKeys: Object.keys(repair).filter((key) => !["repairId", "replacement"].includes(key)).sort()
      };
    })
    : [];
  return {
    responseDigest: sha256(rawJson),
    responseType: "object",
    schemaVersion: String(response.schemaVersion || ""),
    baseDigest: String(response.baseDigest || ""),
    extraKeys: Object.keys(response).filter((key) => !allowedTopLevel.has(key)).sort(),
    repairs
  };
}

function projectReplacement(replacement, target) {
  const currentValue = target?.currentValue;
  if (typeof currentValue === "string" && typeof replacement === "string") {
    return projectSafeString(replacement);
  }
  if (!isRecord(replacement) || !isRecord(currentValue)) {
    return omittedValueMetadata(replacement, currentValue);
  }
  const allowedKeys = new Set([
    ...Object.keys(currentValue),
    ...stringList(target?.mutableFields),
    ...stringList(target?.modelContext?.mutableFields),
    ...Object.keys(isRecord(target?.expectedFields) ? target.expectedFields : {})
  ]);
  return {
    fields: Object.fromEntries(Object.entries(replacement)
      .filter(([key]) => allowedKeys.has(key))
      .map(([key, value]) => {
        const baseline = Object.prototype.hasOwnProperty.call(currentValue, key)
          ? currentValue[key]
          : target?.expectedFields?.[key];
        return [key, projectValueAgainstShape(value, baseline)];
      })),
    extraKeys: Object.keys(replacement).filter((key) => !allowedKeys.has(key)).sort()
  };
}

function stringList(value) {
  return Array.isArray(value) ? value.map((item) => String(item || "")).filter(Boolean) : [];
}

function projectValueAgainstShape(value, baseline, depth = 0) {
  if (depth > 10) return omittedValueMetadata(value, baseline);
  if (baseline === undefined) return projectUnshapedAuthorizedValue(value, depth);
  if (baseline === null) return value === null ? null : omittedValueMetadata(value, baseline);
  if (typeof baseline === "string") {
    return typeof value === "string" ? projectSafeString(value) : omittedValueMetadata(value, baseline);
  }
  if (typeof baseline === "number") {
    return typeof value === "number" ? value : omittedValueMetadata(value, baseline);
  }
  if (typeof baseline === "boolean") {
    return typeof value === "boolean" ? value : omittedValueMetadata(value, baseline);
  }
  if (Array.isArray(baseline)) {
    if (!Array.isArray(value)) return omittedValueMetadata(value, baseline);
    const projected = value.slice(0, 100).map((item, index) => {
      const itemBaseline = baseline[index] === undefined ? baseline[0] : baseline[index];
      return itemBaseline === undefined
        ? projectUnshapedAuthorizedValue(item, depth + 1)
        : projectValueAgainstShape(item, itemBaseline, depth + 1);
    });
    if (value.length > projected.length) projected.push(`[TRUNCATED_${value.length - projected.length}_ITEMS]`);
    return projected;
  }
  if (isRecord(baseline)) {
    if (!isRecord(value)) return omittedValueMetadata(value, baseline);
    const baselineKeys = new Set(Object.keys(baseline));
    return {
      fields: Object.fromEntries(Object.entries(value)
        .filter(([key]) => baselineKeys.has(key))
        .map(([key, child]) => [
          key,
          projectValueAgainstShape(child, baseline[key], depth + 1)
        ])),
      extraKeys: Object.keys(value).filter((key) => !baselineKeys.has(key)).sort()
    };
  }
  return omittedValueMetadata(value, baseline);
}

function projectUnshapedAuthorizedValue(value, depth) {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return projectSafeString(value);
  if (Array.isArray(value)) {
    const projected = value.slice(0, 100).map((item) => (
      item === null || ["string", "number", "boolean"].includes(typeof item)
        ? sanitizeValue(item)
        : omittedValueMetadata(item)
    ));
    if (value.length > projected.length) projected.push(`[TRUNCATED_${value.length - projected.length}_ITEMS]`);
    return projected;
  }
  return omittedValueMetadata(value, undefined, depth);
}

function omittedValueMetadata(value, expectedValue = undefined) {
  const serialized = safeJsonStringify(value);
  return {
    valueOmitted: true,
    valueType: jsonKind(value),
    expectedType: expectedValue === undefined ? "unknown" : jsonKind(expectedValue),
    byteLength: Buffer.byteLength(serialized),
    sha256: sha256(serialized),
    shape: valueShape(value)
  };
}

function valueShape(value) {
  if (Array.isArray(value)) return { itemCount: value.length };
  if (isRecord(value)) return { keys: Object.keys(value).sort().slice(0, 200) };
  if (typeof value === "string") return { characterCount: value.length };
  return {};
}

function projectSafeString(value) {
  const text = String(value ?? "");
  if (isSerializedJsonContainer(text) || embeddedArtifactRootPattern.test(text)) {
    return omittedValueMetadata(text, "");
  }
  return sanitizeText(text).slice(0, 32_000);
}

function isSerializedJsonContainer(value) {
  let text = String(value || "").trim();
  if (!text) return false;
  for (let depth = 0; depth < 8; depth += 1) {
    if (embeddedArtifactRootPattern.test(text)) return true;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return false;
    }
    if (parsed && typeof parsed === "object") return true;
    if (typeof parsed !== "string") return false;
    const unwrapped = parsed.trim();
    if (!unwrapped || unwrapped === text) return false;
    text = unwrapped;
  }
  // Deeply nested JSON-string encoding is not a valid repair target value and
  // is omitted conservatively instead of being written to disk.
  return true;
}

function projectError(error) {
  if (!error) return null;
  return sanitizeValue({
    name: String(error?.name || "Error"),
    message: String(error?.message || error),
    code: String(error?.code || ""),
    details: Array.isArray(error?.details)
      ? structuredClone(error.details)
      : Array.isArray(error?.diagnostics)
        ? structuredClone(error.diagnostics)
        : []
  });
}

function sanitizeValue(value, key = "", depth = 0) {
  if (secretFieldPattern.test(String(key || ""))) return "[REDACTED]";
  if (depth > 14) return "[TRUNCATED_DEPTH]";
  if (typeof value === "string") return projectSafeString(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const items = value.slice(0, 100).map((item) => sanitizeValue(item, "", depth + 1));
    if (value.length > items.length) items.push(`[TRUNCATED_${value.length - items.length}_ITEMS]`);
    return items;
  }
  if (!isRecord(value)) return String(value ?? "");
  const entries = Object.entries(value).slice(0, 200).map(([field, child]) => [
    field,
    sanitizeValue(child, field, depth + 1)
  ]);
  if (Object.keys(value).length > entries.length) {
    entries.push(["__truncatedKeys", Object.keys(value).length - entries.length]);
  }
  return Object.fromEntries(entries);
}

function sanitizeText(value) {
  return String(value ?? "")
    .replace(/data:[^\s"']*;base64,[A-Za-z0-9+/=_-]+/gu, "[REDACTED_DATA_URL]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [REDACTED]")
    .replace(/\bBasic\s+[A-Za-z0-9+/=_-]+/giu, "Basic [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, "[REDACTED_API_KEY]")
    .replace(/("(?:api[_-]?key|x-api-key|authorization|cookie|set-cookie|password|secret|clientSecret|privateKey|accessToken|refreshToken|sessionToken|boundarySignature|groundingSeal|image_url|video_url|audio_url|[^"]*DataUrl|base64)"\s*:\s*")[^"]*(")/giu, "$1[REDACTED]$2")
    .replace(/[A-Za-z0-9+/=_-]{512,}/gu, "[REDACTED_LONG_BASE64_OR_TOKEN]");
}

function boundedJson(value, maximumBytes) {
  const serialized = JSON.stringify(value, null, 2);
  const bytes = Buffer.byteLength(serialized);
  if (bytes <= maximumBytes) return serialized;
  const summary = JSON.stringify({
    schemaVersion: PARTIAL_REPAIR_DEBUG_SCHEMA_VERSION,
    truncated: true,
    originalBytes: bytes,
    sha256: sha256(serialized)
  }, null, 2);
  if (Buffer.byteLength(summary) > maximumBytes) {
    throw new RangeError("maxFileBytes 太小，无法写入安全截断摘要");
  }
  return summary;
}

function boundedText(value, maximumBytes) {
  const bytes = Buffer.byteLength(value);
  if (bytes <= maximumBytes) return value;
  const suffix = `\n\n[TRUNCATED originalBytes=${bytes} sha256=${sha256(value)}]\n`;
  return `${utf8Prefix(value, Math.max(0, maximumBytes - Buffer.byteLength(suffix)))}${suffix}`;
}

async function writeAtomic(filename, value, idFactory) {
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = path.join(
    path.dirname(filename),
    `.${path.basename(filename)}.tmp-${safeFileToken(idFactory())}`
  );
  try {
    await fs.writeFile(temporary, value, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await fs.rename(temporary, filename);
  } catch (error) {
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
}

function timestamp(now) {
  const value = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(value.getTime())) return new Date().toISOString();
  return value.toISOString();
}

function compactTimestamp(value) {
  return String(value).replace(/[-:.]/gu, "");
}

function safeFileToken(value) {
  const token = String(value || "").replace(dangerousFileTokenPattern, "-").replace(/^-+|-+$/gu, "");
  return token.slice(0, 96) || "unknown";
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function sha256(value) {
  return createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

function utf8Prefix(value, maximumBytes) {
  const buffer = Buffer.from(String(value || ""), "utf8");
  if (buffer.byteLength <= maximumBytes) return buffer.toString("utf8");
  return buffer.subarray(0, maximumBytes).toString("utf8").replace(/\uFFFD$/u, "");
}

function normalizeFileByteLimit(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1024) {
    throw new TypeError("maxFileBytes 必须是大于等于 1024 的整数");
  }
  return number;
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function jsonKind(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value === "object" ? "object" : typeof value;
}
