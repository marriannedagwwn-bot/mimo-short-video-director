import fs from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";

const schema = JSON.parse(fs.readFileSync(
  new URL("./schemas/legacy-full-story-strict.schema.json", import.meta.url),
  "utf8"
));
const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  verbose: false
});
const validateFullStory = ajv.compile(schema);

export function validateLegacyFullStoryStrict(value) {
  const valid = validateFullStory(value);
  if (valid) return { ok: true, diagnostics: [] };
  return {
    ok: false,
    diagnostics: (validateFullStory.errors || []).map(schemaErrorToDiagnostic)
  };
}

function schemaErrorToDiagnostic(error) {
  const path = schemaErrorPath(error);
  return {
    code: schemaErrorCode(error.keyword),
    path,
    reason: schemaErrorReason(error),
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

function schemaErrorCode(keyword) {
  if (keyword === "required") return "FULL_STORY_SCHEMA_REQUIRED";
  if (keyword === "additionalProperties") return "FULL_STORY_SCHEMA_UNKNOWN_FIELD";
  if (keyword === "type") return "FULL_STORY_SCHEMA_TYPE";
  if (keyword === "minItems") return "FULL_STORY_SCHEMA_MIN_ITEMS";
  if (keyword === "pattern") return "FULL_STORY_SCHEMA_EMPTY_STRING";
  if (keyword === "minimum" || keyword === "exclusiveMinimum") return "FULL_STORY_SCHEMA_RANGE";
  return "FULL_STORY_SCHEMA_INVALID";
}

function schemaErrorReason(error) {
  if (error.keyword === "required") return "缺少必要字段";
  if (error.keyword === "additionalProperties") return "包含未定义字段";
  if (error.keyword === "pattern") return "必须是非空字符串";
  if (error.keyword === "type") return `类型必须为 ${String(error.params?.type || "schema 指定类型")}`;
  if (error.keyword === "minItems") return `数组至少需要 ${Number(error.params?.limit) || 1} 项`;
  if (error.keyword === "minimum" || error.keyword === "exclusiveMinimum") return "数值超出允许范围";
  return String(error.message || "不符合 Full Story 结构");
}

function escapeJsonPointerToken(value) {
  return String(value).replaceAll("~", "~0").replaceAll("/", "~1");
}
