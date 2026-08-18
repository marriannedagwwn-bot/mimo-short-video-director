import assert from "node:assert/strict";
import test from "node:test";

import { resolveVideoPromptProfile } from "../public/video-prompt-profiles.js";
import {
  ANIMATION_VIDEO_PROMPT_SEMANTIC_REPAIR_MAX_ATTEMPTS,
  ANIMATION_VIDEO_PROMPT_SEMANTIC_REPAIR_MAX_TARGETS,
  ANIMATION_VIDEO_PROMPT_SEMANTIC_REPAIR_SCHEMA_VERSION,
  animationVideoPromptSemanticRepairPrompt,
  mergeAnimationVideoPromptSemanticRepair,
  planAnimationVideoPromptSemanticRepair,
  serializeAnimationVideoPromptSemanticRepairPlan
} from "../src/animation-video-prompt-semantic-repair.js";
import {
  ANIMATION_VIDEO_PROMPT_SEMANTIC_AUDIT_SCHEMA_VERSION,
  createAnimationVideoPromptSemanticAuditCatalog,
  validateAnimationVideoPromptSemanticAuditResponse
} from "../src/animation-video-prompt-semantic-audit.js";
import { contentDigest } from "../src/production-lineage.js";
import { OutputContractError } from "../src/validation.js";

const H3_PROFILE = resolveVideoPromptProfile({
  provider: "MiniMax",
  model: "MiniMax-H3"
});

function h3Prompt(marker) {
  return [
    `integrated_multimodal_description: [Shot 1] Warm afternoon light fills the rural courtyard. Xiaobaizi completes the signed visible action and holds its final state while the camera follows the required sequence. ${marker}`,
    "overall_soundscape: Light footsteps, cloth movement, and the signed rural ambience remain synchronized with the visible action.",
    "non_diegetic_music: A restrained acoustic cue at a slow tempo that softens and resolves after the visible action."
  ].join("\n");
}

function directShot(index) {
  const number = index + 1;
  const shotId = `A${String(number).padStart(2, "0")}`;
  return {
    shotId,
    sourceSceneId: `S${number}`,
    sceneId: `LOC${String(number).padStart(2, "0")}`,
    durationSeconds: 5,
    storyPurpose: `${shotId} 完成权威剧情动作`,
    emotionalTarget: "温暖而安定",
    videoPrompt: h3Prompt(`${shotId}_ORIGINAL_PROMPT_SENTINEL`),
    cameraMotion: "中景跟随，关键动作特写，结尾停在可见完成状态",
    characterAction: `小白子完成 ${shotId} 的权威动作并停住`,
    dialogueOrSubtitle: "",
    soundDesign: "脚步声、布料声和乡村环境声",
    continuityNotes: `${shotId} 的服装、道具与光线方向保持连续`,
    negativePrompts: { image: [], video: [] },
    acceptanceCriteria: [
      `${shotId} 的动作顺序和可见终点完整出现`,
      "中景、关键动作特写和结尾状态按顺序出现"
    ]
  };
}

function candidatePlan(count = 3) {
  const shots = Array.from({ length: count }, (_, index) => directShot(index));
  return {
    promptSchemaVersion: "3.0",
    selectedVariantId: "V1",
    title: "SEMANTIC_REPAIR_PLAN_SENTINEL",
    productionStrategy: {
      format: "direct_shot_video",
      targetAspectRatio: "9:16",
      videoPromptProfile: structuredClone(H3_PROFILE)
    },
    visualBible: {
      animationStyle: "Japanese 2.5D animation",
      lighting: "warm physical afternoon light"
    },
    characterReferencePrompts: [{
      characterName: "小白子",
      appearancePrompt: "Q-version wolf-eared girl in a brown linen top and navy pinafore",
      consistencyTags: ["wolf ears", "brown linen top", "navy pinafore"]
    }],
    sceneReferencePrompts: shots.map((shot) => ({
      sceneId: shot.sceneId,
      environmentPrompt: `${shot.sceneId} rural courtyard environment`,
      consistencyTags: [shot.sceneId, "rural afternoon"]
    })),
    assetPrompts: [{
      assetName: "一束野花",
      storyFunction: "表达感谢",
      imagePrompt: "lavender and white wildflowers tied with hemp string",
      consistencyTags: ["lavender flowers", "white flowers", "hemp string"],
      avoidSimilarityNote: "Do not replace the flowers with roses."
    }],
    shotPlan: shots,
    editPlan: {},
    generationChecklist: [],
    modelAgnosticNotes: "UNRELATED_TOP_LEVEL_SENTINEL",
    continuityAndSafetyCheck: {},
    uncertainties: []
  };
}

function fullStoryFor(candidate) {
  return {
    keyProps: [{
      name: "一束野花",
      storyFunction: "小白子用来表达感谢"
    }],
    sceneScript: candidate.shotPlan.map((shot) => ({
      sceneId: shot.sourceSceneId,
      location: `${shot.sourceSceneId} 的权威乡村地点`,
      characters: ["小白子"],
      visibleAction: shot.characterAction,
      dialogue: shot.dialogueOrSubtitle,
      shotAndSound: shot.soundDesign,
      shootingNotes: shot.cameraMotion
    }))
  };
}

function visualGuardrails() {
  return {
    fixedCharacterBoundary: {
      schemaVersion: "2.0",
      characterName: "小白子",
      canonicalDescription: "Q版狼耳少女，活泼可爱且懂事。",
      bodyForm: "保持人形少女结构与狼耳。",
      requiredTraits: [],
      allowedTraits: [],
      forbiddenTraits: [],
      unresolvedConflicts: [],
      sourceDigest: "sha256:source-sentinel",
      boundaryDigest: "sha256:boundary-sentinel",
      boundarySignature: "signature-sentinel"
    }
  };
}

function videoPromptIssue(shotId, overrides = {}) {
  return {
    layer: "video_prompt",
    field: "videoPrompt",
    category: "camera",
    relation: "required_camera_beat_missing",
    authorityFactId: `${shotId}.exactShot.cameraMotion`,
    candidateFieldId: `${shotId}.videoPrompt`,
    authorityExcerpt: "关键动作特写",
    candidateExcerpt: "the camera follows the required sequence",
    productionImpact: "关键动作可能不会在签发的特写节点中出现",
    ...overrides
  };
}

function semanticAuditCatalog(candidate) {
  return createAnimationVideoPromptSemanticAuditCatalog({
    shots: candidate.shotPlan.map((shot) => ({
      shotId: shot.shotId,
      authorityFacts: [
        {
          authorityFactId: `${shot.shotId}.exactShot.cameraMotion`,
          tier: "exact_shot",
          field: "cameraMotion",
          value: shot.cameraMotion
        },
        {
          authorityFactId: `${shot.shotId}.fullStory.characters`,
          tier: "full_story",
          field: "characters",
          value: ["小白子"]
        }
      ],
      candidateFields: [
        {
          candidateFieldId: `${shot.shotId}.exactShot.characterAction`,
          layer: "shot_facts",
          field: "characterAction",
          value: shot.characterAction
        },
        {
          candidateFieldId: `${shot.shotId}.videoPrompt`,
          layer: "video_prompt",
          field: "videoPrompt",
          value: shot.videoPrompt
        }
      ]
    }))
  }, { candidate });
}

function semanticAudit(candidate, failedIndexes = []) {
  const failed = new Set(failedIndexes);
  const response = {
    schemaVersion: ANIMATION_VIDEO_PROMPT_SEMANTIC_AUDIT_SCHEMA_VERSION,
    shots: candidate.shotPlan.map((shot, index) => ({
      shotId: shot.shotId,
      shotFactsVerdict: "pass",
      videoPromptVerdict: failed.has(index) ? "fail" : "pass",
      issues: failed.has(index) ? [videoPromptIssue(shot.shotId)] : []
    }))
  };
  return validateAnimationVideoPromptSemanticAuditResponse(
    response,
    semanticAuditCatalog(candidate)
  );
}

function repairContext(candidate, audit, overrides = {}) {
  return {
    audit,
    fullStory: fullStoryFor(candidate),
    visualGuardrails: visualGuardrails(),
    planIdentity: {
      projectId: "project-sentinel",
      runId: "run-sentinel",
      requestId: "request-sentinel"
    },
    ...overrides
  };
}

function planRepair(candidate, audit, overrides = {}) {
  return planAnimationVideoPromptSemanticRepair(
    candidate,
    audit,
    repairContext(candidate, audit, overrides)
  );
}

function repairEnvelope(plan, replacements) {
  return {
    schemaVersion: ANIMATION_VIDEO_PROMPT_SEMANTIC_REPAIR_SCHEMA_VERSION,
    repairs: replacements.map((replacement, index) => ({
      repairId: plan.targets[index].repairId,
      replacement
    }))
  };
}

function assertNoPrivateKeys(value) {
  const forbidden = new Set([
    "path",
    "mutablePointers",
    "baseDigest",
    "authorityDigest",
    "currentDigest",
    "adapterState",
    "boundarySignature",
    "sourceDigest",
    "boundaryDigest",
    "planIdentity"
  ]);
  const visit = (item) => {
    if (!item || typeof item !== "object") return;
    for (const [key, child] of Object.entries(item)) {
      assert.equal(forbidden.has(key), false, `provider payload leaked private key ${key}`);
      visit(child);
    }
  };
  visit(value);
}

test("多镜 semantic audit 只签发 failed videoPrompt 并按原顺序原子合并", () => {
  const candidate = candidatePlan();
  const audit = semanticAudit(candidate, [0, 2]);
  const context = repairContext(candidate, audit);
  const plan = planAnimationVideoPromptSemanticRepair(candidate, audit, context);

  assert.ok(plan);
  assert.equal(ANIMATION_VIDEO_PROMPT_SEMANTIC_REPAIR_MAX_ATTEMPTS, 1);
  assert.equal(ANIMATION_VIDEO_PROMPT_SEMANTIC_REPAIR_MAX_TARGETS, 12);
  assert.deepEqual(plan.targets.map((target) => target.path), [
    "/shotPlan/0/videoPrompt",
    "/shotPlan/2/videoPrompt"
  ]);
  assert.deepEqual(plan.targets.map((target) => target.repairId), ["R1", "R2"]);

  const providerPayload = serializeAnimationVideoPromptSemanticRepairPlan(plan);
  assert.deepEqual(Object.keys(providerPayload), ["schemaVersion", "targets"]);
  assertNoPrivateKeys(providerPayload);
  assert.equal(providerPayload.targets.length, 2);
  assert.deepEqual(Object.keys(providerPayload.targets[0]), [
    "repairId",
    "currentValue",
    "diagnostics",
    "authority"
  ]);
  assert.equal(
    providerPayload.targets[0].authority.foundationLocks.assetPrompts[0].imagePrompt,
    candidate.assetPrompts[0].imagePrompt
  );
  assert.equal(
    providerPayload.targets[0].authority.exactShotFacts.videoPrompt,
    undefined
  );
  assert.equal(
    JSON.stringify(providerPayload).includes("UNRELATED_TOP_LEVEL_SENTINEL"),
    false
  );
  const prompt = animationVideoPromptSemanticRepairPrompt(plan);
  assert.match(prompt, /ANIMATION_VIDEO_PROMPT_SEMANTIC_REPAIR_V1/u);
  assert.match(prompt, /repairs must have exactly the same count and order/u);
  assert.doesNotMatch(prompt, /UNRELATED_TOP_LEVEL_SENTINEL/u);

  const beforeDigest = contentDigest(candidate);
  const firstReplacement = h3Prompt("A01_REPAIRED_PROMPT_SENTINEL");
  const thirdReplacement = h3Prompt("A03_REPAIRED_PROMPT_SENTINEL");
  let callerValidationCount = 0;
  const merged = mergeAnimationVideoPromptSemanticRepair(
    candidate,
    repairEnvelope(plan, [firstReplacement, thirdReplacement]),
    plan,
    {
      ...context,
      validateMerged({ candidate: validatedCandidate }) {
        callerValidationCount += 1;
        assert.equal(validatedCandidate.shotPlan[0].videoPrompt, firstReplacement);
        assert.equal(validatedCandidate.shotPlan[2].videoPrompt, thirdReplacement);
        return true;
      }
    }
  );

  assert.equal(callerValidationCount, 1);
  assert.equal(contentDigest(candidate), beforeDigest);
  assert.equal(merged.shotPlan[0].videoPrompt, firstReplacement);
  assert.equal(merged.shotPlan[2].videoPrompt, thirdReplacement);
  assert.deepEqual(merged.shotPlan[1], candidate.shotPlan[1]);
  for (const index of [0, 2]) {
    assert.deepEqual(
      { ...merged.shotPlan[index], videoPrompt: candidate.shotPlan[index].videoPrompt },
      candidate.shotPlan[index]
    );
  }
  assert.equal(merged.modelAgnosticNotes, candidate.modelAgnosticNotes);
});

test("任一结构化 shot 冲突或 uncertain 时整个 semantic repair 不签 plan", () => {
  const candidate = candidatePlan();
  const repairableAudit = semanticAudit(candidate, [0]);

  const structuredConflictResponse = structuredClone(repairableAudit);
  structuredConflictResponse.shots[1] = {
    shotId: "A02",
    shotFactsVerdict: "fail",
    videoPromptVerdict: "not_evaluated",
    issues: [videoPromptIssue("A02", {
      layer: "shot_facts",
      field: "characterAction",
      category: "cast",
      relation: "extra_visible_cast_added",
      authorityFactId: "A02.fullStory.characters",
      candidateFieldId: "A02.exactShot.characterAction",
      authorityExcerpt: "小白子",
      candidateExcerpt: "小白子"
    })]
  };
  const structuredConflict = validateAnimationVideoPromptSemanticAuditResponse(
    structuredConflictResponse,
    semanticAuditCatalog(candidate)
  );
  assert.equal(planRepair(candidate, structuredConflict), null);

  const uncertain = structuredClone(repairableAudit);
  uncertain.shots[1].shotFactsVerdict = "uncertain";
  assert.throws(
    () => planRepair(candidate, uncertain),
    /校验签发/u
  );

  const mixedLayer = structuredClone(repairableAudit);
  mixedLayer.shots[0].issues[0].layer = "shot_facts";
  assert.throws(
    () => planRepair(candidate, mixedLayer),
    /校验签发/u
  );

  const malformedPass = structuredClone(repairableAudit);
  malformedPass.shots[1].issues = [videoPromptIssue("A02")];
  assert.throws(
    () => planRepair(candidate, malformedPass),
    /校验签发/u
  );
});

test("audit 必须完整、同序且只能映射服务端已有 shotId", () => {
  const candidate = candidatePlan();
  const audit = semanticAudit(candidate, [0]);

  const missing = structuredClone(audit);
  missing.shots.pop();
  assert.throws(() => planRepair(candidate, missing), /校验签发/u);

  const reordered = structuredClone(audit);
  [reordered.shots[0], reordered.shots[1]] = [reordered.shots[1], reordered.shots[0]];
  assert.throws(() => planRepair(candidate, reordered), /校验签发/u);

  const forgedId = structuredClone(audit);
  forgedId.shots[0].shotId = "A99";
  assert.throws(() => planRepair(candidate, forgedId), /校验签发/u);

  const extraAuditField = structuredClone(audit);
  extraAuditField.shots[0].path = "/shotPlan/0/videoPrompt";
  assert.throws(() => planRepair(candidate, extraAuditField), /校验签发/u);

  const alreadyPassed = semanticAudit(candidate, []);
  assert.equal(planRepair(candidate, alreadyPassed), null);
});

test("provider envelope 拒绝 path/op、额外字段、对象 replacement 与乱序 repairId", () => {
  const candidate = candidatePlan();
  const audit = semanticAudit(candidate, [0, 2]);
  const context = repairContext(candidate, audit);
  const plan = planAnimationVideoPromptSemanticRepair(candidate, audit, context);
  const replacements = [
    h3Prompt("A01_REPAIRED_PROMPT_SENTINEL"),
    h3Prompt("A03_REPAIRED_PROMPT_SENTINEL")
  ];
  const validEnvelope = repairEnvelope(plan, replacements);

  const extraPath = structuredClone(validEnvelope);
  extraPath.repairs[0].path = "/shotPlan/0/videoPrompt";
  assert.throws(
    () => mergeAnimationVideoPromptSemanticRepair(candidate, extraPath, plan, context),
    OutputContractError
  );

  const extraOperation = structuredClone(validEnvelope);
  extraOperation.repairs[0].op = "replace";
  assert.throws(
    () => mergeAnimationVideoPromptSemanticRepair(candidate, extraOperation, plan, context),
    OutputContractError
  );

  const topLevelDigest = structuredClone(validEnvelope);
  topLevelDigest.baseDigest = plan.baseDigest;
  assert.throws(
    () => mergeAnimationVideoPromptSemanticRepair(candidate, topLevelDigest, plan, context),
    OutputContractError
  );

  const objectReplacement = structuredClone(validEnvelope);
  objectReplacement.repairs[0].replacement = {
    videoPrompt: replacements[0],
    cameraMotion: "越权修改摄影字段"
  };
  assert.throws(
    () => mergeAnimationVideoPromptSemanticRepair(candidate, objectReplacement, plan, context),
    OutputContractError
  );

  const wrongOrder = structuredClone(validEnvelope);
  [wrongOrder.repairs[0].repairId, wrongOrder.repairs[1].repairId] = ["R2", "R1"];
  assert.throws(
    () => mergeAnimationVideoPromptSemanticRepair(candidate, wrongOrder, plan, context),
    /repairs\[0\]\.repairId/u
  );
});

test("旧 candidate digest、变化的 authority/plan identity 与克隆 plan 均被拒绝", () => {
  const candidate = candidatePlan();
  const audit = semanticAudit(candidate, [0]);
  const context = repairContext(candidate, audit);
  const plan = planAnimationVideoPromptSemanticRepair(candidate, audit, context);
  const envelope = repairEnvelope(plan, [h3Prompt("A01_REPAIRED_PROMPT_SENTINEL")]);

  const staleCandidate = structuredClone(candidate);
  staleCandidate.shotPlan[1].storyPurpose = "上次签发计划之后已经变化";
  assert.throws(
    () => mergeAnimationVideoPromptSemanticRepair(staleCandidate, envelope, plan, context),
    /candidate digest/u
  );

  const sameShotIdsDifferentCandidate = structuredClone(candidate);
  sameShotIdsDifferentCandidate.shotPlan[0].videoPrompt = h3Prompt(
    "SAME_SHOT_ID_DIFFERENT_CANDIDATE_SENTINEL"
  );
  assert.throws(
    () => planAnimationVideoPromptSemanticRepair(
      sameShotIdsDifferentCandidate,
      audit,
      repairContext(sameShotIdsDifferentCandidate, audit)
    ),
    /candidate digest/u
  );

  const changedStory = structuredClone(context.fullStory);
  changedStory.sceneScript[0].visibleAction = "权威上游动作已经变化";
  assert.throws(
    () => mergeAnimationVideoPromptSemanticRepair(candidate, envelope, plan, {
      ...context,
      fullStory: changedStory
    }),
    /权威上下文已经失效/u
  );

  assert.throws(
    () => mergeAnimationVideoPromptSemanticRepair(candidate, envelope, plan, {
      ...context,
      planIdentity: { ...context.planIdentity, requestId: "new-request" }
    }),
    /权威上下文已经失效/u
  );

  assert.throws(
    () => mergeAnimationVideoPromptSemanticRepair(
      candidate,
      envelope,
      structuredClone(plan),
      context
    ),
    /不是当前 adapter 签发对象/u
  );
});

test("超过 12 个 videoPrompt target 在 provider 调用前明确失败", () => {
  const candidate = candidatePlan(13);
  const audit = semanticAudit(candidate, candidate.shotPlan.map((_, index) => index));
  assert.throws(
    () => planRepair(candidate, audit),
    (error) => error instanceof OutputContractError && /不能超过 12 个/u.test(error.message)
  );
});
