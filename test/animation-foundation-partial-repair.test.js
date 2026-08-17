import test from "node:test";
import assert from "node:assert/strict";
import {
  ANIMATION_FOUNDATION_PARTIAL_REPAIR_SCHEMA_VERSION,
  animationFoundationPartialRepairPrompt,
  mergeAnimationFoundationPartialRepair,
  planAnimationFoundationPartialRepair
} from "../src/animation-foundation-partial-repair.js";
import {
  OutputContractError,
  ensureAnimationPlanMatchesProfile
} from "../src/validation.js";

function trait(canonicalName, scope, terms = [canonicalName]) {
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

function visualGuardrails() {
  return {
    fixedCharacterBoundary: {
      schemaVersion: "2.0",
      characterName: "小白子",
      canonicalDescription: "Q版狼耳少女，活泼可爱且懂事。",
      bodyForm: "保持人形少女结构与狼耳。",
      requiredTraits: [
        trait("小白子", "identity"),
        trait("狼耳", "appearance", ["狼耳", "狼耳朵"]),
        trait("活泼可爱", "personality"),
        trait("懂事", "personality")
      ],
      allowedTraits: [],
      forbiddenTraits: [trait("特定发色", "appearance")],
      unresolvedConflicts: [],
      sourceDigest: "sha256:source-sentinel",
      boundaryDigest: "sha256:boundary-sentinel",
      boundarySignature: "signature-sentinel"
    },
    allowedPositiveTraits: [],
    sourceSimilarityRules: []
  };
}

function wolfGirlMissingOnlyGuardrails() {
  const guardrails = visualGuardrails();
  guardrails.fixedCharacterBoundary.canonicalDescription =
    "Q版2.5头身狼耳少女，形象类似狼娘。";
  guardrails.fixedCharacterBoundary.requiredTraits = [
    trait("小白子", "identity"),
    trait("狼耳", "appearance", ["狼耳", "狼耳朵"]),
    trait("狼娘形象", "appearance", ["狼娘形象", "狼娘特征", "类似狼娘"])
  ];
  guardrails.fixedCharacterBoundary.forbiddenTraits = [];
  guardrails.fixedCharacterBoundary.boundaryDigest = "sha256:wolf-girl-boundary";
  guardrails.fixedCharacterBoundary.boundarySignature = "wolf-girl-signature";
  return guardrails;
}

function foundationCandidate() {
  return {
    promptSchemaVersion: "3.0",
    selectedVariantId: "V1",
    title: "UNRELATED_FOUNDATION_TITLE_SENTINEL",
    productionStrategy: { format: "direct_shot_video" },
    visualBible: { overallStyle: "UNRELATED_VISUAL_BIBLE_SENTINEL" },
    characterReferencePrompts: [{
      characterName: "小白子",
      storyRole: "主角",
      identity: "Q版狼耳少女人形",
      appearancePrompt: "小白子，Q版狼耳少女，狼耳，特定发色",
      consistencyTags: ["小白子", "狼耳"],
      forbiddenChanges: ["保持人形"]
    }, {
      characterName: "铃木奶奶",
      storyRole: "配角",
      identity: "村中长者",
      appearancePrompt: "COMPANION_ONLY_SENTINEL",
      consistencyTags: ["铃木奶奶"],
      forbiddenChanges: []
    }],
    sceneReferencePrompts: [],
    assetPrompts: [],
    editPlan: {},
    generationChecklist: [],
    modelAgnosticNotes: [],
    continuityAndSafetyCheck: {},
    uncertainties: []
  };
}

const creatorProfile = {
  fixedCharacter: "小白子，Q版狼耳少女，活泼可爱，懂事",
  vertical: "乡村温情",
  constraints: "无"
};
const creativeBrief = { protectedExpressions: [], controlledRewriteVariables: [] };
const variant = { id: "V1" };

function profileError(candidate, guardrails = visualGuardrails()) {
  let error;
  try {
    ensureAnimationPlanMatchesProfile(
      { ...candidate, shotPlan: [] },
      creatorProfile,
      creativeBrief,
      variant,
      guardrails
    );
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof OutputContractError);
  return error;
}

function repairPlan(candidate, guardrails = visualGuardrails(), error = profileError(candidate, guardrails)) {
  return planAnimationFoundationPartialRepair(candidate, error, {
    visualGuardrails: guardrails
  });
}

function validReplacement(candidate) {
  const replacement = structuredClone(candidate.characterReferencePrompts[0]);
  replacement.appearancePrompt = "小白子，Q版狼耳少女，狼耳";
  replacement.consistencyTags = ["小白子", "狼耳", "活泼可爱", "懂事"];
  return replacement;
}

function envelope(plan, replacement) {
  return {
    schemaVersion: ANIMATION_FOUNDATION_PARTIAL_REPAIR_SCHEMA_VERSION,
    baseDigest: plan.baseDigest,
    repairs: [{ repairId: "R1", replacement }]
  };
}

test("仅缺狼娘形象时冻结 appearancePrompt 并只在 consistencyTags 尾部追加签发 canonicalName", () => {
  const candidate = foundationCandidate();
  candidate.characterReferencePrompts[0].appearancePrompt = "Q版2.5头身狼耳少女";
  candidate.characterReferencePrompts[0].consistencyTags = ["小白子", "狼耳"];
  const guardrails = wolfGirlMissingOnlyGuardrails();
  const error = profileError(candidate, guardrails);

  assert.deepEqual(error.details.map((detail) => detail.code), [
    "ANIMATION_FIXED_CHARACTER_REQUIRED_TRAITS_MISSING"
  ]);
  assert.deepEqual(error.details[0].missingRequiredTraits, ["狼娘形象"]);

  const plan = repairPlan(candidate, guardrails, error);
  assert.ok(plan);
  assert.deepEqual(plan.targets[0].mutablePointers, [
    "/characterReferencePrompts/0/consistencyTags"
  ]);
  assert.deepEqual(plan.targets[0].modelContext.missingRequiredTraitCanonicalNames, [
    "狼娘形象"
  ]);
  assert.deepEqual(plan.targets[0].modelContext.expectedConsistencyTags, [
    "小白子",
    "狼耳",
    "狼娘形象"
  ]);
  assert.equal(
    plan.targets[0].modelContext.mutationPolicy,
    "append_signed_canonical_names_to_consistency_tags_only"
  );
  const prompt = animationFoundationPartialRepairPrompt(plan);
  assert.match(prompt, /appearancePrompt 必须逐字不变/u);
  assert.match(prompt, /consistencyTags 尾部/u);

  const replacement = structuredClone(candidate.characterReferencePrompts[0]);
  replacement.consistencyTags.push("狼娘形象");
  const validateMerged = (merged) => {
    ensureAnimationPlanMatchesProfile(
      { ...merged, shotPlan: [] },
      creatorProfile,
      creativeBrief,
      variant,
      guardrails
    );
    return true;
  };
  const merged = mergeAnimationFoundationPartialRepair(
    candidate,
    envelope(plan, replacement),
    plan,
    { context: { visualGuardrails: guardrails }, validateMerged }
  );
  assert.equal(
    merged.characterReferencePrompts[0].appearancePrompt,
    "Q版2.5头身狼耳少女"
  );
  assert.deepEqual(merged.characterReferencePrompts[0].consistencyTags, [
    "小白子",
    "狼耳",
    "狼娘形象"
  ]);

  const rewrittenAppearance = structuredClone(replacement);
  rewrittenAppearance.appearancePrompt = "Q版2.5头身狼娘少女";
  assert.throws(() => mergeAnimationFoundationPartialRepair(
    candidate,
    envelope(plan, rewrittenAppearance),
    plan,
    { context: { visualGuardrails: guardrails }, validateMerged }
  ), /越权改变未授权路径.*appearancePrompt/u);

  for (const invalidTags of [
    ["小白子", "狼耳", "狼娘特征"],
    ["狼耳", "小白子", "狼娘形象"],
    ["小白子", "狼耳", "狼娘形象", "狼娘形象"],
    ["小白子", "狼耳", "机械手臂", "狼娘形象"]
  ]) {
    const invalid = structuredClone(candidate.characterReferencePrompts[0]);
    invalid.consistencyTags = invalidTags;
    assert.throws(() => mergeAnimationFoundationPartialRepair(
      candidate,
      envelope(plan, invalid),
      plan,
      { context: { visualGuardrails: guardrails }, validateMerged }
    ), /只能在 consistencyTags 尾部追加签发 canonicalName/u);
  }

  const missingTagsField = structuredClone(candidate);
  delete missingTagsField.characterReferencePrompts[0].consistencyTags;
  assert.equal(planAnimationFoundationPartialRepair(missingTagsField, error, {
    visualGuardrails: guardrails
  }), null);
  const malformedTags = structuredClone(candidate);
  malformedTags.characterReferencePrompts[0].consistencyTags = ["小白子", 42];
  assert.equal(planAnimationFoundationPartialRepair(malformedTags, error, {
    visualGuardrails: guardrails
  }), null);
  const malformedAppearance = structuredClone(candidate);
  malformedAppearance.characterReferencePrompts[0].appearancePrompt = {
    text: "Q版2.5头身狼耳少女"
  };
  assert.equal(planAnimationFoundationPartialRepair(malformedAppearance, error, {
    visualGuardrails: guardrails
  }), null);
  const malformedForbiddenChanges = structuredClone(candidate);
  malformedForbiddenChanges.characterReferencePrompts[0].forbiddenChanges = "错误类型";
  assert.equal(planAnimationFoundationPartialRepair(malformedForbiddenChanges, error, {
    visualGuardrails: guardrails
  }), null);
  const nestedArtifactLeak = structuredClone(candidate);
  nestedArtifactLeak.characterReferencePrompts[0].artifactDump = {
    shotPlan: ["NESTED_COMPLETE_ARTIFACT_SENTINEL"]
  };
  assert.equal(planAnimationFoundationPartialRepair(nestedArtifactLeak, error, {
    visualGuardrails: guardrails
  }), null, "未知嵌套字段不得进入 repair currentValue 或 Prompt");
  for (const serializedArtifact of [
    JSON.stringify({ shotPlan: [{ videoPrompt: "SERIALIZED_ARTIFACT_SENTINEL" }] }),
    JSON.stringify(JSON.stringify({ sceneScript: ["DOUBLE_ENCODED_ARTIFACT_SENTINEL"] }))
  ]) {
    const serializedLeak = structuredClone(candidate);
    serializedLeak.characterReferencePrompts[0].forbiddenChanges = [serializedArtifact];
    assert.equal(planAnimationFoundationPartialRepair(serializedLeak, error, {
      visualGuardrails: guardrails
    }), null, "序列化完整 Artifact 不得进入 repair currentValue 或 Prompt");
  }
  const oversizedText = structuredClone(candidate);
  oversizedText.characterReferencePrompts[0].appearancePrompt += "外观".repeat(9_000);
  assert.equal(planAnimationFoundationPartialRepair(oversizedText, error, {
    visualGuardrails: guardrails
  }), null, "超限字符串不得进入局部 repair Prompt");
});

test("仅 appearancePrompt 命中禁止词时仍允许精确删除并冻结 consistencyTags", () => {
  const candidate = foundationCandidate();
  candidate.characterReferencePrompts[0].appearancePrompt =
    "小白子，Q版狼耳少女，狼耳，活泼可爱，懂事，特定发色";
  candidate.characterReferencePrompts[0].consistencyTags =
    ["小白子", "狼耳", "活泼可爱", "懂事"];
  const guardrails = visualGuardrails();
  const error = profileError(candidate, guardrails);

  assert.deepEqual(error.details.map((detail) => detail.code), [
    "ANIMATION_CHARACTER_REFERENCE_FORBIDDEN_TERM"
  ]);
  const plan = repairPlan(candidate, guardrails, error);
  assert.ok(plan);
  assert.deepEqual(plan.targets[0].mutablePointers, [
    "/characterReferencePrompts/0/appearancePrompt"
  ]);

  const replacement = structuredClone(candidate.characterReferencePrompts[0]);
  replacement.appearancePrompt = "小白子，Q版狼耳少女，狼耳，活泼可爱，懂事";
  const merged = mergeAnimationFoundationPartialRepair(
    candidate,
    envelope(plan, replacement),
    plan,
    {
      context: { visualGuardrails: guardrails },
      validateMerged: (value) => {
        ensureAnimationPlanMatchesProfile(
          { ...value, shotPlan: [] },
          creatorProfile,
          creativeBrief,
          variant,
          guardrails
        );
        return true;
      }
    }
  );
  assert.deepEqual(
    merged.characterReferencePrompts[0].consistencyTags,
    candidate.characterReferencePrompts[0].consistencyTags
  );
  assert.doesNotMatch(merged.characterReferencePrompts[0].appearancePrompt, /特定发色/u);
});

test("consistencyTags 命中禁止词时允许受限删除，混合缺失时再于尾部追加 canonicalName", () => {
  const guardrails = visualGuardrails();
  const validateMerged = (value) => {
    ensureAnimationPlanMatchesProfile(
      { ...value, shotPlan: [] },
      creatorProfile,
      creativeBrief,
      variant,
      guardrails
    );
    return true;
  };

  const forbiddenOnly = foundationCandidate();
  forbiddenOnly.characterReferencePrompts[0].appearancePrompt =
    "小白子，Q版狼耳少女，狼耳，活泼可爱，懂事";
  forbiddenOnly.characterReferencePrompts[0].consistencyTags =
    ["小白子", "狼耳", "活泼可爱", "懂事", "特定发色"];
  const forbiddenPlan = repairPlan(forbiddenOnly, guardrails);
  assert.deepEqual(forbiddenPlan.targets[0].mutablePointers, [
    "/characterReferencePrompts/0/consistencyTags"
  ]);
  const forbiddenReplacement = structuredClone(
    forbiddenOnly.characterReferencePrompts[0]
  );
  forbiddenReplacement.consistencyTags.pop();
  assert.doesNotThrow(() => mergeAnimationFoundationPartialRepair(
    forbiddenOnly,
    envelope(forbiddenPlan, forbiddenReplacement),
    forbiddenPlan,
    { context: { visualGuardrails: guardrails }, validateMerged }
  ));
  const wrongTagType = structuredClone(forbiddenOnly.characterReferencePrompts[0]);
  wrongTagType.consistencyTags = "错误的字符串类型";
  assert.throws(() => mergeAnimationFoundationPartialRepair(
    forbiddenOnly,
    envelope(forbiddenPlan, wrongTagType),
    forbiddenPlan,
    { context: { visualGuardrails: guardrails }, validateMerged }
  ), /必须保持 consistencyTags 为字符串数组/u);
  const emptyDerivedTag = structuredClone(forbiddenOnly.characterReferencePrompts[0]);
  emptyDerivedTag.consistencyTags[emptyDerivedTag.consistencyTags.length - 1] = "，";
  assert.throws(() => mergeAnimationFoundationPartialRepair(
    forbiddenOnly,
    envelope(forbiddenPlan, emptyDerivedTag),
    forbiddenPlan,
    { context: { visualGuardrails: guardrails }, validateMerged }
  ), /不得向 consistencyTags 新增未授权条目/u);
  const duplicateExistingTag = structuredClone(forbiddenOnly.characterReferencePrompts[0]);
  duplicateExistingTag.consistencyTags[duplicateExistingTag.consistencyTags.length - 1] = "狼耳";
  assert.throws(() => mergeAnimationFoundationPartialRepair(
    forbiddenOnly,
    envelope(forbiddenPlan, duplicateExistingTag),
    forbiddenPlan,
    { context: { visualGuardrails: guardrails }, validateMerged }
  ), /不得向 consistencyTags 新增未授权条目/u);

  const compoundTagCandidate = structuredClone(forbiddenOnly);
  compoundTagCandidate.characterReferencePrompts[0].consistencyTags[
    compoundTagCandidate.characterReferencePrompts[0].consistencyTags.length - 1
  ] = "和平风格，特定发色";
  const compoundTagPlan = repairPlan(compoundTagCandidate, guardrails);
  const compoundTagReplacement = structuredClone(
    compoundTagCandidate.characterReferencePrompts[0]
  );
  compoundTagReplacement.consistencyTags[
    compoundTagReplacement.consistencyTags.length - 1
  ] = "和平风格";
  assert.doesNotThrow(() => mergeAnimationFoundationPartialRepair(
    compoundTagCandidate,
    envelope(compoundTagPlan, compoundTagReplacement),
    compoundTagPlan,
    { context: { visualGuardrails: guardrails }, validateMerged }
  ));
  const lostConjunctionFact = structuredClone(compoundTagReplacement);
  lostConjunctionFact.consistencyTags[lostConjunctionFact.consistencyTags.length - 1] = "平风格";
  assert.throws(() => mergeAnimationFoundationPartialRepair(
    compoundTagCandidate,
    envelope(compoundTagPlan, lostConjunctionFact),
    compoundTagPlan,
    { context: { visualGuardrails: guardrails }, validateMerged }
  ), /不得改写 consistencyTags 中未命中的既有事实/u);

  const mixed = foundationCandidate();
  mixed.characterReferencePrompts[0].appearancePrompt = "小白子，Q版狼耳少女，狼耳";
  mixed.characterReferencePrompts[0].consistencyTags = ["小白子", "狼耳", "特定发色"];
  const mixedPlan = repairPlan(mixed, guardrails);
  assert.deepEqual(mixedPlan.targets[0].mutablePointers, [
    "/characterReferencePrompts/0/consistencyTags"
  ]);
  const mixedReplacement = structuredClone(mixed.characterReferencePrompts[0]);
  mixedReplacement.consistencyTags = ["小白子", "狼耳", "活泼可爱", "懂事"];
  assert.doesNotThrow(() => mergeAnimationFoundationPartialRepair(
    mixed,
    envelope(mixedPlan, mixedReplacement),
    mixedPlan,
    { context: { visualGuardrails: guardrails }, validateMerged }
  ));

  const reordered = structuredClone(mixedReplacement);
  reordered.consistencyTags = ["狼耳", "小白子", "活泼可爱", "懂事"];
  assert.throws(() => mergeAnimationFoundationPartialRepair(
    mixed,
    envelope(mixedPlan, reordered),
    mixedPlan,
    { context: { visualGuardrails: guardrails }, validateMerged }
  ), /不得删除、复制或重排 consistencyTags/u);

  const noRemainingStoryRole = foundationCandidate();
  noRemainingStoryRole.characterReferencePrompts[0].appearancePrompt =
    "小白子，Q版狼耳少女，狼耳，活泼可爱，懂事";
  noRemainingStoryRole.characterReferencePrompts[0].consistencyTags =
    ["小白子", "狼耳", "活泼可爱", "懂事"];
  noRemainingStoryRole.characterReferencePrompts[0].storyRole = "特定发色";
  const noRemainingError = profileError(noRemainingStoryRole, guardrails);
  assert.equal(repairPlan(noRemainingStoryRole, guardrails, noRemainingError), null);
});

test("固定角色缺必需事实且混入特定发色时输出稳定 diagnostics 并只签发该角色参考", () => {
  const candidate = foundationCandidate();
  const guardrails = visualGuardrails();
  const error = profileError(candidate, guardrails);

  assert.deepEqual(error.details.map((detail) => detail.code), [
    "ANIMATION_FIXED_CHARACTER_REQUIRED_TRAITS_MISSING",
    "ANIMATION_CHARACTER_REFERENCE_FORBIDDEN_TERM"
  ]);
  assert.equal(error.details[0].jsonPointer, "/characterReferencePrompts/0");
  assert.deepEqual(error.details[0].missingRequiredTraits, ["活泼可爱", "懂事"]);
  assert.equal(
    error.details[0].authority.boundaryDigest,
    guardrails.fixedCharacterBoundary.boundaryDigest
  );
  assert.equal(
    error.details[1].jsonPointer,
    "/characterReferencePrompts/0/appearancePrompt"
  );
  assert.equal(error.details[1].matchedTerm, "特定发色");

  const plan = repairPlan(candidate, guardrails, error);
  assert.ok(plan);
  assert.equal(plan.targets.length, 1);
  assert.equal(plan.targets[0].path, "/characterReferencePrompts/0");
  assert.deepEqual(plan.targets[0].mutablePointers, [
    "/characterReferencePrompts/0/appearancePrompt",
    "/characterReferencePrompts/0/consistencyTags"
  ]);

  const prompt = animationFoundationPartialRepairPrompt(plan);
  assert.match(prompt, /活泼可爱/u);
  assert.match(prompt, /懂事/u);
  assert.match(prompt, /特定发色/u);
  assert.match(prompt, /boundary-sentinel/u);
  assert.doesNotMatch(
    prompt,
    /UNRELATED_FOUNDATION_TITLE_SENTINEL|UNRELATED_VISUAL_BIBLE_SENTINEL|COMPANION_ONLY_SENTINEL/u
  );
  assert.doesNotMatch(prompt, /"path"\s*:/u);
});

test("固定角色 replacement 原子合并、保护未命中字段并执行接线方完整复验", () => {
  const candidate = foundationCandidate();
  const frozen = structuredClone(candidate);
  const guardrails = visualGuardrails();
  const plan = repairPlan(candidate, guardrails);
  let validatorCalls = 0;
  const validateMerged = (merged) => {
    validatorCalls += 1;
    ensureAnimationPlanMatchesProfile(
      { ...merged, shotPlan: [] },
      creatorProfile,
      creativeBrief,
      variant,
      guardrails
    );
    return true;
  };
  const merged = mergeAnimationFoundationPartialRepair(
    candidate,
    envelope(plan, validReplacement(candidate)),
    plan,
    { context: { visualGuardrails: guardrails }, validateMerged }
  );

  assert.equal(
    merged.characterReferencePrompts[0].appearancePrompt,
    "小白子，Q版狼耳少女，狼耳"
  );
  assert.deepEqual(merged.characterReferencePrompts[0].consistencyTags, [
    "小白子",
    "狼耳",
    "活泼可爱",
    "懂事"
  ]);
  assert.doesNotMatch(merged.characterReferencePrompts[0].appearancePrompt, /特定发色/u);
  assert.deepEqual(merged.characterReferencePrompts[1], candidate.characterReferencePrompts[1]);
  assert.equal(merged.title, "UNRELATED_FOUNDATION_TITLE_SENTINEL");
  assert.equal(merged.visualBible.overallStyle, "UNRELATED_VISUAL_BIBLE_SENTINEL");
  assert.deepEqual(candidate, frozen);
  assert.equal(validatorCalls, 1);

  const unauthorized = validReplacement(candidate);
  unauthorized.identity = "越权改写身份";
  assert.throws(() => mergeAnimationFoundationPartialRepair(
    candidate,
    envelope(plan, unauthorized),
    plan,
    { context: { visualGuardrails: guardrails }, validateMerged }
  ), /越权改变未授权路径.*identity/u);

  const semanticDrift = validReplacement(candidate);
  semanticDrift.appearancePrompt = "小白子，狼耳，活泼可爱，懂事";
  assert.throws(() => mergeAnimationFoundationPartialRepair(
    candidate,
    envelope(plan, semanticDrift),
    plan,
    { context: { visualGuardrails: guardrails }, validateMerged }
  ), /不得改写 appearancePrompt 中未命中的既有事实/u);

  const unauthorizedAddition = validReplacement(candidate);
  unauthorizedAddition.appearancePrompt += "，机械手臂，吸血鬼身份";
  assert.throws(() => mergeAnimationFoundationPartialRepair(
    candidate,
    envelope(plan, unauthorizedAddition),
    plan,
    { context: { visualGuardrails: guardrails }, validateMerged }
  ), /不得向 appearancePrompt 新增未授权角色事实/u);

  const misplacedMissingTraits = validReplacement(candidate);
  misplacedMissingTraits.appearancePrompt += "，活泼可爱，懂事";
  assert.throws(() => mergeAnimationFoundationPartialRepair(
    candidate,
    envelope(plan, misplacedMissingTraits),
    plan,
    { context: { visualGuardrails: guardrails }, validateMerged }
  ), /不得向 appearancePrompt 新增未授权角色事实/u);

  const legalNegativeConstraintCandidate = structuredClone(candidate);
  legalNegativeConstraintCandidate.characterReferencePrompts[0].forbiddenChanges = [
    "禁止特定发色"
  ];
  const legalPlan = repairPlan(legalNegativeConstraintCandidate, guardrails);
  assert.doesNotThrow(() => mergeAnimationFoundationPartialRepair(
    legalNegativeConstraintCandidate,
    envelope(legalPlan, validReplacement(legalNegativeConstraintCandidate)),
    legalPlan,
    { context: { visualGuardrails: guardrails }, validateMerged }
  ));
  assert.deepEqual(candidate, frozen);
});

test("固定角色专属边界不套用到合法配角，配角无需重复主角 requiredTraits", () => {
  const candidate = foundationCandidate();
  candidate.characterReferencePrompts[0].appearancePrompt =
    "小白子，Q版狼耳少女，狼耳，活泼可爱，懂事";
  candidate.characterReferencePrompts[0].consistencyTags =
    ["小白子", "狼耳", "活泼可爱", "懂事"];
  candidate.characterReferencePrompts[1].appearancePrompt =
    "铃木奶奶，银色短发，特定发色，沉稳温和";

  assert.doesNotThrow(() => ensureAnimationPlanMatchesProfile(
    { ...candidate, shotPlan: [] },
    creatorProfile,
    creativeBrief,
    variant,
    visualGuardrails()
  ));
});

test("非唯一固定角色、未签发边界、混入不可修诊断或危险 Pointer 均不签发计划", () => {
  const candidate = foundationCandidate();
  const guardrails = visualGuardrails();
  const error = profileError(candidate, guardrails);

  const duplicate = structuredClone(candidate);
  duplicate.characterReferencePrompts.push(
    structuredClone(candidate.characterReferencePrompts[0])
  );
  assert.equal(repairPlan(duplicate, guardrails, error), null);

  const unsigned = structuredClone(guardrails);
  delete unsigned.fixedCharacterBoundary.boundarySignature;
  assert.equal(planAnimationFoundationPartialRepair(candidate, error, {
    visualGuardrails: unsigned
  }), null);

  const unsupported = new OutputContractError("同时存在不可修错误", [
    ...error.details,
    {
      code: "ANIMATION_POSITIVE_PROMPT_FORBIDDEN_TERM",
      path: "visualBible.overallStyle",
      jsonPointer: "/visualBible/overallStyle",
      reason: "测试不可修错误",
      authority: error.details[0].authority,
      matchedTerm: "测试"
    }
  ]);
  assert.equal(repairPlan(candidate, guardrails, unsupported), null);

  const dangerous = new OutputContractError("危险路径", [{
    ...error.details[1],
    jsonPointer: "/characterReferencePrompts/0/__proto__/polluted"
  }]);
  assert.equal(repairPlan(candidate, guardrails, dangerous), null);
  assert.equal(({}).polluted, undefined);

  const mismatchedPath = new OutputContractError("path 与 Pointer 不一致", [{
    ...error.details[1],
    path: "characterReferencePrompts[1].appearancePrompt"
  }]);
  assert.equal(repairPlan(candidate, guardrails, mismatchedPath), null);
});

test("Foundation repair plan 绑定实际诊断权威，权威变化后拒绝合并", () => {
  const candidate = foundationCandidate();
  const guardrails = visualGuardrails();
  const error = profileError(candidate, guardrails);
  const context = {
    visualGuardrails: guardrails,
    creatorProfile,
    creativeBrief
  };
  const plan = planAnimationFoundationPartialRepair(candidate, error, context);
  assert.ok(plan);
  const changedContext = {
    ...context,
    creatorProfile: {
      ...creatorProfile,
      fixedCharacter: `${creatorProfile.fixedCharacter}，新增但未签发的身份`
    }
  };
  assert.throws(() => mergeAnimationFoundationPartialRepair(
    candidate,
    envelope(plan, validReplacement(candidate)),
    plan,
    {
      context: changedContext,
      validateMerged: () => true
    }
  ), /权威上下文已经失效/u);
});

test("Foundation repair plan 拒绝把合法事实伪报为权威禁词或伪报已存在的必需事实", () => {
  const candidate = foundationCandidate();
  candidate.characterReferencePrompts[0].appearancePrompt += "，浅棕色上衣";
  const guardrails = visualGuardrails();
  const actualError = profileError(candidate, guardrails);

  const forgedForbidden = new OutputContractError("伪造禁词来源", [{
    ...actualError.details.find((detail) => (
      detail.code === "ANIMATION_CHARACTER_REFERENCE_FORBIDDEN_TERM"
    )),
    reason: "把合法既有外观事实伪报为边界禁词",
    matchedTerm: "浅棕色上衣",
    authority: {
      ...actualError.details[0].authority,
      sourcePaths: ["visualGuardrails.fixedCharacterBoundary.forbiddenTraits"]
    }
  }]);
  assert.equal(repairPlan(candidate, guardrails, forgedForbidden), null);

  const forgedMissing = new OutputContractError("伪造缺失事实", [{
    ...actualError.details.find((detail) => (
      detail.code === "ANIMATION_FIXED_CHARACTER_REQUIRED_TRAITS_MISSING"
    )),
    reason: "狼耳已经存在，不得伪报缺失",
    missingRequiredTraits: ["狼耳"]
  }]);
  assert.equal(repairPlan(candidate, guardrails, forgedMissing), null);
});

test("controlledRewriteVariables 来源表达不会触发 Foundation 禁词诊断或纠错计划", () => {
  const candidate = foundationCandidate();
  candidate.characterReferencePrompts[0].appearancePrompt =
    "小白子，Q版狼耳少女，狼耳，活泼可爱，懂事，金色长发";
  candidate.characterReferencePrompts[0].consistencyTags =
    ["小白子", "狼耳", "活泼可爱", "懂事", "金色长发"];
  const guardrails = visualGuardrails();
  const controlledBrief = {
    protectedExpressions: [],
    controlledRewriteVariables: [{
      variable: "原片发型",
      sourceValue: "金色长发",
      mustChange: true
    }]
  };
  assert.doesNotThrow(() => {
    ensureAnimationPlanMatchesProfile(
      { ...candidate, shotPlan: [] },
      creatorProfile,
      controlledBrief,
      variant,
      guardrails
    );
  });

  const context = {
    visualGuardrails: guardrails,
    creatorProfile,
    creativeBrief: controlledBrief
  };
  const forgedSourceDiagnostic = new OutputContractError("来源表达不再构成禁词权威", [{
    code: "ANIMATION_CHARACTER_REFERENCE_FORBIDDEN_TERM",
    path: "characterReferencePrompts[0].appearancePrompt",
    jsonPointer: "/characterReferencePrompts/0/appearancePrompt",
    reason: "来源表达不应触发 Foundation repair",
    matchedTerm: "金色长发",
    authority: {
      characterName: "小白子",
      boundaryDigest: guardrails.fixedCharacterBoundary.boundaryDigest,
      sourcePaths: ["creativeBrief.controlledRewriteVariables"]
    }
  }]);
  assert.equal(
    planAnimationFoundationPartialRepair(candidate, forgedSourceDiagnostic, context),
    null
  );
});
