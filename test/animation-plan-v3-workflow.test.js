import test from "node:test";
import assert from "node:assert/strict";
import { mockAnimationPlan, mockBrief, mockFullStory } from "../src/mock.js";
import { WorkflowService } from "../src/workflow.js";
import { withGlobalCharacterBoundary } from "./helpers/global-character-boundary.js";
import { ARTIFACT_PARTIAL_REPAIR_SCHEMA_VERSION } from "../src/artifact-partial-repair.js";
import { pruneAnimationPlanNegativePrompts } from "../src/validation.js";

const ENDPOINT_FIELDS = [
  "startFrame",
  "endFrame",
  "motion",
  "startFramePrompt",
  "endFramePrompt"
];

const TUTORIAL_STYLE_VIDEO_PROMPT = "温暖治愈的2.5D手绘动画质感，出发点被清晨柔和侧光照亮，背景空间层次清楚。社区修理师阿岚保持既定外观，确认一段旧录音，听到任务期限后立刻把它收好。镜头先以中景跟随阿岚靠近任务物，确认内容时硬切到任务物特写，最后切到阿岚收好录音后的反应近景。前段节奏轻快，确认期限时短促停顿；保留室内环境底噪、收纳动作声和阿岚的短句“我现在去”。内部摄影切换前后保持阿岚身份、服装、任务物造型和光线方向一致，收好任务物后立即停止。全片无背景音乐，只保留现场环境声与动作声。";

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

function createLiveWorkflow(generateAnimationJson, {
  animationShotBatchSceneCount = 6,
  partialRepairDebugWriter = null
} = {}) {
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
    partialRepairDebugWriter,
    ...(animationShotBatchSceneCount === null ? {} : { animationShotBatchSceneCount })
  });
  return { workflow, animationCalls, staticProviderCalls };
}

function partialRepairDebugSpy(sessionId) {
  const events = [];
  return {
    events,
    writer: {
      async begin(payload) {
        const session = { repairSessionId: sessionId };
        events.push({ phase: "begin", payload, session });
        return session;
      },
      async recordResponse(session, response) {
        events.push({ phase: "response", session, response });
      },
      async recordResult(session, result) {
        events.push({ phase: "result", session, result });
      }
    }
  };
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
  const fullStory = withSingleShotSceneTimeRanges(mockFullStory({ ...base, creativeBrief, variant }));
  return withGlobalCharacterBoundary(workflow, {
    ...base,
    creativeBrief,
    variant,
    fullStory,
    animationPlanMode: "direct_shot",
    videoPromptTarget: {
      provider: "Seedance",
      model: "doubao-seedance-2-0-260128"
    }
  });
}

function foundationFrom(plan) {
  const copy = structuredClone(plan);
  const { shotPlan, ...foundation } = copy;
  delete foundation.productionStrategy.videoPromptProfile;
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

function animationVideoPromptSemanticAuditPayload(prompt) {
  const prefix = "服务端签发审核目录：";
  const suffix = "\n\n按目录 shots 顺序逐项输出";
  const text = String(prompt || "");
  const start = text.indexOf(prefix);
  const end = text.indexOf(suffix, start + prefix.length);
  assert.notEqual(start, -1, "语义审计 Prompt 必须包含服务端签发目录");
  assert.notEqual(end, -1, "语义审计 Prompt 必须包含签发目录终点");
  return JSON.parse(text.slice(start + prefix.length, end));
}

function passingAnimationVideoPromptSemanticAudit(prompt) {
  const payload = animationVideoPromptSemanticAuditPayload(prompt);
  return {
    schemaVersion: "animation_video_prompt_semantic_audit/2.0",
    shots: payload.shots.map((shot) => ({
      shotId: shot.shotId,
      shotFactsVerdict: "pass",
      videoPromptVerdict: "pass",
      issues: []
    }))
  };
}

function failingShotFactsAnimationVideoPromptSemanticAudit(prompt) {
  const payload = animationVideoPromptSemanticAuditPayload(prompt);
  return {
    schemaVersion: "animation_video_prompt_semantic_audit/2.0",
    shots: payload.shots.map((shot, index) => {
      if (index !== 0) {
        return {
          shotId: shot.shotId,
          shotFactsVerdict: "pass",
          videoPromptVerdict: "pass",
          issues: []
        };
      }
      const authority = shot.authorityFacts.find(
        (fact) => fact.field === "fullStory.scene.visibleAction"
      );
      const candidate = shot.candidateFields.find(
        (field) => field.layer === "shot_facts" && field.field === "characterAction"
      );
      assert.ok(authority);
      assert.ok(candidate);
      return {
        shotId: shot.shotId,
        shotFactsVerdict: "fail",
        videoPromptVerdict: "not_evaluated",
        issues: [{
          layer: "shot_facts",
          field: "characterAction",
          category: "action",
          relation: "story_action_reordered",
          authorityFactId: authority.authorityFactId,
          candidateFieldId: candidate.candidateFieldId,
          authorityExcerpt: String(authority.value),
          candidateExcerpt: String(candidate.value),
          productionImpact: "结构化镜头动作顺序与权威场次动作不一致"
        }]
      };
    })
  };
}

function failingVideoPromptAnimationSemanticAudit(prompt, targetShotIndex = 0) {
  const payload = animationVideoPromptSemanticAuditPayload(prompt);
  return {
    schemaVersion: "animation_video_prompt_semantic_audit/2.0",
    shots: payload.shots.map((shot, index) => {
      if (index !== targetShotIndex) {
        return {
          shotId: shot.shotId,
          shotFactsVerdict: "pass",
          videoPromptVerdict: "pass",
          issues: []
        };
      }
      const authority = shot.authorityFacts.find(
        (fact) => fact.field === "exactShot.cameraMotion"
      );
      const candidate = shot.candidateFields.find(
        (field) => field.layer === "video_prompt" && field.field === "videoPrompt"
      );
      assert.ok(authority);
      assert.ok(candidate);
      return {
        shotId: shot.shotId,
        shotFactsVerdict: "pass",
        videoPromptVerdict: "fail",
        issues: [{
          layer: "video_prompt",
          field: "videoPrompt",
          category: "camera",
          relation: "required_camera_beat_missing",
          authorityFactId: authority.authorityFactId,
          candidateFieldId: candidate.candidateFieldId,
          authorityExcerpt: String(authority.value),
          candidateExcerpt: null,
          productionImpact: "成片会漏掉同镜结构化字段已签发的关键摄影 beat"
        }]
      };
    })
  };
}

function animationVideoPromptSemanticRepairPayload(prompt) {
  const prefix = "Bounded input:\n";
  const suffix = "\n\nReturn exactly this JSON shape and nothing else:";
  const text = String(prompt || "");
  const start = text.indexOf(prefix);
  const end = text.indexOf(suffix, start + prefix.length);
  assert.notEqual(start, -1, "语义修复 Prompt 必须包含有界输入");
  assert.notEqual(end, -1, "语义修复 Prompt 必须包含有界输入终点");
  return JSON.parse(text.slice(start + prefix.length, end));
}

function animationVideoPromptSemanticRepairEnvelope(prompt, replacements) {
  const payload = animationVideoPromptSemanticRepairPayload(prompt);
  assert.equal(payload.schemaVersion, "animation_video_prompt_semantic_repair/1.0");
  assert.equal(payload.targets.length, replacements.length);
  return {
    schemaVersion: payload.schemaVersion,
    repairs: payload.targets.map((target, index) => ({
      repairId: target.repairId,
      replacement: replacements[index]
    }))
  };
}

function partialRepairPayload(prompt) {
  const prefix = "局部纠错输入：\n";
  const suffix = "\n\n只返回以下精确 JSON 协议：";
  const start = String(prompt || "").indexOf(prefix);
  const end = String(prompt || "").indexOf(suffix, start + prefix.length);
  assert.notEqual(start, -1, "局部纠错 Prompt 必须包含有界 payload 起点");
  assert.notEqual(end, -1, "局部纠错 Prompt 必须包含有界 payload 终点");
  return JSON.parse(String(prompt).slice(start + prefix.length, end));
}

function partialRepairEnvelope(prompt, replacements) {
  const payload = partialRepairPayload(prompt);
  assert.equal(payload.schemaVersion, ARTIFACT_PARTIAL_REPAIR_SCHEMA_VERSION);
  assert.equal(payload.targets.length, replacements.length);
  return {
    schemaVersion: ARTIFACT_PARTIAL_REPAIR_SCHEMA_VERSION,
    baseDigest: payload.baseDigest,
    repairs: payload.targets.map((target, index) => ({
      repairId: target.repairId,
      replacement: structuredClone(replacements[index])
    }))
  };
}

function boundaryTrait(canonicalName, scope, terms = [canonicalName]) {
  return {
    canonicalName,
    terms,
    scope,
    evidenceLevel: "explicit",
    triggerEvidence: [{
      sourcePath: "creatorProfile.fixedCharacter",
      evidence: canonicalName
    }],
    reason: "用户明确设定。"
  };
}

function fixedCharacterRepairBoundary() {
  return {
    schemaVersion: "2.0",
    characterName: "阿岚",
    canonicalDescription: "阿岚，社区修理师，活泼可爱且懂事。",
    bodyForm: "保持已签发的人类社区修理师身份。",
    requiredTraits: [
      boundaryTrait("阿岚", "identity"),
      boundaryTrait("活泼可爱", "personality"),
      boundaryTrait("懂事", "personality")
    ],
    allowedTraits: [],
    forbiddenTraits: [boundaryTrait("特定发色", "appearance")],
    unresolvedConflicts: []
  };
}

function wolfGirlRepairBoundary() {
  return {
    schemaVersion: "2.0",
    characterName: "阿岚",
    canonicalDescription: "阿岚是Q版2.5头身狼耳少女，形象类似狼娘。",
    bodyForm: "保持人形少女结构与狼耳。",
    requiredTraits: [
      boundaryTrait("阿岚", "identity"),
      boundaryTrait("狼耳", "appearance", ["狼耳", "狼耳朵"]),
      boundaryTrait("狼娘形象", "appearance", ["狼娘形象", "狼娘特征", "类似狼娘"])
    ],
    allowedTraits: [],
    forbiddenTraits: [],
    unresolvedConflicts: []
  };
}


// 这些用例验证的是 direct_shot 的字段契约与各类修复协议，不是镜头数下限。
// 把每场脚本时长压到单镜上限以内，使「一场一镜」的既有 fixture 本身就满足
// 新的每场镜头数下限，测试焦点保持不变。下限本身由专门的用例覆盖。
function withSingleShotSceneTimeRanges(fullStory) {
  const story = structuredClone(fullStory);
  story.sceneScript = (Array.isArray(story.sceneScript) ? story.sceneScript : []).map((scene, index) => ({
    ...scene,
    timeRange: `00:${String(index * 5).padStart(2, "0")}-00:${String(index * 5 + 5).padStart(2, "0")}`
  }));
  return story;
}

// 方言只有一种：改写产出的是全新的 Seedance 中文提示词，而不是另一套段落格式。
function seedanceRewriteForPlan(plan) {
  return {
    videoPrompts: plan.shotPlan.map((shot) => ({
      shotId: shot.shotId,
      videoPrompt: `温暖治愈的手绘动画质感。${shot.characterAction}。镜头按动作顺序执行${shot.cameraMotion}。在 ${shot.durationSeconds} 秒内完成后立即停止。`
    }))
  };
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

test("live Foundation 的特定发色与缺失角色事实只修固定角色子树并保持其余 Foundation", async () => {
  const fullStorySentinel = "FOUNDATION_REPAIR_FULL_STORY_SENTINEL";
  const foundationSentinel = "FOUNDATION_WHOLE_SENTINEL";
  const visualBibleSentinel = "FOUNDATION_VISUAL_BIBLE_SENTINEL";
  const companionSentinel = "FOUNDATION_COMPANION_SENTINEL";
  let invalidFoundation;
  let batch;
  let validCharacterReference;
  let repairPrompt = "";
  const debug = partialRepairDebugSpy("foundation-debug");
  const { workflow, animationCalls, staticProviderCalls } = createLiveWorkflow((args, callNumber) => {
    if (/ARTIFACT_PARTIAL_REPAIR_V1/u.test(args.prompt)) {
      repairPrompt = args.prompt;
      return partialRepairEnvelope(args.prompt, [validCharacterReference]);
    }
    if (callNumber === 1) return structuredClone(invalidFoundation);
    if (callNumber === 3) return structuredClone(batch);
    throw new Error(`Foundation 有界纠错出现意外的第 ${callNumber} 次模型调用`);
  }, { partialRepairDebugWriter: debug.writer });
  const baseContext = fixture(workflow);
  const creatorProfile = {
    ...baseContext.creatorProfile,
    fixedCharacter: "阿岚，社区修理师，活泼可爱，懂事"
  };
  const context = withGlobalCharacterBoundary(workflow, {
    ...baseContext,
    creatorProfile
  }, fixedCharacterRepairBoundary());
  context.fullStory.shootingSynopsis = `${context.fullStory.shootingSynopsis} ${fullStorySentinel}`;
  const modelPlan = mockAnimationPlan(context);
  invalidFoundation = foundationFrom(modelPlan);
  invalidFoundation.title = foundationSentinel;
  invalidFoundation.visualBible.overallStyle = visualBibleSentinel;
  invalidFoundation.characterReferencePrompts[1].appearancePrompt = companionSentinel;
  validCharacterReference = structuredClone(invalidFoundation.characterReferencePrompts[0]);
  invalidFoundation.characterReferencePrompts[0].appearancePrompt =
    "阿岚，社区修理师，保持既定身份与服装，特定发色";
  invalidFoundation.characterReferencePrompts[0].consistencyTags = ["阿岚", "社区修理师", "同一服装"];
  validCharacterReference.appearancePrompt =
    "阿岚，社区修理师，保持既定身份与服装";
  validCharacterReference.consistencyTags = ["阿岚", "社区修理师", "同一服装", "活泼可爱", "懂事"];
  const invalidCharacterReference = structuredClone(invalidFoundation.characterReferencePrompts[0]);
  const companionBefore = structuredClone(invalidFoundation.characterReferencePrompts[1]);
  batch = { shotPlan: structuredClone(modelPlan.shotPlan) };

  const { animationPlan } = await workflow.createAnimationPlanWithMetadata(context);

  assert.equal(animationCalls.length, 3);
  assert.equal(staticProviderCalls.length, 0);
  assert.match(repairPrompt, /ARTIFACT_PARTIAL_REPAIR_V1/u);
  assert.match(repairPrompt, /特定发色/u);
  assert.match(repairPrompt, /活泼可爱/u);
  assert.match(repairPrompt, /懂事/u);
  assert.doesNotMatch(
    repairPrompt,
    new RegExp(`${fullStorySentinel}|${foundationSentinel}|${visualBibleSentinel}|${companionSentinel}`, "u")
  );
  assert.equal(animationPlan.title, foundationSentinel);
  assert.equal(animationPlan.visualBible.overallStyle, visualBibleSentinel);
  assert.deepEqual(animationPlan.characterReferencePrompts[1], companionBefore);
  assert.deepEqual(animationPlan.characterReferencePrompts[0], validCharacterReference);
  assert.equal(animationPlan.characterReferencePrompts[0].identity, invalidCharacterReference.identity);
  assert.equal(animationPlan.characterReferencePrompts[0].storyRole, invalidCharacterReference.storyRole);
  assert.doesNotMatch(animationPlan.characterReferencePrompts[0].appearancePrompt, /特定发色/u);
  assert.deepEqual(debug.events.map((event) => event.phase), ["begin", "response", "result"]);
  assert.equal(debug.events[0].payload.stage, "animationFoundation");
  assert.equal(
    debug.events[0].payload.repairPlan.targets[0].path,
    "/characterReferencePrompts/0"
  );
  assert.equal(debug.events[2].result.status, "repaired");
});

test("live Foundation 仅缺狼娘形象时保持 appearancePrompt 逐字不变并只追加签发标签", async () => {
  let invalidFoundation;
  let batch;
  let replacement;
  let repairPrompt = "";
  const debug = partialRepairDebugSpy("foundation-missing-only-debug");
  const { workflow, animationCalls, staticProviderCalls } = createLiveWorkflow((args, callNumber) => {
    if (/ARTIFACT_PARTIAL_REPAIR_V1/u.test(args.prompt)) {
      repairPrompt = args.prompt;
      return partialRepairEnvelope(args.prompt, [replacement]);
    }
    if (callNumber === 1) return structuredClone(invalidFoundation);
    if (callNumber === 3) return structuredClone(batch);
    throw new Error(`Foundation missing-only 纠错出现意外的第 ${callNumber} 次模型调用`);
  }, { partialRepairDebugWriter: debug.writer });
  const baseContext = fixture(workflow);
  const creatorProfile = {
    ...baseContext.creatorProfile,
    fixedCharacter: "阿岚，Q版2.5头身狼耳少女，形象类似狼娘"
  };
  const context = withGlobalCharacterBoundary(workflow, {
    ...baseContext,
    creatorProfile
  }, wolfGirlRepairBoundary());
  const modelPlan = mockAnimationPlan(context);
  invalidFoundation = foundationFrom(modelPlan);
  invalidFoundation.characterReferencePrompts[0].appearancePrompt = "Q版2.5头身狼耳少女";
  invalidFoundation.characterReferencePrompts[0].consistencyTags = ["阿岚", "狼耳"];
  replacement = structuredClone(invalidFoundation.characterReferencePrompts[0]);
  replacement.consistencyTags.push("狼娘形象");
  batch = { shotPlan: structuredClone(modelPlan.shotPlan) };

  const { animationPlan } = await workflow.createAnimationPlanWithMetadata(context);

  assert.equal(animationCalls.length, 3);
  assert.equal(staticProviderCalls.length, 0);
  const payload = partialRepairPayload(repairPrompt);
  assert.deepEqual(payload.targets[0].modelContext.mutableFields, ["consistencyTags"]);
  assert.deepEqual(
    payload.targets[0].modelContext.missingRequiredTraitCanonicalNames,
    ["狼娘形象"]
  );
  assert.match(repairPrompt, /appearancePrompt 必须逐字不变/u);
  assert.equal(
    animationPlan.characterReferencePrompts[0].appearancePrompt,
    "Q版2.5头身狼耳少女"
  );
  assert.deepEqual(animationPlan.characterReferencePrompts[0].consistencyTags, [
    "阿岚",
    "狼耳",
    "狼娘形象"
  ]);
  assert.deepEqual(debug.events.map((event) => event.phase), ["begin", "response", "result"]);
  assert.equal(debug.events[2].result.status, "repaired");
});

test("live Foundation replacement 改写未命中外观事实时记录 rejected debug 并保持首轮候选", async () => {
  let invalidFoundation;
  let invalidSnapshot;
  const debug = partialRepairDebugSpy("foundation-rejected-debug");
  const { workflow, animationCalls } = createLiveWorkflow((args, callNumber) => {
    if (/ARTIFACT_PARTIAL_REPAIR_V1/u.test(args.prompt)) {
      const replacement = structuredClone(invalidFoundation.characterReferencePrompts[0]);
      replacement.appearancePrompt = "阿岚，社区修理师，活泼可爱且懂事，经过重写的全新外观";
      replacement.consistencyTags = ["阿岚", "社区修理师", "活泼可爱", "懂事"];
      return partialRepairEnvelope(args.prompt, [replacement]);
    }
    if (callNumber === 1) return structuredClone(invalidFoundation);
    throw new Error(`Foundation 拒绝纠错出现意外的第 ${callNumber} 次模型调用`);
  }, { partialRepairDebugWriter: debug.writer });
  const baseContext = fixture(workflow);
  const creatorProfile = {
    ...baseContext.creatorProfile,
    fixedCharacter: "阿岚，社区修理师，活泼可爱，懂事"
  };
  const context = withGlobalCharacterBoundary(workflow, {
    ...baseContext,
    creatorProfile
  }, fixedCharacterRepairBoundary());
  invalidFoundation = foundationFrom(mockAnimationPlan(context));
  invalidFoundation.characterReferencePrompts[0].appearancePrompt =
    "阿岚，社区修理师，保持既定身份与服装";
  invalidFoundation.characterReferencePrompts[0].consistencyTags = ["阿岚", "社区修理师"];
  invalidSnapshot = structuredClone(invalidFoundation);

  await assert.rejects(
    () => workflow.createAnimationPlanWithMetadata(context),
    /有界局部纠错失败|越权改变未授权路径.*appearancePrompt/u
  );

  assert.equal(animationCalls.length, 2);
  assert.deepEqual(invalidFoundation, invalidSnapshot, "被拒绝的 replacement 不得回写首轮候选");
  assert.deepEqual(debug.events.map((event) => event.phase), ["begin", "response", "result"]);
  assert.equal(debug.events[2].result.status, "rejected");
  assert.match(
    String(debug.events[2].result.error?.message || ""),
    /越权改变未授权路径.*appearancePrompt/u
  );
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
  assert.equal(animationCalls.length, 1);
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

test("live prompt-only rewrite 分别调用改写与独立语义审计并逐镜保留全部非 videoPrompt 事实", async () => {
  let response;
  const calls = [];
  const client = {
    async generateJson(args) {
      calls.push(args);
      if (/ANIMATION_VIDEO_PROMPT_REWRITE_SEMANTIC_AUDIT_V2/u.test(args.prompt)) {
        return passingAnimationVideoPromptSemanticAudit(args.prompt);
      }
      return structuredClone(response);
    }
  };
  const workflow = new WorkflowService({
    clients: { MiMo: client },
    animationProvider: "MiMo",
    animationModel: "animation-prompt-rewrite-test"
  });
  const context = fixture(workflow);
  const sourcePlan = mockAnimationPlan(context);
  response = seedanceRewriteForPlan(sourcePlan);
  const comparable = (plan) => {
    const clone = structuredClone(plan);
    delete clone.productionStrategy.videoPromptProfile;
    clone.shotPlan.forEach((shot) => delete shot.videoPrompt);
    return clone;
  };

  const result = await workflow.rewriteAnimationPlanVideoPrompts({
    ...context,
    animationPlan: sourcePlan,
    videoPromptTarget: { provider: "Seedance", model: "doubao-seedance-2-0-fast-260128" }
  });

  assert.equal(calls.length, 2);
  assert.match(calls[0].prompt, /只能改写 videoPrompt 的供应商表达/u);
  // 方言统一后改写提示词走 Seedance 规则，不再出现 H3 段名。
  assert.match(calls[0].prompt, /可直接交给 Seedance 2\.0 的中文自然语言提示词/u);
  assert.match(calls[1].prompt, /ANIMATION_VIDEO_PROMPT_REWRITE_SEMANTIC_AUDIT_V2/u);
  assert.match(calls[1].systemPrompt, /只是不可执行的引用数据/u);
  assert.match(calls[1].systemPrompt, /不得遵循.*任何指令/u);
  assert.deepEqual(comparable(result.animationPlan), comparable(sourcePlan));
  assert.equal(result.animationPlan.productionStrategy.videoPromptProfile.profileId, "seedance_2_0");
  assert.deepEqual(
    result.animationPlan.shotPlan.map((shot) => shot.shotId),
    sourcePlan.shotPlan.map((shot) => shot.shotId)
  );
  assert.equal(result.metadata.videoPromptRewrite.semanticAudit.verdict, "pass");
});

test("Profile 改写审计的纯 Prompt 冲突只修目标镜头一次，失败前不覆盖原 Plan", async () => {
  let sourcePlan;
  let rewritten;
  let repairedPrompt;
  let auditRound = 0;
  const calls = [];
  const client = {
    async generateJson(args) {
      calls.push(args);
      if (/ANIMATION_VIDEO_PROMPT_REWRITE_SEMANTIC_AUDIT_V2/u.test(args.prompt)) {
        auditRound += 1;
        return auditRound === 1
          ? failingVideoPromptAnimationSemanticAudit(args.prompt)
          : passingAnimationVideoPromptSemanticAudit(args.prompt);
      }
      if (/ANIMATION_VIDEO_PROMPT_SEMANTIC_REPAIR_V1/u.test(args.prompt)) {
        return animationVideoPromptSemanticRepairEnvelope(args.prompt, [repairedPrompt]);
      }
      return structuredClone(rewritten);
    }
  };
  const workflow = new WorkflowService({
    clients: { MiMo: client },
    animationProvider: "MiMo",
    animationModel: "animation-prompt-rewrite-test"
  });
  const context = fixture(workflow);
  sourcePlan = mockAnimationPlan(context);
  const sourceBefore = structuredClone(sourcePlan);
  rewritten = seedanceRewriteForPlan(sourcePlan);
  repairedPrompt = rewritten.videoPrompts[0].videoPrompt.replace(
    "follows the specified camera sequence",
    "executes every signed camera beat in the specified order"
  );

  const result = await workflow.rewriteAnimationPlanVideoPrompts({
    ...context,
    animationPlan: sourcePlan,
    videoPromptTarget: { provider: "Seedance", model: "doubao-seedance-2-0-fast-260128" }
  });

  assert.equal(calls.length, 4, "改写 + 审计 + 唯一修复 + 相邻复审");
  assert.equal(auditRound, 2);
  assert.match(calls[2].prompt, /ANIMATION_VIDEO_PROMPT_SEMANTIC_REPAIR_V1/u);
  assert.equal(result.animationPlan.shotPlan[0].videoPrompt, repairedPrompt);
  assert.deepEqual(
    result.animationPlan.shotPlan.slice(1).map((shot) => shot.videoPrompt),
    rewritten.videoPrompts.slice(1).map((item) => item.videoPrompt)
  );
  assert.deepEqual(sourcePlan, sourceBefore, "候选提交前不得覆盖当前签发 Plan");
  assert.deepEqual(result.metadata.videoPromptRewrite.semanticAudit.repairedShotIds, ["A01"]);
  assert.deepEqual(
    result.metadata.videoPromptRewrite.semanticAudit.reviewedShotIds,
    sourcePlan.shotPlan.map((shot) => shot.shotId)
  );
  assert.deepEqual(
    result.metadata.videoPromptRewrite.semanticAudit.reReviewedShotIds,
    ["A01", "A02"]
  );
});

test("prompt-only rewrite 结构合法但语义审计发现动作顺序漂移时保留原 Plan", async () => {
  let sourcePlan;
  const calls = [];
  const client = {
    async generateJson(args) {
      calls.push(args);
      if (/ANIMATION_VIDEO_PROMPT_REWRITE_SEMANTIC_AUDIT_V2/u.test(args.prompt)) {
        return failingShotFactsAnimationVideoPromptSemanticAudit(args.prompt);
      }
      return seedanceRewriteForPlan(sourcePlan);
    }
  };
  const workflow = new WorkflowService({
    clients: { MiMo: client },
    animationProvider: "MiMo",
    animationModel: "animation-prompt-rewrite-test"
  });
  const context = fixture(workflow);
  sourcePlan = mockAnimationPlan(context);
  const before = structuredClone(sourcePlan);

  await assert.rejects(
    () => workflow.rewriteAnimationPlanVideoPrompts({
      ...context,
      animationPlan: sourcePlan,
      videoPromptTarget: { provider: "Seedance", model: "doubao-seedance-2-0-fast-260128" }
    }),
    /shot_facts\/story_action_reordered/u
  );

  assert.equal(calls.length, 2);
  assert.deepEqual(sourcePlan, before);
});


// 把 S1 拉长到 20 秒（超过 15 秒单镜上限 → 骨架自动均分成 2 镜），
// 其余场次保持 5 秒 / 1 镜。后续场次的 timeRange 一并顺延，保持时间线有序。
function longFirstSceneContext(workflow) {
  const context = fixture(workflow);
  const patched = structuredClone(context);
  patched.fullStory.sceneScript.forEach((scene, index) => {
    const start = index === 0 ? 0 : 20 + (index - 1) * 5;
    const end = index === 0 ? 20 : start + 5;
    scene.timeRange = `00:${String(start).padStart(2, "0")}-00:${String(end).padStart(2, "0")}`;
  });
  return patched;
}

test("长场次只给一个镜头时明确失败：骨架要求 2 镜，模型给 1 镜不放行", async () => {
  let foundation;
  let batch;
  const { workflow, animationCalls } = createLiveWorkflow((args, callNumber) => {
    if (callNumber === 1) return structuredClone(foundation);
    return structuredClone(batch);
  });
  const context = longFirstSceneContext(workflow);
  const modelPlan = mockAnimationPlan(context);
  foundation = foundationFrom(modelPlan);
  // 模型无视骨架，20 秒的 S1 仍然只给一条镜头。
  batch = {
    shotPlan: structuredClone(modelPlan.shotPlan).filter((shot, index) => index !== 1)
  };

  await assert.rejects(
    () => workflow.createAnimationPlanWithMetadata(context),
    (error) => {
      assert.match(error.message, /必须恰好输出 7 个镜头，实际 6 个/u);
      assert.match(error.message, /不得拆分、合并、新增或遗漏/u);
      assert.match(error.message, /S1（00:00-00:20，20 秒）→ 2 个镜头：A01 10 秒（第 1\/2 段）、A02 10 秒（第 2\/2 段）/u);
      return true;
    }
  );
  // direct_shot 对「已解析但不合契约」的候选一律 fail closed（workflow.js 的
  // directShotMode && hadParsedCandidate 分支），不整批重试：foundation 一次 + batch 一次。
  assert.equal(animationCalls.length, 2);
});

test("长场次按骨架均分后正常签发，成片总长等于各场 timeRange 之和", async () => {
  let foundation;
  let batch;
  const { workflow } = createLiveWorkflow((args, callNumber) => {
    if (callNumber === 1) return structuredClone(foundation);
    if (callNumber === 2) return structuredClone(batch);
    throw new Error(`不应发生第 ${callNumber} 次调用`);
  });
  const context = longFirstSceneContext(workflow);
  const modelPlan = mockAnimationPlan(context);
  foundation = foundationFrom(modelPlan);
  // mock 已经按同一份骨架产出镜头，直接回放即可。
  batch = { shotPlan: structuredClone(modelPlan.shotPlan) };

  const { animationPlan } = await workflow.createAnimationPlanWithMetadata(context);

  const s1Shots = animationPlan.shotPlan.filter((shot) => shot.sourceSceneId === "S1");
  assert.equal(s1Shots.length, 2);
  assert.deepEqual(s1Shots.map((shot) => shot.durationSeconds), [10, 10]);
  // 5 个 5 秒场次 + 1 个 20 秒场次 = 7 镜、45 秒。
  assert.equal(animationPlan.shotPlan.length, 7);
  const plannedSeconds = animationPlan.shotPlan.reduce((total, shot) => total + shot.durationSeconds, 0);
  assert.equal(plannedSeconds, 45);
  assert.equal(animationPlan.productionStrategy.targetRuntimeSeconds, 45);
});


test("场次短于供应商下限时在任何模型调用之前失败", async () => {
  const { workflow, animationCalls } = createLiveWorkflow(() => {
    throw new Error("不应发生任何模型调用");
  });
  const context = fixture(workflow);
  // 2 秒场次低于 Seedance 与 MiniMax H3 的共同 4 秒下限。
  context.fullStory.sceneScript[2].timeRange = "00:10-00:12";
  context.fullStory.sceneScript[3].timeRange = "00:12-00:17";

  await assert.rejects(
    () => workflow.createAnimationPlanWithMetadata(context),
    (error) => {
      assert.equal(error.details?.[0]?.code, "DIRECT_SHOT_SCENE_DURATION_BELOW_PROVIDER_MINIMUM");
      assert.match(error.message, /不得补长、缩短或合并场次/u);
      return true;
    }
  );
  // 骨架派生在 Foundation 之前：契约错误不消耗任何 provider 调用。
  assert.equal(animationCalls.length, 0);
});

test("timeRange 不可解析时明确失败，不再退回下限 1", async () => {
  const { workflow, animationCalls } = createLiveWorkflow(() => {
    throw new Error("不应发生任何模型调用");
  });
  const context = fixture(workflow);
  context.fullStory.sceneScript[1].timeRange = "时长未知";

  await assert.rejects(
    () => workflow.createAnimationPlanWithMetadata(context),
    (error) => error.details?.[0]?.code === "DIRECT_SHOT_SCENE_TIME_RANGE_INVALID"
  );
  assert.equal(animationCalls.length, 0);
});

test("模型按自己的想法重新分配镜头归属时明确失败，不靠注入把错位内容重新贴标签", async () => {
  let foundation;
  let batch;
  const { workflow } = createLiveWorkflow((args, callNumber) => {
    if (callNumber === 1) return structuredClone(foundation);
    return structuredClone(batch);
  });
  // S1 是 20 秒，骨架要求 S1 两镜、S2 一镜。
  const context = longFirstSceneContext(workflow);
  const modelPlan = mockAnimationPlan(context);
  foundation = foundationFrom(modelPlan);
  const shots = structuredClone(modelPlan.shotPlan);
  // 总数、顺序、场次覆盖全部合法，只是模型把第二镜算给了 S2：
  // 既有的顺序/覆盖校验都抓不到，只有逐位骨架比对能抓到。
  const misaligned = structuredClone(shots);
  misaligned[1].sourceSceneId = "S2";
  batch = { shotPlan: misaligned };

  await assert.rejects(
    () => workflow.createAnimationPlanWithMetadata(context),
    (error) => {
      assert.match(error.message, /shotPlan\[1\]\.sourceSceneId 必须是 S1，实际 S2/u);
      assert.match(error.message, /镜头顺序必须逐位对应骨架/u);
      return true;
    }
  );
});

test("模型对调相邻场次时仍由既有顺序校验拦下", async () => {
  let foundation;
  let batch;
  const { workflow } = createLiveWorkflow((args, callNumber) => {
    if (callNumber === 1) return structuredClone(foundation);
    return structuredClone(batch);
  });
  const context = fixture(workflow);
  const modelPlan = mockAnimationPlan(context);
  foundation = foundationFrom(modelPlan);
  const shots = structuredClone(modelPlan.shotPlan);
  batch = { shotPlan: [shots[1], shots[0], ...shots.slice(2)] };

  await assert.rejects(
    () => workflow.createAnimationPlanWithMetadata(context),
    /必须按当前批次的剧情场次顺序输出/u
  );
});

test("模型回显错误的时长与剧情目的时，服务端按骨架确定性覆盖", async () => {
  let foundation;
  let batch;
  const { workflow } = createLiveWorkflow((args, callNumber) => {
    if (callNumber === 1) return structuredClone(foundation);
    if (callNumber === 2) return structuredClone(batch);
    throw new Error(`不应发生第 ${callNumber} 次调用`);
  });
  const context = fixture(workflow);
  const modelPlan = mockAnimationPlan(context);
  foundation = foundationFrom(modelPlan);
  const shots = structuredClone(modelPlan.shotPlan);
  shots[0].durationSeconds = 12;
  shots[0].storyPurpose = "模型自己编的剧情目的";
  shots[0].emotionalTarget = "模型自己编的情绪目标";
  shots[0].shotId = "Z99";
  batch = { shotPlan: shots };

  const { animationPlan } = await workflow.createAnimationPlanWithMetadata(context);

  const scene = context.fullStory.sceneScript[0];
  assert.equal(animationPlan.shotPlan[0].shotId, "A01");
  assert.equal(animationPlan.shotPlan[0].durationSeconds, 5);
  // storyPurpose / emotionalTarget 的唯一事实源是 Full Story，不是模型回显。
  assert.equal(animationPlan.shotPlan[0].storyPurpose, scene.dramaticFunction);
  assert.equal(animationPlan.shotPlan[0].emotionalTarget, scene.emotionNode);
});

test("Foundation 的 targetRuntimeSeconds 由服务端派生，模型给的值一律被覆盖", async () => {
  let foundation;
  let batch;
  const { workflow } = createLiveWorkflow((args, callNumber) => {
    if (callNumber === 1) return structuredClone(foundation);
    if (callNumber === 2) return structuredClone(batch);
    throw new Error(`不应发生第 ${callNumber} 次调用`);
  });
  const context = fixture(workflow);
  const modelPlan = mockAnimationPlan(context);
  foundation = foundationFrom(modelPlan);
  foundation.productionStrategy.targetRuntimeSeconds = 999;
  // 3.1 已经没有"建议单镜时长"这个事实，模型仍旧输出时必须被剥掉。
  foundation.productionStrategy.recommendedShotDurationSeconds = { min: 4, max: 6 };
  batch = { shotPlan: structuredClone(modelPlan.shotPlan) };

  const { animationPlan } = await workflow.createAnimationPlanWithMetadata(context);

  const plannedSeconds = animationPlan.shotPlan.reduce((total, shot) => total + shot.durationSeconds, 0);
  assert.equal(animationPlan.productionStrategy.targetRuntimeSeconds, plannedSeconds);
  assert.equal(plannedSeconds, 30);
  assert.equal(
    Object.hasOwn(animationPlan.productionStrategy, "recommendedShotDurationSeconds"),
    false
  );
});

test("请求不带开关时服务端签发 backgroundMusicMode: none，Seedance 提示词带签发收尾句", async () => {
  let foundation;
  let batch;
  const { workflow } = createLiveWorkflow((args, callNumber) => {
    if (callNumber === 1) return structuredClone(foundation);
    if (callNumber === 2) return structuredClone(batch);
    throw new Error(`不应发生第 ${callNumber} 次调用`);
  });
  const context = fixture(workflow);
  const modelPlan = mockAnimationPlan(context);
  foundation = foundationFrom(modelPlan);
  batch = { shotPlan: structuredClone(modelPlan.shotPlan) };

  const { animationPlan } = await workflow.createAnimationPlanWithMetadata(context);

  assert.equal(animationPlan.productionStrategy.backgroundMusicMode, "none");
  animationPlan.shotPlan.forEach((shot) => {
    assert.ok(
      shot.videoPrompt.trim().endsWith("全片无背景音乐，只保留现场环境声与动作声。"),
      `${shot.shotId} 的 videoPrompt 必须以签发的无配乐句收尾`
    );
  });
});

test("关闭背景音乐时 Seedance videoPrompt 缺收尾句明确失败", async () => {
  let foundation;
  let batch;
  const { workflow } = createLiveWorkflow((args, callNumber) => {
    if (callNumber === 1) return structuredClone(foundation);
    return structuredClone(batch);
  });
  const context = fixture(workflow);
  const modelPlan = mockAnimationPlan(context);
  foundation = foundationFrom(modelPlan);
  batch = { shotPlan: structuredClone(modelPlan.shotPlan) };
  // 模型漏掉了签发的收尾句。
  batch.shotPlan[0].videoPrompt = batch.shotPlan[0].videoPrompt
    .replace("全片无背景音乐，只保留现场环境声与动作声。", "");

  await assert.rejects(
    () => workflow.createAnimationPlanWithMetadata(context),
    (error) => {
      assert.match(error.message, /shotPlan\[0\]\.videoPrompt 必须以「全片无背景音乐，只保留现场环境声与动作声。」逐字收尾/u);
      return true;
    }
  );
});

test("开启背景音乐时不施加收尾句约束，带配乐的提示词照常通过", async () => {
  let foundation;
  let batch;
  const { workflow } = createLiveWorkflow((args, callNumber) => {
    if (callNumber === 1) return structuredClone(foundation);
    if (callNumber === 2) return structuredClone(batch);
    throw new Error(`不应发生第 ${callNumber} 次调用`);
  });
  const base = fixture(workflow);
  const context = { ...base, backgroundMusicEnabled: true };
  const modelPlan = mockAnimationPlan({ ...context, backgroundMusicMode: "allowed" });
  foundation = foundationFrom(modelPlan);
  batch = { shotPlan: structuredClone(modelPlan.shotPlan) };

  const { animationPlan } = await workflow.createAnimationPlanWithMetadata(context);

  assert.equal(animationPlan.productionStrategy.backgroundMusicMode, "allowed");
  assert.equal(
    animationPlan.shotPlan[0].videoPrompt.includes("全片无背景音乐"),
    false,
    "开启配乐时不得注入无配乐句"
  );
});

test("backgroundMusicMode 由服务端签发，模型自行输出时拒绝", async () => {
  let foundation;
  const { workflow } = createLiveWorkflow((args, callNumber) => {
    if (callNumber === 1) return structuredClone(foundation);
    throw new Error(`不应发生第 ${callNumber} 次调用`);
  });
  const context = fixture(workflow);
  const modelPlan = mockAnimationPlan(context);
  foundation = foundationFrom(modelPlan);
  foundation.productionStrategy.backgroundMusicMode = "allowed";

  await assert.rejects(
    () => workflow.createAnimationPlanWithMetadata(context),
    (error) => {
      assert.match(error.message, /backgroundMusicMode 由服务端签发，模型不得输出/u);
      return true;
    }
  );
});
