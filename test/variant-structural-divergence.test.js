import test from "node:test";
import assert from "node:assert/strict";
import { mockVariants } from "../src/mock.js";
import { ensureThemeVariantsMatchProfile, OutputContractError } from "../src/validation.js";

const creatorProfile = Object.freeze({
  fixedCharacter: "小白子，q版狼耳少女，村里的热心帮手",
  vertical: "治愈/温情/日常",
  constraints: ""
});

function variantsWithSignatures(signatures) {
  const value = mockVariants({ creatorProfile, count: signatures.length });
  value.variants.forEach((variant, index) => {
    variant.storyOutline.forEach((beat, beatIndex) => {
      beat.dramaticFunction = signatures[index].dramaticFunctions[beatIndex];
    });
    variant.keyChoice = signatures[index].keyChoice;
    variant.climax = signatures[index].climax;
    variant.emotionalPayoff = signatures[index].emotionalPayoff;
  });
  return value;
}

function signature(dramaticFunctions, suffix = "相同") {
  return {
    dramaticFunctions,
    keyChoice: `${suffix}关键选择`,
    climax: `${suffix}高潮`,
    emotionalPayoff: `${suffix}情绪兑现`
  };
}

test("mock 变体自身结构分化，不会被自己的校验拦下", () => {
  const value = mockVariants({ creatorProfile, count: 4 });
  const signatures = value.variants.map((variant) => JSON.stringify({
    dramaticFunctions: variant.storyOutline.map((beat) => beat.dramaticFunction.trim()),
    keyChoice: variant.keyChoice.trim(),
    climax: variant.climax.trim(),
    emotionalPayoff: variant.emotionalPayoff.trim()
  }));
  assert.equal(new Set(signatures).size, 4, "mock 四个候选应各自不同");
  assert.doesNotThrow(() => ensureThemeVariantsMatchProfile(value, creatorProfile));
});

test("所有候选共用同一条完整结构签名时必须失败", () => {
  const same = ["建立结果问题", "证明关系重量", "获得帮助", "仪式收尾"];
  assert.throws(
    () => ensureThemeVariantsMatchProfile(variantsWithSignatures([
      signature(same),
      signature(same),
      signature(same)
    ]), creatorProfile),
    (error) => error instanceof OutputContractError
      && /共用同一条结构签名/u.test(error.message)
      && error.details.some((detail) => detail.code === "STORY_CANDIDATE_STRUCTURE_NOT_DIVERGENT")
  );
});

test("只要有一个候选的 dramaticFunction 结构不同就放行", () => {
  const a = ["建立结果问题", "证明关系重量", "获得帮助", "仪式收尾"];
  const b = ["建立结果问题", "证明关系重量", "获得帮助", "愿望没有完全达成，收在开放情绪"];
  assert.doesNotThrow(
    () => ensureThemeVariantsMatchProfile(variantsWithSignatures([
      signature(a),
      signature(a),
      signature(b)
    ]), creatorProfile)
  );
});

test("dramaticFunction 相同但 keyChoice、climax 或 emotionalPayoff 不同时放行", () => {
  const same = ["建立结果问题", "证明关系重量", "获得帮助", "仪式收尾"];
  assert.doesNotThrow(() => ensureThemeVariantsMatchProfile(variantsWithSignatures([
    signature(same, "候选甲"),
    signature(same, "候选乙")
  ]), creatorProfile));
});

test("结构签名文本先 trim，只有首尾空白不同仍视为相同", () => {
  const same = ["建立结果问题", "证明关系重量", "获得帮助", "仪式收尾"];
  const a = signature(same);
  const b = {
    dramaticFunctions: same.map((entry) => `  ${entry}\n`),
    keyChoice: ` ${a.keyChoice} `,
    climax: `\n${a.climax}\t`,
    emotionalPayoff: `${a.emotionalPayoff} `
  };
  assert.throws(
    () => ensureThemeVariantsMatchProfile(variantsWithSignatures([a, b]), creatorProfile),
    /共用同一条结构签名/u
  );
});

test("单个方案没有可比对象，不裁决", () => {
  const only = ["建立结果问题", "证明关系重量", "获得帮助", "仪式收尾"];
  assert.doesNotThrow(
    () => ensureThemeVariantsMatchProfile(variantsWithSignatures([signature(only)]), creatorProfile)
  );
});

test("dramaticFunction 留空不能用来绕过分化判定", () => {
  const blank = ["", "", "", ""];
  assert.throws(
    () => ensureThemeVariantsMatchProfile(variantsWithSignatures([
      signature(blank),
      signature(blank)
    ]), creatorProfile),
    (error) => error instanceof OutputContractError
      && /必须填写非空 dramaticFunction/u.test(error.message)
  );
});
