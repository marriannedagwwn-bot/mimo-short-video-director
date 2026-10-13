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
const storyCandidateReviewSchema = JSON.parse(fs.readFileSync(
  new URL("./schemas/story-candidate-review-strict.schema.json", import.meta.url),
  "utf8"
));
const fullStoryPromiseCheckSchema = JSON.parse(fs.readFileSync(
  new URL("./schemas/full-story-promise-check-strict.schema.json", import.meta.url),
  "utf8"
));
const directorAgentTurnSchema = JSON.parse(fs.readFileSync(
  new URL("./schemas/director-agent-turn-strict.schema.json", import.meta.url),
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
const validateStoryCandidateReview = ajv.compile(storyCandidateReviewSchema);
const validateFullStoryPromiseCheck = ajv.compile(fullStoryPromiseCheckSchema);
const validateDirectorAgentTurn = ajv.compile(directorAgentTurnSchema);
const validateStoryCandidate = ajv.compile({
  $schema: storyCandidatesSchema.$schema,
  $id: "internal://story-candidate-strict",
  ...storyCandidatesSchema.$defs.storyCandidate,
  $defs: storyCandidatesSchema.$defs
});

// 「从剧情开始」的候选没有参考视频可对照。从上面那份严格 Schema 派生，只去掉四个
// 对照原片的字段、恰好一个候选——不另写一份 JSON，共享字段就不会漂移，视频入口的
// Schema 一个字不动。派生前先确认四个字段都在：基础 Schema 改了结构，模块加载时
// 就失败，不会静默派生出一份缺口 Schema。两份 Schema 都是 additionalProperties:false，
// 所以互相不接受对方的候选。
export const STORY_ENTRY_REMOVED_CANDIDATE_FIELDS = Object.freeze([
  "highValueBeatMapping",
  "transformationProof",
  "experienceFidelity",
  "originalityRiskCheck"
]);
const storyEntryCandidatesSchema = deriveStoryEntryCandidatesSchema(storyCandidatesSchema);
const validateStoryEntryCandidates = ajv.compile(storyEntryCandidatesSchema);
const validateStoryEntryCandidate = ajv.compile({
  $schema: storyEntryCandidatesSchema.$schema,
  $id: "internal://story-entry-candidate-strict",
  ...storyEntryCandidatesSchema.$defs.storyCandidate,
  $defs: storyEntryCandidatesSchema.$defs
});

function deriveStoryEntryCandidatesSchema(base) {
  const schema = structuredClone(base);
  schema.$id = "internal://story-entry-candidates-strict";
  const candidate = schema.$defs?.storyCandidate;
  for (const field of STORY_ENTRY_REMOVED_CANDIDATE_FIELDS) {
    if (!candidate?.properties?.[field] || !candidate.required?.includes(field)) {
      throw new Error(`派生剧情入口候选 Schema 失败：基础 Schema 里找不到必填字段 ${field}`);
    }
    delete candidate.properties[field];
    candidate.required = candidate.required.filter((key) => key !== field);
  }
  // 唯一引用它的 transformationProof 已删；还有别处引用的话 ajv 编译会直接报错。
  if (!schema.$defs.sourceReplacementPair) throw new Error("派生剧情入口候选 Schema 失败：基础 Schema 里找不到 sourceReplacementPair");
  delete schema.$defs.sourceReplacementPair;
  if (schema.properties?.variants?.type !== "array") throw new Error("派生剧情入口候选 Schema 失败：variants 不再是数组");
  schema.properties.variants = { ...schema.properties.variants, minItems: 1, maxItems: 1 };
  return schema;
}

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

export function storyEntryCandidatesStrictSchema() {
  return structuredClone(storyEntryCandidatesSchema);
}

export function validateStoryEntryCandidatesStrict(value) {
  return validateStrictContract(validateStoryEntryCandidates, value, {
    codePrefix: "STORY_ENTRY_CANDIDATES_SCHEMA",
    label: "Story Entry Candidate"
  });
}

export function validateStoryEntryCandidateStrict(value) {
  return validateStrictContract(validateStoryEntryCandidate, value, {
    codePrefix: "STORY_ENTRY_CANDIDATE_SCHEMA",
    label: "Story Entry Candidate"
  });
}

export function validateStoryQualityReviewStrict(value) {
  return validateStrictContract(validateStoryQualityReview, value, {
    codePrefix: "STORY_QUALITY_REVIEW_SCHEMA",
    label: "Story Quality Review"
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

// 导演助手一轮回复。给模型做约束解码的 Schema 从这份派生（director-agent-turn-model-schema.js）。
export function directorAgentTurnStrictSchema() {
  return structuredClone(directorAgentTurnSchema);
}

export function validateDirectorAgentTurnStrict(value) {
  return validateStrictContract(validateDirectorAgentTurn, value, {
    codePrefix: "DIRECTOR_AGENT_TURN_SCHEMA",
    label: "Director Agent Turn"
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
