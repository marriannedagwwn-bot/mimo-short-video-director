import test from "node:test";
import assert from "node:assert/strict";
import { mockVariants } from "../src/mock.js";
import { OutputContractError, ensureThemeVariantsMatchProfile } from "../src/validation.js";

const signedCharacterName = "小白子";
const generatingProfile = Object.freeze({
  fixedCharacter: "小白子，q版狼耳少女，村里的热心帮手",
  vertical: "治愈/温情/日常",
  constraints: ""
});
const signedGuardrails = Object.freeze({
  fixedCharacterBoundary: {
    characterName: signedCharacterName,
    requiredTraits: [],
    allowedTraits: [],
    forbiddenTraits: []
  }
});

function validValue() {
  return mockVariants({ creatorProfile: generatingProfile, count: 1 });
}

test("Story Candidate fixed protagonist prefers the signed boundary name over profile fallback", () => {
  const value = validValue();
  assert.doesNotThrow(() => ensureThemeVariantsMatchProfile(
    value,
    { ...generatingProfile, fixedCharacter: "旧单测占位名，不能覆盖已签发边界" },
    null,
    signedGuardrails
  ));
});

test("Story Candidate rejects a protagonist that drifts from the signed boundary", () => {
  const value = validValue();
  value.variants[0].characterSetup.protagonist = "小雨，另一位主角";
  assert.throws(
    () => ensureThemeVariantsMatchProfile(value, generatingProfile, null, signedGuardrails),
    (error) => error instanceof OutputContractError
      && /protagonist 未包含「小白子」/u.test(error.message)
  );
});

test("Story Candidate requires the signed protagonist in visible story text", () => {
  const value = validValue();
  const candidate = value.variants[0];
  candidate.oneLineHook = "固定主角必须完成任务。";
  candidate.logline = "固定主角在压力中完成任务。";
  candidate.newTask = "修好旧设备";
  candidate.emotionalMedium = "一段旧录音";
  candidate.environmentPressure = "街区停电";
  candidate.keyChoice = "固定主角选择保护任务物。";
  candidate.climax = "固定主角在最后期限前完成修复。";
  candidate.emotionalPayoff = "双方确认彼此没有忘记约定。";
  candidate.novelty = "以修复过程连接关系变化。";
  candidate.visualPotential = "设备灯光由暗转亮。";
  candidate.storyOutline.forEach((beat) => {
    beat.action = "固定主角推进当前动作。";
  });
  candidate.endingRitual = "双方一起按下播放键。";

  assert.throws(
    () => ensureThemeVariantsMatchProfile(value, generatingProfile, null, signedGuardrails),
    (error) => error instanceof OutputContractError
      && /可见故事文本未使用固定角色「小白子」/u.test(error.message)
  );
});

test("Story Candidate protagonist still rejects signed forbidden traits", () => {
  const value = validValue();
  const guardrails = structuredClone(signedGuardrails);
  guardrails.fixedCharacterBoundary.forbiddenTraits = [{
    canonicalName: "固定主角不得有翅膀",
    terms: ["翅膀"],
    scope: "appearance",
    evidenceLevel: "explicit",
    triggerEvidence: [],
    reason: "用户明确否定"
  }];
  value.variants[0].characterSetup.protagonist += "，背后有翅膀";

  assert.throws(
    () => ensureThemeVariantsMatchProfile(value, generatingProfile, null, guardrails),
    (error) => error instanceof OutputContractError
      && /禁止特征：翅膀/u.test(error.message)
  );
});
