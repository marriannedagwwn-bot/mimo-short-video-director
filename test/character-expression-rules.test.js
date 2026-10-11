import test from "node:test";
import assert from "node:assert/strict";
import {
  CHARACTER_EXPRESSION_RULES_MAX_CHARS,
  isValidCharacterExpressionRules
} from "../public/character-expression-rules.js";
import {
  briefPrompt,
  fullStoryPrompt
} from "../src/prompts.js";

// 3.0 的两个专门注入面（Foundation 与逐镜提示词）与它们用的 normalizeCharacterExpressionRules
// 已于 2026-10-11 随 3.0 分镜删除。服务端仍接受这个请求字段（两个分镜路由只拦类型与超长），
// 4.0 把它原样写进 productionStrategy.characterExpressionRules。

const RULES = "芙芙猫：开心=眯眼、嘴呈 w 形、耳朵朝前；委屈=眼下挂泪珠、耳朵向两侧压平。";

const base = Object.freeze({
  creatorProfile: { fixedCharacter: "小白子，q版猫耳少女", vertical: "治愈/日常", constraints: "" },
  creativeBrief: {},
  visualGuardrails: {},
  referenceAnalysis: {},
  sourceScriptReconstruction: {},
  variant: { id: "V1" },
  fullStory: {}
});

test("请求侧校验只拦类型错误与超长，不裁决内容", () => {
  assert.equal(isValidCharacterExpressionRules(RULES), true);
  // 空串合法：等同于不设置。
  assert.equal(isValidCharacterExpressionRules(""), true);
  assert.equal(isValidCharacterExpressionRules("x".repeat(CHARACTER_EXPRESSION_RULES_MAX_CHARS)), true);
  assert.equal(isValidCharacterExpressionRules("x".repeat(CHARACTER_EXPRESSION_RULES_MAX_CHARS + 1)), false);
  assert.equal(isValidCharacterExpressionRules(null), false);
  assert.equal(isValidCharacterExpressionRules(123), false);
});

// 表情属于渲染表现，Full Story 写的是 emotionNode（情绪节点），Creative Brief 更与它无关。
test("表情规则不进 Full Story 与创意简报提示词", () => {
  const withRules = { ...base, characterExpressionRules: RULES };
  assert.equal(fullStoryPrompt(withRules), fullStoryPrompt(base));
  assert.equal(briefPrompt(withRules), briefPrompt(base));
});
