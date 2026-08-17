import test from "node:test";
import assert from "node:assert/strict";
import { mockAnimationPlan, mockBrief, mockFullStory } from "../src/mock.js";
import { WorkflowService } from "../src/workflow.js";
import { withGlobalCharacterBoundary } from "./helpers/global-character-boundary.js";
import { assertMiniMaxH3BasePrompt, miniMaxH3DialogueTexts } from "../src/minimax-h3-prompt.js";
import { ARTIFACT_PARTIAL_REPAIR_SCHEMA_VERSION } from "../src/artifact-partial-repair.js";
import { pruneAnimationPlanNegativePrompts } from "../src/validation.js";

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
  const fullStory = mockFullStory({ ...base, creativeBrief, variant });
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

function miniMaxH3PromptForShot(shot) {
  const dialogue = miniMaxH3DialogueTexts(shot.dialogueOrSubtitle)
    .map((line, index) => `The signed speaker (S${index + 1}) says, <d>[Chinese] ${line}</d>.`)
    .join(" ");
  return `integrated_multimodal_description: [Shot 1] The signed character remains in the locked Animation Plan location with the authorized wardrobe and props, performs the complete planned action chain in its exact order, follows the specified camera sequence, and holds the stated visible final state. ${dialogue}`.trim()
    + `\noverall_soundscape: The signed diegetic ambience, action sounds, and spoken lines remain synchronized with every visible action.\nnon_diegetic_music: A restrained instrumental cue follows the signed emotional progression and ends with the completed action.`;
}

function miniMaxH3RewriteForPlan(plan) {
  return {
    videoPrompts: plan.shotPlan.map((shot) => ({
      shotId: shot.shotId,
      videoPrompt: miniMaxH3PromptForShot(shot)
    }))
  };
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

test("live 首次选择 MiniMax H3 时生成英文 Base Prompt、锁定 4–6 秒并完成独立语义审计", async () => {
  let foundation;
  let batch;
  const { workflow, animationCalls, staticProviderCalls } = createLiveWorkflow((args, callNumber) => {
    if (/ANIMATION_VIDEO_PROMPT_(?:INITIAL|REWRITE)_SEMANTIC_AUDIT_V2/u.test(args.prompt)) {
      return passingAnimationVideoPromptSemanticAudit(args.prompt);
    }
    if (callNumber === 1) return structuredClone(foundation);
    if (callNumber === 2) return structuredClone(batch);
    throw new Error(`H3 首次生成出现意外的第 ${callNumber} 次模型调用`);
  });
  const context = {
    ...fixture(workflow),
    videoPromptTarget: { provider: "MiniMax", model: "MiniMax-H3" }
  };
  delete context.videoPromptProfile;
  const modelPlan = mockAnimationPlan(context);
  foundation = foundationFrom(modelPlan);
  batch = { shotPlan: structuredClone(modelPlan.shotPlan) };
  batch.shotPlan.forEach((shot) => {
    shot.videoPrompt = miniMaxH3PromptForShot(shot);
  });

  const { animationPlan, metadata } = await workflow.createAnimationPlanWithMetadata(context);

  assert.equal(animationCalls.length, 3);
  assert.equal(staticProviderCalls.length, 0);
  assert.match(animationCalls[2].prompt, /ANIMATION_VIDEO_PROMPT_INITIAL_SEMANTIC_AUDIT_V2/u);
  assert.equal(animationPlan.productionStrategy.videoPromptProfile.profileId, "minimax_h3");
  assert.deepEqual(animationPlan.productionStrategy.recommendedShotDurationSeconds, { min: 4, max: 6 });
  animationPlan.shotPlan.forEach((shot) => {
    assert.ok(shot.durationSeconds >= 4 && shot.durationSeconds <= 6);
    assert.doesNotThrow(() => assertMiniMaxH3BasePrompt(shot.videoPrompt, {
      durationSeconds: shot.durationSeconds,
      dialogueTexts: miniMaxH3DialogueTexts(shot.dialogueOrSubtitle)
    }));
    assert.doesNotMatch(shot.videoPrompt, /<(?:Picture|Video|Audio)\s+\d+>/u);
  });
  assert.equal(metadata.videoPromptSemanticAudit.verdict, "pass");
});

test("H3 语义审计只重写受影响 videoPrompt，并复审目标镜头与相邻镜头后再签发", async () => {
  let foundation;
  let batch;
  let repairedPrompt;
  let auditRound = 0;
  let reviewAuditPayload;
  let semanticRepairPrompt = "";
  const debug = partialRepairDebugSpy("semantic-repair-debug");
  const { workflow, animationCalls, staticProviderCalls } = createLiveWorkflow((args, callNumber) => {
    if (/ANIMATION_VIDEO_PROMPT_INITIAL_SEMANTIC_AUDIT_V2/u.test(args.prompt)) {
      auditRound += 1;
      if (auditRound === 2) {
        reviewAuditPayload = animationVideoPromptSemanticAuditPayload(args.prompt);
      }
      return auditRound === 1
        ? failingVideoPromptAnimationSemanticAudit(args.prompt)
        : passingAnimationVideoPromptSemanticAudit(args.prompt);
    }
    if (/ANIMATION_VIDEO_PROMPT_SEMANTIC_REPAIR_V1/u.test(args.prompt)) {
      semanticRepairPrompt = args.prompt;
      return animationVideoPromptSemanticRepairEnvelope(args.prompt, [repairedPrompt]);
    }
    if (callNumber === 1) return structuredClone(foundation);
    if (callNumber === 2) return structuredClone(batch);
    throw new Error(`H3 语义有界修复出现意外的第 ${callNumber} 次模型调用`);
  }, { partialRepairDebugWriter: debug.writer });
  const context = {
    ...fixture(workflow),
    videoPromptTarget: { provider: "MiniMax", model: "MiniMax-H3" }
  };
  delete context.videoPromptProfile;
  const modelPlan = mockAnimationPlan(context);
  foundation = foundationFrom(modelPlan);
  batch = { shotPlan: structuredClone(modelPlan.shotPlan) };
  batch.shotPlan.forEach((shot) => {
    shot.videoPrompt = miniMaxH3PromptForShot(shot);
  });
  const originalBatch = structuredClone(batch);
  repairedPrompt = batch.shotPlan[0].videoPrompt.replace(
    "follows the specified camera sequence",
    "executes every signed camera beat in the specified order"
  );

  const { animationPlan, metadata } = await workflow.createAnimationPlanWithMetadata(context);

  assert.equal(animationCalls.length, 5, "Foundation + batch + audit + one repair + one re-audit");
  assert.equal(staticProviderCalls.length, 0);
  assert.equal(auditRound, 2);
  assert.deepEqual(reviewAuditPayload.shots.map((shot) => shot.shotId), ["A01", "A02"]);
  assert.ok(reviewAuditPayload.shots[0].authorityFacts.some(
    (fact) => fact.field === "adjacent.nextShot" && fact.value.shotId === "A02"
  ));
  assert.ok(reviewAuditPayload.shots[1].authorityFacts.some(
    (fact) => fact.field === "adjacent.previousShot" && fact.value.shotId === "A01"
  ));
  assert.match(semanticRepairPrompt, /ANIMATION_VIDEO_PROMPT_SEMANTIC_REPAIR_V1/u);
  const providerPayload = animationVideoPromptSemanticRepairPayload(semanticRepairPrompt);
  assert.equal(providerPayload.targets.length, 1);
  assert.equal(providerPayload.targets[0].currentValue, originalBatch.shotPlan[0].videoPrompt);
  for (const privateField of ["path", "baseDigest", "authorityDigest", "mutablePointers"]) {
    assert.equal(Object.hasOwn(providerPayload.targets[0], privateField), false);
  }
  assert.equal(animationPlan.shotPlan[0].videoPrompt, repairedPrompt);
  assert.deepEqual(animationPlan.shotPlan.slice(1), originalBatch.shotPlan.slice(1));
  assert.deepEqual(
    animationPlan.shotPlan.map((shot) => {
      const clone = structuredClone(shot);
      delete clone.videoPrompt;
      return clone;
    }),
    originalBatch.shotPlan.map((shot) => {
      const clone = structuredClone(shot);
      delete clone.videoPrompt;
      return clone;
    })
  );
  assert.deepEqual(metadata.videoPromptSemanticAudit.repairedShotIds, ["A01"]);
  assert.deepEqual(
    metadata.videoPromptSemanticAudit.reviewedShotIds,
    originalBatch.shotPlan.map((shot) => shot.shotId)
  );
  assert.deepEqual(metadata.videoPromptSemanticAudit.reReviewedShotIds, ["A01", "A02"]);
  assert.equal(metadata.videoPromptSemanticAudit.rounds, 2);
  assert.deepEqual(debug.events.map((event) => event.phase), ["begin", "response", "result"]);
  assert.equal(debug.events[0].payload.stage, "animationVideoPromptSemanticRepair");
  assert.equal(debug.events[2].result.status, "repaired");
});

test("live H3 初始 batch 缺两个 section 时只局部修复 videoPrompt，随后才执行语义审计", async () => {
  const fullStorySentinel = "UNRELATED_FULL_STORY_SENTINEL";
  const completePlanSentinel = "UNRELATED_COMPLETE_PLAN_SENTINEL";
  const otherShotSentinel = "UNRELATED_OTHER_SHOT_SENTINEL";
  let foundation;
  let batch;
  let repairedPrompt;
  let preservedIntegratedBody;
  let repairPrompt = "";
  const debug = partialRepairDebugSpy("h3-debug");
  const { workflow, animationCalls, staticProviderCalls } = createLiveWorkflow((args, callNumber) => {
    if (/ANIMATION_VIDEO_PROMPT_INITIAL_SEMANTIC_AUDIT_V2/u.test(args.prompt)) {
      return passingAnimationVideoPromptSemanticAudit(args.prompt);
    }
    if (/ARTIFACT_PARTIAL_REPAIR_V1/u.test(args.prompt)) {
      repairPrompt = args.prompt;
      return partialRepairEnvelope(args.prompt, [repairedPrompt]);
    }
    if (callNumber === 1) return structuredClone(foundation);
    if (callNumber === 2) return structuredClone(batch);
    throw new Error(`H3 有界纠错出现意外的第 ${callNumber} 次模型调用`);
  }, { partialRepairDebugWriter: debug.writer });
  const context = {
    ...fixture(workflow),
    videoPromptTarget: { provider: "MiniMax", model: "MiniMax-H3" }
  };
  delete context.videoPromptProfile;
  context.fullStory.shootingSynopsis = `${context.fullStory.shootingSynopsis} ${fullStorySentinel}`;
  const modelPlan = mockAnimationPlan(context);
  foundation = foundationFrom(modelPlan);
  foundation.title = completePlanSentinel;
  batch = { shotPlan: structuredClone(modelPlan.shotPlan) };
  batch.shotPlan.forEach((shot) => {
    shot.videoPrompt = miniMaxH3PromptForShot(shot);
  });
  batch.shotPlan[1].videoPrompt = batch.shotPlan[1].videoPrompt.replace(
    "The signed character",
    `${otherShotSentinel} The signed character`
  );
  repairedPrompt = miniMaxH3PromptForShot(batch.shotPlan[0]);
  preservedIntegratedBody = assertMiniMaxH3BasePrompt(repairedPrompt, {
    durationSeconds: batch.shotPlan[0].durationSeconds,
    dialogueTexts: miniMaxH3DialogueTexts(batch.shotPlan[0].dialogueOrSubtitle)
  }).sections.integrated_multimodal_description;
  batch.shotPlan[0].videoPrompt = repairedPrompt.split("\noverall_soundscape:")[0];
  const originalBatch = structuredClone(batch);

  const { animationPlan, metadata } = await workflow.createAnimationPlanWithMetadata(context);

  assert.equal(animationCalls.length, 4);
  assert.equal(staticProviderCalls.length, 0);
  assert.match(animationCalls[2].prompt, /ARTIFACT_PARTIAL_REPAIR_V1/u);
  assert.match(animationCalls[3].prompt, /ANIMATION_VIDEO_PROMPT_INITIAL_SEMANTIC_AUDIT_V2/u);
  assert.doesNotMatch(
    repairPrompt,
    new RegExp(`${fullStorySentinel}|${completePlanSentinel}|${otherShotSentinel}`, "u")
  );
  const repairPayload = partialRepairPayload(repairPrompt);
  assert.equal(repairPayload.targets.length, 1);
  assert.equal(repairPayload.targets[0].repairId, "R1");
  for (const privateField of ["path", "mutablePointers", "currentDigest", "adapterState"]) {
    assert.equal(
      Object.hasOwn(repairPayload.targets[0], privateField),
      false,
      `repair payload 不得向模型暴露服务端私有字段 ${privateField}`
    );
  }
  assert.equal(
    repairPayload.targets[0].modelContext.preservedSections.integrated_multimodal_description,
    preservedIntegratedBody,
    "首轮已经合法的 integrated 正文必须作为不可改写内容进入有界 repair"
  );
  assert.equal(animationPlan.title, completePlanSentinel);
  assert.equal(animationPlan.shotPlan[0].videoPrompt, repairedPrompt);
  assert.equal(
    assertMiniMaxH3BasePrompt(animationPlan.shotPlan[0].videoPrompt, {
      durationSeconds: animationPlan.shotPlan[0].durationSeconds,
      dialogueTexts: miniMaxH3DialogueTexts(animationPlan.shotPlan[0].dialogueOrSubtitle)
    }).sections.integrated_multimodal_description,
    preservedIntegratedBody,
    "repair 只能补齐 sound/music，不能改写合法 integrated"
  );
  assert.equal(animationPlan.shotPlan[1].videoPrompt, batch.shotPlan[1].videoPrompt);
  assert.deepEqual(
    animationPlan.shotPlan.map((shot) => {
      const copy = structuredClone(shot);
      delete copy.videoPrompt;
      return copy;
    }),
    originalBatch.shotPlan.map((shot) => {
      const copy = structuredClone(shot);
      delete copy.videoPrompt;
      return copy;
    })
  );
  assert.equal(metadata.videoPromptSemanticAudit.verdict, "pass");
  assert.deepEqual(debug.events.map((event) => event.phase), ["begin", "response", "result"]);
  assert.equal(debug.events[0].payload.stage, "animationShotPrompt");
  assert.equal(debug.events[0].payload.repairPlan.targets[0].path, "/shotPlan/0/videoPrompt");
  assert.equal(debug.events[2].result.status, "repaired");
});

test("live H3 batch 同时缺剧情场次覆盖与 Prompt section 时先 coverage fail，不签发局部修复", async () => {
  let foundation;
  let batch;
  const debug = partialRepairDebugSpy("must-not-start");
  const { workflow, animationCalls, staticProviderCalls } = createLiveWorkflow((args, callNumber) => {
    if (/ARTIFACT_PARTIAL_REPAIR_V1/u.test(args.prompt)) {
      throw new Error("coverage 失败后不得发起 H3 局部修复");
    }
    if (/ANIMATION_VIDEO_PROMPT_INITIAL_SEMANTIC_AUDIT_V2/u.test(args.prompt)) {
      throw new Error("coverage 失败后不得执行 H3 语义审计");
    }
    if (callNumber === 1) return structuredClone(foundation);
    if (callNumber === 2) return structuredClone(batch);
    throw new Error(`coverage 优先级测试出现意外的第 ${callNumber} 次模型调用`);
  }, { partialRepairDebugWriter: debug.writer });
  const context = {
    ...fixture(workflow),
    videoPromptTarget: { provider: "MiniMax", model: "MiniMax-H3" }
  };
  delete context.videoPromptProfile;
  const modelPlan = mockAnimationPlan(context);
  foundation = foundationFrom(modelPlan);
  batch = { shotPlan: structuredClone(modelPlan.shotPlan) };
  batch.shotPlan.forEach((shot) => {
    shot.videoPrompt = miniMaxH3PromptForShot(shot);
  });
  batch.shotPlan[0].videoPrompt =
    "integrated_multimodal_description: [Shot 1] The signed action reaches its visible final state.";
  const missingSourceSceneId = batch.shotPlan.at(-1).sourceSceneId;
  batch.shotPlan.pop();

  await assert.rejects(
    () => workflow.createAnimationPlanWithMetadata(context),
    new RegExp(`animationShotBatch 未覆盖当前批次剧情场次：${missingSourceSceneId}`, "u")
  );

  assert.equal(animationCalls.length, 2);
  assert.equal(staticProviderCalls.length, 0);
  assert.equal(
    animationCalls.some((call) => /ARTIFACT_PARTIAL_REPAIR_V1/u.test(call.prompt)),
    false
  );
  assert.equal(
    animationCalls.some((call) => /ANIMATION_VIDEO_PROMPT_INITIAL_SEMANTIC_AUDIT_V2/u.test(call.prompt)),
    false
  );
  assert.deepEqual(debug.events, [], "没有签发 repair plan 时不得创建 debug session");
});

test("live H3 局部修复以 deterministic negative prune 后的 canonical batch 为不变基线", async () => {
  const pruneSentinel = "H3_NEGATIVE_PROMPT_PRUNE_SENTINEL";
  let foundation;
  let batch;
  let repairedPrompt;
  let repairPrompt = "";
  const { workflow, animationCalls } = createLiveWorkflow((args, callNumber) => {
    if (/ANIMATION_VIDEO_PROMPT_INITIAL_SEMANTIC_AUDIT_V2/u.test(args.prompt)) {
      return passingAnimationVideoPromptSemanticAudit(args.prompt);
    }
    if (/ARTIFACT_PARTIAL_REPAIR_V1/u.test(args.prompt)) {
      repairPrompt = args.prompt;
      return partialRepairEnvelope(args.prompt, [repairedPrompt]);
    }
    if (callNumber === 1) return structuredClone(foundation);
    if (callNumber === 2) return structuredClone(batch);
    throw new Error(`H3 canonical baseline 测试出现意外的第 ${callNumber} 次模型调用`);
  });
  const context = {
    ...fixture(workflow),
    videoPromptTarget: { provider: "MiniMax", model: "MiniMax-H3" }
  };
  delete context.videoPromptProfile;
  const modelPlan = mockAnimationPlan(context);
  foundation = foundationFrom(modelPlan);
  batch = { shotPlan: structuredClone(modelPlan.shotPlan) };
  batch.shotPlan.forEach((shot) => {
    shot.videoPrompt = miniMaxH3PromptForShot(shot);
  });
  repairedPrompt = miniMaxH3PromptForShot(batch.shotPlan[0]);
  batch.shotPlan[0].videoPrompt = repairedPrompt.split("\noverall_soundscape:")[0];
  batch.shotPlan[0].negativePrompts.video.push({
    text: pruneSentinel,
    appliesTo: "video",
    triggerEvidence: [{
      sourcePath: `animationPlan.shotPlan[${batch.shotPlan[0].shotId}].videoPrompt`,
      evidence: "EVIDENCE_NOT_PRESENT_IN_THE_SIGNED_PROMPT"
    }],
    reasonCode: "temporal_consistency_failure",
    priority: "medium",
    enabled: true
  });
  const originalBatch = structuredClone(batch);
  const canonicalBaseline = pruneAnimationPlanNegativePrompts({
    ...structuredClone(foundation),
    shotPlan: structuredClone(batch.shotPlan)
  }, context).shotPlan;

  const { animationPlan } = await workflow.createAnimationPlanWithMetadata(context);

  assert.equal(animationCalls.length, 4);
  assert.match(repairPrompt, /ARTIFACT_PARTIAL_REPAIR_V1/u);
  const repairPayload = partialRepairPayload(repairPrompt);
  assert.deepEqual(
    repairPayload.targets[0].modelContext.candidateShotFacts.negativePrompts,
    canonicalBaseline[0].negativePrompts,
    "repair 计划必须使用 prune 后的 canonical 镜头事实"
  );
  assert.equal(JSON.stringify(repairPayload).includes(pruneSentinel), false);
  assert.equal(
    originalBatch.shotPlan[0].negativePrompts.video.some((item) => item.text === pruneSentinel),
    true,
    "原始模型候选必须保持不变"
  );
  assert.equal(
    animationPlan.shotPlan[0].negativePrompts.video.some((item) => item.text === pruneSentinel),
    false
  );
  const withoutVideoPrompt = (shots) => shots.map((shot) => {
    const clone = structuredClone(shot);
    delete clone.videoPrompt;
    return clone;
  });
  assert.deepEqual(
    withoutVideoPrompt(animationPlan.shotPlan),
    withoutVideoPrompt(canonicalBaseline),
    "repair 后完整校验不得再改写 canonical baseline 中的非 videoPrompt 字段"
  );
  assert.equal(animationPlan.shotPlan[0].videoPrompt, repairedPrompt);
});

test("live H3 唯一一次局部 replacement 仍缺 section 时明确失败，不整批重试也不执行语义审计", async () => {
  let foundation;
  let batch;
  const debug = partialRepairDebugSpy("h3-rejected-debug");
  const { workflow, animationCalls } = createLiveWorkflow((args, callNumber) => {
    if (/ANIMATION_VIDEO_PROMPT_INITIAL_SEMANTIC_AUDIT_V2/u.test(args.prompt)) {
      throw new Error("坏 replacement 后不得执行 H3 语义审计");
    }
    if (/ARTIFACT_PARTIAL_REPAIR_V1/u.test(args.prompt)) {
      return partialRepairEnvelope(args.prompt, [
        "integrated_multimodal_description: [Shot 1] The signed action reaches its visible final state."
      ]);
    }
    if (callNumber === 1) return structuredClone(foundation);
    if (callNumber === 2) return structuredClone(batch);
    throw new Error(`H3 坏 replacement 后出现意外的第 ${callNumber} 次模型调用`);
  }, { partialRepairDebugWriter: debug.writer });
  const context = {
    ...fixture(workflow),
    videoPromptTarget: { provider: "MiniMax", model: "MiniMax-H3" }
  };
  delete context.videoPromptProfile;
  const modelPlan = mockAnimationPlan(context);
  foundation = foundationFrom(modelPlan);
  batch = { shotPlan: structuredClone(modelPlan.shotPlan) };
  batch.shotPlan.forEach((shot) => {
    shot.videoPrompt = miniMaxH3PromptForShot(shot);
  });
  batch.shotPlan[0].videoPrompt = miniMaxH3PromptForShot(
    batch.shotPlan[0]
  ).split("\noverall_soundscape:")[0];

  await assert.rejects(
    () => workflow.createAnimationPlanWithMetadata(context),
    /有界局部纠错失败|H3.*section|H3 段落/u
  );

  assert.equal(animationCalls.length, 3);
  assert.match(animationCalls[2].prompt, /ARTIFACT_PARTIAL_REPAIR_V1/u);
  assert.equal(
    animationCalls.some((call) => /ANIMATION_SHOT_BATCH_RETRY_V1/u.test(call.prompt)),
    false
  );
  assert.equal(
    animationCalls.some((call) => /ANIMATION_VIDEO_PROMPT_INITIAL_SEMANTIC_AUDIT_V2/u.test(call.prompt)),
    false
  );
  assert.deepEqual(debug.events.map((event) => event.phase), ["begin", "response", "result"]);
  assert.equal(debug.events[2].result.status, "rejected");
});

test("live H3 局部 repair envelope 含额外字段或错误 repairId 时原子终止且没有第三次 batch 调用", async (t) => {
  const cases = [
    {
      name: "envelope 顶层额外字段",
      corrupt: (value) => ({ ...value, unexpected: "forbidden" })
    },
    {
      name: "repair item 夹带 path",
      corrupt: (value) => ({
        ...value,
        repairs: [{ ...value.repairs[0], path: "/shotPlan/0/videoPrompt" }]
      })
    },
    {
      name: "错误 repairId",
      corrupt: (value) => ({
        ...value,
        repairs: [{ ...value.repairs[0], repairId: "R999" }]
      })
    }
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      let foundation;
      let batch;
      let repairedPrompt;
      const { workflow, animationCalls, staticProviderCalls } = createLiveWorkflow((args, callNumber) => {
        if (/ANIMATION_VIDEO_PROMPT_INITIAL_SEMANTIC_AUDIT_V2/u.test(args.prompt)) {
          throw new Error("非法 repair envelope 后不得执行 H3 语义审计");
        }
        if (/ARTIFACT_PARTIAL_REPAIR_V1/u.test(args.prompt)) {
          return scenario.corrupt(partialRepairEnvelope(args.prompt, [repairedPrompt]));
        }
        if (callNumber === 1) return structuredClone(foundation);
        if (callNumber === 2) return structuredClone(batch);
        throw new Error(`非法 repair envelope 后出现意外的第 ${callNumber} 次模型调用`);
      });
      const context = {
        ...fixture(workflow),
        videoPromptTarget: { provider: "MiniMax", model: "MiniMax-H3" }
      };
      delete context.videoPromptProfile;
      const modelPlan = mockAnimationPlan(context);
      foundation = foundationFrom(modelPlan);
      batch = { shotPlan: structuredClone(modelPlan.shotPlan) };
      batch.shotPlan.forEach((shot) => {
        shot.videoPrompt = miniMaxH3PromptForShot(shot);
      });
      repairedPrompt = miniMaxH3PromptForShot(batch.shotPlan[0]);
      batch.shotPlan[0].videoPrompt = repairedPrompt.split("\noverall_soundscape:")[0];
      const originalBatch = structuredClone(batch);

      await assert.rejects(
        () => workflow.createAnimationPlanWithMetadata(context),
        /有界局部纠错失败|只允许|repairId/u
      );

      assert.equal(animationCalls.length, 3, "foundation + 首轮 batch + 唯一 repair 后必须终止");
      assert.match(animationCalls[2].prompt, /ARTIFACT_PARTIAL_REPAIR_V1/u);
      assert.equal(
        animationCalls.some((call) => /ANIMATION_SHOT_BATCH_RETRY_V1/u.test(call.prompt)),
        false
      );
      assert.equal(
        animationCalls.some((call) => /ANIMATION_VIDEO_PROMPT_INITIAL_SEMANTIC_AUDIT_V2/u.test(call.prompt)),
        false
      );
      assert.deepEqual(batch, originalBatch, "失败 repair 不得回写首轮候选");
      assert.equal(staticProviderCalls.length, 0);
    });
  }
});

test("live H3 integrated 自身非法或重复时 fail closed，默认两场首批当场停止", async (t) => {
  const cases = [
    {
      name: "integrated 含未授权中文正文",
      corrupt: (prompt) => prompt.replace(
        "The signed character",
        "温暖 The signed character"
      )
    },
    {
      name: "integrated heading 重复",
      corrupt: (prompt) => `${prompt}\nintegrated_multimodal_description: [Shot 1] A duplicate body must not gain repair authority.`
    }
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      let foundation;
      let firstBatch;
      const { workflow, animationCalls, staticProviderCalls } = createLiveWorkflow((args, callNumber) => {
        if (/ARTIFACT_PARTIAL_REPAIR_V1/u.test(args.prompt)) {
          throw new Error("integrated 不可信时不得签发局部 repair");
        }
        if (callNumber === 1) return structuredClone(foundation);
        if (callNumber === 2) return structuredClone(firstBatch);
        throw new Error(`首批 fail closed 后出现意外的第 ${callNumber} 次模型调用`);
      }, {
        // Omit the constructor override and exercise WorkflowService's real
        // production default of two source scenes per batch.
        animationShotBatchSceneCount: null
      });
      const context = {
        ...fixture(workflow),
        videoPromptTarget: { provider: "MiniMax", model: "MiniMax-H3" }
      };
      delete context.videoPromptProfile;
      const modelPlan = mockAnimationPlan(context);
      foundation = foundationFrom(modelPlan);
      const firstSourceSceneIds = new Set(
        context.fullStory.sceneScript.slice(0, 2).map((scene) => scene.sceneId)
      );
      firstBatch = {
        shotPlan: structuredClone(modelPlan.shotPlan.filter(
          (shot) => firstSourceSceneIds.has(shot.sourceSceneId)
        ))
      };
      firstBatch.shotPlan.forEach((shot) => {
        shot.videoPrompt = miniMaxH3PromptForShot(shot);
      });
      firstBatch.shotPlan[0].videoPrompt = scenario.corrupt(firstBatch.shotPlan[0].videoPrompt);

      await assert.rejects(
        () => workflow.createAnimationPlanWithMetadata(context),
        /H3|英文|段落|section/u
      );

      assert.equal(animationCalls.length, 2, "foundation 与坏首批后必须停止，不能生成第二批");
      assert.match(animationCalls[1].prompt, /批次：第 1 批/u);
      assert.match(animationCalls[1].prompt, /本批允许的 sourceSceneId：S1、S2/u);
      assert.equal(
        animationCalls.some((call) => /批次：第 2 批/u.test(call.prompt)),
        false
      );
      assert.equal(
        animationCalls.some((call) => /ARTIFACT_PARTIAL_REPAIR_V1/u.test(call.prompt)),
        false
      );
      assert.equal(staticProviderCalls.length, 0);
    });
  }
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

test("live H3 Foundation 同时有可修角色错误与非 4–6 秒范围时优先 fail closed，不签发 Foundation repair", async () => {
  let invalidFoundation;
  const debug = partialRepairDebugSpy("foundation-must-not-start");
  const { workflow, animationCalls, staticProviderCalls } = createLiveWorkflow((args, callNumber) => {
    if (/ARTIFACT_PARTIAL_REPAIR_V1/u.test(args.prompt)) {
      throw new Error("Foundation 存在非局修 duration 错误时不得发起角色局部修复");
    }
    if (callNumber === 1) return structuredClone(invalidFoundation);
    throw new Error(`Foundation 混合错误测试出现意外的第 ${callNumber} 次模型调用`);
  }, { partialRepairDebugWriter: debug.writer });
  const baseContext = {
    ...fixture(workflow),
    videoPromptTarget: { provider: "MiniMax", model: "MiniMax-H3" }
  };
  delete baseContext.videoPromptProfile;
  const creatorProfile = {
    ...baseContext.creatorProfile,
    fixedCharacter: "阿岚，社区修理师，活泼可爱，懂事"
  };
  const context = withGlobalCharacterBoundary(workflow, {
    ...baseContext,
    creatorProfile
  }, fixedCharacterRepairBoundary());
  invalidFoundation = foundationFrom(mockAnimationPlan(context));
  invalidFoundation.productionStrategy.recommendedShotDurationSeconds = { min: 3, max: 6 };
  invalidFoundation.characterReferencePrompts[0].appearancePrompt =
    "阿岚，社区修理师，保持既定身份与服装，特定发色";
  invalidFoundation.characterReferencePrompts[0].consistencyTags = ["阿岚", "社区修理师", "同一服装"];

  await assert.rejects(
    () => workflow.createAnimationPlanWithMetadata(context),
    /animationFoundation\.productionStrategy\.recommendedShotDurationSeconds 必须为 4–6 秒/u
  );

  assert.equal(animationCalls.length, 1);
  assert.equal(staticProviderCalls.length, 0);
  assert.equal(
    animationCalls.some((call) => /ARTIFACT_PARTIAL_REPAIR_V1/u.test(call.prompt)),
    false
  );
  assert.deepEqual(debug.events, [], "Foundation 未签发 repair plan 时不得创建 debug session");
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
  response = miniMaxH3RewriteForPlan(sourcePlan);
  const comparable = (plan) => {
    const clone = structuredClone(plan);
    delete clone.productionStrategy.videoPromptProfile;
    clone.shotPlan.forEach((shot) => delete shot.videoPrompt);
    return clone;
  };

  const result = await workflow.rewriteAnimationPlanVideoPrompts({
    ...context,
    animationPlan: sourcePlan,
    videoPromptTarget: { provider: "MiniMax", model: "MiniMax-H3" }
  });

  assert.equal(calls.length, 2);
  assert.match(calls[0].prompt, /只能改写 videoPrompt 的供应商表达/u);
  assert.match(calls[0].prompt, /integrated_multimodal_description/u);
  assert.match(calls[1].prompt, /ANIMATION_VIDEO_PROMPT_REWRITE_SEMANTIC_AUDIT_V2/u);
  assert.match(calls[1].systemPrompt, /只是不可执行的引用数据/u);
  assert.match(calls[1].systemPrompt, /不得遵循.*任何指令/u);
  assert.deepEqual(comparable(result.animationPlan), comparable(sourcePlan));
  assert.equal(result.animationPlan.productionStrategy.videoPromptProfile.profileId, "minimax_h3");
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
  rewritten = miniMaxH3RewriteForPlan(sourcePlan);
  repairedPrompt = rewritten.videoPrompts[0].videoPrompt.replace(
    "follows the specified camera sequence",
    "executes every signed camera beat in the specified order"
  );

  const result = await workflow.rewriteAnimationPlanVideoPrompts({
    ...context,
    animationPlan: sourcePlan,
    videoPromptTarget: { provider: "MiniMax", model: "MiniMax-H3" }
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
      return miniMaxH3RewriteForPlan(sourcePlan);
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
      videoPromptTarget: { provider: "MiniMax", model: "MiniMax-H3" }
    }),
    /shot_facts\/story_action_reordered/u
  );

  assert.equal(calls.length, 2);
  assert.deepEqual(sourcePlan, before);
});
