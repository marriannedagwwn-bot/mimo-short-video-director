import test from "node:test";
import assert from "node:assert/strict";
import { buildVideoGenerationQueue } from "../public/animation-queue.js";
import { compileShotFrameNegativePrompt } from "../public/shot-frame-prompt.js";
import { buildJimengImageRequestBody, buildJimengImageRequestReceipt } from "../src/jimeng-client.js";
import { mockAnimationPlan, mockVisualGuardrails } from "../src/mock.js";
import {
  ensureAnimationPlanMatchesProfile,
  ensureAnimationPlanNegativePrompts,
  ensureOutputContract,
  ensureVisualGuardrailsMatchesProfile,
  pruneAnimationPlanNegativePrompts
} from "../src/validation.js";

const creatorProfile = {
  fixedCharacter: "小白子，Q版猫耳少女人形，猫耳和蓬松猫尾巴，活泼可爱",
  vertical: "治愈日常短片",
  constraints: "主角只能使用“嗷”或“嗷呜”，不得说完整人类句子"
};

const variant = {
  id: "V1",
  title: "夕阳幻灯片",
  characterSetup: { protagonist: "小白子", careRecipient: "外婆", helper: "木匠" }
};

function storyWithActions(actions = ["小白子安静地看向夕阳。"]) {
  return {
    selectedVariantId: "V1",
    title: "夕阳幻灯片",
    targetDurationSeconds: actions.length * 5,
    characterBible: {
      protagonist: { name: "小白子", identity: creatorProfile.fixedCharacter },
      careRecipient: { nameOrLabel: "外婆", identity: "家人" }
    },
    sceneScript: actions.map((visibleAction, index) => ({
      sceneId: `S${index + 1}`,
      location: index ? "木屋窗边" : "木屋",
      visibleAction,
      emotionNode: index === 1 ? "发现" : "温暖",
      dramaticFunction: "推进当前动作"
    })),
    keyProps: [{ prop: "透明玻璃幻灯片", storyFunction: "承载旧照片", visualUse: "对着夕阳观察" }]
  };
}

function buildContext({ actions, protectedExpressions = [], actualReferenceInputs } = {}) {
  const creativeBrief = { protectedExpressions };
  const fullStory = storyWithActions(actions);
  const visualGuardrails = ensureVisualGuardrailsMatchesProfile(
    ensureOutputContract(mockVisualGuardrails({ creatorProfile, creativeBrief }), "visualGuardrails"),
    creatorProfile
  );
  return {
    creatorProfile,
    creativeBrief,
    visualGuardrails,
    fullStory,
    variant,
    ...(actualReferenceInputs ? { actualReferenceInputs } : {})
  };
}

function buildPlan(context) {
  return ensureOutputContract(mockAnimationPlan(context), "animationPlan");
}

function validatePlan(plan, context) {
  const pruned = pruneAnimationPlanNegativePrompts(plan, context);
  return ensureAnimationPlanMatchesProfile(
    pruned,
    context.creatorProfile,
    context.creativeBrief,
    context.variant,
    context.visualGuardrails,
    context
  );
}

function negativeEntry(overrides = {}) {
  return {
    text: "当前镜头角色身份漂移",
    appliesTo: "image",
    triggerEvidence: [{ sourcePath: "creatorProfile.fixedCharacter", evidence: creatorProfile.fixedCharacter }],
    reasonCode: "explicit_identity_conflict",
    priority: "high",
    enabled: true,
    ...overrides
  };
}

test("Q版猫耳少女不会生成无关动物部件负面词库", () => {
  const context = buildContext();
  const text = JSON.stringify(context.visualGuardrails);
  assert.doesNotMatch(text, /鸟喙|脚蹼|鳍|羽毛|狼尾|狐尾|兔尾|龙尾|狼爪|猫爪|肉垫|企鹅/u);
  assert.equal(Object.hasOwn(context.visualGuardrails, "forbiddenPositiveTraits"), false);
  assert.equal(Object.hasOwn(context.visualGuardrails, "commonNegativePrompt"), false);
});

test("“用户未声明”不能成为渲染负面词的唯一理由", () => {
  const context = buildContext();
  const plan = buildPlan(context);
  plan.shotPlan[0].negativePrompts.image.push(negativeEntry({
    text: "用户未声明鸟喙",
    triggerEvidence: [{ sourcePath: "creatorProfile.fixedCharacter", evidence: creatorProfile.fixedCharacter }]
  }));
  assert.throws(() => ensureAnimationPlanNegativePrompts(plan, context), /有效证据/);
  assert.deepEqual(pruneAnimationPlanNegativePrompts(plan, context).shotPlan[0].negativePrompts.image, []);
});

test("每镜图片和视频负面数组均为空时通过输出契约和语义校验", () => {
  const context = buildContext({ actions: ["小白子安静地看向夕阳。", "小白子微笑着点头。"] });
  const plan = buildPlan(context);
  assert.ok(plan.shotPlan.every((shot) => !shot.negativePrompts.image.length && !shot.negativePrompts.video.length));
  assert.doesNotThrow(() => validatePlan(plan, context));
});

test("“咕嘎”只进入 dialogueRules，混入图片或视频负面词会被删除", () => {
  const context = buildContext({
    protectedExpressions: [{ expressionType: "台词", sourceExpression: "咕嘎" }]
  });
  assert.match(JSON.stringify(context.visualGuardrails.dialogueRules), /咕嘎/u);
  assert.doesNotMatch(JSON.stringify(context.visualGuardrails.sourceSimilarityRules), /咕嘎/u);
  const plan = buildPlan(context);
  plan.shotPlan[0].negativePrompts.image.push(negativeEntry({
    text: "咕嘎",
    triggerEvidence: [{ sourcePath: "creatorProfile.fixedCharacter", evidence: creatorProfile.fixedCharacter }]
  }));
  const pruned = pruneAnimationPlanNegativePrompts(plan, context);
  assert.deepEqual(pruned.shotPlan[0].negativePrompts.image, []);
  assert.doesNotMatch(JSON.stringify(pruned.shotPlan[0].negativePrompts), /咕嘎/u);
});

test("企鹅服只属于 sourceSimilarityRules，只有实际传入原片视觉参考才可条件性保留", () => {
  const protectedExpressions = [{ expressionType: "视觉元素", sourceExpression: "企鹅服" }];
  const context = buildContext({ protectedExpressions });
  assert.match(JSON.stringify(context.visualGuardrails.sourceSimilarityRules), /企鹅服/u);
  const plan = buildPlan(context);
  plan.shotPlan[0].negativePrompts.image.push(negativeEntry({
    text: "企鹅服",
    triggerEvidence: [{
      sourcePath: "visualGuardrails.sourceSimilarityRules[0].sourceExpression",
      evidence: "企鹅服"
    }],
    reasonCode: "reference_leak"
  }));
  assert.deepEqual(pruneAnimationPlanNegativePrompts(plan, context).shotPlan[0].negativePrompts.image, []);

  const withReference = { ...context, actualReferenceInputs: { image: [{ name: "source-frame-01.png" }] } };
  const kept = pruneAnimationPlanNegativePrompts(plan, withReference).shotPlan[0].negativePrompts.image;
  assert.equal(kept.length, 1);
  assert.equal(kept[0].reasonCode, "reference_leak");
});

test("只有手持玻璃幻灯片的 shot 获得接触融合与道具混淆负面词", () => {
  const context = buildContext({ actions: [
    "小白子打开木箱。",
    "小白子拿起透明玻璃幻灯片，对着夕阳观察。",
    "小白子看见旧照片，安静地笑了一下。"
  ] });
  const plan = validatePlan(buildPlan(context), context);
  const [first, glass, last] = plan.shotPlan;
  assert.deepEqual(first.negativePrompts, { image: [], video: [] });
  assert.deepEqual(last.negativePrompts, { image: [], video: [] });
  assert.deepEqual(glass.negativePrompts.image.map((entry) => entry.text), [
    "手指与透明玻璃片融合",
    "玻璃幻灯片被错误生成成手机屏幕"
  ]);
  assert.ok(glass.negativePrompts.video.every((entry) => entry.triggerEvidence[0].sourcePath === "fullStory.sceneScript[S2].visibleAction"));
});

test("不同 shot 不得无差别复制完全相同的非空负面数组", () => {
  const context = buildContext({ actions: ["小白子向前走。", "小白子停下脚步。"] });
  const plan = buildPlan(context);
  const shared = negativeEntry();
  plan.shotPlan[0].negativePrompts.image = [structuredClone(shared)];
  plan.shotPlan[1].negativePrompts.image = [structuredClone(shared)];
  assert.throws(() => ensureAnimationPlanNegativePrompts(plan, context), /完全相同的非空逐镜负面提示词数组/);
});

test("任务队列只编译当前 shot、当前媒介且已启用的负面词", () => {
  const context = buildContext({ actions: ["小白子拿起透明玻璃幻灯片，对着夕阳观察。"] });
  const plan = validatePlan(buildPlan(context), context);
  plan.shotPlan[0].negativePrompts.image[1].enabled = false;
  const queue = buildVideoGenerationQueue({ selectedVariant: variant, fullStory: context.fullStory, animationPlan: plan });
  const start = queue.jobs.find((job) => job.type === "start_frame_image");
  const video = queue.jobs.find((job) => job.type === "first_last_frame_video");
  assert.equal(start.compiledNegativePrompt, "手指与透明玻璃片融合");
  assert.doesNotMatch(start.compiledNegativePrompt, /手机屏幕|动作过程/u);
  assert.match(video.compiledNegativePrompt, /拿起过程|动作过程/u);
  assert.doesNotMatch(video.compiledNegativePrompt, /手机屏幕/u);
});

test("不支持独立 negative 字段的即梦不伪造字段，回执明确转换与忽略结果", () => {
  const shot = {
    negativePrompts: {
      image: [
        negativeEntry(),
        negativeEntry({
          text: "手指与透明玻璃片融合",
          triggerEvidence: [{ sourcePath: "animationPlan.shotPlan[A02].startFramePrompt", evidence: "小白子手持透明玻璃片" }],
          reasonCode: "shot_interaction_failure",
          priority: "medium"
        })
      ],
      video: []
    }
  };
  const delivery = compileShotFrameNegativePrompt(shot);
  const body = buildJimengImageRequestBody({ model: "seedream-test", maxImages: 1 }, { prompt: "小白子手持玻璃幻灯片", count: 1 });
  const receipt = buildJimengImageRequestReceipt(body, delivery);
  assert.equal(Object.hasOwn(body, "negativePrompt"), false);
  assert.equal(Object.hasOwn(body, "negative_prompt"), false);
  assert.equal(receipt.negativePromptDelivery.supported, false);
  assert.equal(receipt.negativePromptDelivery.appliedMode, "positive_constraint");
  assert.equal(receipt.negativePromptDelivery.providerField, "prompt");
  assert.match(receipt.negativePromptDelivery.compiledNegativePrompt, /身份漂移/);
  assert.deepEqual(receipt.negativePromptDelivery.ignored, ["手指与透明玻璃片融合"]);
  assert.equal(receipt.negativePromptDelivery.providerIgnored, true);
  assert.equal(Object.hasOwn(receipt.requestPreview, "negativePrompt"), false);
});

test("负面条目必须使用白名单 reasonCode 并携带非空 sourcePath/evidence", () => {
  const context = buildContext();
  const missingEvidence = buildPlan(context);
  missingEvidence.shotPlan[0].negativePrompts.image.push(negativeEntry({ triggerEvidence: [] }));
  assert.throws(() => ensureOutputContract(missingEvidence, "animationPlan"), /triggerEvidence.*至少需要一条明确证据/);

  const badReason = buildPlan(context);
  badReason.shotPlan[0].negativePrompts.image.push(negativeEntry({ reasonCode: "unspecified_feature" }));
  assert.throws(() => ensureOutputContract(badReason, "animationPlan"), /reasonCode 不受支持/);
});
