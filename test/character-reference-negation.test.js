import test from "node:test";
import assert from "node:assert/strict";
import { ANIMATION_PLAN_VERSION_UNSUPPORTED } from "../public/storyboard-plan.js";
import { ensureAnimationPlanMatchesProfile, OutputContractError } from "../src/validation.js";
import { minimalStoryboardPlan } from "./helpers/minimal-storyboard-plan.js";

// 原来这里还有一组走旧 3.0 Foundation 的 ensureAnimationPlanMatchesProfile 用例（连同 Foundation 局部纠错的
// 否定词正则回归），已随 3.0 分镜删除（2026-10-11）。成片渲染链路走的是 characterReferenceBoundaryMismatch
// （/api/generate-shot-video 经由 ensureCharacterReferenceMatchesBoundary 硬失败），它此前同样不放行否定语境；
// 4.0 分镜签发与保留下来的 ensureAnimationPlanMatchesProfile 的 4.0 分支用的也是它。
// 真实回放：appearancePrompt 结尾写「无企鹅服装，无动物拟态服装」——模型在服从边界，
// 却被判「混入全局边界禁止特征」，整条角色参考在渲染前被拦死。
const renderGuardrails = Object.freeze({
  fixedCharacterBoundary: {
    schemaVersion: "2.0",
    characterName: "小白子",
    requiredTraits: [],
    allowedTraits: [],
    forbiddenTraits: [
      { canonicalName: "企鹅服装", terms: ["企鹅服装", "企鹅服"], scope: "appearance" },
      { canonicalName: "动物拟态服装", terms: ["动物拟态服装"], scope: "appearance" }
    ],
    boundaryDigest: "sha256:test-boundary"
  }
});

function reference(appearancePrompt) {
  return {
    characterName: "小白子",
    storyRole: "主角",
    identity: "村里的热心帮手",
    appearancePrompt,
    consistencyTags: [],
    // 这个字段的职责就是罗列禁止变化，本就不在扫描范围内。
    forbiddenChanges: ["企鹅服装", "企鹅动作"]
  };
}

test("成片渲染链路的角色参考检查同样放行否定约束", async () => {
  const { characterReferenceBoundaryMismatch, ensureCharacterReferenceMatchesBoundary } =
    await import("../src/validation.js");

  assert.equal(
    characterReferenceBoundaryMismatch(
      reference("Q版少女体型，猫耳，银白色长发，蓝色围巾，无企鹅服装，无动物拟态服装"),
      renderGuardrails
    ),
    ""
  );
  assert.doesNotThrow(() => ensureCharacterReferenceMatchesBoundary(
    reference("Q版少女体型，猫耳，无企鹅服装，无动物拟态服装"),
    renderGuardrails
  ));
  assert.equal(
    characterReferenceBoundaryMismatch(reference("不得出现动物拟态服装"), renderGuardrails),
    ""
  );
});

test("成片渲染链路仍然拒绝真正的越界，否定放行不是免检", async () => {
  const { characterReferenceBoundaryMismatch, ensureCharacterReferenceMatchesBoundary } =
    await import("../src/validation.js");

  // 正向穿着。
  assert.match(
    characterReferenceBoundaryMismatch(reference("Q版少女体型，穿着企鹅服装"), renderGuardrails),
    /混入全局边界禁止特征：企鹅服装/u
  );
  // 先否定后转折又用上。
  assert.match(
    characterReferenceBoundaryMismatch(reference("不穿企鹅服装，但是套着企鹅服"), renderGuardrails),
    /混入全局边界禁止特征/u
  );
  // 否定只在同一分句内生效，跨句不继承。
  assert.match(
    characterReferenceBoundaryMismatch(reference("无企鹅服装。她换上了企鹅服"), renderGuardrails),
    /混入全局边界禁止特征/u
  );
  assert.throws(
    () => ensureCharacterReferenceMatchesBoundary(reference("穿着企鹅服装"), renderGuardrails),
    /混入全局边界禁止特征/u
  );
});

// ensureAnimationPlanMatchesProfile 只保留 4.0 分支（另一个会话的「一句话修改」会调用它）：
// 角色参考走与成片渲染链路同一个判定，旧 2.0/3.0 Plan 一律按版本明确拒绝，不再静默放过。
test("保留的 ensureAnimationPlanMatchesProfile：4.0 角色参考同样放行否定约束，旧 Plan 按版本拒绝", () => {
  const planWith = (appearancePrompt) => {
    const plan = minimalStoryboardPlan({ characterName: "小白子" });
    plan.characterReferencePrompts[0] = reference(appearancePrompt);
    return plan;
  };
  const check = (plan) => ensureAnimationPlanMatchesProfile(plan, { fixedCharacter: "小白子" }, null, { id: "V1" }, renderGuardrails);
  const allowed = planWith("Q版少女体型，猫耳，无企鹅服装，无动物拟态服装");
  assert.equal(check(allowed), allowed);
  assert.throws(
    () => check(planWith("Q版少女体型，穿着企鹅服装")),
    (error) => error instanceof OutputContractError && /混入全局边界禁止特征：企鹅服装/u.test(error.message)
  );
  for (const legacy of [{ promptSchemaVersion: "3.0", selectedVariantId: "V1", shotPlan: [] }, { selectedVariantId: "V1", shotPlan: [] }]) {
    assert.throws(
      () => check(legacy),
      (error) => error instanceof OutputContractError && error.code === ANIMATION_PLAN_VERSION_UNSUPPORTED
    );
  }
});
