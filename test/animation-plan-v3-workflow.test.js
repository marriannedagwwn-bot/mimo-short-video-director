import test from "node:test";
import assert from "node:assert/strict";
import { mockAnimationPlan, mockBrief, mockFullStory } from "../src/mock.js";
import { WorkflowService } from "../src/workflow.js";
import { withGlobalCharacterBoundary } from "./helpers/global-character-boundary.js";

const ENDPOINT_FIELDS = [
  "startFrame",
  "endFrame",
  "motion",
  "startFramePrompt",
  "endFramePrompt"
];

const TUTORIAL_STYLE_VIDEO_PROMPT = "温暖治愈的2.5D手绘动画质感，出发点被清晨柔和侧光照亮，背景空间层次清楚。社区修理师阿岚保持既定外观，确认一段旧录音，听到任务期限后立刻把它收好。镜头先以中景跟随阿岚靠近任务物，确认内容时硬切到任务物特写，最后切到阿岚收好录音后的反应近景。前段节奏轻快，确认期限时短促停顿；保留室内环境底噪、收纳动作声和阿岚的短句“我现在去”。内部摄影切换前后保持阿岚身份、服装、任务物造型和光线方向一致，收好任务物后立即停止。";

const DIRECT_SHOT_SENTINELS = {
  videoPrompt: TUTORIAL_STYLE_VIDEO_PROMPT,
  cameraMotion: "先以中景跟随阿岚靠近任务物，确认内容时硬切任务物特写，最后切到收好录音后的反应近景",
  characterAction: "阿岚确认一段旧录音，听到任务期限后立刻把它收好",
  dialogueOrSubtitle: "阿岚：我现在去。",
  soundDesign: "室内环境底噪、收纳动作声；确认期限时短促停顿",
  continuityNotes: "内部摄影切换前后保持阿岚身份、服装、任务物造型和光线方向一致"
};

const DIRECT_SHOT_ACCEPTANCE = [
  "阿岚按顺序完成确认旧录音并在期限出现后收好的动作链",
  "摄影顺序为中景跟随、任务物特写、阿岚反应近景",
  "三段摄影表达中的阿岚与任务物外观保持一致"
];

function createLiveWorkflow(generateAnimationJson) {
  const animationCalls = [];
  const staticProviderCalls = [];
  const animationClient = {
    async generateJson(args) {
      animationCalls.push(args);
      return generateAnimationJson(args, animationCalls.length);
    }
  };
  const staticProviderClient = {
    async generateJson(args) {
      staticProviderCalls.push(args);
      throw new Error("direct_shot 不得调用 Static Frame 或 Character Feature provider");
    }
  };
  const workflow = new WorkflowService({
    clients: {
      MiMo: animationClient,
      Qwen: staticProviderClient
    },
    animationProvider: "MiMo",
    animationModel: "animation-direct-shot-test",
    staticFrameCompilerProvider: "Qwen",
    staticFrameCompilerModel: "static-provider-spy",
    animationShotBatchSceneCount: 6
  });
  return { workflow, animationCalls, staticProviderCalls };
}

function fixture(workflow) {
  const creatorProfile = {
    fixedCharacter: "阿岚，社区修理师",
    vertical: "家电维修",
    constraints: "60 秒内"
  };
  const base = { creatorProfile };
  const creativeBrief = mockBrief({
    ...base,
    referenceAnalysis: {},
    sourceScriptReconstruction: {}
  });
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
  const fullStory = mockFullStory({ ...base, creativeBrief, variant });
  return withGlobalCharacterBoundary(workflow, {
    ...base,
    creativeBrief,
    variant,
    fullStory,
    animationPlanMode: "direct_shot"
  });
}

function foundationFrom(plan) {
  const copy = structuredClone(plan);
  const { shotPlan, ...foundation } = copy;
  foundation.sceneReferencePrompts.forEach((scene) => {
    scene.relatedShotIds = [];
    scene.sourceSceneIds = [...new Set(
      shotPlan
        .filter((shot) => shot.sceneId === scene.sceneId)
        .map((shot) => shot.sourceSceneId)
    )];
  });
  return foundation;
}

test("live direct_shot 保留模型视频字段且完全绕过三个编译阶段", async () => {
  let foundation;
  let batch;
  const { workflow, animationCalls, staticProviderCalls } = createLiveWorkflow((args, callNumber) => {
    if (callNumber === 1) return structuredClone(foundation);
    if (callNumber === 2) return structuredClone(batch);
    throw new Error(`direct_shot animation provider 出现意外的第 ${callNumber} 次调用`);
  });
  const context = fixture(workflow);
  const modelPlan = mockAnimationPlan(context);
  foundation = foundationFrom(modelPlan);
  batch = { shotPlan: structuredClone(modelPlan.shotPlan) };
  Object.assign(batch.shotPlan[0], DIRECT_SHOT_SENTINELS);
  batch.shotPlan[0].acceptanceCriteria = DIRECT_SHOT_ACCEPTANCE;

  const { animationPlan, metadata } = await workflow.createAnimationPlanWithMetadata(context);

  assert.equal(animationCalls.length, 2);
  assert.equal(staticProviderCalls.length, 0);
  assert.equal(animationPlan.promptSchemaVersion, "3.0");
  assert.equal(animationPlan.productionStrategy.format, "direct_shot_video");
  assert.deepEqual(
    Object.fromEntries(Object.keys(DIRECT_SHOT_SENTINELS).map((field) => [field, animationPlan.shotPlan[0][field]])),
    DIRECT_SHOT_SENTINELS
  );
  assert.equal(
    animationPlan.shotPlan.filter((shot) => shot.sourceSceneId === batch.shotPlan[0].sourceSceneId).length,
    1,
    "同一地点、同一主要动作目标下的内部硬切不得增加业务 shot"
  );
  assert.deepEqual(animationPlan.shotPlan[0].acceptanceCriteria, DIRECT_SHOT_ACCEPTANCE);
  animationPlan.shotPlan.forEach((shot) => {
    ENDPOINT_FIELDS.forEach((field) => assert.equal(Object.hasOwn(shot, field), false));
  });
  assert.equal(metadata.characterFeatureCompiler.disabled, true);
  assert.equal(metadata.staticFrameCompiler.disabled, true);
  assert.deepEqual(metadata.staticFrameCompiler.runs, []);
  assert.equal(metadata.localPromptCompiler.disabled, true);
});

test("direct_shot 拒绝 2.0 Animation Foundation", async () => {
  let v2Foundation;
  const { workflow, animationCalls, staticProviderCalls } = createLiveWorkflow(() => (
    structuredClone(v2Foundation)
  ));
  const context = fixture(workflow);
  v2Foundation = foundationFrom(mockAnimationPlan({ ...context, animationPlanMode: "" }));

  await assert.rejects(
    () => workflow.createAnimationPlanWithMetadata(context),
    /animationFoundation\.promptSchemaVersion 与 animationPlanMode 不匹配，必须为 3\.0/u
  );
  assert.equal(animationCalls.length, 2);
  assert.equal(staticProviderCalls.length, 0);
});

test("direct_shot 拒绝模型把用户选择的 16:9 改回 9:16", async () => {
  let foundation;
  const { workflow } = createLiveWorkflow(() => structuredClone(foundation));
  const context = { ...fixture(workflow), targetAspectRatio: "16:9" };
  foundation = foundationFrom(mockAnimationPlan({ ...context, targetAspectRatio: "9:16" }));

  await assert.rejects(
    () => workflow.createAnimationPlanWithMetadata(context),
    /targetAspectRatio 必须等于用户选择的 16:9/u
  );
});
