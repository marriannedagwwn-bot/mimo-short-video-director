import test from "node:test";
import assert from "node:assert/strict";
import {
  automaticUsageConstraints,
  countUnicodeCodePoints,
  evaluateCastProposalPolicy,
  validateCastProposal,
  validateDialogueAgainstUsageConstraints
} from "../src/cast-proposal.js";
import { CastProposalValidationError } from "../src/cast-errors.js";

function role(overrides = {}) {
  return {
    proposalRef: "cast-proposal-1",
    entityClass: "single-scene-functional",
    identityMode: "generic-label",
    proposedDisplayName: "快递员",
    proposedAliases: [],
    scopePolicy: "scene-limited",
    maxSceneCount: 1,
    narrativeImportance: "functional",
    relationshipMode: "transient",
    dialoguePolicy: "one-functional-line",
    shotEmphasis: "normal",
    continuityRequired: false,
    requiresReferenceAsset: false,
    sceneHint: "送包裹的短暂场面",
    ...overrides
  };
}

test("Cast 模型输出服务端授权字段、scene 字段或 /sceneScript/* 引用时拒绝", () => {
  for (const forbidden of [
    "characterId",
    "requiresConfirmation",
    "approvalDecision",
    "approved",
    "sceneId",
    "sceneScope"
  ]) {
    assert.throws(
      () => validateCastProposal({ roles: [role({ [forbidden]: "model-claim" })] }),
      (error) => error instanceof CastProposalValidationError
        && error.details.some((detail) => (
          detail.code === "CAST_PROPOSAL_FIELD_FORBIDDEN"
          && detail.path === `/roles/0/${forbidden}`
        )),
      forbidden
    );
  }
  assert.throws(
    () => validateCastProposal({
      roles: [role({ sceneHint: "参考 /sceneScript/0/visibleAction" })]
    }),
    (error) => error instanceof CastProposalValidationError
      && error.details.some((detail) => detail.code === "CAST_PROPOSAL_SCENE_REFERENCE_FORBIDDEN")
  );
});

test("每个结构化政策事实都有确定性的自动批准与确认分支", () => {
  const automaticVariants = [
    { entityClass: "anonymous-extra" },
    { entityClass: "anonymous-group" },
    { entityClass: "crowd" },
    { entityClass: "single-scene-functional" },
    { identityMode: "anonymous" },
    { identityMode: "generic-label" },
    { narrativeImportance: "ambient" },
    { narrativeImportance: "functional" },
    { relationshipMode: "none" },
    { relationshipMode: "transient" },
    { dialoguePolicy: "none" },
    { dialoguePolicy: "one-functional-line" },
    { shotEmphasis: "background" },
    { shotEmphasis: "normal" }
  ];
  for (const overrides of automaticVariants) {
    assert.equal(
      evaluateCastProposalPolicy(role(overrides)).decision,
      "automatic",
      JSON.stringify(overrides)
    );
  }

  const confirmationVariants = [
    { entityClass: "persistent-character" },
    { identityMode: "named" },
    { proposedAliases: ["小王"] },
    { scopePolicy: "story-wide", maxSceneCount: null },
    { maxSceneCount: 2 },
    { narrativeImportance: "supporting" },
    { narrativeImportance: "key" },
    { relationshipMode: "persistent" },
    { dialoguePolicy: "multiple-lines" },
    { shotEmphasis: "close-up" },
    { continuityRequired: true },
    { requiresReferenceAsset: true }
  ];
  for (const overrides of confirmationVariants) {
    assert.equal(
      evaluateCastProposalPolicy(role(overrides)).decision,
      "confirmation-required",
      JSON.stringify(overrides)
    );
  }
});

test("相互矛盾的结构化字段不会自动批准", () => {
  const contradictions = [
    role({
      entityClass: "single-scene-functional",
      narrativeImportance: "key"
    }),
    role({
      scopePolicy: "scene-limited",
      continuityRequired: true
    }),
    role({ dialoguePolicy: "multiple-lines" }),
    role({ shotEmphasis: "close-up" }),
    role({ requiresReferenceAsset: true })
  ];
  for (const candidate of contradictions) {
    assert.equal(evaluateCastProposalPolicy(candidate).decision, "confirmation-required");
  }
});

test("自动批准结果只由服务端政策计算，名称和 sceneHint 不参与授权", () => {
  const first = evaluateCastProposalPolicy(role({
    proposedDisplayName: "快递员",
    sceneHint: "送包裹"
  }));
  const second = evaluateCastProposalPolicy(role({
    proposedDisplayName: "另一个创作标签",
    sceneHint: "完全不同的非权威提示"
  }));

  assert.equal(first.decision, "automatic");
  assert.equal(second.decision, "automatic");
  assert.deepEqual(first.usageConstraints, second.usageConstraints);
  assert.deepEqual(first.usageConstraints, {
    approvalMode: "automatic",
    isEphemeral: true,
    maxSceneCount: 1,
    maxDialogueLines: 1,
    maxDialogueCodePoints: 80,
    allowedNarrativeImportance: ["ambient", "functional"],
    allowCloseUp: false,
    allowPersistentRelationship: false,
    allowReferenceAsset: false,
    assetPolicy: "none"
  });
  assert.equal(Object.hasOwn(first, "requiresConfirmation"), false);
  assert.equal(Object.hasOwn(first, "approved"), false);
});

test("同一输入多次执行 policy 得到完全相同结果", () => {
  const candidate = role({ entityClass: "crowd", dialoguePolicy: "none" });
  assert.deepEqual(
    evaluateCastProposalPolicy(candidate),
    evaluateCastProposalPolicy(structuredClone(candidate))
  );
});

test("单句台词限制按 Unicode code points 而非 UTF-16 code units 计算", () => {
  const constraints = automaticUsageConstraints(role());
  const eightyEmoji = "😀".repeat(80);
  const eightyOneEmoji = `${eightyEmoji}😀`;

  assert.equal(eightyEmoji.length, 160);
  assert.equal(countUnicodeCodePoints(eightyEmoji), 80);
  assert.deepEqual(
    validateDialogueAgainstUsageConstraints([eightyEmoji], constraints),
    { ok: true, violations: [] }
  );
  const invalid = validateDialogueAgainstUsageConstraints([eightyOneEmoji], constraints);
  assert.equal(invalid.ok, false);
  assert.deepEqual(invalid.violations, [{
    code: "CAST_DIALOGUE_CODE_POINTS_EXCEEDED",
    index: 0,
    actual: 81,
    allowed: 80
  }]);
});
