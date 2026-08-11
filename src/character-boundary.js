import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { canonicalize } from "./frame-dependency.js";

export const GLOBAL_CHARACTER_BOUNDARY_VERSION = "2.0";

export class CharacterBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = "CharacterBoundaryError";
  }
}

export function createCharacterBoundaryKey() {
  return randomBytes(32);
}

export function sealGlobalCharacterBoundary(visualGuardrails, input = {}, key) {
  assertSigningKey(key);
  const value = cloneRecord(visualGuardrails, "visualGuardrails");
  const rawBoundary = cloneRecord(value.fixedCharacterBoundary, "visualGuardrails.fixedCharacterBoundary");
  const preexistingSealFields = ["sourceDigest", "boundaryDigest", "boundarySignature"]
    .filter((field) => Object.prototype.hasOwnProperty.call(rawBoundary, field));
  if (preexistingSealFields.length) {
    throw new CharacterBoundaryError(`待签发全局角色边界不得预先包含签发字段：${preexistingSealFields.join("、")}`);
  }
  const sourceDigest = computeCharacterBoundarySourceDigest(input);
  const boundaryDigest = digest({ sourceDigest, boundary: rawBoundary });
  const boundarySignature = sign({ sourceDigest, boundaryDigest }, key);
  return {
    ...value,
    fixedCharacterBoundary: {
      ...rawBoundary,
      sourceDigest,
      boundaryDigest,
      boundarySignature
    }
  };
}

export function verifyGlobalCharacterBoundary(visualGuardrails, input = {}, key, {
  requireSignature = true
} = {}) {
  assertSigningKey(key);
  const value = cloneRecord(visualGuardrails, "visualGuardrails");
  const boundary = cloneRecord(value.fixedCharacterBoundary, "visualGuardrails.fixedCharacterBoundary");
  const sourceDigest = computeCharacterBoundarySourceDigest(input);
  if (boundary.sourceDigest !== sourceDigest) {
    throw new CharacterBoundaryError("全局角色边界与当前用户设定、创意简报或参考分析不匹配，请重新生成角色边界");
  }
  const rawBoundary = { ...boundary };
  delete rawBoundary.sourceDigest;
  delete rawBoundary.boundaryDigest;
  delete rawBoundary.boundarySignature;
  const boundaryDigest = digest({ sourceDigest, boundary: rawBoundary });
  if (boundary.boundaryDigest !== boundaryDigest) {
    throw new CharacterBoundaryError("全局角色边界内容已变化，不能继续使用旧边界");
  }
  if (requireSignature) {
    const expectedSignature = sign({ sourceDigest, boundaryDigest }, key);
    if (!safeEqual(boundary.boundarySignature, expectedSignature)) {
      throw new CharacterBoundaryError("全局角色边界签名无效，请重新生成角色边界");
    }
  }
  return value;
}

export function computeCharacterBoundarySourceDigest(input = {}) {
  return digest({
    creatorProfile: {
      fixedCharacter: String(input.creatorProfile?.fixedCharacter || "").trim(),
      vertical: String(input.creatorProfile?.vertical || "").trim(),
      constraints: String(input.creatorProfile?.constraints || "").trim()
    },
    referenceAnalysis: withoutGroundingSeal(input.referenceAnalysis),
    sourceScriptReconstruction: withoutGroundingSeal(input.sourceScriptReconstruction),
    creativeBrief: input.creativeBrief || {}
  });
}

function withoutGroundingSeal(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value || {};
  const projected = structuredClone(value);
  delete projected.groundingSeal;
  return projected;
}

function digest(value) {
  return `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
}

function sign(value, key) {
  return createHmac("sha256", key).update(canonicalize(value)).digest("base64url");
}

function safeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function assertSigningKey(key) {
  if (!(key instanceof Uint8Array) || key.byteLength < 32) {
    throw new CharacterBoundaryError("全局角色边界签名密钥无效");
  }
}

function cloneRecord(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CharacterBoundaryError(`${path} 必须是对象`);
  }
  return structuredClone(value);
}
