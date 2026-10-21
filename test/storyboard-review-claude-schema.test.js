import test from "node:test";
import assert from "node:assert/strict";
import Ajv2020 from "ajv/dist/2020.js";
import {
  STORYBOARD_REVIEW_CLAUDE_SCHEMA_NAME,
  storyboardReviewClaudeResponseSchema,
  storyboardReviewClaudeSchema
} from "../src/contracts/storyboard-review-claude-schema.js";
import {
  STORYBOARD_REVIEW_EVIDENCE_KEYS,
  STORYBOARD_REVIEW_ITEM_KEYS,
  STORYBOARD_REVIEW_KEYS,
  storyboardReviewPrompt,
  validateStoryboardReview
} from "../src/storyboard-review.js";

// 给 Claude 审阅的结构化输出 Schema（2026-10-21）。只用 Claude 支持的子集；条数、非空、ref 编号与逐字引用
// 仍由校验器判。键名与校验器共用一份常量。

const ALLOWED_KEYWORDS = new Set(["type", "properties", "required", "additionalProperties", "items"]);

function walk(node, path, visit) {
  visit(node, path);
  for (const [key, child] of Object.entries(node.properties || {})) walk(child, `${path}.properties.${key}`, visit);
  if (node.items) walk(node.items, `${path}.items`, visit);
}

// 用 Ajv 判「符合 / 不符合」，strict 模式下 Schema 写错关键字会直接报错。
const ajv = new Ajv2020({ strict: true, allErrors: true });
const conforms = (schema, value) => ajv.validate(schema, value);

const plan = { shotPlan: [{ beats: [{ visibleAction: "蜗牛朝画面右侧爬" }] }] };
const context = { input: {}, plan };
const valid = { strengths: ["保住的设计"], guidance: ["引导"], items: [{ ref: "I1", reportedProblem: "问题", originalEvidence: [{ id: "P001", quote: "朝画面右侧爬" }], guidance: "一段话" }] };

test("只用 Claude 支持的关键字；每个对象都是 additionalProperties:false 且全部必填", () => {
  walk(storyboardReviewClaudeSchema(), "$", (node, path) => {
    for (const keyword of Object.keys(node)) assert.ok(ALLOWED_KEYWORDS.has(keyword), `${path} 用了 ${keyword}`);
    if (node.type === "object") {
      assert.equal(node.additionalProperties, false, path);
      assert.deepEqual(node.required, Object.keys(node.properties), path);
    }
  });
  assert.deepEqual(storyboardReviewClaudeResponseSchema(), { name: STORYBOARD_REVIEW_CLAUDE_SCHEMA_NAME, schema: storyboardReviewClaudeSchema() });
});

test("键名与顺序取自校验器的常量，也与提示词里的输出模板一致", () => {
  const schema = storyboardReviewClaudeSchema();
  assert.deepEqual(Object.keys(schema.properties), [...STORYBOARD_REVIEW_KEYS]);
  assert.deepEqual(Object.keys(schema.properties.items.items.properties), [...STORYBOARD_REVIEW_ITEM_KEYS]);
  assert.deepEqual(Object.keys(schema.properties.items.items.properties.originalEvidence.items.properties), [...STORYBOARD_REVIEW_EVIDENCE_KEYS]);
  const template = JSON.parse(storyboardReviewPrompt({ input: {}, plan: {} }).match(/只输出严格JSON：(\{.*\})。items可以为空/u)[1]);
  assert.deepEqual(Object.keys(template), [...STORYBOARD_REVIEW_KEYS]);
  assert.deepEqual(Object.keys(template.items[0]), [...STORYBOARD_REVIEW_ITEM_KEYS]);
  assert.deepEqual(Object.keys(template.items[0].originalEvidence[0]), [...STORYBOARD_REVIEW_EVIDENCE_KEYS]);
});

test("能过校验器的审阅符合 Schema；意见里的 guidance 写成数组、引用键写成 text 都不符合", () => {
  const schema = storyboardReviewClaudeSchema();
  assert.doesNotThrow(() => validateStoryboardReview(structuredClone(valid), context));
  assert.equal(conforms(schema, valid), true);
  assert.equal(conforms(schema, { strengths: [], guidance: [], items: [] }), true);
  const arrayGuidance = structuredClone(valid);
  arrayGuidance.items[0].guidance = ["第一点", "第二点"];
  assert.equal(conforms(schema, arrayGuidance), false);
  const textKey = structuredClone(valid);
  textKey.items[0].originalEvidence[0] = { id: "P001", text: "朝画面右侧爬" };
  assert.equal(conforms(schema, textKey), false);
  const missingTopGuidance = structuredClone(valid);
  delete missingTopGuidance.guidance;
  assert.equal(conforms(schema, missingTopGuidance), false);
});
