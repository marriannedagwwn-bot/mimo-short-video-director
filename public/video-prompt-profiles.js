export const VIDEO_PROMPT_PROFILE_SCHEMA_VERSION = "1.0";

export const VIDEO_PROMPT_PROFILE_IDS = Object.freeze({
  SEEDANCE_2_0: "seedance_2_0",
  MINIMAX_H3: "minimax_h3"
});

export const SEEDANCE_2_0_PROMPT_GUIDE_VERSION = "direct-shot-video-prompt-1.0";
export const MINIMAX_H3_PROMPT_GUIDE_VERSION = "80365054c7fbaace01ed417076fecd532c1ae0e0";

const SEEDANCE_2_0_MODELS = Object.freeze([
  "doubao-seedance-2-0-260128",
  "doubao-seedance-2-0-fast-260128",
  "doubao-seedance-2-0-mini-260615"
]);

const PROFILE_FIELDS = Object.freeze([
  "schemaVersion",
  "profileId",
  "provider",
  "model",
  "guideVersion"
]);

/**
 * Resolves the prompt-writing contract from an explicit shot-video setting.
 * This deliberately does not normalize aliases or infer a provider from a model.
 */
export function resolveVideoPromptProfile(setting = {}) {
  if (!isPlainRecord(setting)) {
    throw new TypeError("视频提示词 Profile 必须由显式的 {provider, model} 设置解析。");
  }
  const provider = requireExplicitString(setting.provider, "provider");
  const model = requireExplicitString(setting.model, "model");

  if (provider === "Seedance" && SEEDANCE_2_0_MODELS.includes(model)) {
    return makeProfile({
      profileId: VIDEO_PROMPT_PROFILE_IDS.SEEDANCE_2_0,
      provider,
      model,
      guideVersion: SEEDANCE_2_0_PROMPT_GUIDE_VERSION
    });
  }
  if (provider === "MiniMax" && model === "MiniMax-H3") {
    return makeProfile({
      profileId: VIDEO_PROMPT_PROFILE_IDS.MINIMAX_H3,
      provider,
      model,
      guideVersion: MINIMAX_H3_PROMPT_GUIDE_VERSION
    });
  }
  if (provider === "Kling" || provider === "VideoHTTP") {
    throw new RangeError(`${provider} 当前没有 direct_shot 视频提示词 Profile。`);
  }
  throw new RangeError(`不支持的视频提示词 Profile 设置：provider=${provider}, model=${model}`);
}

/**
 * Validates persisted profile data and returns an immutable canonical copy.
 */
export function assertVideoPromptProfile(profile) {
  if (!isPlainRecord(profile)) {
    throw new TypeError("视频提示词 Profile 必须是对象。");
  }
  const keys = Object.keys(profile).sort();
  const expectedKeys = [...PROFILE_FIELDS].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new TypeError(`视频提示词 Profile 只允许字段：${PROFILE_FIELDS.join("、")}。`);
  }
  if (profile.schemaVersion !== VIDEO_PROMPT_PROFILE_SCHEMA_VERSION) {
    throw new RangeError(`不支持的视频提示词 Profile Schema：${String(profile.schemaVersion || "(empty)")}`);
  }
  const expected = resolveVideoPromptProfile({
    provider: profile.provider,
    model: profile.model
  });
  for (const field of PROFILE_FIELDS) {
    if (profile[field] !== expected[field]) {
      throw new RangeError(`视频提示词 Profile 字段 ${field} 与已登记契约不一致。`);
    }
  }
  return expected;
}

export function sameVideoPromptProfile(left, right) {
  if (left == null || right == null) return left == null && right == null;
  const canonicalLeft = assertVideoPromptProfile(left);
  const canonicalRight = assertVideoPromptProfile(right);
  return PROFILE_FIELDS.every((field) => canonicalLeft[field] === canonicalRight[field]);
}

/**
 * Returns null when profiles match. A missing current profile is treated as a
 * legacy-plan mismatch; malformed persisted profiles still fail explicitly.
 */
export function getVideoPromptProfileMismatch(current, target) {
  const canonicalTarget = assertVideoPromptProfile(target);
  if (current == null) {
    return Object.freeze({
      reason: "missing_current_profile",
      current: null,
      target: canonicalTarget,
      changedFields: Object.freeze([...PROFILE_FIELDS])
    });
  }
  const canonicalCurrent = assertVideoPromptProfile(current);
  const changedFields = PROFILE_FIELDS.filter(
    (field) => canonicalCurrent[field] !== canonicalTarget[field]
  );
  if (!changedFields.length) return null;
  return Object.freeze({
    reason: "profile_changed",
    current: canonicalCurrent,
    target: canonicalTarget,
    changedFields: Object.freeze(changedFields)
  });
}

export function needsVideoPromptRegeneration(current, target) {
  return getVideoPromptProfileMismatch(current, target) !== null;
}

function makeProfile({ profileId, provider, model, guideVersion }) {
  return Object.freeze({
    schemaVersion: VIDEO_PROMPT_PROFILE_SCHEMA_VERSION,
    profileId,
    provider,
    model,
    guideVersion
  });
}

function requireExplicitString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`视频提示词 Profile 缺少显式 ${field}。`);
  }
  if (value !== value.trim()) {
    throw new RangeError(`视频提示词 Profile 的 ${field} 不能包含首尾空白。`);
  }
  return value;
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
