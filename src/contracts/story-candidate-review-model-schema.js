// 候选对照评审（含展开前体检复用的那一次）发给模型做约束解码的 Schema（response_format: json_schema）。
// 与候选阶段同一个做法（story-candidates-model-schema.js）：从服务端严格 Schema 派生，不另写一份；
// 严格 Schema、覆盖率核验与全部派生仍是唯一裁决方，这里只做模型那一侧必需的几处变换。
// 起因见 docs/variants-mimo-format-2026-09-24.md 末节「候选对照评审」。
import { storyCandidateReviewStrictSchema } from "./contract-validator.js";

export const STORY_CANDIDATE_REVIEW_MODEL_SCHEMA_NAME = "story_candidate_review";

// 服务端在校验通过后派生并覆盖（validation.js 的十一维派生链），模型不写（提示词也这么写）。
const SERVER_DERIVED_REPORT_FIELDS = Object.freeze(["scoreOrder", "recommendedWinner", "runnerUp", "rejectOrRegenerate"]);
const SERVER_DERIVED_CHECK_FIELDS = Object.freeze([
  "overallScore", "tier", "scoreBasedVerdict", "effectiveVerdict", "verdictOverrideReasons"
]);

// 与 storyCandidateReviewPrompt 输出模板的字段顺序一致。约束解码按 Schema 顺序出字段，
// 两边同序就不会出现「提示词要求先写 A、解码器先放 B」的情况。
export const STORY_CANDIDATE_REVIEW_MODEL_FIELD_ORDER = Object.freeze([
  "schemaVersion", "sourceMechanisms", "candidateChecks", "holisticPreferenceOrder",
  "batchTemplateConvergence", "briefProblemsDetected", "summary"
]);
export const STORY_CANDIDATE_REVIEW_CHECK_MODEL_FIELD_ORDER = Object.freeze([
  "candidateId", "title", "coreInteraction", "mechanismChecks", "coherenceChecks",
  "sourceScaffoldOverlap", "dimensions", "physicalAssumptions", "strongestReason",
  "dominantDefect", "briefAlignment", "top3RevisionSuggestions", "why", "keepThis"
]);

// strictSchema 只供测试注入「结构变了的严格 Schema」，生产调用一律用默认值。
export function storyCandidateReviewModelSchema(count, strictSchema = storyCandidateReviewStrictSchema()) {
  if (!Number.isInteger(count) || count < 1) {
    throw new TypeError(`候选对照评审模型 Schema 的 count 必须是正整数，收到 ${count}`);
  }
  const schema = structuredClone(strictSchema);
  delete schema.$schema;
  delete schema.$id;
  const defs = requireRecord(schema.$defs, "$defs");

  // MiMo 把 pattern 当成全串匹配：pattern "\\S" 会把每个字符串截成一个字符，
  // 开思考时还吐出过非法 JSON。改用 minLength；全空白字符串仍由服务端严格 Schema 拦下。
  requireRecord(defs.nonEmptyString, "$defs.nonEmptyString");
  defs.nonEmptyString = { type: "string", minLength: 1 };

  const properties = requireRecord(schema.properties, "properties");
  // const 没有在 MiMo 上实测过，换成已实测生效的单值 enum，取值逐字不变。
  const version = requireRecord(properties.schemaVersion, "properties.schemaVersion");
  if (typeof version.const !== "string") fail("properties.schemaVersion 不再是 const 字符串");
  properties.schemaVersion = { type: "string", enum: [version.const] };

  schema.properties = pickInOrder(
    properties,
    schema.required,
    SERVER_DERIVED_REPORT_FIELDS,
    STORY_CANDIDATE_REVIEW_MODEL_FIELD_ORDER,
    "评审顶层"
  );

  const check = requireRecord(defs.candidateCheck, "$defs.candidateCheck");
  check.properties = pickInOrder(
    requireRecord(check.properties, "$defs.candidateCheck.properties"),
    check.required,
    SERVER_DERIVED_CHECK_FIELDS,
    STORY_CANDIDATE_REVIEW_CHECK_MODEL_FIELD_ORDER,
    "candidateCheck"
  );

  // 提示词给了 count 个候选；覆盖率核验要求逐个评、且整体偏好序是它们的排列。
  // 锁死个数之后，「数组里混进孤立字符串」「多评或漏评一个」这类失败在解码时就被挡掉。
  for (const field of ["candidateChecks", "holisticPreferenceOrder"]) {
    const array = requireRecord(schema.properties[field], `properties.${field}`);
    if (array.type !== "array") fail(`properties.${field} 不再是数组`);
    array.minItems = count;
    array.maxItems = count;
  }
  return schema;
}

// 去掉服务端派生字段（它们在严格 Schema 里是可选键，必须不在 required 里），
// 其余字段必须与模型字段顺序表逐一对上，按表排序。
function pickInOrder(properties, required, derived, order, label) {
  for (const field of derived) {
    if (!Object.hasOwn(properties, field)) fail(`${label} 里找不到服务端派生字段 ${field}`);
    if (required?.includes(field)) fail(`${label} 的派生字段 ${field} 变成了必填`);
  }
  const remaining = Object.keys(properties).filter((field) => !derived.includes(field));
  const missing = order.filter((field) => !remaining.includes(field));
  const extra = remaining.filter((field) => !order.includes(field));
  if (missing.length || extra.length) {
    fail(`${label} 字段与模型字段顺序表不一致：缺 ${missing.join("、") || "无"}；多 ${extra.join("、") || "无"}`);
  }
  return Object.fromEntries(order.map((field) => [field, properties[field]]));
}

function requireRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} 不存在或不是对象`);
  return value;
}

function fail(message) {
  throw new Error(`候选对照评审模型 Schema 派生失败（严格 Schema 结构变了？）：${message}`);
}
