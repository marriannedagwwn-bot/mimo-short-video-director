import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const GROUNDING_SEAL_VERSION = "1.0";
const observationFactKinds = new Set([
  "visible_subject",
  "visible_action",
  "visible_object",
  "visible_location",
  "visible_state",
  "onscreen_text"
]);
const observationImportance = new Set(["core", "supporting"]);

export class ReconstructionGroundingError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReconstructionGroundingError";
  }
}

export function createGroundingKey() {
  return randomBytes(32);
}

export function groundingContextDigest(input = {}) {
  return evidenceContextDigest(input);
}

export function normalizeReferenceObservations(referenceAnalysis = {}, input = {}, options = {}) {
  assertArray(referenceAnalysis.observedFacts, "referenceAnalysis.observedFacts");
  return referenceAnalysis.observedFacts.map((item, index) =>
    normalizeReferenceObservation(item, index, input, options)
  );
}

export function sealReferenceAnalysis(referenceAnalysis, input, key, options = {}) {
  assertSigningKey(key);
  assertObject(referenceAnalysis, "referenceAnalysis");
  if (Object.hasOwn(referenceAnalysis, "groundingSeal")) {
    fail("referenceAnalysis.groundingSeal", "由服务端附加，模型不得输出");
  }
  normalizeReferenceObservations(referenceAnalysis, input, options);
  const contextDigest = evidenceContextDigest(input);
  const signature = signPayload({ kind: "referenceAnalysis", contextDigest, value: referenceAnalysis }, key);
  return {
    ...structuredClone(referenceAnalysis),
    groundingSeal: { version: GROUNDING_SEAL_VERSION, contextDigest, signature }
  };
}

export function verifyReferenceAnalysis(referenceAnalysis, key, input = null) {
  assertSigningKey(key);
  assertObject(referenceAnalysis, "referenceAnalysis");
  const seal = referenceAnalysis.groundingSeal;
  validateSeal(seal, "referenceAnalysis.groundingSeal");
  const unsigned = omitKey(referenceAnalysis, "groundingSeal");
  const expected = signPayload({ kind: "referenceAnalysis", contextDigest: seal.contextDigest, value: unsigned }, key);
  if (!safeSignatureEqual(seal.signature, expected)) {
    fail("referenceAnalysis.groundingSeal.signature", "签名无效；请重新运行参考片分析");
  }
  if (input && seal.contextDigest !== evidenceContextDigest(input)) {
    fail("referenceAnalysis.groundingSeal.contextDigest", "与当前 transcript、关键帧或原生视频不一致；请重新运行参考片分析");
  }
  return {
    referenceAnalysis: unsigned,
    observations: input ? normalizeReferenceObservations(unsigned, input) : [],
    contextDigest: seal.contextDigest
  };
}

export function sealReconstruction(value, key, contextDigest) {
  assertSigningKey(key);
  assertObject(value, "sourceScriptReconstruction");
  assertString(contextDigest, "sourceScriptReconstruction.groundingSeal.contextDigest");
  if (Object.hasOwn(value, "groundingSeal")) {
    fail("sourceScriptReconstruction.groundingSeal", "由服务端附加，模型不得输出");
  }
  const signature = signPayload({ kind: "sourceScriptReconstruction", contextDigest, value }, key);
  return {
    ...structuredClone(value),
    groundingSeal: { version: GROUNDING_SEAL_VERSION, contextDigest, signature }
  };
}

export function verifyReconstructionSeal(value, key, { expectedContextDigest = null } = {}) {
  assertSigningKey(key);
  assertObject(value, "sourceScriptReconstruction");
  const seal = value.groundingSeal;
  validateSeal(seal, "sourceScriptReconstruction.groundingSeal");
  const unsigned = omitKey(value, "groundingSeal");
  const expected = signPayload({ kind: "sourceScriptReconstruction", contextDigest: seal.contextDigest, value: unsigned }, key);
  if (!safeSignatureEqual(seal.signature, expected)) {
    fail("sourceScriptReconstruction.groundingSeal.signature", "签名无效；请重新运行脚本还原");
  }
  if (expectedContextDigest && seal.contextDigest !== expectedContextDigest) {
    fail("sourceScriptReconstruction.groundingSeal.contextDigest", "与 referenceAnalysis 的素材上下文不一致；请重新运行 AI 导演流程");
  }
  return unsigned;
}

function normalizeReferenceObservation(item, index, input, options) {
  const path = `referenceAnalysis.observedFacts[${index}]`;
  assertObject(item, path);
  assertExactKeys(item, ["factType", "observation", "importance", "evidenceRefs"], path);
  if (!observationFactKinds.has(item.factType)) fail(`${path}.factType`, "枚举值无效");
  assertString(item.observation, `${path}.observation`);
  if (!observationImportance.has(item.importance)) fail(`${path}.importance`, "枚举值无效");
  assertArray(item.evidenceRefs, `${path}.evidenceRefs`, { nonEmpty: true });
  const seen = new Set();
  const evidenceRefs = item.evidenceRefs.map((reference, evidenceIndex) => {
    const normalized = normalizeObservationEvidence(reference, `${path}.evidenceRefs[${evidenceIndex}]`, input, options);
    const key = stableStringify(normalized);
    if (seen.has(key)) fail(`${path}.evidenceRefs[${evidenceIndex}]`, "重复 evidence reference");
    seen.add(key);
    return normalized;
  });
  return {
    factType: item.factType,
    observation: item.observation.trim(),
    importance: item.importance,
    evidenceRefs
  };
}

function normalizeObservationEvidence(reference, path, input, options) {
  assertObject(reference, path);
  assertAllowedEvidenceSource(reference.source, `${path}.source`, options.allowedEvidenceSources);
  const durationMs = mediaDurationMs(input.metadata);
  if (reference.source === "frame") {
    assertExactKeys(reference, ["source", "frameNumber"], path);
    if (!Number.isInteger(reference.frameNumber) || reference.frameNumber < 1) {
      fail(`${path}.frameNumber`, "必须是正整数");
    }
    const timestamp = Number(input.frames?.[reference.frameNumber - 1]?.timestamp);
    if (!Number.isFinite(timestamp) || timestamp < 0) fail(`${path}.frameNumber`, "引用了不存在或无效的输入关键帧");
    const timestampMs = Math.round(timestamp * 1000);
    if (durationMs !== null && timestampMs > durationMs) fail(`${path}.frameNumber`, "关键帧时间超过输入视频时长");
    return { source: "frame", frameNumber: reference.frameNumber, timestampMs };
  }
  if (reference.source === "video") {
    assertExactKeys(reference, ["source", "startMs", "endMs"], path);
    if (!validVideo(input.video)) fail(`${path}.source`, "输入未提供有效原生视频");
    if (durationMs === null) fail(path, "原生视频 evidence 需要 metadata.duration");
    assertTimePair(reference.startMs, reference.endMs, path);
    if (reference.endMs > durationMs) fail(`${path}.endMs`, "超过输入视频时长");
    return { source: "video", startMs: reference.startMs, endMs: reference.endMs };
  }
  fail(`${path}.source`, "只允许 frame 或 video");
}

function assertAllowedEvidenceSource(source, path, allowedSources) {
  if (!allowedSources) return;
  const allowed = allowedSources instanceof Set ? allowedSources : new Set(allowedSources);
  if (!allowed.has(source)) fail(path, `本次成功媒体请求只允许 ${[...allowed].join("/")} evidence`);
}

function evidenceContextDigest(input = {}) {
  const frames = Array.isArray(input.frames) ? input.frames : [];
  const value = {
    transcriptHash: hashText(String(input.transcript || "")),
    metadata: {
      duration: Number.isFinite(Number(input.metadata?.duration)) ? Number(input.metadata.duration) : null,
      width: Number.isFinite(Number(input.metadata?.width)) ? Number(input.metadata.width) : null,
      height: Number.isFinite(Number(input.metadata?.height)) ? Number(input.metadata.height) : null
    },
    frames: frames.map((frame) => ({
      timestamp: Number.isFinite(Number(frame?.timestamp)) ? Number(frame.timestamp) : null,
      contentHash: hashText(String(frame?.dataUrl || ""))
    })),
    video: validVideo(input.video)
      ? {
          mimeType: String(input.video.mimeType || ""),
          size: Number.isFinite(Number(input.video.size)) ? Number(input.video.size) : null,
          contentHash: hashText(input.video.dataUrl)
        }
      : null
  };
  return `sha256:${hashText(stableStringify(value))}`;
}

function mediaDurationMs(metadata) {
  const duration = Number(metadata?.duration);
  return Number.isFinite(duration) && duration >= 0 ? Math.round(duration * 1000) : null;
}

function validVideo(video) {
  return Boolean(video && typeof video === "object" && typeof video.dataUrl === "string" && video.dataUrl.startsWith("data:video/"));
}

function hashText(value) {
  return createHash("sha256").update(value).digest("hex");
}

function signPayload(value, key) {
  return `hmac-sha256:${createHmac("sha256", key).update(stableStringify(value)).digest("hex")}`;
}

function safeSignatureEqual(actual, expected) {
  const left = Buffer.from(String(actual || ""));
  const right = Buffer.from(String(expected || ""));
  return left.length === right.length && timingSafeEqual(left, right);
}

function validateSeal(seal, path) {
  assertObject(seal, path);
  assertExactKeys(seal, ["version", "contextDigest", "signature"], path);
  if (seal.version !== GROUNDING_SEAL_VERSION) fail(`${path}.version`, `必须等于 ${GROUNDING_SEAL_VERSION}`);
  assertString(seal.contextDigest, `${path}.contextDigest`);
  assertString(seal.signature, `${path}.signature`);
}

function assertSigningKey(key) {
  if (!(Buffer.isBuffer(key) || typeof key === "string") || !key.length) fail("groundingKey", "缺少服务端 grounding key");
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function omitKey(value, key) {
  const copy = {};
  for (const [entryKey, entryValue] of Object.entries(value || {})) {
    if (entryKey !== key) copy[entryKey] = structuredClone(entryValue);
  }
  return copy;
}

function assertObject(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "必须是对象");
}

function assertArray(value, path, { nonEmpty = false } = {}) {
  if (!Array.isArray(value) || (nonEmpty && !value.length)) fail(path, `必须是${nonEmpty ? "非空" : ""}数组`);
}

function assertString(value, path) {
  if (typeof value !== "string" || !value.trim()) fail(path, "必须是非空字符串");
}

function assertTimePair(startMs, endMs, path) {
  if (!Number.isInteger(startMs) || startMs < 0) fail(`${path}.startMs`, "必须是非负整数毫秒");
  if (!Number.isInteger(endMs) || endMs < startMs) fail(`${path}.endMs`, "必须是不小于 startMs 的整数毫秒");
}

function assertExactKeys(value, expected, path) {
  const missing = expected.filter((key) => !Object.hasOwn(value, key));
  if (missing.length) fail(path, `缺少字段：${missing.join("、")}`);
  const unexpected = Object.keys(value).filter((key) => !expected.includes(key));
  if (unexpected.length) fail(path, `包含未允许字段：${unexpected.join("、")}`);
}

function fail(path, message) {
  throw new ReconstructionGroundingError(`${path} ${message}`);
}
