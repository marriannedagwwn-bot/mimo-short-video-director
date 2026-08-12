import test from "node:test";
import assert from "node:assert/strict";
import { sealGlobalCharacterBoundary } from "../src/character-boundary.js";
import { mockAnimationPlan, mockBrief, mockFullStory, mockVisualGuardrails } from "../src/mock.js";
import { animationFoundationPrompt, animationShotBatchPrompt } from "../src/prompts.js";
import {
  ANIMATION_DIRECT_PROMPT_SCHEMA_VERSION,
  ANIMATION_DIRECT_SHOT_MODE,
  OutputContractError,
  ensureAnimationShotBatchContract,
  materializeGlobalCharacterBoundaryViews,
  pruneAnimationPlanNegativePrompts
} from "../src/validation.js";
import { WorkflowService } from "../src/workflow.js";
import { generateShotVideo, normalizeShotVideoAspectRatio, ShotVideoConfigError } from "../src/shot-video-generator.js";

const DIRECT_SHOT_FIELDS = Object.freeze([
  "shotId",
  "sourceSceneId",
  "sceneId",
  "durationSeconds",
  "storyPurpose",
  "emotionalTarget",
  "videoPrompt",
  "cameraMotion",
  "characterAction",
  "dialogueOrSubtitle",
  "soundDesign",
  "continuityNotes",
  "negativePrompts",
  "acceptanceCriteria"
]);

const DISABLED_ENDPOINT_FIELDS = Object.freeze([
  "startFrame",
  "endFrame",
  "motion",
  "startFramePrompt",
  "endFramePrompt"
]);

function directShot() {
  return {
    shotId: "A01",
    sourceSceneId: "S1",
    sceneId: "LOC01",
    durationSeconds: 4,
    storyPurpose: "建立修理任务",
    emotionalTarget: "专注",
    videoPrompt: "阿岚在社区维修间检查旧收音机，镜头保持单一连续构图，修理动作完成后立即停止。",
    cameraMotion: "固定机位，中近景保持稳定",
    characterAction: "阿岚低头检查旧收音机并拧紧松动螺丝",
    dialogueOrSubtitle: "",
    soundDesign: "维修间环境声，螺丝刀轻响",
    continuityNotes: "阿岚、旧收音机和维修台位置保持连续",
    negativePrompts: { image: [], video: [] },
    acceptanceCriteria: ["阿岚身份稳定", "修理动作连续可见"]
  };
}

function directContext(workflow = new WorkflowService()) {
  const creatorProfile = {
    fixedCharacter: "阿岚，社区修理师",
    vertical: "家电维修",
    constraints: "60 秒内"
  };
  const boundaryInput = {
    creatorProfile,
    referenceAnalysis: {},
    sourceScriptReconstruction: {}
  };
  const creativeBrief = mockBrief(boundaryInput);
  const variant = {
    id: "V1",
    title: "最后一格电",
    characterSetup: {
      protagonist: "阿岚，社区修理师",
      careRecipient: "独居老人",
      helper: "夜班便利店员"
    },
    newTask: "修复并送回旧设备",
    emotionalMedium: "一段旧录音",
    environmentPressure: "暴雨停电",
    endingRitual: "老人按下播放键"
  };
  const fullStory = mockFullStory({ ...boundaryInput, creativeBrief, variant });
  const signingInput = { ...boundaryInput, creativeBrief };
  const visualGuardrails = sealGlobalCharacterBoundary(
    materializeGlobalCharacterBoundaryViews(mockVisualGuardrails(signingInput), creatorProfile),
    signingInput,
    workflow.characterBoundaryKey
  );
  return {
    ...signingInput,
    visualGuardrails,
    variant,
    fullStory,
    animationPlanMode: ANIMATION_DIRECT_SHOT_MODE
  };
}

test("direct foundation 与 batch prompt 声明 3.0 且 JSON 结构不含端点字段", () => {
  const context = directContext();
  const plan = mockAnimationPlan(context);
  const { shotPlan: ignoredShotPlan, ...animationFoundation } = structuredClone(plan);
  animationFoundation.sceneReferencePrompts.forEach((scene, index) => {
    scene.sourceSceneIds = [context.fullStory.sceneScript[index].sceneId];
    scene.relatedShotIds = [];
  });

  const foundationPrompt = animationFoundationPrompt(context);
  const batchPrompt = animationShotBatchPrompt({
    ...context,
    animationFoundation,
    sourceScenes: context.fullStory.sceneScript.slice(0, 2),
    shotIdStartIndex: 1
  });

  assert.match(foundationPrompt, /当前显式模式：direct_shot/u);
  assert.match(foundationPrompt, /"promptSchemaVersion":"3\.0"/u);
  assert.match(foundationPrompt, /"format":"direct_shot_video"/u);
  assert.match(batchPrompt, /当前显式模式：direct_shot/u);
  assert.match(batchPrompt, /契约版本：3\.0/u);
  assert.match(batchPrompt, /"videoPrompt":""/u);
  assert.match(batchPrompt, /"cameraMotion":""/u);

  for (const prompt of [foundationPrompt, batchPrompt]) {
    for (const field of DISABLED_ENDPOINT_FIELDS) {
      assert.doesNotMatch(
        prompt,
        new RegExp(`"${field}"\\s*:`, "u"),
        `direct prompt 的 JSON 结构不得声明 ${field}`
      );
    }
  }
});

test("direct_shot 把用户选择的 16:9 锁入 Prompt、Mock 和最终计划", async () => {
  const workflow = new WorkflowService();
  const context = { ...directContext(workflow), targetAspectRatio: "16:9" };
  const prompt = animationFoundationPrompt(context);

  assert.match(prompt, /用户选择的目标画幅：16:9/u);
  assert.match(prompt, /"targetAspectRatio":"16:9"/u);
  const plan = await workflow.createAnimationPlan(context);
  assert.equal(plan.productionStrategy.targetAspectRatio, "16:9");
  assert.match(plan.visualBible.cameraLanguage, /横屏 16:9/u);
});

test("direct_shot 明确拒绝未支持的动画目标画幅", async () => {
  const workflow = new WorkflowService();
  const context = directContext(workflow);
  await assert.rejects(
    () => workflow.createAnimationPlan({ ...context, targetAspectRatio: "1:1" }),
    /targetAspectRatio 只允许 9:16 或 16:9/u
  );
});

test("direct foundation 只发送基础事实投影且 fixedCharacterBoundary 不重复", () => {
  const context = directContext();
  context.variant.foundationPromptLeakSentinel = "VARIANT_PROMPT_LEAK_SENTINEL";
  context.creativeBrief.foundationPromptLeakSentinel = "BRIEF_PROMPT_LEAK_SENTINEL";
  context.fullStory.beatSheet = [{ beat: "BEAT_SHEET_PROMPT_LEAK_SENTINEL" }];
  context.fullStory.shootingPlan = [{ setup: "SHOOTING_PLAN_PROMPT_LEAK_SENTINEL" }];

  const firstScene = context.fullStory.sceneScript[0];
  firstScene.timeRange = "TIME_RANGE_FOUNDATION_SENTINEL";
  firstScene.location = "LOCATION_FOUNDATION_SENTINEL";
  firstScene.characters = [...firstScene.characters, "SCENE_CHARACTER_FOUNDATION_SENTINEL"];
  firstScene.visibleAction = "VISIBLE_ACTION_FOUNDATION_SENTINEL";
  firstScene.emotionNode = "EMOTION_NODE_FOUNDATION_SENTINEL";
  firstScene.dramaticFunction = "DRAMATIC_FUNCTION_FOUNDATION_SENTINEL";
  firstScene.dialogue = [{ speaker: "DIALOGUE_PROMPT_LEAK_SENTINEL", line: "不应进入 Foundation" }];
  firstScene.shotAndSound = "SHOT_AND_SOUND_PROMPT_LEAK_SENTINEL";
  firstScene.shootingNotes = "SHOOTING_NOTES_PROMPT_LEAK_SENTINEL";
  context.fullStory.characterBible.protagonist.traits.push("CHARACTER_BIBLE_FOUNDATION_SENTINEL");
  context.fullStory.keyProps[0].visualUse = "KEY_PROP_FOUNDATION_SENTINEL";

  const prompt = animationFoundationPrompt(context);
  const boundarySignature = context.visualGuardrails.fixedCharacterBoundary.boundarySignature;

  assert.doesNotMatch(prompt, /\n选中主题变体：/u);
  assert.doesNotMatch(prompt, /\ncreativeBrief：/u);
  for (const sentinel of [
    "VARIANT_PROMPT_LEAK_SENTINEL",
    "BRIEF_PROMPT_LEAK_SENTINEL",
    "BEAT_SHEET_PROMPT_LEAK_SENTINEL",
    "SHOOTING_PLAN_PROMPT_LEAK_SENTINEL",
    "DIALOGUE_PROMPT_LEAK_SENTINEL",
    "SHOT_AND_SOUND_PROMPT_LEAK_SENTINEL",
    "SHOOTING_NOTES_PROMPT_LEAK_SENTINEL"
  ]) {
    assert.doesNotMatch(prompt, new RegExp(sentinel, "u"), `${sentinel} 不得进入 Foundation prompt`);
  }

  for (const sentinel of [
    "TIME_RANGE_FOUNDATION_SENTINEL",
    "LOCATION_FOUNDATION_SENTINEL",
    "SCENE_CHARACTER_FOUNDATION_SENTINEL",
    "VISIBLE_ACTION_FOUNDATION_SENTINEL",
    "EMOTION_NODE_FOUNDATION_SENTINEL",
    "DRAMATIC_FUNCTION_FOUNDATION_SENTINEL",
    "CHARACTER_BIBLE_FOUNDATION_SENTINEL",
    "KEY_PROP_FOUNDATION_SENTINEL"
  ]) {
    assert.match(prompt, new RegExp(sentinel, "u"), `${sentinel} 必须保留在 Foundation 基础事实投影`);
  }

  assert.equal(
    prompt.split(boundarySignature).length - 1,
    1,
    "已签发 fixedCharacterBoundary 在 Foundation prompt 中只能出现一次"
  );
  assert.match(prompt, /visualGuardrails 附加规则（不重复 fixedCharacterBoundary）/u);
  assert.match(prompt, /"sourceSimilarityRules"/u);
});

test("direct batch 只按人物动作与地点拆镜，机位建议不得生成额外 shot", () => {
  const context = directContext();
  const plan = mockAnimationPlan(context);
  const { shotPlan: ignoredShotPlan, ...animationFoundation } = structuredClone(plan);
  animationFoundation.sceneReferencePrompts.forEach((scene, index) => {
    scene.sourceSceneIds = [context.fullStory.sceneScript[index].sceneId];
    scene.relatedShotIds = [];
  });

  const sourceScene = structuredClone(context.fullStory.sceneScript[0]);
  sourceScene.location = "社区维修间";
  sourceScene.visibleAction = "阿岚持续拧紧旧收音机上的一颗螺丝";
  sourceScene.shotAndSound = "中景记录动作；切到手部特写；再切回近景表情";
  sourceScene.shootingNotes = "可尝试俯拍或侧面机位";

  const prompt = animationShotBatchPrompt({
    ...context,
    animationFoundation,
    sourceScenes: [sourceScene],
    shotIdStartIndex: 1
  });

  assert.match(prompt, /拆镜边界只依据本批 source scene 的 location 与 visibleAction/u);
  assert.match(prompt, /景别、机位、构图、焦段、运镜或转场变化不得单独触发拆镜/u);
  assert.match(prompt, /不得逐个机位生成 shot/u);
  assert.match(prompt, /多人同步完成同一个协作动作仍可作为一个主要动作 shot/u);
  assert.match(prompt, /中景记录动作；切到手部特写；再切回近景表情/u);
  assert.doesNotMatch(prompt, /多地点、多机位切换或多个先后动作必须拆镜/u);

  const oneActionShot = directShot();
  oneActionShot.cameraMotion = "同一连续镜头从中景缓慢推近至手部近景";
  assert.doesNotThrow(() => ensureAnimationShotBatchContract(
    { shotPlan: [oneActionShot] },
    { promptSchemaVersion: ANIMATION_DIRECT_PROMPT_SCHEMA_VERSION }
  ));
});

test("v3 batch 只接受精确 direct 字段并拒绝端点字段或非空 image negatives", () => {
  const batch = { shotPlan: [directShot()] };
  assert.equal(
    ensureAnimationShotBatchContract(batch, {
      promptSchemaVersion: ANIMATION_DIRECT_PROMPT_SCHEMA_VERSION
    }),
    batch
  );
  assert.deepEqual(Object.keys(batch.shotPlan[0]).sort(), [...DIRECT_SHOT_FIELDS].sort());

  const missingDirectField = structuredClone(batch);
  delete missingDirectField.shotPlan[0].videoPrompt;
  assert.throws(
    () => ensureAnimationShotBatchContract(missingDirectField, {
      promptSchemaVersion: ANIMATION_DIRECT_PROMPT_SCHEMA_VERSION
    }),
    /缺少字段：videoPrompt/u
  );

  const forbiddenValues = {
    startFrame: {},
    endFrame: {},
    motion: {},
    startFramePrompt: "旧首帧别名",
    endFramePrompt: "旧尾帧别名"
  };
  for (const [field, value] of Object.entries(forbiddenValues)) {
    const mixed = structuredClone(batch);
    mixed.shotPlan[0][field] = value;
    assert.throws(
      () => ensureAnimationShotBatchContract(mixed, {
        promptSchemaVersion: ANIMATION_DIRECT_PROMPT_SCHEMA_VERSION
      }),
      (error) => error instanceof OutputContractError && error.message.includes(field),
      `direct shot 混入 ${field} 必须失败`
    );
  }

  const imageNegative = structuredClone(batch);
  imageNegative.shotPlan[0].negativePrompts.image.push({
    text: "不要改变阿岚身份",
    appliesTo: "image",
    triggerEvidence: [{
      sourcePath: "creatorProfile.fixedCharacter",
      evidence: "阿岚，社区修理师"
    }],
    reasonCode: "explicit_identity_conflict",
    priority: "high",
    enabled: true
  });
  assert.throws(
    () => ensureAnimationShotBatchContract(imageNegative, {
      promptSchemaVersion: ANIMATION_DIRECT_PROMPT_SCHEMA_VERSION
    }),
    /negativePrompts\.image 在 direct_shot 模式必须为 \[\]/u
  );
});

test("demo direct_shot 返回无端点的 3.0 plan 并标记 compiler disabled", async () => {
  const workflow = new WorkflowService();
  const result = await workflow.createAnimationPlanWithMetadata(directContext(workflow));

  assert.equal(result.animationPlan.promptSchemaVersion, ANIMATION_DIRECT_PROMPT_SCHEMA_VERSION);
  assert.equal(result.animationPlan.productionStrategy.format, "direct_shot_video");
  assert.ok(result.animationPlan.shotPlan.length > 0);
  for (const shot of result.animationPlan.shotPlan) {
    assert.deepEqual(Object.keys(shot).sort(), [...DIRECT_SHOT_FIELDS].sort());
    for (const field of DISABLED_ENDPOINT_FIELDS) {
      assert.equal(Object.hasOwn(shot, field), false, `${shot.shotId} 不得包含 ${field}`);
    }
  }

  assert.equal(result.metadata.characterFeatureCompiler.disabled, true);
  assert.equal(result.metadata.staticFrameCompiler.disabled, true);
  assert.deepEqual(result.metadata.staticFrameCompiler.runs, []);
  assert.equal(result.metadata.localPromptCompiler.disabled, true);
});

test("v3 视频请求不得静默进入 first_last_frame", async () => {
  await assert.rejects(
    () => generateShotVideo({
      animationPromptSchemaVersion: ANIMATION_DIRECT_PROMPT_SCHEMA_VERSION,
      generationMode: "first_last_frame",
      shot: directShot()
    }),
    (error) => error instanceof ShotVideoConfigError
      && /direct_shot.*不能使用 first_last_frame/u.test(error.message)
  );
});

test("逐镜视频请求只接受计划支持的两个画幅", () => {
  assert.equal(normalizeShotVideoAspectRatio("9:16"), "9:16");
  assert.equal(normalizeShotVideoAspectRatio("16:9"), "16:9");
  assert.throws(() => normalizeShotVideoAspectRatio("1:1"), /aspectRatio 只允许 9:16 或 16:9/u);
});

test("direct_shot 六个镜头职责字段都可作为逐镜视频负面词证据", () => {
  const evidenceFields = [
    "videoPrompt",
    "cameraMotion",
    "characterAction",
    "dialogueOrSubtitle",
    "soundDesign",
    "continuityNotes"
  ];
  for (const field of evidenceFields) {
    const shot = directShot();
    shot[field] = `${field}-DIRECT-EVIDENCE`;
    shot.negativePrompts.video = [{
      text: `${field} 对应过程不得跳变`,
      appliesTo: "video",
      triggerEvidence: [{
        sourcePath: `animationPlan.shotPlan[A01].${field}`,
        evidence: shot[field]
      }],
      reasonCode: "temporal_consistency_failure",
      priority: "medium",
      enabled: true
    }];
    const pruned = pruneAnimationPlanNegativePrompts({
      visualBible: {},
      sceneReferencePrompts: [],
      shotPlan: [shot]
    });
    assert.equal(pruned.shotPlan[0].negativePrompts.video.length, 1, `${field} 证据不得被裁剪`);
  }
});
