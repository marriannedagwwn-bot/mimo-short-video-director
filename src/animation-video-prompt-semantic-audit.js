import { contentDigest } from "./production-lineage.js";
import { OutputContractError } from "./validation.js";

export const ANIMATION_VIDEO_PROMPT_SEMANTIC_AUDIT_SCHEMA_VERSION =
  "animation_video_prompt_semantic_audit/2.0";

export const ANIMATION_VIDEO_PROMPT_SEMANTIC_AUDIT_LAYERS = Object.freeze([
  "shot_facts",
  "video_prompt"
]);

export const ANIMATION_VIDEO_PROMPT_SEMANTIC_AUDIT_CATEGORIES = Object.freeze([
  "language_format",
  "cast",
  "character_identity",
  "character_appearance",
  "location_environment",
  "prop",
  "action",
  "visible_final_state",
  "camera",
  "dialogue",
  "sound",
  "continuity",
  "duration"
]);

// These are deliberately material production differences, not prose-quality
// judgements. In particular there is no generic "meaning weakened",
// "uncertain", or "minor addition" relation.
export const ANIMATION_VIDEO_PROMPT_SEMANTIC_AUDIT_RELATIONS = Object.freeze([
  "required_language_format_violated",
  "required_visible_cast_missing",
  "extra_visible_cast_added",
  "locked_identity_or_trait_changed",
  "location_or_weather_state_contradicted",
  "prop_identity_or_story_function_changed",
  "required_story_action_missing",
  "extra_story_action_added",
  "story_action_reordered",
  "actor_object_relation_changed",
  "visible_final_state_changed",
  "required_camera_beat_missing",
  "camera_beat_changed_or_reordered",
  "required_dialogue_missing",
  "dialogue_speaker_or_text_changed",
  "required_sound_event_missing",
  "sound_event_contradicted",
  "continuity_state_impossible",
  "duration_changed"
]);

export const ANIMATION_VIDEO_PROMPT_SEMANTIC_AUDIT_AUTHORITY_TIERS = Object.freeze([
  "fixed_character",
  "full_story",
  "foundation",
  "adjacent_shot",
  "exact_shot"
]);

const candidateFieldsByLayer = Object.freeze({
  shot_facts: new Set([
    "sourceSceneId",
    "sceneId",
    "durationSeconds",
    "storyPurpose",
    "emotionalTarget",
    "cameraMotion",
    "characterAction",
    "dialogueOrSubtitle",
    "soundDesign",
    "continuityNotes",
    "acceptanceCriteria"
  ]),
  video_prompt: new Set(["videoPrompt"])
});

const categorySet = new Set(ANIMATION_VIDEO_PROMPT_SEMANTIC_AUDIT_CATEGORIES);
const relationSet = new Set(ANIMATION_VIDEO_PROMPT_SEMANTIC_AUDIT_RELATIONS);
const authorityTierRanks = Object.freeze({
  fixed_character: 500,
  full_story: 400,
  foundation: 300,
  adjacent_shot: 250,
  exact_shot: 200
});
const candidateLayerRanks = Object.freeze({
  shot_facts: 200,
  video_prompt: 100
});
const relationCategories = Object.freeze({
  required_language_format_violated: new Set(["language_format"]),
  required_visible_cast_missing: new Set(["cast"]),
  extra_visible_cast_added: new Set(["cast"]),
  locked_identity_or_trait_changed: new Set(["character_identity", "character_appearance"]),
  location_or_weather_state_contradicted: new Set(["location_environment"]),
  prop_identity_or_story_function_changed: new Set(["prop"]),
  required_story_action_missing: new Set(["action"]),
  extra_story_action_added: new Set(["action"]),
  story_action_reordered: new Set(["action"]),
  actor_object_relation_changed: new Set(["action", "prop"]),
  visible_final_state_changed: new Set(["visible_final_state"]),
  required_camera_beat_missing: new Set(["camera"]),
  camera_beat_changed_or_reordered: new Set(["camera"]),
  required_dialogue_missing: new Set(["dialogue"]),
  dialogue_speaker_or_text_changed: new Set(["dialogue"]),
  required_sound_event_missing: new Set(["sound"]),
  sound_event_contradicted: new Set(["sound"]),
  continuity_state_impossible: new Set(["continuity"]),
  duration_changed: new Set(["duration"])
});
// Evidence IDs are not enough by themselves: a Foundation character sheet
// defines appearance but cannot authorize that character to appear in a
// scene, and Full Story shotAndSound is not an exact camera-beat contract.
// Bind each material relation to the authority fields that can actually
// decide it. Suffix matching supports the compact unit-test catalog names and
// the fully-qualified production names without parsing human prose.
const issueAuthorityFieldSuffixes = Object.freeze({
  "required_language_format_violated:language_format": ["visualProductionStrategy"],
  "required_visible_cast_missing:cast": ["scene.characters", "characters"],
  "extra_visible_cast_added:cast": ["scene.characters", "characters"],
  "locked_identity_or_trait_changed:character_identity": [
    "fixedCharacterBoundary",
    "scene.characters",
    "characters",
    "scene.visibleAction",
    "characterReferencePrompts"
  ],
  // A scene cast list proves who appears, not what that character looks like.
  // Appearance must be grounded in an actual appearance-bearing authority.
  "locked_identity_or_trait_changed:character_appearance": [
    "fixedCharacterBoundary",
    "scene.visibleAction",
    "characterReferencePrompts"
  ],
  "location_or_weather_state_contradicted:location_environment": [
    "scene.location",
    "scene.visibleAction",
    "sceneReferencePrompt"
  ],
  "prop_identity_or_story_function_changed:prop": [
    "scene.visibleAction",
    "fullStory.keyProps",
    "assetPrompts",
    "characterAction",
    "continuityNotes",
    "acceptanceCriteria"
  ],
  "required_story_action_missing:action": [
    "scene.visibleAction",
    "characterAction",
    "acceptanceCriteria"
  ],
  "extra_story_action_added:action": [
    "scene.visibleAction",
    "characterAction",
    "acceptanceCriteria"
  ],
  "story_action_reordered:action": [
    "scene.visibleAction",
    "characterAction",
    "acceptanceCriteria"
  ],
  "actor_object_relation_changed:action": [
    "scene.visibleAction",
    "characterAction",
    "acceptanceCriteria"
  ],
  "actor_object_relation_changed:prop": [
    "scene.visibleAction",
    "characterAction",
    "acceptanceCriteria",
    "fullStory.keyProps"
  ],
  "visible_final_state_changed:visible_final_state": [
    "scene.visibleAction",
    "characterAction",
    "continuityNotes",
    "acceptanceCriteria"
  ],
  "required_camera_beat_missing:camera": ["cameraMotion", "acceptanceCriteria"],
  "camera_beat_changed_or_reordered:camera": ["cameraMotion", "acceptanceCriteria"],
  "required_dialogue_missing:dialogue": ["scene.dialogue", "dialogueOrSubtitle"],
  "dialogue_speaker_or_text_changed:dialogue": ["scene.dialogue", "dialogueOrSubtitle"],
  "required_sound_event_missing:sound": ["scene.shotAndSound", "soundDesign"],
  "sound_event_contradicted:sound": ["scene.shotAndSound", "soundDesign"],
  "continuity_state_impossible:continuity": [
    "scene.visibleAction",
    "continuityNotes",
    "acceptanceCriteria",
    "adjacent.previousShot",
    "adjacent.nextShot"
  ],
  "duration_changed:duration": ["durationSeconds", "visualProductionStrategy"]
});
const relationCandidateFields = Object.freeze({
  required_language_format_violated: new Set(["videoPrompt"]),
  required_visible_cast_missing: new Set([
    "cameraMotion",
    "characterAction",
    "dialogueOrSubtitle",
    "continuityNotes",
    "acceptanceCriteria",
    "videoPrompt"
  ]),
  extra_visible_cast_added: new Set([
    "cameraMotion",
    "characterAction",
    "dialogueOrSubtitle",
    "continuityNotes",
    "acceptanceCriteria",
    "videoPrompt"
  ]),
  locked_identity_or_trait_changed: new Set([
    "cameraMotion",
    "characterAction",
    "dialogueOrSubtitle",
    "continuityNotes",
    "acceptanceCriteria",
    "videoPrompt"
  ]),
  location_or_weather_state_contradicted: new Set([
    "storyPurpose",
    "cameraMotion",
    "characterAction",
    "continuityNotes",
    "acceptanceCriteria",
    "videoPrompt"
  ]),
  prop_identity_or_story_function_changed: new Set([
    "characterAction",
    "soundDesign",
    "continuityNotes",
    "acceptanceCriteria",
    "videoPrompt"
  ]),
  required_story_action_missing: new Set(["cameraMotion", "characterAction", "acceptanceCriteria", "videoPrompt"]),
  extra_story_action_added: new Set(["cameraMotion", "characterAction", "acceptanceCriteria", "videoPrompt"]),
  story_action_reordered: new Set(["cameraMotion", "characterAction", "acceptanceCriteria", "videoPrompt"]),
  actor_object_relation_changed: new Set(["cameraMotion", "characterAction", "acceptanceCriteria", "videoPrompt"]),
  visible_final_state_changed: new Set(["characterAction", "continuityNotes", "acceptanceCriteria", "videoPrompt"]),
  required_camera_beat_missing: new Set(["cameraMotion", "acceptanceCriteria", "videoPrompt"]),
  camera_beat_changed_or_reordered: new Set(["cameraMotion", "acceptanceCriteria", "videoPrompt"]),
  required_dialogue_missing: new Set(["dialogueOrSubtitle", "videoPrompt"]),
  dialogue_speaker_or_text_changed: new Set(["dialogueOrSubtitle", "videoPrompt"]),
  required_sound_event_missing: new Set(["soundDesign", "videoPrompt"]),
  sound_event_contradicted: new Set(["soundDesign", "videoPrompt"]),
  continuity_state_impossible: new Set([
    "cameraMotion",
    "characterAction",
    "continuityNotes",
    "acceptanceCriteria",
    "videoPrompt"
  ]),
  duration_changed: new Set(["durationSeconds", "videoPrompt"])
});
const missingEvidenceRelations = new Set([
  "required_visible_cast_missing",
  "required_story_action_missing",
  "required_camera_beat_missing",
  "required_dialogue_missing",
  "required_sound_event_missing"
]);
const shotFactsVerdictSet = new Set(["pass", "fail"]);
const videoPromptVerdictSet = new Set(["pass", "fail", "not_evaluated"]);
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/u;
const authorityFieldPattern = /^[A-Za-z][A-Za-z0-9._/-]{0,159}$/u;
const issuedCatalogs = new WeakMap();
const validatedAudits = new WeakMap();

/**
 * Issue the immutable, server-owned evidence catalog used for one semantic
 * audit call. The model receives a clone through
 * animationVideoPromptSemanticAuditCatalogPayload; response ids have meaning
 * only when resolved against this exact issued object.
 */
export function createAnimationVideoPromptSemanticAuditCatalog(input = {}, { candidate } = {}) {
  assertPlainJson(input, "animationVideoPromptSemanticAuditCatalogInput");
  assertExactKeys(input, ["shots"], "animationVideoPromptSemanticAuditCatalogInput");
  assertPlainJson(candidate, "animationVideoPromptSemanticAuditCatalogCandidate");
  if (!isRecord(candidate) || !Array.isArray(candidate.shotPlan)) {
    throw new OutputContractError(
      "Animation videoPrompt 语义审计 catalog 必须私有绑定完整 candidate.shotPlan"
    );
  }
  if (!Array.isArray(input.shots) || !input.shots.length) {
    throw new OutputContractError("Animation videoPrompt 语义审计 catalog 至少需要一个 shot");
  }

  const shotIds = new Set();
  const authorityFactIds = new Set();
  const candidateFieldIds = new Set();
  const shots = input.shots.map((shot, shotIndex) => {
    const path = `animationVideoPromptSemanticAuditCatalogInput.shots[${shotIndex}]`;
    assertExactKeys(shot, ["shotId", "authorityFacts", "candidateFields"], path);
    const shotId = requireProtocolId(shot.shotId, `${path}.shotId`);
    if (shotIds.has(shotId)) {
      throw new OutputContractError(`Animation videoPrompt 语义审计 catalog 重复 shotId：${shotId}`);
    }
    shotIds.add(shotId);

    if (!Array.isArray(shot.authorityFacts) || !shot.authorityFacts.length) {
      throw new OutputContractError(`${path}.authorityFacts 必须是非空数组`);
    }
    const authorityFacts = shot.authorityFacts.map((fact, factIndex) => {
      const factPath = `${path}.authorityFacts[${factIndex}]`;
      assertExactKeys(fact, ["authorityFactId", "tier", "field", "value"], factPath);
      const authorityFactId = requireProtocolId(fact.authorityFactId, `${factPath}.authorityFactId`);
      if (authorityFactIds.has(authorityFactId)) {
        throw new OutputContractError(
          `Animation videoPrompt 语义审计 catalog 重复 authorityFactId：${authorityFactId}`
        );
      }
      authorityFactIds.add(authorityFactId);
      const tier = requireExactEnum(
        fact.tier,
        authorityTierRanks,
        `${factPath}.tier`
      );
      const field = requireAuthorityField(fact.field, `${factPath}.field`);
      assertPlainJson(fact.value, `${factPath}.value`);
      return {
        authorityFactId,
        tier,
        field,
        value: structuredClone(fact.value)
      };
    });

    if (!Array.isArray(shot.candidateFields) || !shot.candidateFields.length) {
      throw new OutputContractError(`${path}.candidateFields 必须是非空数组`);
    }
    const layerFields = new Set();
    const candidateFields = shot.candidateFields.map((candidate, candidateIndex) => {
      const candidatePath = `${path}.candidateFields[${candidateIndex}]`;
      assertExactKeys(
        candidate,
        ["candidateFieldId", "layer", "field", "value"],
        candidatePath
      );
      const candidateFieldId = requireProtocolId(
        candidate.candidateFieldId,
        `${candidatePath}.candidateFieldId`
      );
      if (candidateFieldIds.has(candidateFieldId)) {
        throw new OutputContractError(
          `Animation videoPrompt 语义审计 catalog 重复 candidateFieldId：${candidateFieldId}`
        );
      }
      candidateFieldIds.add(candidateFieldId);
      const layer = requireExactEnum(
        candidate.layer,
        candidateFieldsByLayer,
        `${candidatePath}.layer`
      );
      const field = requireCandidateField(layer, candidate.field, `${candidatePath}.field`);
      const layerField = `${layer}:${field}`;
      if (layerFields.has(layerField)) {
        throw new OutputContractError(`${path}.candidateFields 重复 ${layer}.${field}`);
      }
      layerFields.add(layerField);
      assertPlainJson(candidate.value, `${candidatePath}.value`);
      return {
        candidateFieldId,
        layer,
        field,
        value: structuredClone(candidate.value)
      };
    });
    if (!layerFields.has("video_prompt:videoPrompt")) {
      throw new OutputContractError(`${path}.candidateFields 必须包含 video_prompt.videoPrompt`);
    }
    if (![...layerFields].some((entry) => entry.startsWith("shot_facts:"))) {
      throw new OutputContractError(`${path}.candidateFields 必须包含至少一个 shot_facts 字段`);
    }

    return { shotId, authorityFacts, candidateFields };
  });

  const catalog = deepFreeze({
    schemaVersion: ANIMATION_VIDEO_PROMPT_SEMANTIC_AUDIT_SCHEMA_VERSION,
    shots
  });
  assertCatalogMatchesCandidate(catalog, candidate);
  issuedCatalogs.set(catalog, deepFreeze({
    catalogDigest: contentDigest(catalog),
    candidateDigest: contentDigest(candidate),
    candidateShotIds: candidate.shotPlan.map((shot) => String(shot?.shotId || ""))
  }));
  return catalog;
}

/** Return a detached, immutable payload safe to serialize into the audit prompt. */
export function animationVideoPromptSemanticAuditCatalogPayload(catalog) {
  assertIssuedCatalog(catalog);
  return deepFreeze(structuredClone(catalog));
}

/**
 * Validate and bind a model response to an issued catalog. This validator does
 * not attempt literal translation equality: a semantically equivalent prompt
 * may pass with no issues. A reported blocker, however, must carry excerpts
 * that exist verbatim in the server-issued evidence catalog.
 */
export function validateAnimationVideoPromptSemanticAuditResponse(value, catalog) {
  const catalogBinding = assertIssuedCatalog(catalog);
  assertPlainJson(value, "animationVideoPromptSemanticAudit");
  assertExactKeys(
    value,
    ["schemaVersion", "shots"],
    "animationVideoPromptSemanticAudit"
  );
  if (value.schemaVersion !== ANIMATION_VIDEO_PROMPT_SEMANTIC_AUDIT_SCHEMA_VERSION) {
    throw new OutputContractError("Animation videoPrompt 语义审计 schemaVersion 无效");
  }
  if (!Array.isArray(value.shots) || value.shots.length !== catalog.shots.length) {
    throw new OutputContractError(
      `Animation videoPrompt 语义审计必须按序返回 ${catalog.shots.length} 个 shots`
    );
  }

  const normalizedShots = value.shots.map((shotResult, shotIndex) => {
    const path = `animationVideoPromptSemanticAudit.shots[${shotIndex}]`;
    const catalogShot = catalog.shots[shotIndex];
    assertExactKeys(
      shotResult,
      ["shotId", "shotFactsVerdict", "videoPromptVerdict", "issues"],
      path
    );
    if (shotResult.shotId !== catalogShot.shotId) {
      throw new OutputContractError(
        `${path}.shotId 必须按 catalog 顺序等于 ${catalogShot.shotId}`
      );
    }
    const shotFactsVerdict = requireExactEnum(
      shotResult.shotFactsVerdict,
      shotFactsVerdictSet,
      `${path}.shotFactsVerdict`
    );
    const videoPromptVerdict = requireExactEnum(
      shotResult.videoPromptVerdict,
      videoPromptVerdictSet,
      `${path}.videoPromptVerdict`
    );
    if (!Array.isArray(shotResult.issues)) {
      throw new OutputContractError(`${path}.issues 必须是数组`);
    }

    const authorityFacts = new Map(
      catalogShot.authorityFacts.map((fact) => [fact.authorityFactId, fact])
    );
    const candidateFields = new Map(
      catalogShot.candidateFields.map((candidate) => [candidate.candidateFieldId, candidate])
    );
    const issues = shotResult.issues.map((issue, issueIndex) => validateIssue({
      issue,
      path: `${path}.issues[${issueIndex}]`,
      authorityFacts,
      candidateFields
    }));

    assertLayerVerdictMatchesIssues({
      verdict: shotFactsVerdict,
      issues,
      layer: "shot_facts",
      path: `${path}.shotFactsVerdict`
    });
    const videoPromptIssues = issues.filter((issue) => issue.layer === "video_prompt");
    if (shotFactsVerdict === "fail") {
      if (videoPromptVerdict !== "not_evaluated") {
        throw new OutputContractError(
          `${path}.shotFactsVerdict 为 fail 时 videoPromptVerdict 必须为 not_evaluated`
        );
      }
      if (videoPromptIssues.length) {
        throw new OutputContractError(
          `${path}.shotFactsVerdict 为 fail 时不得报告低层 video_prompt issue`
        );
      }
    } else {
      if (videoPromptVerdict === "not_evaluated") {
        throw new OutputContractError(
          `${path}.shotFactsVerdict 为 pass 时 videoPromptVerdict 不得为 not_evaluated`
        );
      }
      assertLayerVerdictMatchesIssues({
        verdict: videoPromptVerdict,
        issues,
        layer: "video_prompt",
        path: `${path}.videoPromptVerdict`
      });
    }
    return {
      shotId: catalogShot.shotId,
      shotFactsVerdict,
      videoPromptVerdict,
      issues
    };
  });

  const audit = deepFreeze({
    schemaVersion: ANIMATION_VIDEO_PROMPT_SEMANTIC_AUDIT_SCHEMA_VERSION,
    shots: normalizedShots
  });
  validatedAudits.set(audit, deepFreeze({
    catalog,
    catalogDigest: catalogBinding.catalogDigest,
    candidateDigest: catalogBinding.candidateDigest,
    candidateShotIds: catalogBinding.candidateShotIds
  }));
  return audit;
}

/** Derive the old plan-level decision without accepting a model-supplied one. */
export function deriveAnimationVideoPromptSemanticAuditOverall(audit) {
  assertValidatedAnimationVideoPromptSemanticAudit(audit);
  const shotFactsFailedShotIds = audit.shots
    .filter((shot) => shot.shotFactsVerdict === "fail")
    .map((shot) => shot.shotId);
  const videoPromptFailedShotIds = audit.shots
    .filter((shot) => shot.videoPromptVerdict === "fail")
    .map((shot) => shot.shotId);
  const failedShotIds = audit.shots
    .filter((shot) => (
      shot.shotFactsVerdict === "fail" || shot.videoPromptVerdict === "fail"
    ))
    .map((shot) => shot.shotId);
  const repairableVideoPromptShotIds = audit.shots
    .filter((shot) => (
      shot.shotFactsVerdict === "pass" && shot.videoPromptVerdict === "fail"
    ))
    .map((shot) => shot.shotId);
  return deepFreeze({
    verdict: failedShotIds.length ? "fail" : "pass",
    failedShotIds,
    shotFactsFailedShotIds,
    videoPromptFailedShotIds,
    repairableVideoPromptShotIds
  });
}

/**
 * Project the already-validated semantic issues into the workflow's existing
 * code + RFC 6901 JSON Pointer + reason diagnostic shape. This is an
 * observability projection only: relation remains the stable code and no new
 * semantic decision is introduced here.
 */
export function animationVideoPromptSemanticAuditDiagnostics(audit) {
  assertValidatedAnimationVideoPromptSemanticAudit(audit);
  const binding = validatedAudits.get(audit);
  return audit.shots.flatMap((shot, reviewedShotIndex) => (
    shot.issues.map((issue) => ({
      code: String(issue.relation || "ANIMATION_VIDEO_PROMPT_SEMANTIC_CONFLICT"),
      path: `animationPlan.shotPlan[${semanticAuditShotIndex(binding, shot, reviewedShotIndex)}].${issue.field}`,
      jsonPointer: `/shotPlan/${semanticAuditShotIndex(binding, shot, reviewedShotIndex)}/${escapeJsonPointerToken(issue.field)}`,
      reason: String(issue.productionImpact || issue.relation || "视频提示词语义审计未通过"),
      shotId: String(shot.shotId || ""),
      layer: String(issue.layer || ""),
      category: String(issue.category || "")
    }))
  ));
}

/** Reject raw or reconstructed responses at trust boundaries such as repair adapters. */
export function assertValidatedAnimationVideoPromptSemanticAudit(
  audit,
  { catalog = null, candidate = null } = {}
) {
  const binding = isRecord(audit) ? validatedAudits.get(audit) : null;
  if (!binding) {
    throw new OutputContractError(
      "Animation videoPrompt 语义审计不是本次进程校验签发的对象"
    );
  }
  if (contentDigest(binding.catalog) !== binding.catalogDigest) {
    throw new OutputContractError("Animation videoPrompt 语义审计签发 catalog digest 已失效");
  }
  if (catalog !== null) {
    const expectedCatalogBinding = assertIssuedCatalog(catalog);
    if (binding.catalog !== catalog
      || binding.catalogDigest !== expectedCatalogBinding.catalogDigest) {
      throw new OutputContractError("Animation videoPrompt 语义审计与签发 catalog 不匹配");
    }
  }
  if (candidate !== null) {
    assertPlainJson(candidate, "animationVideoPromptSemanticAuditCandidate");
    if (contentDigest(candidate) !== binding.candidateDigest) {
      throw new OutputContractError("Animation videoPrompt 语义审计与签发 candidate digest 不匹配");
    }
  }
  return audit;
}

function escapeJsonPointerToken(value) {
  return String(value || "").replaceAll("~", "~0").replaceAll("/", "~1");
}

function semanticAuditShotIndex(binding, shot, fallbackIndex) {
  const index = Array.isArray(binding?.candidateShotIds)
    ? binding.candidateShotIds.indexOf(String(shot?.shotId || ""))
    : -1;
  return index >= 0 ? index : fallbackIndex;
}

function validateIssue({ issue, path, authorityFacts, candidateFields }) {
  assertExactKeys(issue, [
    "layer",
    "field",
    "category",
    "relation",
    "authorityFactId",
    "candidateFieldId",
    "authorityExcerpt",
    "candidateExcerpt",
    "productionImpact"
  ], path);
  const layer = requireExactEnum(issue.layer, candidateFieldsByLayer, `${path}.layer`);
  const field = requireCandidateField(layer, issue.field, `${path}.field`);
  const category = requireExactEnum(issue.category, categorySet, `${path}.category`);
  const relation = requireExactEnum(issue.relation, relationSet, `${path}.relation`);
  if (!relationCategories[relation]?.has(category)) {
    throw new OutputContractError(`${path}.category 与 relation 的实质冲突类型不匹配`);
  }
  const authorityFactId = requireProtocolId(issue.authorityFactId, `${path}.authorityFactId`);
  const candidateFieldId = requireProtocolId(issue.candidateFieldId, `${path}.candidateFieldId`);
  const authorityFact = authorityFacts.get(authorityFactId);
  const candidateField = candidateFields.get(candidateFieldId);
  if (!authorityFact) {
    throw new OutputContractError(`${path}.authorityFactId 不属于当前 shot catalog`);
  }
  if (!authorityFieldCanDecideIssue(authorityFact.field, relation, category)) {
    throw new OutputContractError(
      `${path}.authorityFactId 的字段不能作为 ${relation} 的事实来源`
    );
  }
  if (!candidateField) {
    throw new OutputContractError(`${path}.candidateFieldId 不属于当前 shot catalog`);
  }
  if (candidateField.layer !== layer || candidateField.field !== field) {
    throw new OutputContractError(
      `${path} 的 layer/field 与 candidateFieldId 签发字段不一致`
    );
  }
  if (!relationCandidateFields[relation]?.has(candidateField.field)) {
    throw new OutputContractError(
      `${path}.candidateFieldId 的字段不能承载 ${relation} 冲突`
    );
  }
  if (authorityTierRanks[authorityFact.tier] <= candidateLayerRanks[layer]) {
    throw new OutputContractError(`${path} 引用的 authority tier 必须高于 candidate layer`);
  }

  const authorityExcerpt = requireEvidenceExcerpt(
    issue.authorityExcerpt,
    `${path}.authorityExcerpt`
  );
  assertExcerptExists(authorityExcerpt, authorityFact.value, `${path}.authorityExcerpt`);

  let candidateExcerpt = issue.candidateExcerpt;
  if (candidateExcerpt === null) {
    if (!missingEvidenceRelations.has(relation)) {
      throw new OutputContractError(
        `${path}.candidateExcerpt 只有明确缺失 relation 才允许为 null`
      );
    }
  } else {
    candidateExcerpt = requireEvidenceExcerpt(candidateExcerpt, `${path}.candidateExcerpt`);
    assertExcerptExists(candidateExcerpt, candidateField.value, `${path}.candidateExcerpt`);
  }
  const productionImpact = requireNonEmptyString(
    issue.productionImpact,
    `${path}.productionImpact`,
    1200
  );
  return {
    layer,
    field,
    category,
    relation,
    authorityFactId,
    candidateFieldId,
    authorityExcerpt,
    candidateExcerpt,
    productionImpact
  };
}

function authorityFieldCanDecideIssue(field, relation, category) {
  const suffixes = issueAuthorityFieldSuffixes[`${relation}:${category}`] || [];
  return suffixes.some((suffix) => field === suffix || field.endsWith(`.${suffix}`));
}

function assertCatalogMatchesCandidate(catalog, candidate) {
  const candidateShotsById = new Map();
  for (const [shotIndex, shot] of candidate.shotPlan.entries()) {
    if (!isRecord(shot)) {
      throw new OutputContractError(
        `animationVideoPromptSemanticAuditCatalogCandidate.shotPlan[${shotIndex}] 必须是对象`
      );
    }
    const shotId = requireProtocolId(
      shot.shotId,
      `animationVideoPromptSemanticAuditCatalogCandidate.shotPlan[${shotIndex}].shotId`
    );
    if (candidateShotsById.has(shotId)) {
      throw new OutputContractError(
        `Animation videoPrompt 语义审计 candidate 重复 shotId：${shotId}`
      );
    }
    candidateShotsById.set(shotId, shot);
  }
  for (const catalogShot of catalog.shots) {
    const candidateShot = candidateShotsById.get(catalogShot.shotId);
    if (!candidateShot) {
      throw new OutputContractError(
        `Animation videoPrompt 语义审计 catalog shotId 不属于绑定 candidate：${catalogShot.shotId}`
      );
    }
    for (const field of catalogShot.candidateFields) {
      if (!Object.prototype.hasOwnProperty.call(candidateShot, field.field)
        || contentDigest(candidateShot[field.field]) !== contentDigest(field.value)) {
        throw new OutputContractError(
          `Animation videoPrompt 语义审计 catalog ${catalogShot.shotId}.${field.field} 与绑定 candidate 不一致`
        );
      }
    }
  }
}

function assertLayerVerdictMatchesIssues({ verdict, issues, layer, path }) {
  const hasIssue = issues.some((issue) => issue.layer === layer);
  if (verdict === "pass" && hasIssue) {
    throw new OutputContractError(`${path} 为 pass 时不得包含 ${layer} issue`);
  }
  if (verdict === "fail" && !hasIssue) {
    throw new OutputContractError(`${path} 为 fail 时至少需要一个 ${layer} issue`);
  }
}

function assertExcerptExists(excerpt, value, path) {
  const evidence = typeof value === "string" ? value : JSON.stringify(value);
  if (!evidence.includes(excerpt)) {
    throw new OutputContractError(`${path} 必须逐字存在于签发 catalog value`);
  }
}

function requireEvidenceExcerpt(value, path) {
  return requireNonEmptyString(value, path, 4000);
}

function requireNonEmptyString(value, path, maximumLength) {
  if (typeof value !== "string" || !value.trim()) {
    throw new OutputContractError(`${path} 必须是非空字符串`);
  }
  if (value.length > maximumLength) {
    throw new OutputContractError(`${path} 不能超过 ${maximumLength} 字符`);
  }
  return value;
}

function requireProtocolId(value, path) {
  if (typeof value !== "string" || value !== value.trim() || !idPattern.test(value)) {
    throw new OutputContractError(`${path} 必须是稳定协议标识`);
  }
  return value;
}

function requireAuthorityField(value, path) {
  if (typeof value !== "string" || value !== value.trim() || !authorityFieldPattern.test(value)) {
    throw new OutputContractError(`${path} 必须是稳定权威字段标识`);
  }
  return value;
}

function requireCandidateField(layer, value, path) {
  if (typeof value !== "string" || !candidateFieldsByLayer[layer].has(value)) {
    throw new OutputContractError(`${path} 不是 ${layer} allowlist 字段`);
  }
  return value;
}

function requireExactEnum(value, allowed, path) {
  if (typeof value !== "string" || value !== value.trim()) {
    throw new OutputContractError(`${path} 必须是 allowlist 字符串`);
  }
  const hasValue = allowed instanceof Set
    ? allowed.has(value)
    : Object.prototype.hasOwnProperty.call(allowed, value);
  if (!hasValue) throw new OutputContractError(`${path} 不在 allowlist 中`);
  return value;
}

function assertIssuedCatalog(catalog) {
  const binding = isRecord(catalog) ? issuedCatalogs.get(catalog) : null;
  if (!binding) {
    throw new OutputContractError("Animation videoPrompt 语义审计 catalog 不是当前服务端签发对象");
  }
  if (contentDigest(catalog) !== binding.catalogDigest) {
    throw new OutputContractError("Animation videoPrompt 语义审计 catalog digest 已失效");
  }
  return binding;
}

function assertExactKeys(value, keys, path) {
  if (!isRecord(value)) throw new OutputContractError(`${path} 必须是对象`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new OutputContractError(`${path} 只允许字段 ${keys.join("、")}`);
  }
}

function assertPlainJson(value, path, seen = new WeakSet()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new OutputContractError(`${path} 包含非有限数字`);
    return;
  }
  if (!isContainer(value)) throw new OutputContractError(`${path} 不是合法 JSON 值`);
  if (seen.has(value)) throw new OutputContractError(`${path} 包含循环引用`);
  seen.add(value);
  if (!Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new OutputContractError(`${path} 必须是普通 JSON 对象`);
    }
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) {
    throw new OutputContractError(`${path} 包含 JSON 不支持的 Symbol 字段`);
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, String(index))) {
        throw new OutputContractError(`${path} 包含稀疏数组项`);
      }
    }
  }
  for (const key of keys) {
    if (Array.isArray(value) && key === "length") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) {
      throw new OutputContractError(`${path}.${key} 必须是普通数据字段`);
    }
    assertPlainJson(descriptor.value, `${path}.${key}`, seen);
  }
  seen.delete(value);
}

function isContainer(value) {
  return Boolean(value) && typeof value === "object";
}

function isRecord(value) {
  return isContainer(value) && !Array.isArray(value);
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!isContainer(value) || seen.has(value)) return value;
  seen.add(value);
  Object.values(value).forEach((child) => deepFreeze(child, seen));
  return Object.freeze(value);
}
