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

test("方言唯一：换运行时视频模型不再算 mismatch，旧 Plan 缺 Profile 仍要重生", () => {
  const matched = videoPromptProfileUiState(planFor(MINIMAX), MINIMAX);
  assert.equal(matched.status, "matched");
  assert.equal(matched.mismatch, null);

  // 同一条 Seedance 提示词同时喂两个模型，切换模型不需要重写。
  const switched = videoPromptProfileUiState(planFor(MINIMAX), SEEDANCE);
  assert.equal(switched.status, "matched");
  assert.equal(switched.mismatch, null);

  const legacy = videoPromptProfileUiState({ productionStrategy: {} }, MINIMAX);
  assert.equal(legacy.status, "mismatch");
  assert.equal(legacy.mismatch.reason, "missing_current_profile");

  // 已下线的 minimax_h3 方言：能加载查看，但生成前必须重生 Plan。
  const retired = videoPromptProfileUiState({
    productionStrategy: {
      videoPromptProfile: {
        schemaVersion: "1.0",
        profileId: "minimax_h3",
        provider: "MiniMax",
        model: "MiniMax-H3",
        guideVersion: "80365054c7fbaace01ed417076fecd532c1ae0e0"
      }
    }
  }, SEEDANCE);
  assert.equal(retired.status, "mismatch");
  assert.equal(retired.mismatch.reason, "unsupported_current_profile");
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

test("两个视频模型共用 Seedance 方言：预览后缀与标签一致", () => {
  const h3 = resolveVideoPromptProfile(MINIMAX);
  const seedance = resolveVideoPromptProfile(SEEDANCE);
  // 方言只有一种，H3 的预览也要带 Seedance 的中文负面后缀。
  assert.equal(shouldAppendSeedanceNoTextRule(h3), true);
  assert.equal(shouldAppendSeedanceNoTextRule(seedance), true);
  assert.equal(shouldAppendSeedanceNoTextRule(null), true);
  assert.equal(videoPromptProfileLabel(h3), "Seedance 2.0");
  assert.equal(videoPromptProfileLabel(seedance), "Seedance 2.0");
});

test("预览文本非空即作为本次运行时提示词覆盖提交", () => {
  const signed = "温暖治愈的手绘动画质感。小白子走过院子并挥手。";
  // 预览恒带 UI 追加的负面规则，因此非空即是本次运行的实际提示词。
  assert.equal(runtimePromptOverride(`${signed}\n禁止新增字幕。`), `${signed}\n禁止新增字幕。`);
  assert.equal(runtimePromptOverride(`  ${signed}  `), signed);
  assert.equal(runtimePromptOverride(""), "");
  assert.equal(runtimePromptOverride(null), "");
});
