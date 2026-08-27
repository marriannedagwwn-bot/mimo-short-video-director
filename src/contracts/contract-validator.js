import fs from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";

const fullStorySchema = JSON.parse(fs.readFileSync(
  new URL("./schemas/legacy-full-story-strict.schema.json", import.meta.url),
  "utf8"
));
const storyCandidatesSchema = JSON.parse(fs.readFileSync(
  new URL("./schemas/story-candidates-strict.schema.json", import.meta.url),
  "utf8"
));
const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  verbose: false
});
const validateFullStory = ajv.compile(fullStorySchema);
const validateStoryCandidates = ajv.compile(storyCandidatesSchema);
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

export function validateStoryCandidatesStrict(value) {
  return validateStrictContract(validateStoryCandidates, value, {
    codePrefix: "STORY_CANDIDATES_SCHEMA",
    label: "Story Candidates"
  });
}

export function validateStoryCandidateStrict(value) {
  return validateStrictContract(validateStoryCandidate, value, {
    codePrefix: "STORY_CANDIDATE_SCHEMA",
    label: "Story Candidate"
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

function schemaErrorCode(keyword, codePrefix) {
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
