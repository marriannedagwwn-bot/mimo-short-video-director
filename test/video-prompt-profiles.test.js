import test from "node:test";
import assert from "node:assert/strict";
import {
  assertVideoPromptProfile,
  getVideoPromptProfileMismatch,
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

test("MiniMax H3 也签发 Seedance 方言：一份提示词喂两个视频模型", () => {
  const profile = resolveVideoPromptProfile({
    provider: "MiniMax",
    model: "MiniMax-H3"
  });
  // 方言恒为 Seedance；provider/model 如实记录用户当时选的运行时视频模型。
  assert.deepEqual(profile, {
    schemaVersion: "1.0",
    profileId: "seedance_2_0",
    provider: "MiniMax",
    model: "MiniMax-H3",
    guideVersion: "direct-shot-video-prompt-1.0"
  });
  assert.equal(Object.isFrozen(profile), true);
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
  // 方言只有一种：换运行时视频模型不再改变提示词，因此不需要重写。
  assert.equal(needsVideoPromptRegeneration(seedance, minimax), false);
  assert.equal(getVideoPromptProfileMismatch(seedance, minimax), null);
  assert.equal(getVideoPromptProfileMismatch(seedance, seedanceFast), null);

  const legacyMismatch = getVideoPromptProfileMismatch(null, minimax);
  assert.equal(legacyMismatch.reason, "missing_current_profile");
  assert.equal(legacyMismatch.current, null);
  assert.equal(legacyMismatch.target.profileId, "seedance_2_0");
  assert.equal(Object.isFrozen(legacyMismatch), true);
  assert.equal(Object.isFrozen(legacyMismatch.changedFields), true);
});

test("已下线的 minimax_h3 方言降级为需重生，损坏 Profile 仍然硬失败", () => {
  const target = resolveVideoPromptProfile({
    provider: "Seedance",
    model: "doubao-seedance-2-0-260128"
  });
  const retired = {
    schemaVersion: "1.0",
    profileId: "minimax_h3",
    provider: "MiniMax",
    model: "MiniMax-H3",
    guideVersion: "80365054c7fbaace01ed417076fecd532c1ae0e0"
  };

  // 旧 Plan 能加载查看，但生成前必须重生——与缺失 Profile 同义。
  const mismatch = getVideoPromptProfileMismatch(retired, target);
  assert.equal(mismatch.reason, "unsupported_current_profile");
  assert.equal(mismatch.current, null);

  // 降级白名单只认这一对；改动其中任何一项都属于损坏数据，必须继续抛错。
  // 白名单外的任何一项改动都回到严格校验：profileId 先于 guideVersion 被比对。
  assert.throws(() => getVideoPromptProfileMismatch({ ...retired, guideVersion: "other" }, target), /profileId/u);
  assert.throws(() => getVideoPromptProfileMismatch({ ...retired, profileId: "unknown" }, target), /profileId/u);
  assert.throws(() => getVideoPromptProfileMismatch({ ...retired, model: "MiniMax-H4" }, target), /Profile/u);
  // assertVideoPromptProfile 本身始终严格，不受降级影响。
  assert.throws(() => assertVideoPromptProfile(retired), /profileId/u);
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
