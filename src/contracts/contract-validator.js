import fs from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";

const fullStorySchema = JSON.parse(fs.readFileSync(
  new URL("./schemas/legacy-full-story-strict.schema.json", import.meta.url),
  "utf8"
));
const narrativeFullStorySchema = JSON.parse(fs.readFileSync(
  new URL("./schemas/narrative-full-story-strict.schema.json", import.meta.url),
  "utf8"
));
const castFullStorySchema = JSON.parse(fs.readFileSync(
  new URL("./schemas/cast-full-story-strict.schema.json", import.meta.url), "utf8"
));
const storyCandidatesSchema = JSON.parse(fs.readFileSync(
  new URL("./schemas/story-candidates-strict.schema.json", import.meta.url),
  "utf8"
));
const storyQualityReviewSchema = JSON.parse(fs.readFileSync(
  new URL("./schemas/story-quality-review-strict.schema.json", import.meta.url),
  "utf8"
));
const animationPlanReviewSchema = JSON.parse(fs.readFileSync(
  new URL("./schemas/animation-plan-review-strict.schema.json", import.meta.url),
  "utf8"
));
const storyCandidateReviewSchema = JSON.parse(fs.readFileSync(
  new URL("./schemas/story-candidate-review-strict.schema.json", import.meta.url),
  "utf8"
));
const fullStoryPromiseCheckSchema = JSON.parse(fs.readFileSync(
  new URL("./schemas/full-story-promise-check-strict.schema.json", import.meta.url),
  "utf8"
));
const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  verbose: false
});
const validateFullStory = ajv.compile(fullStorySchema);
const validateNarrativeFullStory = ajv.compile(narrativeFullStorySchema);
const validateCastFullStory = ajv.compile(castFullStorySchema);
const validateCastRegistry = ajv.compile(castFullStorySchema.properties.characterBible);
const validateStoryCandidates = ajv.compile(storyCandidatesSchema);
const validateStoryQualityReview = ajv.compile(storyQualityReviewSchema);
const validateAnimationPlanReview = ajv.compile(animationPlanReviewSchema);
const validateStoryCandidateReview = ajv.compile(storyCandidateReviewSchema);
const validateFullStoryPromiseCheck = ajv.compile(fullStoryPromiseCheckSchema);
const validateStoryCandidate = ajv.compile({
  $schema: storyCandidatesSchema.$schema,
  $id: "internal://story-candidate-strict",
  ...storyCandidatesSchema.$defs.storyCandidate,
  $defs: storyCandidatesSchema.$defs
});

export function validateLegacyFullStoryStrict(value) {
  return validateStrictContract(validateFullStory, value, {
    codePrefix: "FULL_STORY_SCHEMA",
    label: "Full Story"
  });
}

export function validateNarrativeFullStoryStrict(value) {
  return validateStrictContract(value?.schemaVersion === "full_story/1.2" ? validateCastFullStory : validateNarrativeFullStory, value, {
    codePrefix: "FULL_STORY_SCHEMA",
    label: "Full Story"
  });
}

export function validateFullStoryRegistryStrict(value) {
  return validateStrictContract(validateCastRegistry, value, { codePrefix: "FULL_STORY_CAST_SCHEMA", label: "角色事实表" });
}

// variant-source-baseline 在严格 Schema 之前先查候选形状，用同一个前缀和
// schemaErrorCode 报码，两处的码名只有这一份。
export const STORY_CANDIDATES_SCHEMA_CODE_PREFIX = "STORY_CANDIDATES_SCHEMA";

// 给模型做约束解码的 Schema 从这份派生（story-candidates-model-schema.js），不另写一份。
export function storyCandidatesStrictSchema() {
  return structuredClone(storyCandidatesSchema);
}

export function validateStoryCandidatesStrict(value) {
  return validateStrictContract(validateStoryCandidates, value, {
    codePrefix: STORY_CANDIDATES_SCHEMA_CODE_PREFIX,
    label: "Story Candidates"
  });
}

export function validateStoryCandidateStrict(value) {
  return validateStrictContract(validateStoryCandidate, value, {
    codePrefix: "STORY_CANDIDATE_SCHEMA",
    label: "Story Candidate"
  });
}

export function validateStoryQualityReviewStrict(value) {
  return validateStrictContract(validateStoryQualityReview, value, {
    codePrefix: "STORY_QUALITY_REVIEW_SCHEMA",
    label: "Story Quality Review"
  });
}

export function validateAnimationPlanReviewStrict(value) {
  return validateStrictContract(validateAnimationPlanReview, value, {
    codePrefix: "ANIMATION_PLAN_REVIEW_SCHEMA",
    label: "Animation Plan Review"
  });
}

// 给模型做约束解码的 Schema 从这份派生（story-candidate-review-model-schema.js），不另写一份。
export function storyCandidateReviewStrictSchema() {
  return structuredClone(storyCandidateReviewSchema);
}

export function validateStoryCandidateReviewStrict(value) {
  return validateStrictContract(validateStoryCandidateReview, value, {
    codePrefix: "STORY_CANDIDATE_REVIEW_SCHEMA",
    label: "Story Candidate Review"
  });
}

export function validateFullStoryPromiseCheckStrict(value) {
  return validateStrictContract(validateFullStoryPromiseCheck, value, {
    codePrefix: "FULL_STORY_PROMISE_CHECK_SCHEMA",
    label: "Full Story Promise Check"
  });
}

function validateStrictContract(validate, value, diagnosticOptions) {
  const valid = validate(value);
  if (valid) return { ok: true, diagnostics: [] };
  return {
    ok: false,
    diagnostics: (validate.errors || []).map((error) => schemaErrorToDiagnostic(error, diagnosticOptions))
  };
}

function schemaErrorToDiagnostic(error, { codePrefix, label }) {
  const path = schemaErrorPath(error);
  return {
    code: schemaErrorCode(error.keyword, codePrefix),
    path,
    reason: schemaErrorReason(error, label),
    keyword: String(error.keyword || "")
  };
}

function schemaErrorPath(error) {
  const instancePath = String(error.instancePath || "");
  if (error.keyword === "required" && error.params?.missingProperty) {
    return `${instancePath}/${escapeJsonPointerToken(error.params.missingProperty)}`;
  }
  if (error.keyword === "additionalProperties" && error.params?.additionalProperty) {
    return `${instancePath}/${escapeJsonPointerToken(error.params.additionalProperty)}`;
  }
  return instancePath || "/";
}

export function schemaErrorCode(keyword, codePrefix) {
  if (keyword === "required") return `${codePrefix}_REQUIRED`;
  if (keyword === "additionalProperties") return `${codePrefix}_UNKNOWN_FIELD`;
  if (keyword === "type") return `${codePrefix}_TYPE`;
  if (keyword === "minItems") return `${codePrefix}_MIN_ITEMS`;
  if (keyword === "pattern") return `${codePrefix}_EMPTY_STRING`;
  if (keyword === "minimum" || keyword === "exclusiveMinimum") return `${codePrefix}_RANGE`;
  return `${codePrefix}_INVALID`;
}

function schemaErrorReason(error, label) {
  if (error.keyword === "required") return "缺少必要字段";
  if (error.keyword === "additionalProperties") return "包含未定义字段";
  if (error.keyword === "pattern") return "必须是非空字符串";
  if (error.keyword === "type") return `类型必须为 ${String(error.params?.type || "schema 指定类型")}`;
  if (error.keyword === "minItems") return `数组至少需要 ${Number(error.params?.limit) || 1} 项`;
  if (error.keyword === "minimum" || error.keyword === "exclusiveMinimum") return "数值超出允许范围";
  return String(error.message || `不符合 ${label} 结构`);
}

function escapeJsonPointerToken(value) {
  return String(value).replaceAll("~", "~0").replaceAll("/", "~1");
}
