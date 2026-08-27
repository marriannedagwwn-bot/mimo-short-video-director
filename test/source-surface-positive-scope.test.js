import test from "node:test";
import assert from "node:assert/strict";
import { mockFullStory, mockVisualGuardrails } from "../src/mock.js";
import {
  animationFoundationPrompt,
  animationShotBatchPrompt,
  characterReferenceRefinePrompt,
  fullStoryPrompt,
  variantsPrompt,
  visualGuardrailsPrompt
} from "../src/prompts.js";
import {
  ensureAnimationPlanMatchesProfile,
  ensureCharacterPromptMatchesBoundary,
  ensureFullStoryMatchesProfile,
  ensureThemeVariantsMatchProfile,
  ensureVisualGuardrailsMatchesProfile,
  materializeGlobalCharacterBoundaryViews
} from "../src/validation.js";

const creatorProfile = Object.freeze({
  fixedCharacter: "小白子，q版狼耳少女，活泼可爱，懂事，村里的热心帮手",
  vertical: "治愈/温情/日常",
  constraints: "小白子只用嗷或嗷呜表达情绪"
});

const creativeBrief = Object.freeze({
  protectedExpressions: [
    {
      expressionType: "原片角色组合",
      sourceExpression: "企鹅装角色、金发戴帽女孩、粉发女孩、蓝发女孩",
      prohibition: "不得把原片角色组合写入新故事正向内容",
      safeAlternativePrinciple: "使用小白子和新的帮助者"
    },
    {
      expressionType: "原片拟声词",
      sourceExpression: "咕咕、耶～、咕嘎",
      prohibition: "不得把原片拟声词写入新对白",
      safeAlternativePrinciple: "使用小白子已签发的嗷或嗷呜"
    }
  ],
  controlledRewriteVariables: [
    {
      variable: "原片道具组合",
      sourceValue: "绿色挎包、白毯子、橘子、伞",
      allowedDirections: ["改成苹果、蜂蜜糖、围裙和木板"],
      mustChange: true,
      reason: "原片具体道具必须替换"
    }
  ]
});

const visualGuardrails = Object.freeze({
  fixedCharacterBoundary: {
    characterName: "小白子",
    requiredTraits: [],
    allowedTraits: [],
    forbiddenTraits: [],
    boundaryDigest: "sha256:test-boundary"
  },
  sourceSimilarityRules: []
});

function safeVariant() {
  return {
    id: "V1",
    title: "果园小眠",
    oneLineHook: "小白子送完水果后在草垛上休息。",
    logline: "小白子完成任务后得到新伙伴照顾。",
    verticalFit: "治愈日常",
    characterSetup: {
      protagonist: "小白子，q版狼耳少女",
      careRecipient: "小白子",
      helper: "果园小哥阿橙、邻居小桃、杂货店学徒小栗"
    },
    newTask: "把新鲜水果送给村中老人",
    emotionalMedium: "围裙、苹果、蜂蜜糖、稻草和木板",
    environmentPressure: "傍晚露水让草垛变潮",
    keyChoice: "小白子选择先保护滚落的水果，再接受伙伴帮助搭建防潮小棚。",
    climax: "小白子在露水加重前把最后一篮水果送达，并亲手固定小棚木板。",
    emotionalPayoff: "小白子从独自完成任务转为确认自己也可以接受伙伴照顾。",
    novelty: "把送达任务与主角接受照顾的关系转变结合。",
    visualPotential: "滚落苹果、傍晚露水和木板小棚形成连续可见的状态变化。",
    storyOutline: [{
      beat: 1,
      phase: "受到照顾",
      action: "小桃追回滚落的苹果，并在篮子旁放下一颗蜂蜜糖。",
      emotion: "温暖",
      dramaticFunction: "用具体行动表达关怀",
      estimatedSeconds: 8
    }],
    highValueBeatMapping: [{
      briefBeat: "原片由企鹅装角色和金发戴帽女孩等朋友追回绿色挎包并放下橘子",
      newExpression: "小桃追回苹果并放下蜂蜜糖",
      retainedValue: "解决突发问题并留下关怀物"
    }],
    keyDialogueDirections: ["小白子用嗷呜表达满足"],
    endingRitual: "新伙伴用稻草和木板搭起遮露水的小棚",
    transformationProof: {
      changedCharacters: "不再使用企鹅装角色、金发戴帽女孩、粉发女孩、蓝发女孩组合",
      changedTask: "改为果园送水果",
      changedDetailsAndProps: "不再使用绿色挎包、白毯子、橘子、雨伞",
      changedDialogue: "不再使用咕咕、耶～、咕嘎",
      changedVisualExpression: "改为果园和傍晚暖光"
    },
    experienceFidelity: {
      positioning: "治愈日常",
      audience: "年轻观众",
      emotion: "温暖",
      plotDriver: "伙伴关怀",
      highValueBeats: "完成任务、休息、受到照顾"
    },
    originalityRiskCheck: {
      riskLevel: "low",
      possibleSimilarity: "来源包含原片道具组合和角色组合",
      mitigation: "正向故事已全部替换"
    }
  };
}

function safeStory() {
  const variant = safeVariant();
  const story = mockFullStory({ creatorProfile, creativeBrief, variant });
  story.beatSheet[3].retainedValueFromBrief = "原片节拍为追回绿色挎包并放下橘子；只保留解决突发问题和表达关怀的剧作价值";
  story.keyProps[0].avoidSimilarityNote = "不使用绿色挎包、白毯子、橘子和雨伞，改用苹果与蜂蜜糖";
  story.dialogueStyleGuide.forbiddenDialoguePatterns = ["原片拟声词咕咕、耶～和咕嘎"];
  story.transformationProof.changedCharacters = "不再使用企鹅装角色与金发戴帽女孩等原片角色组合";
  story.transformationProof.changedDetailsAndProps = "不再使用绿色挎包、白毯子、橘子和雨伞";
  story.transformationProof.changedDialogue = "不再使用咕咕、耶～和咕嘎";
  story.continuityAndSafetyCheck.protectedExpressionsAvoided = "已规避原片道具、拟声词和角色组合";
  story.characterBible.protagonist.speechRules = "不得使用咕咕、耶～或咕嘎，只能使用嗷或嗷呜";
  return story;
}

function safeAnimationPlan() {
  return {
    selectedVariantId: "V1",
    title: "果园小眠",
    visualBible: {
      overallStyle: "温暖的2.5D动画",
      animationStyle: "动作自然",
      colorPalette: ["傍晚暖色"],
      lighting: "柔和侧光",
      cameraLanguage: "稳定中景",
      worldRules: ["不得出现原片企鹅装角色组合"],
      characterConsistencyRules: []
    },
    characterReferencePrompts: [{
      characterName: "小白子",
      storyRole: "热心帮手",
      identity: "q版狼耳少女",
      appearancePrompt: "小白子，q版狼耳少女，暖色日常造型",
      consistencyTags: ["小白子", "狼耳"]
    }],
    sceneReferencePrompts: [],
    assetPrompts: [],
    shotPlan: [{
      shotId: "A01",
      sourceSceneId: "S1",
      sceneId: "LOC01",
      durationSeconds: 4,
      storyPurpose: "表现小白子完成新任务",
      emotionalTarget: "温暖",
      videoPrompt: "小白子在果园把苹果放回篮子，并在旁边看见一颗蜂蜜糖。",
      cameraMotion: "稳定中景后切手部特写",
      characterAction: "小白子把苹果放回篮子",
      dialogueOrSubtitle: "小白子：嗷呜！",
      soundDesign: "果园风声与苹果滚动声",
      continuityNotes: "不得出现原片绿色挎包、白毯子、橘子或雨伞",
      negativePrompts: { image: [], video: [] },
      acceptanceCriteria: ["不得出现原片角色组合或咕咕、耶～、咕嘎拟声词"]
    }]
  };
}

test("原片道具、拟声词和角色组合进入 Variant 正向字段时仍然放行", () => {
  const variant = safeVariant();
  assert.doesNotThrow(() => ensureThemeVariantsMatchProfile(
    { variants: [variant] },
    creatorProfile,
    creativeBrief,
    visualGuardrails
  ));

  variant.characterSetup.helper = "企鹅装角色、金发戴帽女孩、粉发女孩和蓝发女孩";
  variant.keyDialogueDirections = ["小白子听见咕咕、耶～和咕嘎后作出回应"];
  variant.highValueBeatMapping[0].newExpression = "小桃放下橘子，大家拿来白毯子和伞";
  assert.doesNotThrow(() => ensureThemeVariantsMatchProfile(
    { variants: [variant] },
    creatorProfile,
    creativeBrief,
    visualGuardrails
  ));
});

test("原片道具、拟声词和角色组合进入 Full Story 正向剧情时仍然放行", () => {
  const variant = safeVariant();
  const story = safeStory();
  assert.doesNotThrow(() => ensureFullStoryMatchesProfile(
    story,
    creatorProfile,
    creativeBrief,
    variant,
    visualGuardrails
  ));

  story.beatSheet[3].storyAction = "金发戴帽女孩追回绿色挎包并放下橘子";
  story.characterBible.helpers[0].nameOrLabel = "金发戴帽女孩";
  story.sceneScript[3].dialogue[0].line = "咕嘎";
  story.sceneScript[0].shotAndSound = "角色发出耶～的拟声，白毯子落下时发出窸窣声";
  story.keyProps[0].prop = "白毯子";
  assert.doesNotThrow(() => ensureFullStoryMatchesProfile(
    story,
    creatorProfile,
    creativeBrief,
    variant,
    visualGuardrails
  ));
});

test("原片道具、拟声词和角色组合进入 Animation 视频、对白和声音字段时仍然放行", () => {
  const variant = safeVariant();
  const plan = safeAnimationPlan();
  assert.doesNotThrow(() => ensureAnimationPlanMatchesProfile(
    plan,
    creatorProfile,
    creativeBrief,
    variant,
    visualGuardrails
  ));

  plan.shotPlan[0].videoPrompt = "企鹅装角色把橘子放在绿色挎包旁，金发戴帽女孩盖上白毯子";
  plan.shotPlan[0].dialogueOrSubtitle = "金发戴帽女孩：咕嘎；粉发女孩：耶～";
  plan.shotPlan[0].soundDesign = "咕咕、咕嘎与白毯子落下的窸窣声";
  assert.doesNotThrow(() => ensureAnimationPlanMatchesProfile(
    plan,
    creatorProfile,
    creativeBrief,
    variant,
    visualGuardrails
  ));
});

test("来源表达放行不能覆盖 fixedCharacterBoundary 的固定主角禁用特征", () => {
  const guardrails = structuredClone(visualGuardrails);
  guardrails.fixedCharacterBoundary.forbiddenTraits = [{
    canonicalName: "固定主角不得穿企鹅装",
    terms: ["企鹅装"],
    scope: "identity",
    evidence: []
  }];
  const variant = safeVariant();
  variant.characterSetup.protagonist = "小白子，企鹅装角色";
  assert.throws(
    () => ensureThemeVariantsMatchProfile(
      { variants: [variant] },
      creatorProfile,
      creativeBrief,
      guardrails
    ),
    /protagonist.*企鹅装/u
  );
});

test("sourceSimilarityRules 与固定角色允许特征重合时不再反向形成禁词", () => {
  const guardrails = structuredClone(visualGuardrails);
  guardrails.fixedCharacterBoundary.requiredTraits = [{
    canonicalName: "狼耳",
    terms: ["狼耳"],
    scope: "identity",
    evidence: []
  }];
  guardrails.sourceSimilarityRules = [{
    text: "记录原片狼耳角色",
    sourceExpression: "狼耳",
    triggerEvidence: [{ sourcePath: "referenceAnalysis.observedFacts[0]", evidence: "狼耳" }],
    appliesWhenReferenceUsed: true
  }];
  const materialized = materializeGlobalCharacterBoundaryViews(guardrails, creatorProfile);
  assert.doesNotThrow(() => ensureVisualGuardrailsMatchesProfile(materialized, creatorProfile));
  assert.match(materialized.positivePromptBoundary[0].rule, /固定角色「小白子」必须沿用：狼耳/u);
  assert.match(materialized.positivePromptBoundary[0].rule, /不套用到配角、道具、对白或声音/u);
});

test("非固定角色参考精修允许保留来源角色外观且不注入 sourceSimilarityRules", () => {
  const guardrails = structuredClone(visualGuardrails);
  guardrails.sourceSimilarityRules = [{
    text: "SOURCE_ROLE_RULE_SENTINEL",
    sourceExpression: "企鹅装角色",
    triggerEvidence: [{ sourcePath: "referenceAnalysis.observedFacts[0]", evidence: "企鹅装角色" }],
    appliesWhenReferenceUsed: true
  }];
  const prompt = characterReferenceRefinePrompt({
    creatorProfile,
    visualGuardrails: guardrails,
    characterReference: {
      characterName: "企鹅装角色",
      storyRole: "独立配角",
      identity: "企鹅装女孩",
      appearancePrompt: "企鹅装角色，黑白连体服",
      consistencyTags: ["企鹅装"],
      forbiddenChanges: []
    },
    selectedVariant: safeVariant(),
    fullStory: safeStory()
  });
  assert.match(prompt, /可以保留其已有企鹅装、玩偶感、职业或其他来源外观/u);
  assert.doesNotMatch(prompt, /SOURCE_ROLE_RULE_SENTINEL/u);
});

test("多角色视频 Prompt 不把配角来源外观误归因给固定主角", () => {
  const guardrails = structuredClone(visualGuardrails);
  guardrails.fixedCharacterBoundary.forbiddenTraits = [{
    canonicalName: "固定主角不得穿企鹅装",
    terms: ["企鹅装"],
    scope: "identity",
    evidence: []
  }];
  const multiCharacterPrompt = "小白子挥手，旁边的企鹅装角色拿起橘子并发出咕嘎声。";
  assert.doesNotThrow(() => ensureCharacterPromptMatchesBoundary(
    multiCharacterPrompt,
    guardrails,
    { requireRequiredTraits: false, promptScope: "multi_character" }
  ));
  assert.throws(() => ensureCharacterPromptMatchesBoundary(
    "小白子，企鹅装角色造型",
    guardrails,
    { characterName: "小白子", requireRequiredTraits: false }
  ), /企鹅装|禁止特征/u);
});

test("来源拟声词不会被升级成 dialogueRules，正向生成 Prompt 也不注入 sourceSimilarityRules", () => {
  const mockGuardrails = mockVisualGuardrails({ creatorProfile, creativeBrief });
  assert.equal(mockGuardrails.dialogueRules.length, 1);
  assert.equal(mockGuardrails.dialogueRules[0].text, creatorProfile.constraints);
  assert.doesNotMatch(JSON.stringify(mockGuardrails.dialogueRules), /咕咕|耶～|咕嘎/u);

  const guardrails = structuredClone(mockGuardrails);
  guardrails.sourceSimilarityRules.push({
    text: "SOURCE_RULE_SENTINEL",
    sourceExpression: "SOURCE_RULE_SENTINEL",
    triggerEvidence: [{ sourcePath: "referenceAnalysis.storySynopsis", evidence: "SOURCE_RULE_SENTINEL" }],
    appliesWhenReferenceUsed: true
  });
  const variant = safeVariant();
  const story = safeStory();
  const foundation = safeAnimationPlan();
  foundation.productionStrategy = {
    format: "direct_shot_video",
    videoPromptProfile: { profileId: "seedance_2_0", provider: "Seedance", model: "doubao-seedance-2-0-pro" }
  };

  const prompts = [
    variantsPrompt({ count: 1, creatorProfile, creativeBrief, visualGuardrails: guardrails }),
    fullStoryPrompt({ creatorProfile, creativeBrief, visualGuardrails: guardrails, variant }),
    animationFoundationPrompt({
      animationPlanMode: "direct_shot",
      creatorProfile,
      creativeBrief,
      visualGuardrails: guardrails,
      fullStory: story,
      videoPromptProfile: foundation.productionStrategy.videoPromptProfile
    }),
    animationShotBatchPrompt({
      animationPlanMode: "direct_shot",
      creatorProfile,
      creativeBrief,
      visualGuardrails: guardrails,
      variant,
      fullStory: story,
      animationFoundation: foundation,
      sourceScenes: [story.sceneScript[0]],
      batchStartShotIndex: 0
    })
  ];
  prompts.forEach((prompt) => {
    assert.doesNotMatch(prompt, /SOURCE_RULE_SENTINEL/u);
    assert.doesNotMatch(prompt, /禁止复用原片具体表达黑名单/u);
  });

  const guardrailPrompt = visualGuardrailsPrompt({
    creatorProfile,
    creativeBrief,
    referenceAnalysis: {},
    sourceScriptReconstruction: {}
  });
  assert.match(guardrailPrompt, /不得把它升级成 dialogueRules 禁令/u);
  assert.match(guardrailPrompt, /不是 Variants、Full Story 或 Animation Plan 的正向内容黑名单/u);
});
