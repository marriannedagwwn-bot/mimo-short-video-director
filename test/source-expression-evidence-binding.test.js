import test from "node:test";
import assert from "node:assert/strict";
import { mockVisualGuardrails } from "../src/mock.js";
import { ensureOutputContract, OutputContractError } from "../src/validation.js";

const creatorProfile = Object.freeze({
  fixedCharacter: "小白子，q版狼耳少女，活泼可爱，懂事，村里的热心帮手",
  vertical: "治愈/温情/日常",
  constraints: ""
});

const creativeBrief = Object.freeze({
  protectedExpressions: [],
  controlledRewriteVariables: []
});

function guardrailsWithRule(rule) {
  const guardrails = mockVisualGuardrails({ creatorProfile, creativeBrief });
  guardrails.sourceSimilarityRules = [{
    text: "记录原片表面表达，仅在实际使用原片视觉参考时用于 reference_leak 判断。",
    appliesWhenReferenceUsed: true,
    ...rule
  }];
  return guardrails;
}

function assertRejected(rule, expectedFragment) {
  assert.throws(
    () => ensureOutputContract(guardrailsWithRule(rule), "visualGuardrails"),
    (error) => error instanceof OutputContractError
      && /sourceExpression 含未出现在自身 triggerEvidence 中的表达/u.test(error.message)
      && error.message.includes(expectedFragment)
  );
}

test("逐字引用上游证据的 sourceExpression 通过校验", () => {
  assert.doesNotThrow(() => ensureOutputContract(guardrailsWithRule({
    sourceExpression: "企鹅背包",
    triggerEvidence: [{
      sourcePath: "creativeBrief.protectedExpressions[0].sourceExpression",
      evidence: "企鹅连帽外套、企鹅背包、企鹅翅膀动作"
    }]
  }), "visualGuardrails"));
});

test("并列各项都能在证据中逐字找到时通过，允许只挑选其中若干项", () => {
  assert.doesNotThrow(() => ensureOutputContract(guardrailsWithRule({
    sourceExpression: "信件、绿色邮箱、雨伞",
    triggerEvidence: [{
      sourcePath: "creativeBrief.controlledRewriteVariables[0].sourceValue",
      evidence: "信件、绿色邮箱、红色邮箱、蓝色邮箱、白色毯子、橘子、雨伞"
    }]
  }), "visualGuardrails"));
});

test("引号样式与句末标点差异不构成违规", () => {
  assert.doesNotThrow(() => ensureOutputContract(guardrailsWithRule({
    sourceExpression: "咕咕、耶～、咕嘎。",
    triggerEvidence: [{
      sourcePath: "creativeBrief.protectedExpressions[1].sourceExpression",
      evidence: "拟声词如‘咕咕’、‘耶～’、‘咕嘎’"
    }]
  }), "visualGuardrails"));
});

test("下游补全上游省略的中心名词必须 fail closed（文档中的邮箱范例）", () => {
  assertRejected({
    sourceExpression: "投递信件至红色邮箱",
    triggerEvidence: [{
      sourcePath: "creativeBrief.protectedExpressions[0].sourceExpression",
      evidence: "投递信件至绿色邮箱、红色邮箱、蓝色邮箱"
    }]
  }, "投递信件至红色邮箱");
});

test("下游补全共享主语的缩写必须 fail closed（真实运行中复现的缺陷）", () => {
  assertRejected({
    sourceExpression: "拟人化企鹅乘车",
    triggerEvidence: [{
      sourcePath: "creativeBrief.protectedExpressions[2].sourceExpression",
      evidence: "拟人化企鹅与人类共同生活、乘车、用餐"
    }]
  }, "拟人化企鹅乘车");
});

test("并列中任一项被改写或写错都会被逐项定位", () => {
  assertRejected({
    sourceExpression: "咕嘎、菲比比、doro",
    triggerEvidence: [{
      sourcePath: "creativeBrief.protectedExpressions[1].sourceExpression",
      evidence: "咕嘎、菲比啾比、doro"
    }]
  }, "菲比比");
});

test("以回指或转述充当证据不能满足逐字引用", () => {
  assertRejected({
    sourceExpression: "咕咕嘎嘎",
    triggerEvidence: [{
      sourcePath: "creativeBrief.protectedExpressions[1].sourceExpression",
      evidence: "同上"
    }]
  }, "咕咕嘎嘎");
});

test("保留上游缩写原文是合法退路，不需要下游推断", () => {
  assert.doesNotThrow(() => ensureOutputContract(guardrailsWithRule({
    sourceExpression: "拟人化企鹅与人类共同生活、乘车、用餐",
    triggerEvidence: [{
      sourcePath: "creativeBrief.protectedExpressions[2].sourceExpression",
      evidence: "拟人化企鹅与人类共同生活、乘车、用餐"
    }]
  }), "visualGuardrails"));
});
