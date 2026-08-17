import test from "node:test";
import assert from "node:assert/strict";
import {
  assertVideoPromptProfile,
  getVideoPromptProfileMismatch,
  MINIMAX_H3_PROMPT_GUIDE_VERSION,
  needsVideoPromptRegeneration,
  resolveVideoPromptProfile,
  sameVideoPromptProfile,
  VIDEO_PROMPT_PROFILE_IDS,
  VIDEO_PROMPT_PROFILE_SCHEMA_VERSION
} from "../public/video-prompt-profiles.js";

const SEEDANCE_MODELS = [
  "doubao-seedance-2-0-260128",
  "doubao-seedance-2-0-fast-260128",
  "doubao-seedance-2-0-mini-260615"
];

test("显式 Seedance 2.0 设置解析为带版本的不可变 Profile", () => {
  for (const model of SEEDANCE_MODELS) {
    const profile = resolveVideoPromptProfile({ provider: "Seedance", model });
    assert.deepEqual(profile, {
      schemaVersion: VIDEO_PROMPT_PROFILE_SCHEMA_VERSION,
      profileId: VIDEO_PROMPT_PROFILE_IDS.SEEDANCE_2_0,
      provider: "Seedance",
      model,
      guideVersion: "direct-shot-video-prompt-1.0"
    });
    assert.equal(Object.isFrozen(profile), true);
    assert.equal(assertVideoPromptProfile(structuredClone(profile)).model, model);
  }
});

test("MiniMax H3 Profile 固定官方 Skill commit", () => {
  const profile = resolveVideoPromptProfile({
    provider: "MiniMax",
    model: "MiniMax-H3"
  });
  assert.deepEqual(profile, {
    schemaVersion: "1.0",
    profileId: "minimax_h3",
    provider: "MiniMax",
    model: "MiniMax-H3",
    guideVersion: "80365054c7fbaace01ed417076fecd532c1ae0e0"
  });
  assert.equal(MINIMAX_H3_PROMPT_GUIDE_VERSION, profile.guideVersion);
});

test("Profile 解析不推断 provider、不接受别名、空值或未登记模型", () => {
  const invalidSettings = [
    {},
    { provider: "MiniMax" },
    { model: "MiniMax-H3" },
    { provider: "minimax", model: "MiniMax-H3" },
    { provider: "MiniMax", model: "minimax-h3" },
    { provider: "Seedance", model: "MiniMax-H3" },
    { provider: "MiniMax", model: "doubao-seedance-2-0-260128" },
    { provider: "Seedance", model: "doubao-seedance-2-0-260128 " },
    { provider: "Seedance", model: "doubao-seedance-1-0-legacy" }
  ];
  for (const setting of invalidSettings) {
    assert.throws(() => resolveVideoPromptProfile(setting), /Profile/u);
  }
});

test("Kling 与 VideoHTTP 在 direct_shot Profile 解析时明确失败", () => {
  assert.throws(
    () => resolveVideoPromptProfile({ provider: "Kling", model: "kling-v3" }),
    /Kling 当前没有 direct_shot/u
  );
  assert.throws(
    () => resolveVideoPromptProfile({ provider: "VideoHTTP", model: "custom-video" }),
    /VideoHTTP 当前没有 direct_shot/u
  );
});

test("持久化 Profile 的 schema、精确字段和 guideVersion 均受校验", () => {
  const valid = resolveVideoPromptProfile({ provider: "MiniMax", model: "MiniMax-H3" });
  assert.throws(
    () => assertVideoPromptProfile({ ...valid, schemaVersion: "2.0" }),
    /Schema/u
  );
  assert.throws(
    () => assertVideoPromptProfile({ ...valid, guideVersion: "moving-main" }),
    /guideVersion/u
  );
  assert.throws(
    () => assertVideoPromptProfile({ ...valid, inferred: true }),
    /只允许字段/u
  );
});

test("compare 与 mismatch 为 UI 提供确定性的提示词重生成决策", () => {
  const seedance = resolveVideoPromptProfile({
    provider: "Seedance",
    model: "doubao-seedance-2-0-260128"
  });
  const seedanceFast = resolveVideoPromptProfile({
    provider: "Seedance",
    model: "doubao-seedance-2-0-fast-260128"
  });
  const minimax = resolveVideoPromptProfile({ provider: "MiniMax", model: "MiniMax-H3" });

  assert.equal(sameVideoPromptProfile(seedance, structuredClone(seedance)), true);
  assert.equal(getVideoPromptProfileMismatch(seedance, structuredClone(seedance)), null);
  assert.equal(needsVideoPromptRegeneration(seedance, minimax), true);

  const modelMismatch = getVideoPromptProfileMismatch(seedance, seedanceFast);
  assert.equal(modelMismatch.reason, "profile_changed");
  assert.deepEqual(modelMismatch.changedFields, ["model"]);
  assert.equal(Object.isFrozen(modelMismatch), true);
  assert.equal(Object.isFrozen(modelMismatch.changedFields), true);

  const providerMismatch = getVideoPromptProfileMismatch(seedance, minimax);
  assert.deepEqual(providerMismatch.changedFields, ["profileId", "provider", "model", "guideVersion"]);

  const legacyMismatch = getVideoPromptProfileMismatch(null, minimax);
  assert.equal(legacyMismatch.reason, "missing_current_profile");
  assert.equal(legacyMismatch.current, null);
  assert.equal(legacyMismatch.target.profileId, "minimax_h3");
});

test("损坏的旧 Profile 不会被 compare/mismatch 静默当成普通模型切换", () => {
  const target = resolveVideoPromptProfile({ provider: "MiniMax", model: "MiniMax-H3" });
  assert.throws(
    () => getVideoPromptProfileMismatch({ ...target, guideVersion: "unknown" }, target),
    /guideVersion/u
  );
  assert.equal(sameVideoPromptProfile(null, null), true);
  assert.equal(sameVideoPromptProfile(null, target), false);
});
