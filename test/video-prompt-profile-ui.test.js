import test from "node:test";
import assert from "node:assert/strict";
import {
  runtimePromptOverride,
  shouldAppendSeedanceNoTextRule,
  videoPromptProfileLabel,
  videoPromptProfileUiState,
  videoPromptTargetForSetting
} from "../public/video-prompt-profile-ui.js";
import { resolveVideoPromptProfile } from "../public/video-prompt-profiles.js";

const SEEDANCE = { provider: "Seedance", model: "doubao-seedance-2-0-260128" };
const MINIMAX = { provider: "MiniMax", model: "MiniMax-H3" };

function planFor(setting) {
  return {
    promptSchemaVersion: "3.0",
    productionStrategy: {
      format: "direct_shot_video",
      videoPromptProfile: resolveVideoPromptProfile(setting)
    }
  };
}

test("初次 Animation Plan 请求从显式镜头视频设置投影 provider/model", () => {
  assert.deepEqual(videoPromptTargetForSetting(MINIMAX), MINIMAX);
  assert.equal(Object.isFrozen(videoPromptTargetForSetting(MINIMAX)), true);
  assert.throws(
    () => videoPromptTargetForSetting({ provider: "Kling", model: "kling-v3" }),
    /没有 direct_shot/u
  );
});

test("UI 明确区分 Profile 一致、模型切换和旧 Plan 缺失", () => {
  const matched = videoPromptProfileUiState(planFor(MINIMAX), MINIMAX);
  assert.equal(matched.status, "matched");
  assert.equal(matched.mismatch, null);

  const mismatch = videoPromptProfileUiState(planFor(MINIMAX), SEEDANCE);
  assert.equal(mismatch.status, "mismatch");
  assert.equal(mismatch.current.profileId, "minimax_h3");
  assert.equal(mismatch.target.profileId, "seedance_2_0");

  const legacy = videoPromptProfileUiState({ productionStrategy: {} }, MINIMAX);
  assert.equal(legacy.status, "mismatch");
  assert.equal(legacy.mismatch.reason, "missing_current_profile");
});

test("不受支持的目标和损坏的 Plan Profile 不被静默解释为可重写", () => {
  const unsupported = videoPromptProfileUiState(
    planFor(MINIMAX),
    { provider: "Kling", model: "kling-v3" }
  );
  assert.equal(unsupported.status, "unsupported_target");
  assert.equal(unsupported.target, null);

  const invalid = videoPromptProfileUiState({
    productionStrategy: {
      videoPromptProfile: {
        ...resolveVideoPromptProfile(MINIMAX),
        guideVersion: "moving-main"
      }
    }
  }, SEEDANCE);
  assert.equal(invalid.status, "invalid_current_profile");
  assert.match(invalid.message, /guideVersion/u);
});

test("H3 预览不追加 Seedance 中文负面后缀", () => {
  const h3 = resolveVideoPromptProfile(MINIMAX);
  const seedance = resolveVideoPromptProfile(SEEDANCE);
  assert.equal(shouldAppendSeedanceNoTextRule(h3), false);
  assert.equal(shouldAppendSeedanceNoTextRule(seedance), true);
  assert.equal(shouldAppendSeedanceNoTextRule(null), true);
  assert.equal(videoPromptProfileLabel(h3), "MiniMax H3");
  assert.equal(videoPromptProfileLabel(seedance), "Seedance 2.0");
});

test("H3 默认预览保留 animation_plan provenance，只有实际编辑才覆盖", () => {
  const h3 = resolveVideoPromptProfile(MINIMAX);
  const seedance = resolveVideoPromptProfile(SEEDANCE);
  const signed = "integrated_multimodal_description: [Shot 1] The character waves.";
  assert.equal(runtimePromptOverride(signed, signed, h3), "");
  assert.equal(runtimePromptOverride(`  ${signed}  `, signed, h3), "");
  assert.equal(runtimePromptOverride(`${signed}\nUser edit.`, signed, h3), `${signed}\nUser edit.`);
  assert.equal(runtimePromptOverride(`${signed}\n禁止新增字幕。`, signed, seedance), `${signed}\n禁止新增字幕。`);
  assert.equal(runtimePromptOverride("", signed, h3), "");
});
