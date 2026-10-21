// 4.0 分镜审阅（含终审复查）发给 Claude 做结构化输出的 Schema（output_config.format，2026-10-21）。
//
// 起因：Opus 5.5 审阅这一步 10 次调用里 5 次把意见里的 guidance 写成数组（顶层的 guidance 才是数组），
// 校验器拦下后重试也不一定改对。结构化输出按构造保证字段类型与键名，只管结构不管内容。
// 数据见 reports/storyboard-review-replay-2026-10-21/README.md。
//
// 只用 Claude 支持的子集：type / properties / required / additionalProperties:false / items。
// 条数上限、非空、ref 编号与逐字引用都仍由 validateStoryboardReview 判，它是唯一裁决方。
// https://platform.claude.com/docs/en/build-with-claude/structured-outputs（2026-10-21 核对：不支持 minLength /
// maxLength / minimum / maximum 与复杂的数组约束，additionalProperties 只能是 false；可与流式、思考一起用）
//
// 只给 Claude：MiMo 认 responseSchema，审阅不发给 MiMo 任何 Schema，它的请求体逐字不变。
import { STORYBOARD_REVIEW_EVIDENCE_KEYS, STORYBOARD_REVIEW_ITEM_KEYS, STORYBOARD_REVIEW_KEYS } from "../storyboard-review.js";

export const STORYBOARD_REVIEW_CLAUDE_SCHEMA_NAME = "storyboard_review";

const string = () => ({ type: "string" });
const object = (keys, properties) => ({
  type: "object",
  properties: Object.fromEntries(keys.map(key => [key, properties[key]])),
  required: [...keys],
  additionalProperties: false
});

export function storyboardReviewClaudeSchema() {
  const evidence = object(STORYBOARD_REVIEW_EVIDENCE_KEYS, { id: string(), quote: string() });
  const item = object(STORYBOARD_REVIEW_ITEM_KEYS, {
    ref: string(),
    reportedProblem: string(),
    originalEvidence: { type: "array", items: evidence },
    guidance: string()
  });
  return object(STORYBOARD_REVIEW_KEYS, {
    strengths: { type: "array", items: string() },
    guidance: { type: "array", items: string() },
    items: { type: "array", items: item }
  });
}

export function storyboardReviewClaudeResponseSchema() {
  return { name: STORYBOARD_REVIEW_CLAUDE_SCHEMA_NAME, schema: storyboardReviewClaudeSchema() };
}
