import test from "node:test";
import assert from "node:assert/strict";
import {
  CHARACTER_EXPRESSION_RULES_MAX_CHARS,
  isValidCharacterExpressionRules,
  normalizeCharacterExpressionRules
} from "../public/character-expression-rules.js";
import {
  animationFoundationPrompt,
  animationShotBatchPrompt,
  briefPrompt,
  fullStoryPrompt
} from "../src/prompts.js";

const RULES = "芙芙猫：开心=眯眼、嘴呈 w 形、耳朵朝前；委屈=眼下挂泪珠、耳朵向两侧压平。";

const base = Object.freeze({
  creatorProfile: { fixedCharacter: "小白子，q版猫耳少女", vertical: "治愈/日常", constraints: "" },
  creativeBrief: {},
  visualGuardrails: {},
  referenceAnalysis: {},
  sourceScriptReconstruction: {},
  variant: { id: "V1" },
  fullStory: {},
  animationPlanMode: "direct_shot",
  directShotSkeleton: []
});

test("请求侧校验只拦类型错误与超长，不裁决内容", () => {
  assert.equal(isValidCharacterExpressionRules(RULES), true);
  // 空串合法：等同于不设置。
  assert.equal(isValidCharacterExpressionRules(""), true);
  assert.equal(isValidCharacterExpressionRules("x".repeat(CHARACTER_EXPRESSION_RULES_MAX_CHARS)), true);
  assert.equal(isValidCharacterExpressionRules("x".repeat(CHARACTER_EXPRESSION_RULES_MAX_CHARS + 1)), false);
  assert.equal(isValidCharacterExpressionRules(null), false);
  assert.equal(isValidCharacterExpressionRules(123), false);
  assert.equal(normalizeCharacterExpressionRules(`  ${RULES}  `), RULES);
  assert.equal(normalizeCharacterExpressionRules(undefined), "");
});

test("direct_shot 的 Foundation 与逐镜提示词都带上表情规则", () => {
  for (const build of [animationFoundationPrompt, animationShotBatchPrompt]) {
    const text = build({ ...base, characterExpressionRules: RULES });
    assert.match(text, /角色表情规则（用户指定）/u);
    assert.ok(text.includes(RULES), "规则原文必须逐字出现");
    // 边界优先级必须写明，否则用户可以借表情规则改角色外观。
    assert.match(text, /只约束表情、神态与表演方式\*\*，不得据此改变角色身份、外观、物种、服装或颜色/u);
    assert.match(text, /与固定角色外观边界冲突时一律以边界为准/u);
    // 针对实测到的无信息量措辞（现有 Plan 里写的是「表情活泼可爱，动作自然灵动」）。
    assert.match(text, /不要用“表情可爱”“神态自然”“情绪到位”这类看不出画面的措辞/u);
  }
});

test("不传时提示词与历史逐字一致", () => {
  for (const build of [animationFoundationPrompt, animationShotBatchPrompt]) {
    const off = build(base);
    assert.doesNotMatch(off, /角色表情规则/u);
    // 空串与全空白都等同于未设置，不得留下空的标题行。
    assert.equal(build({ ...base, characterExpressionRules: "" }), off);
    assert.equal(build({ ...base, characterExpressionRules: "   \n  " }), off);
    assert.equal(build({ ...base, characterExpressionRules: undefined }), off);
  }
});

// 注入面刻意只有两个。表情属于渲染表现，Full Story 写的是 emotionNode（情绪节点），
// Creative Brief 更与它无关——扩大注入面只会稀释这两份提示词。
test("表情规则不进 Full Story 与创意简报提示词", () => {
  const withRules = { ...base, characterExpressionRules: RULES };
  assert.equal(fullStoryPrompt(withRules), fullStoryPrompt(base));
  assert.equal(briefPrompt(withRules), briefPrompt(base));
});

// 旧 v2 兼容路径的语义不变是硬约束（CLAUDE.md §2.3）。
test("旧 v2 兼容路径逐字不受影响", () => {
  const v2 = { ...base };
  delete v2.animationPlanMode;
  delete v2.directShotSkeleton;
  for (const build of [animationFoundationPrompt, animationShotBatchPrompt]) {
    assert.equal(build({ ...v2, characterExpressionRules: RULES }), build(v2));
  }
});
