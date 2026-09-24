// 候选阶段发给模型做约束解码的 Schema（response_format: json_schema）。
// 从服务端严格 Schema 派生，不另写一份：严格 Schema 与全部校验仍是唯一裁决方，
// 这里只做模型那一侧必需的几处变换。依据与实测见 docs/variants-mimo-format-2026-09-24.md。
import { storyCandidatesStrictSchema } from "./contract-validator.js";
import { VARIANT_SOURCE_FIELDS } from "../variant-source-baseline.js";

export const STORY_CANDIDATES_MODEL_SCHEMA_NAME = "story_candidates";

// 服务端从 storyOutline 按拍号派生，模型不得输出（提示词也这么写）。
const SERVER_DERIVED_FIELDS = Object.freeze(["keyChoice", "climax", "emotionalPayoff"]);

// 与 variantsPrompt 输出模板的字段顺序一致。可选的 emotionalMedium / endingRitual
// 不在模板里，放在严格 Schema 里相同的相邻位置。约束解码可能按 Schema 顺序出字段，
// 两边同序就不会出现「提示词要求先写 A、解码器先放 B」的情况。
export const STORY_CANDIDATE_MODEL_FIELD_ORDER = Object.freeze([
  "id", "title", "oneLineHook", "logline", "verticalFit",
  "characterSetup",
  "newTask", "emotionalMedium", "environmentPressure",
  "narrativeMode", "keyChoiceBeat", "climaxBeat", "novelty", "visualPotential",
  "storyOutline", "highValueBeatMapping", "keyDialogueDirections", "endingRitual",
  "transformationProof", "experienceFidelity", "originalityRiskCheck"
]);

// strictSchema 只供测试注入「结构变了的严格 Schema」，生产调用一律用默认值。
export function storyCandidatesModelSchema(count, strictSchema = storyCandidatesStrictSchema()) {
  if (!Number.isInteger(count) || count < 1) {
    throw new TypeError(`候选模型 Schema 的 count 必须是正整数，收到 ${count}`);
  }
  const schema = structuredClone(strictSchema);
  delete schema.$schema;
  delete schema.$id;
  const defs = requireRecord(schema.$defs, "$defs");

  // MiMo 把 pattern 当成全串匹配：pattern "\\S" 会把每个字符串截成一个字符，
  // 开思考时还吐出过非法 JSON。改用 minLength；全空白字符串仍由服务端严格 Schema 拦下。
  requireRecord(defs.nonEmptyString, "$defs.nonEmptyString");
  defs.nonEmptyString = { type: "string", minLength: 1 };

  // source 由服务端从冻结的原片目录填回，模型只写 replacement。
  requireRecord(defs.sourceReplacementPair, "$defs.sourceReplacementPair");
  delete defs.sourceReplacementPair;
  defs.replacementOnly = {
    type: "object",
    additionalProperties: false,
    required: ["replacement"],
    properties: { replacement: { $ref: "#/$defs/nonEmptyString" } }
  };

  const candidate = requireRecord(defs.storyCandidate, "$defs.storyCandidate");
  const properties = requireRecord(candidate.properties, "$defs.storyCandidate.properties");
  const proof = requireRecord(properties.transformationProof?.properties, "transformationProof.properties");
  const proofFields = Object.keys(proof);
  if (proofFields.length !== VARIANT_SOURCE_FIELDS.length || VARIANT_SOURCE_FIELDS.some((field) => !proofFields.includes(field))) {
    fail(`transformationProof 的字段与 VARIANT_SOURCE_FIELDS 不一致：${proofFields.join("、")}`);
  }
  for (const field of VARIANT_SOURCE_FIELDS) {
    if (proof[field]?.$ref !== "#/$defs/sourceReplacementPair") fail(`transformationProof.${field} 不再引用 sourceReplacementPair`);
    proof[field] = { $ref: "#/$defs/replacementOnly" };
  }

  for (const field of SERVER_DERIVED_FIELDS) {
    if (!Object.hasOwn(properties, field) || !candidate.required?.includes(field)) {
      fail(`严格 Schema 里找不到服务端派生字段 ${field}`);
    }
    delete properties[field];
  }
  candidate.required = candidate.required.filter((field) => !SERVER_DERIVED_FIELDS.includes(field));

  const remaining = Object.keys(properties);
  const missing = STORY_CANDIDATE_MODEL_FIELD_ORDER.filter((field) => !remaining.includes(field));
  const extra = remaining.filter((field) => !STORY_CANDIDATE_MODEL_FIELD_ORDER.includes(field));
  if (missing.length || extra.length) {
    fail(`候选字段与 STORY_CANDIDATE_MODEL_FIELD_ORDER 不一致：缺 ${missing.join("、") || "无"}；多 ${extra.join("、") || "无"}`);
  }
  candidate.properties = Object.fromEntries(STORY_CANDIDATE_MODEL_FIELD_ORDER.map((field) => [field, properties[field]]));

  // 提示词要求「恰好 count 个」；锁死之后多写一个空模板候选这类失败在解码时就被挡掉。
  const variants = requireRecord(schema.properties?.variants, "properties.variants");
  if (variants.type !== "array" || variants.items?.$ref !== "#/$defs/storyCandidate") fail("properties.variants 不再是候选数组");
  variants.minItems = count;
  variants.maxItems = count;
  return schema;
}

function requireRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} 不存在或不是对象`);
  return value;
}

function fail(message) {
  throw new Error(`候选模型 Schema 派生失败（严格 Schema 结构变了？）：${message}`);
}
