import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const PRODUCTION_LINEAGE_SCHEMA_VERSION = "1.0";
export const PRODUCTION_PACKAGE_TYPE = "story-production-test-package";
export const PRODUCTION_PACKAGE_VERSION = "3.0";

export class ProductionStateError extends Error {
  constructor(message, {
    code = "PRODUCTION_STATE_INVALID",
    httpStatus = 400,
    details = []
  } = {}) {
    super(message);
    this.name = "ProductionStateError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = Array.isArray(details) ? details : [];
  }
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function contentDigest(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function packageDigest(value) {
  return contentDigest(packageUnsignedValue(value));
}

export function signPackageDigest(digest, key) {
  const normalizedDigest = requireSha256(digest, "packageDigest");
  const normalizedKey = normalizeSigningKey(key);
  return createHmac("sha256", normalizedKey).update(normalizedDigest, "utf8").digest("hex");
}

export function verifyPackageSignature(digest, signature, key) {
  const expected = Buffer.from(signPackageDigest(digest, key), "hex");
  const receivedText = String(signature || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(receivedText)) return false;
  const received = Buffer.from(receivedText, "hex");
  return expected.byteLength === received.byteLength && timingSafeEqual(expected, received);
}

export function createMediaNamespace({ projectId, runId, planRevision, planDigest }) {
  return [
    safeIdentifier(projectId, "projectId"),
    safeIdentifier(runId, "runId"),
    `${safeIdentifier(planRevision, "planRevision")}-${requireSha256(planDigest, "planDigest").slice(0, 16)}`
  ].join("/");
}

export function normalizeArtifactId(value) {
  const artifactId = String(value || "").trim();
  if (!artifactId || artifactId.length > 160 || !/^[A-Za-z0-9._:-]+$/u.test(artifactId)) {
    throw new ProductionStateError("artifactId 格式无效", {
      code: "ARTIFACT_ID_INVALID"
    });
  }
  return artifactId;
}

export function normalizeArtifactType(value) {
  const artifactType = String(value || "").trim();
  if (!artifactType || artifactType.length > 80 || !/^[A-Za-z][A-Za-z0-9._-]*$/u.test(artifactType)) {
    throw new ProductionStateError("artifactType 格式无效", {
      code: "ARTIFACT_TYPE_INVALID"
    });
  }
  return artifactType;
}

export function safeIdentifier(value, label = "identifier") {
  const text = String(value || "").trim();
  if (!text || text.length > 160 || !/^[A-Za-z0-9._-]+$/u.test(text)) {
    throw new ProductionStateError(`${label} 格式无效`, {
      code: "PRODUCTION_IDENTIFIER_INVALID"
    });
  }
  return text;
}

export function normalizeDependency(dependency = {}) {
  return {
    artifactId: normalizeArtifactId(dependency.artifactId),
    revision: safeIdentifier(dependency.revision, "dependency.revision"),
    contentDigest: requireSha256(dependency.contentDigest, "dependency.contentDigest")
  };
}

export function sameDependencies(left = [], right = []) {
  return canonicalJson(normalizeDependencies(left)) === canonicalJson(normalizeDependencies(right));
}

export function normalizeDependencies(value = []) {
  if (!Array.isArray(value)) {
    throw new ProductionStateError("dependencies 必须是数组", {
      code: "ARTIFACT_DEPENDENCIES_INVALID"
    });
  }
  const dependencies = value.map(normalizeDependency);
  const ids = new Set();
  for (const dependency of dependencies) {
    if (ids.has(dependency.artifactId)) {
      throw new ProductionStateError(`dependencies 重复引用 ${dependency.artifactId}`, {
        code: "ARTIFACT_DEPENDENCY_DUPLICATE"
      });
    }
    ids.add(dependency.artifactId);
  }
  return dependencies.sort((a, b) => a.artifactId.localeCompare(b.artifactId));
}

export function lineageRef(lineage = {}) {
  return normalizeDependency(lineage);
}

function canonicalValue(value) {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) return null;
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  const result = {};
  for (const key of Object.keys(value).sort()) {
    const entry = value[key];
    if (entry === undefined) continue;
    result[key] = canonicalValue(entry);
  }
  return result;
}

function packageUnsignedValue(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProductionStateError("生产包必须是对象", {
      code: "PRODUCTION_PACKAGE_INVALID"
    });
  }
  const {
    packageDigest: _packageDigest,
    packageSignature: _packageSignature,
    ...unsigned
  } = value;
  return unsigned;
}

function requireSha256(value, label) {
  const text = String(value || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(text)) {
    throw new ProductionStateError(`${label} 必须是 SHA-256 摘要`, {
      code: "DIGEST_INVALID"
    });
  }
  return text;
}

function normalizeSigningKey(key) {
  if (Buffer.isBuffer(key) && key.byteLength >= 32) return key;
  const text = String(key || "");
  if (Buffer.byteLength(text, "utf8") < 32) {
    throw new ProductionStateError("生产包签名密钥无效", {
      code: "PACKAGE_SIGNING_KEY_INVALID",
      httpStatus: 500
    });
  }
  return Buffer.from(text, "utf8");
}
