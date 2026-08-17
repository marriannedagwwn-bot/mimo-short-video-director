import {
  VIDEO_PROMPT_PROFILE_IDS,
  assertVideoPromptProfile
} from "../public/video-prompt-profiles.js";
import {
  ARTIFACT_PARTIAL_REPAIR_SCHEMA_VERSION,
  createArtifactPartialRepairPlan,
  mergeArtifactPartialRepair
} from "./artifact-partial-repair.js";
import {
  ANIMATION_VIDEO_PROMPT_SEMANTIC_AUDIT_SCHEMA_VERSION,
  assertValidatedAnimationVideoPromptSemanticAudit
} from "./animation-video-prompt-semantic-audit.js";
import {
  MiniMaxH3PromptError,
  assertMiniMaxH3BasePrompt,
  miniMaxH3DialogueTexts
} from "./minimax-h3-prompt.js";
import { contentDigest } from "./production-lineage.js";
import {
  OutputContractError,
  ensureAnimationPlanDirectShotContract
} from "./validation.js";

export const ANIMATION_VIDEO_PROMPT_SEMANTIC_REPAIR_SCHEMA_VERSION =
  "animation_video_prompt_semantic_repair/1.0";
export const ANIMATION_VIDEO_PROMPT_SEMANTIC_REPAIR_MAX_ATTEMPTS = 1;
export const ANIMATION_VIDEO_PROMPT_SEMANTIC_REPAIR_MAX_TARGETS = 12;

const semanticRepairPlans = new WeakMap();
const semanticAuditTrustToken = globalThis.crypto.randomUUID();
const issueFields = Object.freeze([
  "layer",
  "field",
  "category",
  "relation",
  "authorityFactId",
  "candidateFieldId",
  "authorityExcerpt",
  "candidateExcerpt",
  "productionImpact"
]);

/**
 * The semantic adapter is intentionally narrower than the deterministic H3
 * repair adapter. It accepts only a complete, per-shot V2 audit which already
 * proved that every structured shot is compatible with the signed authority.
 * A structured-shot conflict or uncertain verdict makes the whole audit
 * ineligible; the server must not spend a provider call on a Prompt-only patch
 * that cannot make the final Plan valid.
 */
export const animationVideoPromptSemanticRepairAdapter = Object.freeze({
  id: "animationPlan/minimax-h3-semantic-video-prompt/1.0",
  maxTargets: ANIMATION_VIDEO_PROMPT_SEMANTIC_REPAIR_MAX_TARGETS,

  selectTargets({ candidate, diagnostics, context }) {
    if (Number(context.repairAttemptCount || 0) !== 0) return null;
    if (context.semanticAuditTrustToken !== semanticAuditTrustToken) return null;
    if (!isTrustedH3DirectShotPlan(candidate)) return null;
    if (!isSignedCharacterBoundary(context.visualGuardrails?.fixedCharacterBoundary)) return null;

    const audit = context.audit;
    const reviewedShots = reviewCompleteAudit(candidate, audit, diagnostics);
    if (!reviewedShots) return null;

    // One unsafe reviewed shot invalidates the whole repair operation. In
    // particular, never repair a Prompt while a sibling shot has a known
    // structured-fact conflict or an unresolved verdict.
    if (reviewedShots.some((review) => review.shotFactsVerdict !== "pass")) return null;
    if (reviewedShots.some((review) => !["pass", "fail"].includes(review.videoPromptVerdict))) {
      return null;
    }
    if (reviewedShots.some((review) => (
      review.issues.some((issue) => issue.layer !== "video_prompt" || issue.field !== "videoPrompt")
    ))) return null;

    const failedShots = reviewedShots.filter((review) => review.videoPromptVerdict === "fail");
    if (!failedShots.length) return null;

    const drafts = failedShots.map((review) => {
      if (!review.issues.length) return null;
      const shotIndex = review.shotIndex;
      const shot = candidate.shotPlan[shotIndex];
      const publicAuthority = buildPublicShotAuthority(candidate, shotIndex, context);
      if (!publicAuthority) return null;
      const path = `/shotPlan/${shotIndex}/videoPrompt`;
      return {
        path,
        targetLabel: `${shot.shotId} videoPrompt semantic repair`,
        diagnostics: structuredClone(review.issues),
        mutablePointers: [path],
        allowedReplacementKinds: ["string"],
        repairInstruction: [
          "Rewrite only this shot's complete MiniMax H3 videoPrompt string.",
          "Resolve every listed material issue against the supplied authority without changing any signed story fact.",
          "Preserve all already-correct character, location, prop, action, camera, dialogue, sound, continuity, duration, and final-state facts.",
          "Return no path, patch operation, structured shot, Foundation, or complete Animation Plan."
        ].join(" "),
        modelContext: { authority: publicAuthority },
        adapterState: {
          shotIndex,
          shotId: shot.shotId,
          durationSeconds: shot.durationSeconds,
          dialogueTexts: miniMaxH3DialogueTexts(shot.dialogueOrSubtitle)
        }
      };
    });
    return drafts.some((draft) => !draft) ? null : drafts;
  },

  buildAuthority({ candidate, targets, context }) {
    return buildPrivateRepairAuthority(candidate, targets, context);
  },

  validateAuthority({ candidate, authority, targets, context, helpers }) {
    const current = buildPrivateRepairAuthority(candidate, targets, context);
    return Boolean(current)
      && helpers.contentDigest(current) === helpers.contentDigest(authority);
  },

  authorizeReplacement({ target, replacement }) {
    if (typeof replacement !== "string" || !replacement.trim()) {
      throw new OutputContractError(
        `Animation videoPrompt 语义修复 ${target.repairId} replacement 必须是非空字符串`
      );
    }
    try {
      assertMiniMaxH3BasePrompt(replacement, {
        durationSeconds: target.adapterState.durationSeconds,
        path: target.path,
        dialogueTexts: target.adapterState.dialogueTexts
      });
    } catch (error) {
      if (error instanceof MiniMaxH3PromptError) {
        throw new OutputContractError(error.message, error.details);
      }
      throw error;
    }
    return true;
  },

  validateMerged({ candidate }) {
    ensureAnimationPlanDirectShotContract(candidate);
    return true;
  }
});

/**
 * Sign one transient semantic repair plan. The audit must review every shot in
 * candidate order. Only failed videoPrompt leaves are selected; no model path
 * is trusted or parsed.
 */
export function planAnimationVideoPromptSemanticRepair(candidate, audit, {
  repairAttemptCount = 0,
  fullStory = null,
  visualGuardrails = null,
  planIdentity = null
} = {}) {
  assertValidatedAnimationVideoPromptSemanticAudit(audit, { candidate });
  const plan = createArtifactPartialRepairPlan({
    artifactType: "animationPlan",
    candidate,
    diagnostics: Array.isArray(audit?.shots) ? audit.shots : [],
    adapter: animationVideoPromptSemanticRepairAdapter,
    context: {
      repairAttemptCount,
      audit,
      fullStory,
      visualGuardrails,
      planIdentity,
      semanticAuditTrustToken
    }
  });
  if (plan) semanticRepairPlans.set(plan, Object.freeze({ audit }));
  return plan;
}

/**
 * Serialize only provider-visible repair data. Private target paths,
 * mutablePointers, base/authority digests, signatures, operation identity and
 * the rest of the Animation Plan are deliberately excluded.
 */
export function serializeAnimationVideoPromptSemanticRepairPlan(plan) {
  assertSemanticRepairPlan(plan);
  return {
    schemaVersion: ANIMATION_VIDEO_PROMPT_SEMANTIC_REPAIR_SCHEMA_VERSION,
    targets: plan.targets.map((target) => ({
      repairId: target.repairId,
      currentValue: target.currentValue,
      diagnostics: structuredClone(target.diagnostics),
      authority: structuredClone(target.modelContext.authority)
    }))
  };
}

export function animationVideoPromptSemanticRepairPrompt(plan) {
  const payload = serializeAnimationVideoPromptSemanticRepairPlan(plan);
  return `ANIMATION_VIDEO_PROMPT_SEMANTIC_REPAIR_V1

You perform one bounded MiniMax H3 video-prompt semantic repair operation.

For each target, rewrite only currentValue as one complete replacement string. Resolve exactly the listed material diagnostics using that target's authority. The signed Full Story and fixed character facts have priority over Foundation appearance locks; the already-audited exactShotFacts then define this shot's rendering implementation. Foundation locks may refine appearance but never authorize a new character, prop, action, or story function.

Keep all unrelated valid facts unchanged. The replacement must remain a valid MiniMax H3 Base/T2VA prompt with exactly these three English sections in order, each beginning on its own line: integrated_multimodal_description, overall_soundscape, non_diegetic_music. Preserve every signed original-language dialogue item verbatim inside <d>[Chinese] ...</d>. Do not add Plan-stage reference labels.

Bounded input:
${JSON.stringify(payload)}

Return exactly this JSON shape and nothing else:
{
  "schemaVersion":"${ANIMATION_VIDEO_PROMPT_SEMANTIC_REPAIR_SCHEMA_VERSION}",
  "repairs":[
    {"repairId":"R1","replacement":"complete videoPrompt string"}
  ]
}

repairs must have exactly the same count and order as targets. Do not return path, op, reason, diagnostics, a structured shot, a Foundation, an Animation Plan, Markdown, or extra fields.`;
}

/**
 * Convert the public, digest-free provider envelope into the private generic
 * protocol and atomically merge exact string leaves. A caller may add its full
 * stage validator through validateMerged; the adapter always runs the direct
 * shot/H3 deterministic contract first.
 */
export function mergeAnimationVideoPromptSemanticRepair(
  candidate,
  envelope,
  plan,
  {
    audit = null,
    fullStory = null,
    visualGuardrails = null,
    planIdentity = null,
    validateMerged
  } = {}
) {
  assertSemanticRepairPlan(plan);
  assertValidatedAnimationVideoPromptSemanticAudit(audit, { candidate });
  if (semanticRepairPlans.get(plan).audit !== audit) {
    throw new OutputContractError(
      "Animation videoPrompt 语义修复 audit 与服务端签发计划不匹配"
    );
  }
  assertPublicRepairEnvelope(envelope);
  return mergeArtifactPartialRepair({
    candidate,
    plan,
    adapter: animationVideoPromptSemanticRepairAdapter,
    envelope: {
      schemaVersion: ARTIFACT_PARTIAL_REPAIR_SCHEMA_VERSION,
      baseDigest: plan.baseDigest,
      repairs: structuredClone(envelope.repairs)
    },
    context: {
      repairAttemptCount: 0,
      audit,
      fullStory,
      visualGuardrails,
      planIdentity,
      semanticAuditTrustToken
    },
    validateMerged
  });
}

function reviewCompleteAudit(candidate, audit, diagnostics) {
  if (!isRecord(audit) || !hasExactKeys(audit, ["schemaVersion", "shots"])) return null;
  if (audit.schemaVersion !== ANIMATION_VIDEO_PROMPT_SEMANTIC_AUDIT_SCHEMA_VERSION) return null;
  if (!Array.isArray(audit.shots) || audit.shots.length !== candidate.shotPlan.length) return null;
  if (!Array.isArray(diagnostics) || contentDigest(diagnostics) !== contentDigest(audit.shots)) {
    return null;
  }

  const reviews = [];
  for (let shotIndex = 0; shotIndex < audit.shots.length; shotIndex += 1) {
    const review = audit.shots[shotIndex];
    const shot = candidate.shotPlan[shotIndex];
    if (!isRecord(review)
      || !hasExactKeys(review, ["shotId", "shotFactsVerdict", "videoPromptVerdict", "issues"])
      || review.shotId !== shot.shotId
      || typeof review.shotFactsVerdict !== "string"
      || typeof review.videoPromptVerdict !== "string"
      || !Array.isArray(review.issues)) {
      return null;
    }
    if (review.videoPromptVerdict === "pass" && review.issues.length) return null;
    if (review.videoPromptVerdict === "fail" && !review.issues.length) return null;
    if (!review.issues.every(isTrustedVideoPromptIssue)) return null;
    reviews.push({
      shotIndex,
      shotId: review.shotId,
      shotFactsVerdict: review.shotFactsVerdict,
      videoPromptVerdict: review.videoPromptVerdict,
      issues: structuredClone(review.issues)
    });
  }
  return reviews;
}

function isTrustedVideoPromptIssue(issue) {
  if (!isRecord(issue) || !hasExactKeys(issue, issueFields)) return false;
  for (const field of [
    "layer",
    "field",
    "category",
    "relation",
    "authorityFactId",
    "candidateFieldId",
    "productionImpact"
  ]) {
    if (typeof issue[field] !== "string" || !issue[field].trim()) return false;
  }
  return ["string", "null"].includes(jsonKind(issue.authorityExcerpt))
    && ["string", "null"].includes(jsonKind(issue.candidateExcerpt));
}

function buildPrivateRepairAuthority(candidate, targets, context) {
  if (context.semanticAuditTrustToken !== semanticAuditTrustToken
    || !isRecord(context.audit)
    || context.audit.schemaVersion !== ANIMATION_VIDEO_PROMPT_SEMANTIC_AUDIT_SCHEMA_VERSION
    || !isSignedCharacterBoundary(context.visualGuardrails?.fixedCharacterBoundary)) {
    return null;
  }
  const targetAuthorities = targets.map((target) => {
    const shotIndex = Number(target.adapterState?.shotIndex);
    const publicAuthority = buildPublicShotAuthority(candidate, shotIndex, context);
    if (!publicAuthority) return null;
    return {
      repairId: target.repairId,
      shotIndex,
      shotId: String(candidate.shotPlan[shotIndex]?.shotId || ""),
      authority: publicAuthority
    };
  });
  if (targetAuthorities.some((authority) => !authority)) return null;
  return {
    auditSchemaVersion: context.audit.schemaVersion,
    auditDigest: contentDigest(context.audit),
    planIdentity: {
      promptSchemaVersion: candidate.promptSchemaVersion,
      format: candidate.productionStrategy?.format,
      targetAspectRatio: candidate.productionStrategy?.targetAspectRatio,
      videoPromptProfile: structuredClone(candidate.productionStrategy?.videoPromptProfile || null),
      orderedShots: candidate.shotPlan.map((shot) => ({
        shotId: shot.shotId,
        sourceSceneId: shot.sourceSceneId,
        sceneId: shot.sceneId,
        durationSeconds: shot.durationSeconds
      })),
      operation: structuredClone(context.planIdentity ?? null)
    },
    fixedCharacterBoundary: structuredClone(context.visualGuardrails.fixedCharacterBoundary),
    targetAuthorities,
    maximumRepairAttempts: ANIMATION_VIDEO_PROMPT_SEMANTIC_REPAIR_MAX_ATTEMPTS
  };
}

function buildPublicShotAuthority(candidate, shotIndex, context) {
  const shot = candidate.shotPlan?.[shotIndex];
  if (!isRecord(shot)) return null;
  const sourceScene = findUniqueSourceScene(context.fullStory, shot.sourceSceneId);
  if (!sourceScene) return null;
  const sceneReference = findUniqueSceneReference(candidate, shot.sceneId);
  if (!sceneReference) return null;
  const boundary = projectPublicCharacterBoundary(
    context.visualGuardrails?.fixedCharacterBoundary
  );
  if (!boundary) return null;
  const visibleCharacterNames = new Set(
    sourceScene.characters.map((name) => String(name || "").trim()).filter(Boolean)
  );
  const visibleCharacterReferences = (Array.isArray(candidate.characterReferencePrompts)
    ? candidate.characterReferencePrompts
    : []).filter((reference) => (
    isRecord(reference)
    && visibleCharacterNames.has(String(reference.characterName || "").trim())
  ));
  return {
    authorityPriority: [
      "fixedCharacterBoundary",
      "authoritativeSourceScene_and_fullStoryKeyProps",
      "foundationAppearanceLocks",
      "exactShotFacts"
    ],
    authoritativeSourceScene: sourceScene,
    fullStoryKeyProps: structuredClone(context.fullStory?.keyProps || []),
    fixedCharacterBoundary: boundary,
    foundationLocks: {
      targetAspectRatio: candidate.productionStrategy?.targetAspectRatio,
      videoPromptProfile: structuredClone(candidate.productionStrategy?.videoPromptProfile),
      visualBible: structuredClone(candidate.visualBible || {}),
      characterReferencePrompts: structuredClone(visibleCharacterReferences),
      sceneReferencePrompt: sceneReference,
      // Do not guess relevance with local keywords. The complete signed asset
      // lock is small and is needed to distinguish authorized visual detail
      // from a material prop mutation.
      assetPrompts: structuredClone(candidate.assetPrompts || [])
    },
    exactShotFacts: omitKey(shot, "videoPrompt"),
    adjacentContinuity: {
      previous: projectAdjacentShot(candidate.shotPlan[shotIndex - 1]),
      next: projectAdjacentShot(candidate.shotPlan[shotIndex + 1])
    }
  };
}

function findUniqueSourceScene(fullStory, sourceSceneId) {
  const expected = String(sourceSceneId || "");
  const matches = (Array.isArray(fullStory?.sceneScript) ? fullStory.sceneScript : [])
    .filter((scene) => isRecord(scene) && String(scene.sceneId || "") === expected);
  if (!expected || matches.length !== 1) return null;
  const scene = matches[0];
  return {
    sceneId: String(scene.sceneId || ""),
    location: String(scene.location || ""),
    characters: structuredClone(scene.characters || []),
    visibleAction: String(scene.visibleAction || ""),
    dialogue: structuredClone(scene.dialogue ?? ""),
    shotAndSound: structuredClone(scene.shotAndSound ?? ""),
    shootingNotes: String(scene.shootingNotes || "")
  };
}

function findUniqueSceneReference(candidate, sceneId) {
  const expected = String(sceneId || "");
  const matches = (Array.isArray(candidate.sceneReferencePrompts)
    ? candidate.sceneReferencePrompts
    : []).filter((reference) => (
    isRecord(reference) && String(reference.sceneId || "") === expected
  ));
  return expected && matches.length === 1 ? structuredClone(matches[0]) : null;
}

function projectPublicCharacterBoundary(boundary) {
  if (!isSignedCharacterBoundary(boundary)) return null;
  return {
    schemaVersion: String(boundary.schemaVersion || ""),
    characterName: String(boundary.characterName || ""),
    canonicalDescription: String(boundary.canonicalDescription || ""),
    bodyForm: String(boundary.bodyForm || ""),
    requiredTraits: structuredClone(boundary.requiredTraits),
    allowedTraits: structuredClone(boundary.allowedTraits || []),
    forbiddenTraits: structuredClone(boundary.forbiddenTraits),
    unresolvedConflicts: structuredClone(boundary.unresolvedConflicts || [])
  };
}

function projectAdjacentShot(shot) {
  if (!isRecord(shot)) return null;
  return {
    shotId: shot.shotId,
    sourceSceneId: shot.sourceSceneId,
    sceneId: shot.sceneId,
    characterAction: shot.characterAction,
    continuityNotes: shot.continuityNotes,
    visibleFinalStateCriteria: structuredClone(shot.acceptanceCriteria || [])
  };
}

function isTrustedH3DirectShotPlan(candidate) {
  try {
    ensureAnimationPlanDirectShotContract(candidate);
    const profile = assertVideoPromptProfile(
      candidate.productionStrategy?.videoPromptProfile
    );
    return profile.profileId === VIDEO_PROMPT_PROFILE_IDS.MINIMAX_H3;
  } catch {
    return false;
  }
}

function isSignedCharacterBoundary(boundary) {
  return Boolean(
    isRecord(boundary)
    && String(boundary.characterName || "").trim()
    && String(boundary.sourceDigest || "").trim()
    && String(boundary.boundaryDigest || "").trim()
    && String(boundary.boundarySignature || "").trim()
    && Array.isArray(boundary.requiredTraits)
    && Array.isArray(boundary.forbiddenTraits)
  );
}

function assertSemanticRepairPlan(plan) {
  if (!isRecord(plan) || !semanticRepairPlans.has(plan)) {
    throw new OutputContractError("Animation videoPrompt 语义修复计划不是当前 adapter 签发对象");
  }
}

function assertPublicRepairEnvelope(envelope) {
  if (!isRecord(envelope)
    || !hasExactKeys(envelope, ["schemaVersion", "repairs"])) {
    throw new OutputContractError(
      "Animation videoPrompt 语义修复响应只允许 schemaVersion、repairs"
    );
  }
  if (envelope.schemaVersion !== ANIMATION_VIDEO_PROMPT_SEMANTIC_REPAIR_SCHEMA_VERSION) {
    throw new OutputContractError("Animation videoPrompt 语义修复 schemaVersion 无效");
  }
  if (!Array.isArray(envelope.repairs)) {
    throw new OutputContractError("Animation videoPrompt 语义修复 repairs 必须是数组");
  }
  envelope.repairs.forEach((repair, index) => {
    if (!isRecord(repair) || !hasExactKeys(repair, ["repairId", "replacement"])) {
      throw new OutputContractError(
        `Animation videoPrompt 语义修复 repairs[${index}] 只允许 repairId、replacement`
      );
    }
    if (typeof repair.repairId !== "string" || !repair.repairId.trim()) {
      throw new OutputContractError(
        `Animation videoPrompt 语义修复 repairs[${index}].repairId 无效`
      );
    }
    if (typeof repair.replacement !== "string") {
      throw new OutputContractError(
        `Animation videoPrompt 语义修复 repairs[${index}].replacement 必须是字符串`
      );
    }
  });
}

function omitKey(value, omitted) {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== omitted).map(([key, item]) => (
      [key, structuredClone(item)]
    ))
  );
}

function hasExactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function jsonKind(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
