import test from "node:test";
import assert from "node:assert/strict";
import { mockAnimationPlan } from "../src/mock.js";
import { animationFoundationPrompt, animationPlanPrompt, animationShotBatchPrompt } from "../src/prompts.js";

const creatorProfile = {
  fixedCharacter: "小白子，Q版猫耳少女人形，猫耳和蓬松猫尾巴",
  vertical: "治愈日常短片",
  constraints: "主角只能使用“嗷”或“嗷呜”"
};

const variant = {
  id: "V1",
  title: "夕阳下的幻灯片",
  characterSetup: { protagonist: "小白子", careRecipient: "外婆", helper: "木匠" }
};

const fullStory = {
  selectedVariantId: "V1",
  title: "夕阳下的幻灯片",
  targetDurationSeconds: 15,
  characterBible: {
    protagonist: { name: "小白子", identity: creatorProfile.fixedCharacter },
    careRecipient: { nameOrLabel: "外婆", identity: "家人" }
  },
  keyProps: [{ prop: "透明玻璃幻灯片", storyFunction: "承载旧照片", visualUse: "对着夕阳观察" }],
  sceneScript: [{
    sceneId: "S1",
    timeRange: "00:00-00:05",
    location: "木屋里",
    visibleAction: "小白子打开木箱。",
    emotionNode: "好奇",
    dramaticFunction: "建立发现"
  }, {
    sceneId: "S2",
    timeRange: "00:05-00:10",
    location: "木屋窗边",
    visibleAction: "小白子拿起透明玻璃幻灯片，对着夕阳观察。",
    emotionNode: "发现",
    dramaticFunction: "推进发现",
    dialogue: [{ speaker: "小白子", line: "嗷呜", deliveryOrSubtext: "轻声惊喜" }]
  }, {
    sceneId: "S3",
    timeRange: "00:10-00:15",
    location: "木屋窗边",
    visibleAction: "小白子看见幻灯片上的旧照片，安静地笑了一下。",
    emotionNode: "温暖",
    dramaticFunction: "兑现情绪"
  }]
};

const context = { creatorProfile, variant, fullStory, creativeBrief: {}, visualGuardrails: {} };

const frameFields = ["camera", "characters", "continuityLocks", "environment", "lighting", "styleModifiers", "timeAndWeather"].sort();
const characterFields = ["actionState", "bodyOrientation", "emotionState", "expression", "gaze", "handPropState", "name", "pose", "screenPosition"].sort();
const cameraFields = ["angle", "composition", "depthOfField", "height", "lensFeel", "shotSize", "viewDirection"].sort();
const motionFields = ["audio", "cameraMove", "emotionArc", "endStateRef", "environmentChange", "lightingChange", "mode", "postRetime", "preserve", "primaryAction", "stopCondition", "timingBeats"].sort();
const legacyShotFields = ["startFramePrompt", "endFramePrompt", "videoPrompt", "cameraMotion", "characterAction", "dialogueOrSubtitle", "soundDesign", "continuityNotes"];

test("foundation 与单体 animationPlan prompt 都声明 v2 结构", () => {
  const foundation = animationFoundationPrompt(context);
  const monolithic = animationPlanPrompt(context);

  assert.match(foundation, /"promptSchemaVersion":"2\.0"/u);
  assert.match(monolithic, /"promptSchemaVersion":"2\.0"/u);
  assert.match(monolithic, /"startFrame":\{/u);
  assert.match(monolithic, /"endFrame":\{/u);
  assert.match(monolithic, /"motion":\{/u);
  assert.match(monolithic, /"dialogue":\[\]/u);
  assert.match(monolithic, /motion\.mode 只允许 continuous_action、camera_move、object_transform、loop/u);
  assert.match(monolithic, /cameraMove\.mode 只允许 locked 或 continuous/u);
  assert.match(monolithic, /timingBeats 必须有 1–4 条/u);
  assert.match(monolithic, /相邻两条的前一条 toPercent 必须等于后一条 fromPercent/u);
  assert.match(monolithic, /时段天气、环境状态、光线和道具位置只能在剧情真实需要时连续变化/u);
  assert.match(monolithic, /cameraMove\.mode=continuous 时允许沿唯一路径逐渐重构图或缓慢改变景别/u);
  for (const field of legacyShotFields) assert.doesNotMatch(monolithic, new RegExp(`"${field}"\\s*:`));
});

test("生产批次 prompt 只要求结构化 shot，旧字段由服务端编译", () => {
  const plan = mockAnimationPlan(context);
  const { shotPlan, ...animationFoundation } = structuredClone(plan);
  animationFoundation.sceneReferencePrompts.forEach((scene, index) => {
    scene.sourceSceneIds = [fullStory.sceneScript[index].sceneId];
    scene.relatedShotIds = [];
  });
  const prompt = animationShotBatchPrompt({
    ...context,
    animationFoundation,
    sourceScenes: fullStory.sceneScript.slice(0, 2),
    shotIdStartIndex: 1
  });

  assert.match(prompt, /顶层仍只能输出 shotPlan/u);
  assert.match(prompt, /"startFrame":\{/u);
  assert.match(prompt, /"endFrame":\{/u);
  assert.match(prompt, /"motion":\{/u);
  assert.match(prompt, /cameraMove\.mode=locked/u);
  assert.match(prompt, /cameraMove\.mode=continuous/u);
  assert.match(prompt, /达到 endFrame 状态后立即停止/u);
  assert.match(prompt, /旧提示词和动作\/声音字段由服务端/u);
  for (const field of legacyShotFields) assert.doesNotMatch(prompt, new RegExp(`"${field}"\\s*:`));
});

test("mock animationPlan 输出完整 v2 shot 与无缝 timing beats", () => {
  const plan = mockAnimationPlan(context);

  assert.equal(plan.promptSchemaVersion, "2.0");
  assert.equal(plan.shotPlan.length, 3);
  assert.ok(plan.shotPlan.some((shot) => shot.motion.cameraMove.mode === "locked"));
  assert.ok(plan.shotPlan.some((shot) => shot.motion.cameraMove.mode === "continuous"));

  for (const shot of plan.shotPlan) {
    assert.deepEqual(Object.keys(shot.startFrame).sort(), frameFields);
    assert.deepEqual(Object.keys(shot.endFrame).sort(), frameFields);
    assert.deepEqual(Object.keys(shot.startFrame.characters[0]).sort(), characterFields);
    assert.deepEqual(Object.keys(shot.endFrame.characters[0]).sort(), characterFields);
    assert.deepEqual(Object.keys(shot.startFrame.camera).sort(), cameraFields);
    assert.deepEqual(Object.keys(shot.endFrame.camera).sort(), cameraFields);
    assert.deepEqual(Object.keys(shot.motion).sort(), motionFields);
    assert.equal(shot.startFrame.environment.sceneId, shot.sceneId);
    assert.equal(shot.endFrame.environment.sceneId, shot.sceneId);
    assert.equal(shot.motion.emotionArc.from, shot.startFrame.characters[0].emotionState);
    assert.equal(shot.motion.emotionArc.to, shot.endFrame.characters[0].emotionState);
    assert.equal(shot.motion.endStateRef, "endFrame");
    assert.ok(["continuous_action", "camera_move", "object_transform", "loop"].includes(shot.motion.mode));
    assert.ok(["locked", "continuous"].includes(shot.motion.cameraMove.mode));
    assert.ok(["slow", "medium", "fast"].includes(shot.motion.cameraMove.speed));
    assert.equal(typeof shot.motion.postRetime.recommended, "boolean");
    assert.ok(shot.motion.timingBeats.length >= 1 && shot.motion.timingBeats.length <= 4);
    assert.equal(shot.motion.timingBeats[0].fromPercent, 0);
    assert.equal(shot.motion.timingBeats.at(-1).toPercent, 100);
    shot.motion.timingBeats.forEach((beat, index) => {
      assert.ok(beat.fromPercent < beat.toPercent);
      if (index) assert.equal(shot.motion.timingBeats[index - 1].toPercent, beat.fromPercent);
    });
    if (shot.motion.cameraMove.mode === "locked") {
      assert.deepEqual(shot.endFrame.camera, shot.startFrame.camera);
      assert.match(shot.motion.cameraMove.path, /固定机位|保持首帧构图/u);
    }
    for (const field of legacyShotFields) assert.equal(Object.hasOwn(shot, field), false);
  }

  assert.deepEqual(plan.shotPlan[0].motion.audio.dialogue, []);
  assert.deepEqual(plan.shotPlan[1].motion.audio.dialogue, [{ speaker: "小白子", text: "嗷呜", delivery: "轻声惊喜" }]);
});
