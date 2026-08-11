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

const DIRECT_SHOT_SENTINELS = {
  videoPrompt: "VIDEO_PROMPT_SENTINEL：阿岚完成当前剧情动作。",
  cameraMotion: "CAMERA_MOTION_SENTINEL：固定机位。",
  characterAction: "CHARACTER_ACTION_SENTINEL：阿岚完成动作。",
  dialogueOrSubtitle: "DIALOGUE_OR_SUBTITLE_SENTINEL",
  soundDesign: "SOUND_DESIGN_SENTINEL",
  continuityNotes: "CONTINUITY_NOTES_SENTINEL：阿岚身份保持一致。"
};

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

  const { animationPlan, metadata } = await workflow.createAnimationPlanWithMetadata(context);

  assert.equal(animationCalls.length, 2);
  assert.equal(staticProviderCalls.length, 0);
  assert.equal(animationPlan.promptSchemaVersion, "3.0");
  assert.equal(animationPlan.productionStrategy.format, "direct_shot_video");
  assert.deepEqual(
    Object.fromEntries(Object.keys(DIRECT_SHOT_SENTINELS).map((field) => [field, animationPlan.shotPlan[0][field]])),
    DIRECT_SHOT_SENTINELS
  );
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
