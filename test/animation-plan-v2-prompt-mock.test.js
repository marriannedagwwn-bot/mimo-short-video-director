import test from "node:test";
import assert from "node:assert/strict";
import { mockAnimationPlan } from "../src/mock.js";
import {
  animationActionStateAuditPrompt,
  animationFoundationPrompt,
  animationPlanPrompt,
  animationShotBatchPatchPrompt,
  animationShotBatchPrompt
} from "../src/prompts.js";

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
  assert.match(prompt, /pose 只描述单张画面中可见的身体姿态/u);
  assert.match(prompt, /handPropState 只描述左右手与道具在当前画面的静态关系/u);
  assert.match(prompt, /midground 不是收纳主要角色动作的备用字段/u);
  assert.match(prompt, /environment 不得承载当前可见角色的身份、姿态、表情、手部动作或持有关系/u);
  assert.match(prompt, /没有真实环境变化.*startFrame\.environment 的五个字符串逐字复制到 endFrame\.environment/u);
  assert.match(prompt, /地点名中的归属称呼不代表该角色出镜/u);
  assert.match(prompt, /actionState 字段必须保留，但允许写空字符串/u);
  assert.match(prompt, /除 characters\[\]\.actionState 明确允许为 "" 外，startFrame\/endFrame 的所有字符串字段都必须填入非空/u);
  assert.match(prompt, /角色没有手持道具时，handPropState 也必须明确写出.*未持有、未接触或道具不在画面内，绝不能留空/u);
  assert.match(prompt, /不要求包含位置、距离、接触等固定表达/u);
  assert.match(prompt, /StartState\.pose=.*半蹲在木盒旁/u);
  assert.match(prompt, /非道具移动“走向门口”/u);
  assert.match(prompt, /输出前必须逐镜执行 camera 一致性自检/u);
  assert.match(prompt, /cameraMove\.mode="locked"，令 endFrame\.camera 等于 startFrame\.camera 的逐字深拷贝/u);
  assert.match(prompt, /若 cameraMove\.mode="continuous"，endFrame\.camera 至少一个字段必须与 startFrame\.camera 不同/u);
  assert.match(prompt, /loop 是唯一例外.*endFrame 必须完整回到 startFrame/u);
  assert.match(prompt, /必须先确定当前镜头的主角色并放在 startFrame\.characters\[0\]/u);
  assert.match(prompt, /emotionArc\.from 必须是 startFrame\.characters\[0\]\.emotionState 的原样字符串，emotionArc\.to 必须是 endFrame 中该同名角色 emotionState 的原样字符串/u);
  assert.match(prompt, /不要为了满足该规则把全剧 protagonist 强行加入配角单人反应镜头/u);
  assert.match(prompt, /输出前必须逐镜执行 emotionArc 一致性自检/u);
  assert.match(prompt, /不得复制示例中的角色、道具、地点或动作/u);
  assert.match(prompt, /旧提示词和动作\/声音字段由服务端/u);
  for (const field of legacyShotFields) assert.doesNotMatch(prompt, new RegExp(`"${field}"\\s*:`));
});

test("actionState 语义审核 prompt 只提交最小单句输入", () => {
  const prompt = animationActionStateAuditPrompt([{
    id: "AS-0001",
    actionState: "角色脸上露出惊讶表情",
    frameKind: "startFrame",
    pose: "不应进入审核的姿态值",
    handPropState: "不应进入审核的道具值",
    gaze: "不应进入审核的视线值",
    expression: "不应进入审核的表情字段值"
  }]);

  assert.match(prompt, /只判断每条 actionState 单句本身/u);
  assert.match(prompt, /不判断整个角色状态是否完整/u);
  assert.match(prompt, /不必包含位置、距离、接触等固定词语/u);
  assert.match(prompt, /"id":"AS-0001","actionState":"角色脸上露出惊讶表情","frameKind":"startFrame"/u);
  assert.doesNotMatch(prompt, /不应进入审核/u);
  assert.match(prompt, /小鸟停在女孩掌心，翅膀轻微展开/u);
  assert.match(prompt, /发现盒子里的小鸟，决定帮助它/u);
  assert.match(prompt, /不得复制示例中的角色、道具、地点或动作/u);
  assert.match(prompt, /不得根据固定关键词或固定句式机械判定/u);
  assert.doesNotMatch(prompt, /animationShotBatch\.shotPlan/u);
  assert.match(prompt, /"id":"AS-0001","verdict":"pass","reasonCode":"visible_state"/u);
  assert.doesNotMatch(prompt, /"reason":/u);
});

test("单字段 patch prompt 强制 pose 消除失败原因且 handPropState 不得留空", () => {
  const failedBatch = {
    shotPlan: [{
      startFrame: {
        characters: [{
          pose: "准备打开盒子",
          handPropState: ""
        }]
      }
    }]
  };
  const posePrompt = animationShotBatchPatchPrompt({
    failedBatch,
    path: "animationShotBatch.shotPlan[0].startFrame.characters[0].pose",
    reason: "命中单张画面无法直接观察的意图措辞：准备"
  });

  assert.match(posePrompt, /必须先消除“校验失败原因”指出的问题/u);
  assert.match(posePrompt, /不得保留或换序复述触发失败的意图、过程、运镜、对白或音效措辞/u);
  assert.match(posePrompt, /路径以 \.pose 结尾时，只写此刻可见的身体朝向、支撑、重心、关节弯曲和肢体停留位置/u);
  assert.match(posePrompt, /不写角色试图、准备、想要或将要完成什么/u);

  const handPropPrompt = animationShotBatchPatchPrompt({
    failedBatch,
    path: "animationShotBatch.shotPlan[0].startFrame.characters[0].handPropState",
    reason: "静态端点字段不能为空"
  });
  assert.match(handPropPrompt, /路径以 \.handPropState 结尾时，只写此刻手部\/前肢\/身体与道具的接触、距离和道具状态/u);
  assert.match(handPropPrompt, /即使未持有道具也必须写出可见的未持有或未接触关系，不得留空/u);

  const cameraPrompt = animationShotBatchPatchPrompt({
    failedBatch,
    path: "animationShotBatch.shotPlan[0].endFrame.camera",
    reason: "连续运镜没有留下可见 camera 终点"
  });
  assert.match(cameraPrompt, /完整 EndState\.camera 对象/u);
  assert.match(cameraPrompt, /"value":\{"shotSize":"","height":"","angle":"","viewDirection":"","lensFeel":"","depthOfField":"","composition":""\}/u);
  assert.match(cameraPrompt, /至少一个字段必须与 StartState\.camera 逐字不同/u);
  assert.match(cameraPrompt, /不得把“推、拉、移动、跟拍、环绕、升降”等运动过程原样塞入静态 camera/u);
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
