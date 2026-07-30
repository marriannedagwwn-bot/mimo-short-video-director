import fs from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { CastProposalValidationError } from "./cast-errors.js";

const AUTOMATIC_ENTITY_CLASSES = new Set([
  "anonymous-extra",
  "anonymous-group",
  "crowd",
  "single-scene-functional"
]);
const AUTOMATIC_IDENTITY_MODES = new Set(["anonymous", "generic-label"]);
const AUTOMATIC_NARRATIVE_IMPORTANCE = new Set(["ambient", "functional"]);
const AUTOMATIC_RELATIONSHIP_MODES = new Set(["none", "transient"]);
const AUTOMATIC_DIALOGUE_POLICIES = new Set(["none", "one-functional-line"]);
const AUTOMATIC_SHOT_EMPHASIS = new Set(["background", "normal"]);
const SCENE_SCRIPT_REFERENCE = /\/sceneScript(?:\/|\[|$)/iu;

const schema = JSON.parse(fs.readFileSync(
  new URL("./contracts/schemas/cast-proposal.schema.json", import.meta.url),
  "utf8"
));
const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  verbose: false
});
const validateSchema = ajv.compile(schema);

export function validateCastProposal(value) {
  if (!validateSchema(value)) {
    const details = (validateSchema.errors || []).map(schemaErrorToDiagnostic);
    throw new CastProposalValidationError(
      `Cast Proposal 结构无效：${details.map((detail) => `${detail.path} ${detail.message}`).join("；")}`,
      { details }
    );
  }

  const details = [];
  const seenProposalRefs = new Set();
  value.roles.forEach((role, index) => {
    const path = `/roles/${index}`;
    if (seenProposalRefs.has(role.proposalRef)) {
      details.push(diagnostic(
        "CAST_PROPOSAL_REF_DUPLICATE",
        `${path}/proposalRef`,
        "proposalRef 必须唯一"
      ));
    }
    seenProposalRefs.add(role.proposalRef);
    if (role.scopePolicy === "scene-limited" && !Number.isInteger(role.maxSceneCount)) {
      details.push(diagnostic(
        "CAST_PROPOSAL_SCOPE_COUNT_INVALID",
        `${path}/maxSceneCount`,
        "scene-limited 必须提供正整数 maxSceneCount"
      ));
    }
    if (role.scopePolicy === "story-wide" && role.maxSceneCount !== null) {
      details.push(diagnostic(
        "CAST_PROPOSAL_SCOPE_COUNT_INVALID",
        `${path}/maxSceneCount`,
        "story-wide 的 maxSceneCount 必须为 null"
      ));
    }
    for (const [field, fieldValue] of Object.entries(role)) {
      if (typeof fieldValue === "string" && SCENE_SCRIPT_REFERENCE.test(fieldValue)) {
        details.push(diagnostic(
          "CAST_PROPOSAL_SCENE_REFERENCE_FORBIDDEN",
          `${path}/${escapeJsonPointerToken(field)}`,
          "Cast Proposal 不得引用尚未生成的 /sceneScript/*"
        ));
      }
      if (Array.isArray(fieldValue)) {
        fieldValue.forEach((item, itemIndex) => {
          if (typeof item !== "string" || !SCENE_SCRIPT_REFERENCE.test(item)) return;
          details.push(diagnostic(
            "CAST_PROPOSAL_SCENE_REFERENCE_FORBIDDEN",
            `${path}/${escapeJsonPointerToken(field)}/${itemIndex}`,
            "Cast Proposal 不得引用尚未生成的 /sceneScript/*"
          ));
        });
      }
    }
  });
  if (details.length) {
    throw new CastProposalValidationError(
      `Cast Proposal 语义无效：${details.map((detail) => `${detail.path} ${detail.message}`).join("；")}`,
      { details }
    );
  }
  return structuredClone(value);
}

export function evaluateCastProposalPolicy(role) {
  const validated = validateCastProposal({ roles: [role] }).roles[0];
  const reasons = [];

  if (!AUTOMATIC_ENTITY_CLASSES.has(validated.entityClass)) {
    reasons.push(reason(
      "ENTITY_CLASS_REQUIRES_CONFIRMATION",
      "entityClass",
      validated.entityClass
    ));
  }
  if (!AUTOMATIC_IDENTITY_MODES.has(validated.identityMode)) {
    reasons.push(reason(
      "IDENTITY_MODE_REQUIRES_CONFIRMATION",
      "identityMode",
      validated.identityMode
    ));
  }
  if (validated.proposedAliases.length > 0) {
    reasons.push(reason(
      "ALIASES_REQUIRE_CONFIRMATION",
      "proposedAliases",
      validated.proposedAliases.length
    ));
  }
  if (validated.scopePolicy !== "scene-limited") {
    reasons.push(reason(
      "STORY_WIDE_SCOPE_REQUIRES_CONFIRMATION",
      "scopePolicy",
      validated.scopePolicy
    ));
  }
  if (validated.maxSceneCount !== 1) {
    reasons.push(reason(
      "SCENE_COUNT_REQUIRES_CONFIRMATION",
      "maxSceneCount",
      validated.maxSceneCount
    ));
  }
  if (!AUTOMATIC_NARRATIVE_IMPORTANCE.has(validated.narrativeImportance)) {
    reasons.push(reason(
      "NARRATIVE_IMPORTANCE_REQUIRES_CONFIRMATION",
      "narrativeImportance",
      validated.narrativeImportance
    ));
  }
  if (!AUTOMATIC_RELATIONSHIP_MODES.has(validated.relationshipMode)) {
    reasons.push(reason(
      "RELATIONSHIP_REQUIRES_CONFIRMATION",
      "relationshipMode",
      validated.relationshipMode
    ));
  }
  if (!AUTOMATIC_DIALOGUE_POLICIES.has(validated.dialoguePolicy)) {
    reasons.push(reason(
      "DIALOGUE_POLICY_REQUIRES_CONFIRMATION",
      "dialoguePolicy",
      validated.dialoguePolicy
    ));
  }
  if (!AUTOMATIC_SHOT_EMPHASIS.has(validated.shotEmphasis)) {
    reasons.push(reason(
      "SHOT_EMPHASIS_REQUIRES_CONFIRMATION",
      "shotEmphasis",
      validated.shotEmphasis
    ));
  }
  if (validated.continuityRequired) {
    reasons.push(reason(
      "CONTINUITY_REQUIRES_CONFIRMATION",
      "continuityRequired",
      true
    ));
  }
  if (validated.requiresReferenceAsset) {
    reasons.push(reason(
      "REFERENCE_ASSET_REQUIRES_CONFIRMATION",
      "requiresReferenceAsset",
      true
    ));
  }

  if (validated.entityClass.startsWith("anonymous-") && validated.identityMode === "named") {
    reasons.push(reason(
      "ENTITY_IDENTITY_CONFLICT",
      "identityMode",
      validated.identityMode
    ));
  }
  if (validated.entityClass === "single-scene-functional"
    && !AUTOMATIC_NARRATIVE_IMPORTANCE.has(validated.narrativeImportance)) {
    reasons.push(reason(
      "FUNCTIONAL_ROLE_IMPORTANCE_CONFLICT",
      "narrativeImportance",
      validated.narrativeImportance
    ));
  }
  if (validated.scopePolicy === "scene-limited" && validated.continuityRequired) {
    reasons.push(reason(
      "SCENE_SCOPE_CONTINUITY_CONFLICT",
      "continuityRequired",
      true
    ));
  }

  const uniqueReasons = dedupeReasons(reasons);
  if (uniqueReasons.length) {
    return Object.freeze({
      proposalRef: validated.proposalRef,
      decision: "confirmation-required",
      reasons: Object.freeze(uniqueReasons)
    });
  }

  return Object.freeze({
    proposalRef: validated.proposalRef,
    decision: "automatic",
    reasons: Object.freeze([]),
    usageConstraints: Object.freeze(automaticUsageConstraints(validated))
  });
}

export function evaluateCastProposal(castProposal) {
  const validated = validateCastProposal(castProposal);
  return Object.freeze({
    roles: Object.freeze(validated.roles.map(evaluateCastProposalPolicy))
  });
}

export function automaticUsageConstraints(role) {
  return {
    approvalMode: "automatic",
    isEphemeral: true,
    maxSceneCount: 1,
    maxDialogueLines: role.dialoguePolicy === "none" ? 0 : 1,
    maxDialogueCodePoints: 80,
    allowedNarrativeImportance: ["ambient", "functional"],
    allowCloseUp: false,
    allowPersistentRelationship: false,
    allowReferenceAsset: false,
    assetPolicy: "none"
  };
}

export function confirmedUsageConstraints(role) {
  return {
    approvalMode: "user-confirmed",
    isEphemeral: role.scopePolicy === "scene-limited"
      && role.entityClass !== "persistent-character",
    maxSceneCount: role.maxSceneCount,
    maxDialogueLines: role.dialoguePolicy === "none"
      ? 0
      : role.dialoguePolicy === "one-functional-line" ? 1 : null,
    maxDialogueCodePoints: role.dialoguePolicy === "one-functional-line" ? 80 : null,
    allowedNarrativeImportance: [role.narrativeImportance],
    allowCloseUp: role.shotEmphasis === "close-up",
    allowPersistentRelationship: role.relationshipMode === "persistent",
    allowReferenceAsset: role.requiresReferenceAsset,
    assetPolicy: role.requiresReferenceAsset ? "reference-required" : "none"
  };
}

export function countUnicodeCodePoints(value) {
  return Array.from(String(value || "")).length;
}

export function validateDialogueAgainstUsageConstraints(lines, constraints) {
  const normalizedLines = Array.isArray(lines) ? lines.map((line) => String(line || "")) : [];
  const maxLines = constraints?.maxDialogueLines;
  const maxCodePoints = constraints?.maxDialogueCodePoints;
  const violations = [];
  if (Number.isInteger(maxLines) && normalizedLines.length > maxLines) {
    violations.push({
      code: "CAST_DIALOGUE_LINE_COUNT_EXCEEDED",
      actual: normalizedLines.length,
      allowed: maxLines
    });
  }
  normalizedLines.forEach((line, index) => {
    const actual = countUnicodeCodePoints(line);
    if (Number.isInteger(maxCodePoints) && actual > maxCodePoints) {
      violations.push({
        code: "CAST_DIALOGUE_CODE_POINTS_EXCEEDED",
        index,
        actual,
        allowed: maxCodePoints
      });
    }
  });
  return {
    ok: violations.length === 0,
    violations
  };
}

function schemaErrorToDiagnostic(error) {
  const property = error.keyword === "required"
    ? error.params?.missingProperty
    : error.keyword === "additionalProperties"
      ? error.params?.additionalProperty
      : "";
  const path = property
    ? `${String(error.instancePath || "")}/${escapeJsonPointerToken(property)}`
    : String(error.instancePath || "") || "/";
  const code = error.keyword === "additionalProperties"
    ? "CAST_PROPOSAL_FIELD_FORBIDDEN"
    : error.keyword === "required"
      ? "CAST_PROPOSAL_FIELD_REQUIRED"
      : "CAST_PROPOSAL_SCHEMA_INVALID";
  return diagnostic(code, path, schemaErrorMessage(error));
}

function schemaErrorMessage(error) {
  if (error.keyword === "additionalProperties") return "包含禁止或未知字段";
  if (error.keyword === "required") return "缺少必要字段";
  if (error.keyword === "enum") return "值不在允许枚举中";
  if (error.keyword === "type") return `类型必须为 ${String(error.params?.type || "schema 指定类型")}`;
  return String(error.message || "不符合 Cast Proposal schema");
}

function diagnostic(code, path, message) {
  return { code, path, message };
}

function reason(code, field, actual) {
  return Object.freeze({ code, field, actual });
}

function dedupeReasons(reasons) {
  const seen = new Set();
  return reasons.filter((item) => {
    const key = `${item.code}:${item.field}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function escapeJsonPointerToken(value) {
  return String(value).replaceAll("~", "~0").replaceAll("/", "~1");
}
