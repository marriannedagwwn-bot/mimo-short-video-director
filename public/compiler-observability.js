const COMPILER_STAGES = new Set(["staticFrameCompiler", "characterFeatureCompiler"]);
const DIAGNOSTIC_KEYS = new Set([
  "errorCode",
  "targetId",
  "characterTargetId",
  "patchIndex",
  "path",
  "field",
  "requiredDimensionCount",
  "selectedValidatedEvidenceCount",
  "unselectedCandidateEvidenceCount",
  "availableDimensions",
  "safeDimensions",
  "detectedDimensions",
  "recognizedFeatures",
  "unselectedCandidateEvidence",
  "unselectedCandidateCount",
  "repairMode",
  "skipReason",
  "combinationTriedCount",
  "combinationAccepted",
  "acceptedStateSlotIds",
  "batchRetryEligible",
  "batchRetryTriggered",
  "batchRetryPass",
  "batchRetryBudgetRemaining",
  "batchRetryPropagationResult"
]);
const DIAGNOSTIC_SIGNAL_KEYS = new Set([
  "errorCode",
  "targetId",
  "characterTargetId",
  "patchIndex",
  "path",
  "field",
  "requiredDimensionCount",
  "selectedValidatedEvidenceCount",
  "unselectedCandidateEvidenceCount",
  "availableDimensions",
  "safeDimensions",
  "detectedDimensions",
  "recognizedFeatures",
  "unselectedCandidateEvidence",
  "unselectedCandidateCount",
  "combinationTriedCount",
  "combinationAccepted",
  "batchRetryTriggered",
  "batchRetryPropagationResult"
]);
const TRAVERSAL_BLOCKLIST = /^(?:(?:prompt|raw|apiKey|authorization|token|secret|credential|sourcePath|sourceText|displayText|utf16)|(?:start|end|offset|before|after|value)$)/iu;

export class ApiRequestError extends Error {
  constructor(payload = {}, responseStatus = 0, fallbackMessage = "请求失败") {
    const normalized = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
    const status = normalizeStatus(responseStatus) || normalizeStatus(normalized.status);
    const stage = normalizeCompilerStage(normalized.stage);
    const message = apiErrorMessage(normalized, status, fallbackMessage, stage);
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.stage = normalized.stage || "";
    this.category = normalized.category || "";
    this.metadata = isRecord(normalized.metadata) ? normalized.metadata : null;
    this.code = normalized.code || normalized.errorCode || "";
  }
}

export function createApiRequestError(payload, responseStatus, fallbackMessage) {
  return new ApiRequestError(payload, responseStatus, fallbackMessage);
}

export function compilerFailureStage(error = {}) {
  const direct = normalizeCompilerStage(error.stage);
  if (direct) return direct;
  const metadataStage = normalizeCompilerStage(error.metadata?.stage);
  if (metadataStage) return metadataStage;
  return normalizeCompilerStage(error.name);
}

export function renderCompilerFailureDetails(error = {}) {
  const stage = compilerFailureStage(error);
  if (!stage) return "";
  const metadata = isRecord(error.metadata) ? error.metadata : {};
  const diagnostics = collectCompilerDiagnostics(metadata);
  const repairMode = firstMetadataValue(metadata, "repairMode");
  const skipReason = firstMetadataValue(metadata, "skipReason");
  const stageLabel = stage === "characterFeatureCompiler"
    ? "Character Feature Compiler"
    : "Static Frame Compiler";
  const summaryTags = [
    error.category ? `category: ${displayScalar(error.category)}` : "",
    error.status ? `HTTP ${displayScalar(error.status)}` : "",
    repairMode ? `repairMode: ${displayScalar(repairMode)}` : "",
    skipReason ? `skipReason: ${displayScalar(skipReason)}` : ""
  ].filter(Boolean);
  const cards = diagnostics.map((diagnostic, index) => renderDiagnosticCard(diagnostic, index)).join("");
  return `<div class="result-block compiler-failure" data-compiler-stage="${escapeHtml(stage)}">
    <span class="block-label">${escapeHtml(stageLabel)} 结构化错误</span>
    <div class="compiler-log">
      <div class="compiler-log-summary">
        <span>${escapeHtml(error.message || `${stageLabel} 执行失败`)}</span>
        <span>${summaryTags.length ? summaryTags.map(escapeHtml).join(" · ") : "没有阶段摘要"}</span>
      </div>
      ${cards
        ? `<div class="compiler-run-list">${cards}</div>`
        : `<p class="compiler-log-empty">服务端未返回可安全展示的结构化诊断。</p>`}
    </div>
  </div>`;
}

export function collectCompilerDiagnostics(metadata = {}) {
  const diagnostics = [];
  const seenObjects = new WeakSet();
  const seenSignatures = new Set();

  visit(metadata, 0);
  return diagnostics;

  function visit(value, depth) {
    if (depth > 8 || !value) return;
    if (Array.isArray(value)) {
      value.slice(0, 100).forEach((item) => visit(item, depth + 1));
      return;
    }
    if (!isRecord(value) || seenObjects.has(value)) return;
    seenObjects.add(value);
    if (Object.keys(value).some((key) => DIAGNOSTIC_SIGNAL_KEYS.has(key))) {
      const projected = projectDiagnostic(value);
      const signature = JSON.stringify(projected);
      if (Object.keys(projected).length && !seenSignatures.has(signature)) {
        seenSignatures.add(signature);
        diagnostics.push(projected);
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (TRAVERSAL_BLOCKLIST.test(key)) continue;
      visit(child, depth + 1);
    }
  }
}

function projectDiagnostic(value) {
  const diagnostic = {};
  for (const key of DIAGNOSTIC_KEYS) {
    if (value[key] === undefined || value[key] === null || value[key] === "") continue;
    if ([
      "availableDimensions",
      "safeDimensions",
      "detectedDimensions",
      "recognizedFeatures",
      "unselectedCandidateEvidence",
      "acceptedStateSlotIds"
    ].includes(key)) {
      diagnostic[key] = projectSafeCollection(value[key], key);
      continue;
    }
    diagnostic[key] = displayScalar(value[key]);
  }
  return diagnostic;
}

function projectSafeCollection(value, key) {
  if (typeof value === "number") return [String(value)];
  const values = Array.isArray(value) ? value : [value];
  return values.slice(0, 50).map((item) => {
    if (!isRecord(item)) return displayScalar(item);
    const preferredKeys = key === "recognizedFeatures"
      ? ["featureId", "suggestedFeatureKey", "canonicalName", "matchedSpanId", "evidenceLevel", "hasStaticState"]
      : key === "unselectedCandidateEvidence"
        ? ["candidateId", "evidenceId", "segmentId", "spanId", "targetId"]
        : ["primaryDimensionKey", "dimensionKey", "featureId", "stateSlotId"];
    const pairs = preferredKeys
      .filter((candidateKey) => item[candidateKey] !== undefined && item[candidateKey] !== null && item[candidateKey] !== "")
      .map((candidateKey) => `${candidateKey}=${displayScalar(item[candidateKey])}`);
    return pairs.join(" · ") || "结构化条目";
  }).filter(Boolean);
}

function renderDiagnosticCard(diagnostic, index) {
  const target = diagnostic.targetId || diagnostic.characterTargetId || `diagnostic-${index + 1}`;
  const location = [
    diagnostic.patchIndex !== undefined ? `patch ${diagnostic.patchIndex}` : "",
    diagnostic.path,
    diagnostic.field
  ].filter(Boolean).join(" · ");
  return `<section class="compiler-run-card">
    <div class="compiler-run-head">
      <div>
        <strong>${escapeHtml(target)}</strong>
        ${location ? `<small>${escapeHtml(location)}</small>` : ""}
      </div>
      <div class="compiler-flag-row">
        ${diagnostic.errorCode ? `<span class="compiler-flag no">${escapeHtml(diagnostic.errorCode)}</span>` : ""}
      </div>
    </div>
    <div class="compiler-modification-list">
      ${renderDiagnosticValue("requiredDimensionCount", diagnostic.requiredDimensionCount)}
      ${renderDiagnosticValue("selectedValidatedEvidenceCount", diagnostic.selectedValidatedEvidenceCount)}
      ${renderDiagnosticValue("unselectedCandidateEvidenceCount", diagnostic.unselectedCandidateEvidenceCount)}
      ${renderDiagnosticList("availableDimensions", diagnostic.availableDimensions)}
      ${renderDiagnosticList("safeDimensions", diagnostic.safeDimensions)}
      ${renderDiagnosticList("detectedDimensions", diagnostic.detectedDimensions)}
      ${renderDiagnosticList("recognizedFeatures", diagnostic.recognizedFeatures)}
      ${renderDiagnosticList("unselectedCandidateEvidence", diagnostic.unselectedCandidateEvidence)}
      ${renderDiagnosticValue("unselectedCandidateCount", diagnostic.unselectedCandidateCount)}
      ${renderDiagnosticValue("repairMode", diagnostic.repairMode)}
      ${renderDiagnosticValue("skipReason", diagnostic.skipReason)}
      ${renderDiagnosticValue("combinationTriedCount", diagnostic.combinationTriedCount)}
      ${renderDiagnosticValue("combinationAccepted", diagnostic.combinationAccepted)}
      ${renderDiagnosticList("acceptedStateSlotIds", diagnostic.acceptedStateSlotIds)}
      ${renderDiagnosticValue("batchRetryEligible", diagnostic.batchRetryEligible)}
      ${renderDiagnosticValue("batchRetryTriggered", diagnostic.batchRetryTriggered)}
      ${renderDiagnosticValue("batchRetryPass", diagnostic.batchRetryPass)}
      ${renderDiagnosticValue("batchRetryBudgetRemaining", diagnostic.batchRetryBudgetRemaining)}
      ${renderDiagnosticValue("batchRetryPropagationResult", diagnostic.batchRetryPropagationResult)}
    </div>
  </section>`;
}

function renderDiagnosticValue(label, value) {
  if (value === undefined || value === null || value === "") return "";
  return `<p class="compiler-reason"><b>${escapeHtml(label)}</b> ${escapeHtml(value)}</p>`;
}

function renderDiagnosticList(label, values) {
  if (!Array.isArray(values)) return "";
  return `<div class="compiler-evidence"><b>${escapeHtml(label)}</b><div>${values.length
    ? values.map((value) => `<span>${escapeHtml(value)}</span>`).join("")
    : "<span class=\"empty\">无</span>"}</div></div>`;
}

function firstMetadataValue(value, wantedKey, depth = 0, seen = new WeakSet()) {
  if (depth > 8 || !value) return "";
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 100)) {
      const found = firstMetadataValue(item, wantedKey, depth + 1, seen);
      if (found !== "") return found;
    }
    return "";
  }
  if (!isRecord(value) || seen.has(value)) return "";
  seen.add(value);
  if (value[wantedKey] !== undefined && value[wantedKey] !== null && value[wantedKey] !== "") {
    return displayScalar(value[wantedKey]);
  }
  for (const [key, child] of Object.entries(value)) {
    if (TRAVERSAL_BLOCKLIST.test(key)) continue;
    const found = firstMetadataValue(child, wantedKey, depth + 1, seen);
    if (found !== "") return found;
  }
  return "";
}

function apiErrorMessage(payload, status, fallbackMessage, compilerStage) {
  const message = displayScalar(payload.error || fallbackMessage || (status ? `请求失败（${status}）` : "请求失败"));
  if (compilerStage) return message;
  const detail = typeof payload.detail === "string" ? payload.detail.trim().slice(0, 240) : "";
  return detail ? `${message}：${detail}` : message;
}

function normalizeCompilerStage(value) {
  const normalized = String(value || "").replace(/[\s_-]+/gu, "").toLowerCase();
  if (normalized.includes("staticframecompiler")) return "staticFrameCompiler";
  if (normalized.includes("characterfeaturecompiler")) return "characterFeatureCompiler";
  return "";
}

function normalizeStatus(value) {
  const status = Number(value);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0;
}

function displayScalar(value) {
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string") return value.slice(0, 500);
  return "";
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/gu, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;"
  })[character]);
}
