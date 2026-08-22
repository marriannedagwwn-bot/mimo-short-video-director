import {
  assertVideoPromptProfile,
  getVideoPromptProfileMismatch,
  resolveVideoPromptProfile,
  VIDEO_PROMPT_PROFILE_IDS
} from "./video-prompt-profiles.js";

export function videoPromptTargetForSetting(setting = {}) {
  const profile = resolveVideoPromptProfile(setting);
  return Object.freeze({ provider: profile.provider, model: profile.model });
}

export function videoPromptProfileUiState(plan = {}, setting = {}) {
  const current = plan?.productionStrategy?.videoPromptProfile ?? null;
  let target;
  try {
    target = resolveVideoPromptProfile(setting);
  } catch (error) {
    return Object.freeze({
      status: "unsupported_target",
      current: validateCurrentProfileForUi(current),
      target: null,
      mismatch: null,
      message: error.message
    });
  }
  try {
    // 直接交给 mismatch：它自己区分「已下线的旧方言」（降级为需重生）和
    // 「损坏的 Profile」（继续硬失败），这里再抢先 assert 会把前者也判成损坏。
    const mismatch = getVideoPromptProfileMismatch(current, target);
    return Object.freeze({
      status: mismatch ? "mismatch" : "matched",
      current: mismatch ? mismatch.current : assertVideoPromptProfile(current),
      target,
      mismatch,
      message: ""
    });
  } catch (error) {
    return Object.freeze({
      status: "invalid_current_profile",
      current: null,
      target,
      mismatch: null,
      message: error.message
    });
  }
}

/**
 * 预览是否追加中文负面规则。方言只有一种，两个视频供应商都追加。
 * 保留形参与 Profile 校验：非法 Profile 仍应在这里明确失败，而不是静默放行。
 */
export function shouldAppendSeedanceNoTextRule(profile) {
  if (profile == null) return true;
  assertVideoPromptProfile(profile);
  return true;
}

/**
 * 预览框里的文本是否作为本次运行时提示词覆盖提交。
 *
 * 方言只有一种，预览恒等于「签发 videoPrompt + UI 追加的中文负面规则」，
 * 因此只要非空就是本次运行的实际提示词。H3 曾有「预览等于签发值就不覆盖」的
 * 特例，那是因为它的预览不追加后缀；该方言下线后特例一并消失。
 */
export function runtimePromptOverride(preview) {
  return String(preview ?? "").trim();
}

export function videoPromptProfileLabel(profile) {
  if (!profile) return "未记录";
  const canonical = assertVideoPromptProfile(profile);
  if (canonical.profileId === VIDEO_PROMPT_PROFILE_IDS.SEEDANCE_2_0) return "Seedance 2.0";
  return `${canonical.provider} ${canonical.model}`;
}

function validateCurrentProfileForUi(profile) {
  if (profile == null) return null;
  try {
    return assertVideoPromptProfile(profile);
  } catch {
    return null;
  }
}
