import test from "node:test";
import assert from "node:assert/strict";
import {
  ANIMATION_PLAN_ASPECT_RATIOS,
  animationPlanRuntimeSummary,
  isAnimationPlanAspectRatio,
  normalizeAnimationPlanAspectRatio,
  withAnimationPlanAspectRatio
} from "../public/animation-plan-settings.js";

test("Animation Plan 时长展示使用全部镜头计划合计而非上游目标", () => {
  const plan = {
    productionStrategy: { targetRuntimeSeconds: 60 },
    shotPlan: [4, 5, 5, 6, 5, 5, 5, 5, 6, 5, 4, 4, 5, 6].map((durationSeconds) => ({ durationSeconds }))
  };
  const before = structuredClone(plan);

  assert.deepEqual(animationPlanRuntimeSummary(plan), {
    valid: true,
    plannedSeconds: 70,
    targetSeconds: 60,
    deltaSeconds: 10,
    reason: ""
  });
  assert.deepEqual(plan, before);
});

test("Animation Plan 时长汇总保留等于目标和低于目标的合法结果", () => {
  assert.equal(animationPlanRuntimeSummary({
    productionStrategy: { targetRuntimeSeconds: 10 },
    shotPlan: [{ durationSeconds: 4 }, { durationSeconds: 6 }]
  }).deltaSeconds, 0);
  assert.equal(animationPlanRuntimeSummary({
    productionStrategy: { targetRuntimeSeconds: 12 },
    shotPlan: [{ durationSeconds: 4 }, { durationSeconds: 5 }]
  }).deltaSeconds, -3);
});

test("Animation Plan 时长数据不完整时不输出误导性的部分合计", () => {
  assert.equal(animationPlanRuntimeSummary({ shotPlan: [] }).valid, false);
  assert.deepEqual(animationPlanRuntimeSummary({
    productionStrategy: { targetRuntimeSeconds: 60 },
    shotPlan: [{ durationSeconds: 4 }, { durationSeconds: 0 }]
  }), {
    valid: false,
    plannedSeconds: null,
    targetSeconds: 60,
    deltaSeconds: null,
    reason: "镜头时长数据不完整"
  });
});

test("动画画幅只允许 9:16 和 16:9", () => {
  assert.deepEqual(ANIMATION_PLAN_ASPECT_RATIOS, ["9:16", "16:9"]);
  assert.equal(isAnimationPlanAspectRatio("9:16"), true);
  assert.equal(isAnimationPlanAspectRatio("16:9"), true);
  assert.equal(isAnimationPlanAspectRatio("1:1"), false);
  assert.equal(normalizeAnimationPlanAspectRatio("16:9"), "16:9");
  assert.equal(normalizeAnimationPlanAspectRatio("1:1", "9:16"), "9:16");
});

test("已有 Animation Plan 切换画幅只改计划级字段，不重写镜头", () => {
  const plan = {
    productionStrategy: { format: "direct_shot_video", targetAspectRatio: "9:16" },
    shotPlan: [{ shotId: "A01", durationSeconds: 4, videoPrompt: "原镜头内容" }]
  };
  const updated = withAnimationPlanAspectRatio(plan, "16:9");

  assert.equal(updated.productionStrategy.targetAspectRatio, "16:9");
  assert.deepEqual(updated.shotPlan, plan.shotPlan);
  assert.notEqual(updated.shotPlan, plan.shotPlan);
  assert.equal(plan.productionStrategy.targetAspectRatio, "9:16");
  assert.throws(() => withAnimationPlanAspectRatio(plan, "1:1"), /只允许 9:16 或 16:9/u);
});
