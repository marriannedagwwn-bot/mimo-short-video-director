import test from "node:test";
import assert from "node:assert/strict";
import {
  ANIMATION_PLAN_ASPECT_RATIOS,
  isAnimationPlanAspectRatio,
  normalizeAnimationPlanAspectRatio,
  withAnimationPlanAspectRatio
} from "../public/animation-plan-settings.js";
import { mockFullStory, mockVariants } from "../src/mock.js";
import { ensureStoryboardPlan } from "../src/storyboard-contract.js";
import { storyboardPlanFixture } from "./helpers/app-ui-harness.js";

// 旧 Plan 阅读视图的时长汇总（animationPlanRuntimeSummary / animationPlanShotDurationRange）
// 已于 2026-10-11 随旧视图删除；4.0 分镜卡片自己显示每段时长。

test("动画画幅只允许 9:16 和 16:9", () => {
  assert.deepEqual(ANIMATION_PLAN_ASPECT_RATIOS, ["9:16", "16:9"]);
  assert.equal(isAnimationPlanAspectRatio("9:16"), true);
  assert.equal(isAnimationPlanAspectRatio("16:9"), true);
  assert.equal(isAnimationPlanAspectRatio("1:1"), false);
  assert.equal(normalizeAnimationPlanAspectRatio("16:9"), "16:9");
  assert.equal(normalizeAnimationPlanAspectRatio("1:1", "9:16"), "9:16");
});

test("已有 Animation Plan 切换画幅只改计划级字段，不重写镜头", () => {
  // withAnimationPlanAspectRatio 有意保留、随时可接回 UI（CLAUDE.md §2.5），夹具用最小合法 4.0 分镜。
  const fullStory = mockFullStory({ variant: mockVariants({ count: 3 }).variants[1] });
  const plan = storyboardPlanFixture(fullStory);
  assert.equal(plan.productionStrategy.targetAspectRatio, "16:9");
  const updated = withAnimationPlanAspectRatio(plan, "9:16");

  assert.equal(updated.productionStrategy.targetAspectRatio, "9:16");
  assert.deepEqual({ ...updated.productionStrategy, targetAspectRatio: "16:9" }, plan.productionStrategy);
  assert.deepEqual(updated.shotPlan, plan.shotPlan);
  assert.notEqual(updated.shotPlan, plan.shotPlan);
  assert.equal(plan.productionStrategy.targetAspectRatio, "16:9");
  // 换完仍是一份合法的 4.0 分镜：除画幅外逐字不变。
  ensureStoryboardPlan(updated, { fullStory });
  assert.deepEqual({ ...updated, productionStrategy: plan.productionStrategy }, plan);
  assert.throws(() => withAnimationPlanAspectRatio(plan, "1:1"), /只允许 9:16 或 16:9/u);
});
