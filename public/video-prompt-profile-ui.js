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
    const canonicalCurrent = current == null ? null : assertVideoPromptProfile(current);
    const mismatch = getVideoPromptProfileMismatch(canonicalCurrent, target);
    return Object.freeze({
      status: mismatch ? "mismatch" : "matched",
      current: canonicalCurrent,
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

export function shouldAppendSeedanceNoTextRule(profile) {
  if (profile == null) return true;
  return assertVideoPromptProfile(profile).profileId !== VIDEO_PROMPT_PROFILE_IDS.MINIMAX_H3;
}

export function runtimePromptOverride(preview, signedVideoPrompt, profile) {
  const previewText = String(preview ?? "").trim();
  const signedText = String(signedVideoPrompt ?? "").trim();
  if (!previewText) return "";
  if (
    profile != null
    && assertVideoPromptProfile(profile).profileId === VIDEO_PROMPT_PROFILE_IDS.MINIMAX_H3
    && previewText === signedText
  ) return "";
  return previewText;
}

export function videoPromptProfileLabel(profile) {
  if (!profile) return "未记录";
  const canonical = assertVideoPromptProfile(profile);
  if (canonical.profileId === VIDEO_PROMPT_PROFILE_IDS.MINIMAX_H3) return "MiniMax H3";
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
