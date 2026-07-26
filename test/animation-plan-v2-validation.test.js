import test from "node:test";
import assert from "node:assert/strict";
import {
  ensureAnimationPlanMatchesProfile,
  ensureAnimationPlanNegativePrompts,
  ensureAnimationPlanV2Contract,
  ensureFrameReferenceModeCompatibility,
  ensureAnimationShotBatchContract,
  ensureAnimationShotPromptAliases,
  ensureAnimationShotV2Contract
} from "../src/validation.js";

function frame({ end = false } = {}) {
  return {
    timeAndWeather: "秋日下午，夕阳稳定",
    characters: [{
      name: "小白子",
      screenPosition: "画面左侧三分之一",
      bodyOrientation: "身体朝向画面右侧",
      pose: end ? "双脚站稳，右手抬至眼前" : "双脚站稳，右手靠近木箱",
      actionState: "",
      handPropState: end ? "右手夹持透明玻璃幻灯片" : "双手打开木箱，玻璃幻灯片仍在箱内",
      gaze: end ? "视线穿过玻璃幻灯片看向夕阳" : "视线落在木箱内部",
      emotionState: end ? "安心" : "期待",
      expression: end ? "轻轻微笑" : "专注好奇"
    }],
    environment: {
      sceneId: "LOC01",
      foreground: "打开的旧木箱",
      midground: "小白子站在木桌旁",
      background: "同一扇朝西窗户与夕阳",
      atmosphere: "安静温暖"
    },
    camera: {
      shotSize: "中近景",
      height: "角色胸口高度",
      angle: "平视",
      viewDirection: "朝向西侧窗户",
      lensFeel: "50mm 自然透视",
      depthOfField: "主体与玻璃片清晰，背景轻微虚化",
      composition: "角色位于左侧，窗户位于右侧"
    },
    lighting: {
      source: "窗外夕阳",
      direction: "右后方逆光",
      colorAndContrast: "暖金色低反差"
    },
    styleModifiers: ["Q版治愈动画"],
    continuityLocks: ["保持小白子、木箱和窗户身份一致"]
  };
}

function motion() {
  return {
    mode: "continuous_action",
    primaryAction: "小白子从木箱中拿起玻璃幻灯片并举向夕阳",
    cameraMove: {
      mode: "locked",
      technique: "固定机位",
      path: "相机位置与朝向不移动",
      speed: "slow",
      motivation: "让手部与玻璃片动作保持清楚"
    },
    emotionArc: {
      from: "期待",
      visibleProgression: "专注逐渐转为安心",
      to: "安心"
    },
    environmentChange: "同一室内场景保持稳定",
    lightingChange: "夕阳在玻璃片边缘形成轻微高光",
    timingBeats: [
      {
        fromPercent: 0,
        toPercent: 45,
        action: "右手靠近并夹住玻璃幻灯片",
        camera: "固定中近景",
        emotion: "保持期待与专注",
        environment: "木箱、木桌和窗户保持原位",
        soundCue: "木箱轻响"
      },
      {
        fromPercent: 45,
        toPercent: 100,
        action: "右手把玻璃幻灯片举向夕阳并稳定停住",
        camera: "固定中近景",
        emotion: "表情逐渐安心",
        environment: "玻璃片边缘出现夕阳高光",
        soundCue: ""
      }
    ],
    audio: {
      dialogue: [],
      ambience: "室内微弱风声",
      soundEffects: ["木箱轻响"],
      musicCue: ""
    },
    preserve: ["角色身份", "同一木箱", "同一窗户", "同一镜头核心"],
    endStateRef: "endFrame",
    stopCondition: "右手与玻璃幻灯片稳定到达 endFrame 状态后停止",
    postRetime: {
      recommended: false,
      speedCurve: "",
      reason: ""
    }
  };
}

function v2Shot() {
  return {
    shotId: "A01",
    sourceSceneId: "S1",
    sceneId: "LOC01",
    durationSeconds: 4,
    storyPurpose: "发现承载回忆的玻璃幻灯片",
    emotionalTarget: "从期待转为安心",
    startFrame: frame(),
    endFrame: frame({ end: true }),
    motion: motion(),
    negativePrompts: { image: [], video: [] },
    acceptanceCriteria: ["动作连续且玻璃幻灯片保持透明"]
  };
}

function legacyShot() {
  return {
    shotId: "A01",
    sourceSceneId: "S1",
    sceneId: "LOC01",
    durationSeconds: 4,
    storyPurpose: "建立动作",
    emotionalTarget: "期待",
    startFramePrompt: "小白子站在木箱旁。",
    endFramePrompt: "小白子拿起玻璃幻灯片。",
    videoPrompt: "小白子连续拿起玻璃幻灯片。",
    cameraMotion: "固定镜头",
    characterAction: "拿起玻璃幻灯片",
    dialogueOrSubtitle: "",
    soundDesign: "木箱轻响",
    continuityNotes: "保持同一地点",
    negativePrompts: { image: [], video: [] },
    acceptanceCriteria: []
  };
}

function validateShot(shot) {
  return ensureAnimationShotV2Contract(shot, "animationPlan.shotPlan[0]");
}

test("legacy animation shot batch remains valid while v2 public plans declare schema version", () => {
  const legacy = { shotPlan: [legacyShot()] };
  assert.equal(ensureAnimationShotBatchContract(legacy), legacy);
  assert.equal(ensureAnimationPlanV2Contract(legacy), legacy);

  const batch = { shotPlan: [v2Shot()] };
  assert.equal(ensureAnimationShotBatchContract(batch), batch);
  const publicPlan = { promptSchemaVersion: "2.0", shotPlan: [v2Shot()] };
  assert.equal(ensureAnimationPlanV2Contract(publicPlan), publicPlan);
  assert.throws(
    () => ensureAnimationPlanV2Contract({ shotPlan: [v2Shot()] }),
    /promptSchemaVersion 缺失/
  );
  assert.throws(
    () => ensureAnimationPlanV2Contract({ promptSchemaVersion: "2", shotPlan: [v2Shot()] }),
    /必须严格等于 "2.0"/
  );
});

test("v2 frame schema requires exact scene ids and complete character objects", () => {
  const wrongScene = v2Shot();
  wrongScene.endFrame.environment.sceneId = "LOC02";
  assert.throws(() => validateShot(wrongScene), /environment.sceneId 必须与镜头 sceneId/);

  const missingCharacterField = v2Shot();
  delete missingCharacterField.startFrame.characters[0].handPropState;
  assert.throws(() => validateShot(missingCharacterField), /characters\[0\] 缺少字段：handPropState/);

  const unknownFrameField = v2Shot();
  unknownFrameField.startFrame.camera.zoom = "2x";
  assert.throws(() => validateShot(unknownFrameField), /camera 包含未知字段：zoom/);

  const objectOnly = v2Shot();
  objectOnly.startFrame.characters = [];
  objectOnly.endFrame.characters = [];
  objectOnly.motion.mode = "object_transform";
  objectOnly.motion.emotionArc = { from: "无人物情绪", visibleProgression: "氛围保持安静", to: "无人物情绪" };
  assert.equal(validateShot(objectOnly), objectOnly);
});

test("v2 frame fields remain static and keep process, camera motion and audio in motion", () => {
  const process = v2Shot();
  process.startFrame.characters[0].pose = "随后拿起玻璃幻灯片";
  assert.throws(() => validateShot(process), /静态帧字段.*过程、运镜、对白或音效措辞：随后/);

  const actionStateProcess = v2Shot();
  actionStateProcess.startFrame.characters[0].actionState = "随后拿起玻璃幻灯片";
  assert.throws(() => validateShot(actionStateProcess), /actionState.*过程、运镜、对白或音效措辞：随后/);

  const actionStateProgressive = v2Shot();
  actionStateProgressive.startFrame.characters[0].actionState = "正在按下按钮";
  assert.throws(() => validateShot(actionStateProgressive), /actionState.*过程、运镜、对白或音效措辞：正在/);

  const actionStateIntent = v2Shot();
  actionStateIntent.startFrame.characters[0].actionState = "准备按按钮";
  assert.throws(() => validateShot(actionStateIntent), /actionState.*无法直接画出的意图措辞：准备/);

  const audio = v2Shot();
  audio.endFrame.environment.atmosphere = "室内响起木箱音效";
  assert.throws(() => validateShot(audio), /静态帧字段.*音效/);

  const frozenContact = v2Shot();
  frozenContact.startFrame.characters[0].actionState = "右手刚触到木箱搭扣";
  assert.equal(validateShot(frozenContact), frozenContact);

  for (const intent of ["准备", "即将", "将要", "想要", "试图"]) {
    const invisibleIntent = v2Shot();
    invisibleIntent.startFrame.characters[0].pose = `角色${intent}拿起玻璃幻灯片`;
    assert.throws(() => validateShot(invisibleIntent), new RegExp(`静态帧字段.*无法直接画出的意图措辞：${intent}`));
  }
});

test("v2 actionState keeps its key and string type but may be empty", () => {
  const empty = v2Shot();
  empty.startFrame.characters[0].actionState = "";
  assert.equal(validateShot(empty), empty);

  const whitespace = v2Shot();
  whitespace.endFrame.characters[0].actionState = "   ";
  assert.equal(validateShot(whitespace), whitespace);

  const wrongType = v2Shot();
  wrongType.startFrame.characters[0].actionState = null;
  assert.throws(() => validateShot(wrongType), /actionState 必须是字符串/);

  const emptyPose = v2Shot();
  emptyPose.startFrame.characters[0].pose = "";
  assert.throws(() => validateShot(emptyPose), /pose 不能为空/);

  const emptyHandPropState = v2Shot();
  emptyHandPropState.startFrame.characters[0].handPropState = "";
  assert.throws(() => validateShot(emptyHandPropState), /handPropState 不能为空/);
});

test("v2 separates visible prop and walking poses from temporal motion", () => {
  const invisiblePropIntent = v2Shot();
  invisiblePropIntent.startFrame.characters[0].pose = "准备打开盒子";
  assert.throws(() => validateShot(invisiblePropIntent), /pose.*意图措辞：准备/);

  const visiblePropPose = v2Shot();
  visiblePropPose.startFrame.characters[0].pose = "半蹲在木盒旁，右手停在盒盖边缘";
  assert.equal(validateShot(visiblePropPose), visiblePropPose);

  const invisibleWalkingIntent = v2Shot();
  invisibleWalkingIntent.startFrame.characters[0].pose = "准备走向门口";
  assert.throws(() => validateShot(invisibleWalkingIntent), /pose.*意图措辞：准备/);

  const visibleWalkingPose = v2Shot();
  visibleWalkingPose.startFrame.characters[0].pose = "站在门前，身体朝向门口，左脚略微前伸";
  assert.equal(validateShot(visibleWalkingPose), visibleWalkingPose);

  const visibleMotion = v2Shot();
  visibleMotion.motion.primaryAction = "打开盒盖";
  assert.equal(validateShot(visibleMotion), visibleMotion);
});

test("frame reference modes enforce start-image stages and same-scene endpoint compatibility", () => {
  const inheritShot = v2Shot();
  assert.equal(ensureFrameReferenceModeCompatibility(inheritShot, "inherit"), "inherit");
  assert.throws(
    () => ensureFrameReferenceModeCompatibility(inheritShot, "inherit", { hasStartFrame: false }),
    (error) => error.details?.[0]?.code === "FRAME_START_IMAGE_REQUIRED"
  );
  assert.equal(
    ensureFrameReferenceModeCompatibility(inheritShot, "independent", { hasStartFrame: false }),
    "independent"
  );

  const transitionShot = v2Shot();
  transitionShot.endFrame.camera.composition = "角色位于画面中心，窗户留在右侧";
  transitionShot.motion.cameraMove.mode = "continuous";
  transitionShot.motion.cameraMove.technique = "缓慢侧移";
  transitionShot.motion.cameraMove.path = "沿同一空间轴线向右侧移动";
  assert.equal(ensureFrameReferenceModeCompatibility(transitionShot, "transition"), "transition");
  assert.throws(
    () => ensureFrameReferenceModeCompatibility(transitionShot, "inherit"),
    (error) => error.details?.[0]?.code === "FRAME_INHERIT_INCOMPATIBLE"
  );

  const crossScene = v2Shot();
  crossScene.endFrame.environment.sceneId = "LOC02";
  assert.throws(
    () => ensureFrameReferenceModeCompatibility(crossScene, "transition"),
    (error) => error.details?.[0]?.code === "FRAME_CROSS_SCENE_NOT_ALLOWED"
  );

  const undeclaredLighting = v2Shot();
  undeclaredLighting.endFrame.lighting.colorAndContrast = "冷蓝色高反差";
  undeclaredLighting.motion.lightingChange = "无，保持首帧光线";
  assert.throws(
    () => ensureFrameReferenceModeCompatibility(undeclaredLighting, "transition"),
    (error) => error.details?.[0]?.code === "FRAME_TRANSITION_LIGHTING_CHANGE_UNDECLARED"
  );
});

test("v2 motion validates enums and 1-4 contiguous timing beats covering 0..100", () => {
  const badMode = v2Shot();
  badMode.motion.mode = "cut_sequence";
  assert.throws(() => validateShot(badMode), /mode 只允许 continuous_action/);

  const badSpeed = v2Shot();
  badSpeed.motion.cameraMove.speed = "very_fast";
  assert.throws(() => validateShot(badSpeed), /speed 只允许 slow、medium 或 fast/);

  const gap = v2Shot();
  gap.motion.timingBeats[1].fromPercent = 50;
  assert.throws(() => validateShot(gap), /必须与上一节拍无缝相接于 45/);

  const incomplete = v2Shot();
  incomplete.motion.timingBeats[1].toPercent = 99;
  assert.throws(() => validateShot(incomplete), /连续覆盖 0\.\.100/);

  const tooMany = v2Shot();
  tooMany.motion.timingBeats = Array.from({ length: 5 }, (_, index) => ({
    ...tooMany.motion.timingBeats[0],
    fromPercent: index * 20,
    toPercent: (index + 1) * 20
  }));
  assert.throws(() => validateShot(tooMany), /1–4 个连续节拍/);
});

test("emotion endpoints, locked camera core and continuous camera intent remain explicit", () => {
  const wrongEmotion = v2Shot();
  wrongEmotion.motion.emotionArc.to = "激动";
  assert.throws(() => validateShot(wrongEmotion), /emotionArc.to 必须等于 endFrame/);

  const movedLockedCamera = v2Shot();
  movedLockedCamera.endFrame.camera.composition = "角色居中";
  assert.throws(() => validateShot(movedLockedCamera), /mode=locked.*camera 核心必须完全相等/);

  const continuousWithoutPath = v2Shot();
  continuousWithoutPath.motion.cameraMove.mode = "continuous";
  continuousWithoutPath.motion.cameraMove.path = "";
  assert.throws(() => validateShot(continuousWithoutPath), /cameraMove.path 不能为空/);

  const continuousWithoutEndpoint = v2Shot();
  continuousWithoutEndpoint.motion.cameraMove.mode = "continuous";
  continuousWithoutEndpoint.motion.cameraMove.technique = "平稳横移跟拍";
  continuousWithoutEndpoint.motion.cameraMove.path = "从左向右平行移动";
  assert.throws(
    () => validateShot(continuousWithoutEndpoint),
    (error) => {
      assert.match(error.message, /EndState\.camera 必须留下.*可见差异/u);
      assert.deepEqual(error.details, [{
        code: "CONTINUOUS_CAMERA_ENDPOINT_MISSING",
        path: "animationPlan.shotPlan[0].endFrame.camera",
        reason: "连续运镜已声明，但 EndState.camera 的景别、机位、角度、观察方向、镜头质感、景深和构图与 StartState.camera 完全相同；请只重建可见的终点 camera 状态"
      }]);
      return true;
    }
  );

  const continuousWithEndpoint = structuredClone(continuousWithoutEndpoint);
  continuousWithEndpoint.endFrame.camera.composition = "角色位于右侧三分线，左侧保留行进空间";
  assert.equal(validateShot(continuousWithEndpoint), continuousWithEndpoint);

  const wrongEndRef = v2Shot();
  wrongEndRef.motion.endStateRef = "lastFrame";
  assert.throws(() => validateShot(wrongEndRef), /endStateRef 必须严格等于 "endFrame"/);
});

test("loop shots declare a return stop condition and compatible endpoint state", () => {
  const loop = v2Shot();
  loop.motion.mode = "loop";
  loop.endFrame = structuredClone(loop.startFrame);
  loop.motion.emotionArc.to = loop.endFrame.characters[0].emotionState;
  loop.motion.emotionArc.visibleProgression = "期待短暂变化后回归期待";
  loop.motion.stopCondition = "角色、道具与镜头回到首帧起始状态后停止";
  assert.equal(validateShot(loop), loop);

  const movingLoop = structuredClone(loop);
  movingLoop.motion.cameraMove.mode = "continuous";
  movingLoop.motion.cameraMove.technique = "环绕一周";
  movingLoop.motion.cameraMove.path = "围绕角色完成一周闭环并回到起始机位";
  assert.equal(validateShot(movingLoop), movingLoop);
  assert.equal(ensureFrameReferenceModeCompatibility(movingLoop, "inherit"), "inherit");

  const changedLoopLighting = structuredClone(movingLoop);
  changedLoopLighting.endFrame.lighting.colorAndContrast = "冷蓝色高反差";
  assert.throws(
    () => validateShot(changedLoopLighting),
    /循环镜头首尾 lighting 必须完全相同.*colorAndContrast/u
  );

  const changedLoopEnvironment = structuredClone(movingLoop);
  changedLoopEnvironment.endFrame.environment.atmosphere = "雨雾加重";
  assert.throws(
    () => validateShot(changedLoopEnvironment),
    /循环镜头首尾 environment 必须完全相同.*atmosphere/u
  );

  const reorderedCharacters = structuredClone(loop);
  const supporting = { ...reorderedCharacters.startFrame.characters[0], name: "外婆" };
  reorderedCharacters.startFrame.characters.push(supporting);
  reorderedCharacters.endFrame.characters.unshift(structuredClone(supporting));
  assert.equal(validateShot(reorderedCharacters), reorderedCharacters);

  const vagueStop = structuredClone(loop);
  vagueStop.motion.stopCondition = "动作完成后停止";
  assert.throws(() => validateShot(vagueStop), /必须明确循环回到起始\/首帧状态/);

  const incompatible = structuredClone(loop);
  incompatible.endFrame.characters[0].handPropState = "右手新增一部手机";
  assert.throws(() => validateShot(incompatible), /首尾状态不兼容：handPropState/);
});

test("normal shots reject cut and location-jump wording but allow explicit no-cut locks", () => {
  const cut = v2Shot();
  cut.motion.primaryAction = "拿起玻璃幻灯片后切镜到海边";
  assert.throws(() => validateShot(cut), /普通镜头不得写切镜、转场或地点跳转/);

  const jump = v2Shot();
  jump.motion.environmentChange = "角色瞬移到另一个地点";
  assert.throws(() => validateShot(jump), /普通镜头不得写切镜、转场或地点跳转/);

  const noCut = v2Shot();
  noCut.motion.environmentChange = "同一场景保持稳定，不切镜，不转场";
  assert.equal(validateShot(noCut), noCut);
});

test("compiler alias hook proves all eight legacy aliases equal structured compilation", () => {
  const shot = v2Shot();
  const aliases = {
    startFramePrompt: "compiled start",
    endFramePrompt: "compiled end",
    videoPrompt: "compiled motion",
    cameraMotion: "compiled camera",
    characterAction: "compiled action",
    dialogueOrSubtitle: "compiled dialogue",
    soundDesign: "compiled sound",
    continuityNotes: "compiled locks"
  };
  Object.assign(shot, aliases);
  assert.equal(ensureAnimationShotPromptAliases(shot, aliases), shot);
  const plan = { promptSchemaVersion: "2.0", shotPlan: [shot] };
  assert.equal(ensureAnimationPlanV2Contract(plan, { compileShotPrompts: () => aliases }), plan);

  const mismatch = structuredClone(shot);
  mismatch.videoPrompt = "stale alias";
  assert.throws(
    () => ensureAnimationShotPromptAliases(mismatch, aliases),
    /videoPrompt 与结构化 prompt 的编译结果不一致/
  );
});

test("nested current-shot visual evidence paths are supported while audio dialogue is not render evidence", () => {
  const shot = v2Shot();
  shot.negativePrompts.image.push({
    text: "玻璃幻灯片被错误生成成手机屏幕",
    appliesTo: "image",
    triggerEvidence: [{
      sourcePath: "animationPlan.shotPlan[A01].startFrame.characters[0].handPropState",
      evidence: "玻璃幻灯片仍在箱内"
    }],
    reasonCode: "shot_object_confusion",
    priority: "high"
  });
  const plan = { shotPlan: [shot] };
  assert.equal(ensureAnimationPlanNegativePrompts(plan), plan);

  const dialogueEvidence = v2Shot();
  dialogueEvidence.motion.audio.dialogue = [{ speaker: "小白子", text: "看这里", delivery: "轻声" }];
  dialogueEvidence.negativePrompts.image.push({
    text: "画面出现错误文字",
    appliesTo: "image",
    triggerEvidence: [{
      sourcePath: "animationPlan.shotPlan[A01].motion.audio.dialogue[0].text",
      evidence: "看这里"
    }],
    reasonCode: "shot_object_confusion",
    priority: "low"
  });
  assert.throws(
    () => ensureAnimationPlanNegativePrompts({ shotPlan: [dialogueEvidence] }),
    /缺少与当前镜头直接相关的有效证据/
  );
});

test("nested visual leaves enter visual-boundary scans and structured dialogue stays separated", () => {
  const creatorProfile = { fixedCharacter: "小白子，Q版猫耳少女人形" };
  const creativeBrief = {
    protectedExpressions: [{ sourceExpression: "企鹅服", prohibition: "不得复用企鹅服" }],
    controlledRewriteVariables: []
  };
  const visualGuardrails = { allowedPositiveTraits: [], sourceSimilarityRules: [] };
  const basePlan = {
    promptSchemaVersion: "2.0",
    selectedVariantId: "V1",
    title: "玻璃里的夕阳",
    visualBible: {},
    characterReferencePrompts: [{
      characterName: "小白子",
      storyRole: "主角",
      identity: "Q版猫耳少女人形",
      appearancePrompt: "小白子，Q版猫耳少女人形",
      consistencyTags: []
    }],
    sceneReferencePrompts: [],
    assetPrompts: [],
    shotPlan: [v2Shot()]
  };
  const args = [creatorProfile, creativeBrief, { id: "V1" }, visualGuardrails];

  const dialogueOnly = structuredClone(basePlan);
  dialogueOnly.shotPlan[0].motion.audio.dialogue = [{ speaker: "路人", text: "那套企鹅服已收进仓库", delivery: "平静" }];
  assert.equal(ensureAnimationPlanMatchesProfile(dialogueOnly, ...args), dialogueOnly);

  const sourceLeak = structuredClone(basePlan);
  sourceLeak.shotPlan[0].startFrame.characters[0].actionState = "穿着企鹅服打开木箱";
  assert.throws(
    () => ensureAnimationPlanMatchesProfile(sourceLeak, ...args),
    /企鹅服.*startFrame\.characters\[0\]\.actionState/
  );

  const positiveBoundaryLeak = structuredClone(basePlan);
  positiveBoundaryLeak.shotPlan[0].endFrame.characters[0].expression = "脸部长出鸟喙";
  assert.throws(
    () => ensureAnimationPlanMatchesProfile(positiveBoundaryLeak, ...args),
    /鸟喙.*endFrame\.characters\[0\]\.expression/
  );
});
