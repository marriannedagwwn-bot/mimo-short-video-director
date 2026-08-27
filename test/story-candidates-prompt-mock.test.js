import test from "node:test";
import assert from "node:assert/strict";
import { mockVariants } from "../src/mock.js";
import { variantsPrompt } from "../src/prompts.js";
import { ensureOutputContract, ensureThemeVariantsMatchProfile } from "../src/validation.js";

const creatorProfile = Object.freeze({
  fixedCharacter: "小白子，q版狼耳少女，村里的热心帮手",
  vertical: "治愈/温情/日常",
  constraints: ""
});

test("Variants Prompt replaces the disposable beat conflict and declares only candidate-level additions", () => {
  const prompt = variantsPrompt({
    count: 3,
    creatorProfile,
    creativeBrief: {},
    referenceAnalysis: {},
    visualGuardrails: {}
  });

  assert.doesNotMatch(prompt, /beat 不推进主线|删掉它故事依然完整/u);
  assert.match(prompt, /主要承担角色性格或人物关系质感/u);
  assert.match(prompt, /仍必须改变关系状态、情绪状态、信息状态或后续选择条件/u);
  assert.match(prompt, /删除后必须使角色弧线、关系推进、情绪积累或后续因果至少损失一项/u);
  assert.match(prompt, /签名由 dramaticFunction 序列、keyChoice、climax 和 emotionalPayoff 共同组成/u);

  for (const field of ["keyChoice", "climax", "emotionalPayoff", "novelty", "visualPotential"]) {
    assert.match(prompt, new RegExp(`"${field}"`, "u"));
  }
  assert.match(prompt, /只写候选级摘要，不展开 Full Story/u);
  assert.match(prompt, /不写分场、镜头或 shotPlan/u);
  assert.doesNotMatch(prompt, /"characterBible"\s*:/u);
  assert.doesNotMatch(prompt, /"sceneScript"\s*:/u);
  assert.doesNotMatch(prompt, /"shotPlan"\s*:/u);
});

test("Demo Mock emits strict Story Candidates with distinct structural signatures", () => {
  const value = mockVariants({ creatorProfile, count: 4 });
  assert.doesNotThrow(() => ensureOutputContract(value, "themeVariants"));
  assert.doesNotThrow(() => ensureThemeVariantsMatchProfile(value, creatorProfile));

  const signatures = value.variants.map((candidate) => JSON.stringify({
    dramaticFunctions: candidate.storyOutline.map((beat) => beat.dramaticFunction.trim()),
    keyChoice: candidate.keyChoice.trim(),
    climax: candidate.climax.trim(),
    emotionalPayoff: candidate.emotionalPayoff.trim()
  }));
  assert.ok(new Set(signatures).size >= 2);
});
