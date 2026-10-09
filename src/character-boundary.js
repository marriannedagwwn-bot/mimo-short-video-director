import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { canonicalize } from "./frame-dependency.js";
import { normalizeStorySource } from "../public/story-entry.js";

export const GLOBAL_CHARACTER_BOUNDARY_VERSION = "2.0";

// sourceDigest 的两种来源。参考视频 Run 沿用最初那一版：哈希输入里不写版本号，
// 逐字节不变，已签发的边界照常可验。「从剧情开始」的 Run 没有原片分析、脚本还原和
// 创意简报，改用固定角色设定 + storySource，并把版本号写进哈希输入——两种输入的
// 键集合不相交，canonicalize 之后不可能撞出同一个摘要，所以互相验证一律失败。
// 用哪一种由服务端按 Run 元数据决定，请求体不能选。
export const CHARACTER_BOUNDARY_SOURCE_REFERENCE_VIDEO = "reference_video";
export const CHARACTER_BOUNDARY_SOURCE_STORY = "story_source/2";

export class CharacterBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = "CharacterBoundaryError";
  }
}

export function createCharacterBoundaryKey() {
  return randomBytes(32);
}

export function sealGlobalCharacterBoundary(visualGuardrails, input = {}, key, {
  source = CHARACTER_BOUNDARY_SOURCE_REFERENCE_VIDEO
} = {}) {
  assertSigningKey(key);
  const value = cloneRecord(visualGuardrails, "visualGuardrails");
  const rawBoundary = cloneRecord(value.fixedCharacterBoundary, "visualGuardrails.fixedCharacterBoundary");
  const preexistingSealFields = ["sourceDigest", "boundaryDigest", "boundarySignature"]
    .filter((field) => Object.prototype.hasOwnProperty.call(rawBoundary, field));
  if (preexistingSealFields.length) {
    throw new CharacterBoundaryError(`待签发全局角色边界不得预先包含签发字段：${preexistingSealFields.join("、")}`);
  }
  const sourceDigest = computeCharacterBoundarySourceDigest(input, { source });
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
  requireSignature = true,
  source = CHARACTER_BOUNDARY_SOURCE_REFERENCE_VIDEO
} = {}) {
  assertSigningKey(key);
  const value = cloneRecord(visualGuardrails, "visualGuardrails");
  const boundary = cloneRecord(value.fixedCharacterBoundary, "visualGuardrails.fixedCharacterBoundary");
  const sourceDigest = computeCharacterBoundarySourceDigest(input, { source });
  if (boundary.sourceDigest !== sourceDigest) {
    throw new CharacterBoundaryError(source === CHARACTER_BOUNDARY_SOURCE_STORY
      ? "全局角色边界与当前用户设定或故事原文不匹配，请重新生成角色边界"
      : "全局角色边界与当前用户设定、创意简报或参考分析不匹配，请重新生成角色边界");
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

export function computeCharacterBoundarySourceDigest(input = {}, {
  source = CHARACTER_BOUNDARY_SOURCE_REFERENCE_VIDEO
} = {}) {
  if (source === CHARACTER_BOUNDARY_SOURCE_REFERENCE_VIDEO) {
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
  if (source === CHARACTER_BOUNDARY_SOURCE_STORY) {
    let storySource;
    try {
      storySource = normalizeStorySource(input.storySource);
    } catch (error) {
      throw new CharacterBoundaryError(`剧情入口的角色边界需要合法的 storySource：${error.message}`);
    }
    return digest({
      sourceDigestVersion: CHARACTER_BOUNDARY_SOURCE_STORY,
      creatorProfile: {
        fixedCharacter: String(input.creatorProfile?.fixedCharacter || "").trim(),
        vertical: String(input.creatorProfile?.vertical || "").trim(),
        constraints: String(input.creatorProfile?.constraints || "").trim()
      },
      storySource
    });
  }
  throw new CharacterBoundaryError(`未知的角色边界来源：${String(source)}`);
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
