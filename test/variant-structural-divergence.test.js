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
    const target = signatures[index];
    variant.storyOutline.forEach((beat, beatIndex) => {
      beat.dramaticFunction = target.dramaticFunctions[beatIndex];
    });
    // 投影契约：keyChoice/climax/emotionalPayoff 必须逐字等于某一拍的 action，
    // 且顺序为「关键选择拍 < 高潮拍 < 最后一拍」、中间隔一拍。
    // 只改顶层不改 action 会先撞上投影校验，永远走不到分化判定。
    const last = variant.storyOutline.length - 1;
    variant.storyOutline[1].action = target.keyChoice;
    variant.storyOutline[3].action = target.climax;
    variant.storyOutline[last].action = target.emotionalPayoff;
    variant.keyChoice = target.keyChoice;
    variant.climax = target.climax;
    variant.emotionalPayoff = target.emotionalPayoff;
  });
  return value;
}

// mock 的 storyOutline 是 5 拍，dramaticFunctions 必须逐拍给满。
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
  const same = ["建立结果问题", "证明关系重量", "获得帮助", "亲手解决", "仪式收尾"];
  assert.throws(
    () => ensureThemeVariantsMatchProfile(variantsWithSignatures([
      signature(same),
      signature(same),
      signature(same)
    ]), creatorProfile),
    (error) => error instanceof OutputContractError
      && /存在结构签名相同的候选/u.test(error.message)
      && error.details.some((detail) => detail.code === "STORY_CANDIDATE_STRUCTURE_NOT_DIVERGENT")
  );
});

test("三个候选里有两个雷同，即使第三个不同也必须失败", () => {
  const a = ["建立结果问题", "证明关系重量", "获得帮助", "亲手解决", "仪式收尾"];
  const b = ["建立结果问题", "证明关系重量", "获得帮助", "亲手解决", "愿望没有完全达成，收在开放情绪"];
  assert.throws(
    () => ensureThemeVariantsMatchProfile(variantsWithSignatures([
      signature(a),
      signature(a),
      signature(b)
    ]), creatorProfile),
    (error) => error instanceof OutputContractError
      && /V1 与 V2/u.test(error.message)
      && error.details.some((detail) => detail.code === "STORY_CANDIDATE_STRUCTURE_NOT_DIVERGENT"
        && detail.path === "/variants/1")
  );
});

test("候选两两都不同才放行，并且指出具体是哪一对雷同", () => {
  const a = ["建立结果问题", "证明关系重量", "获得帮助", "亲手解决", "仪式收尾"];
  const b = ["建立结果问题", "证明关系重量", "获得帮助", "亲手解决", "愿望没有完全达成，收在开放情绪"];
  const c = ["先让主角判断失误", "承担代价重新定目标", "独自完成", "亲手解决", "开放结尾"];
  assert.doesNotThrow(
    () => ensureThemeVariantsMatchProfile(variantsWithSignatures([
      signature(a), signature(b), signature(c)
    ]), creatorProfile)
  );
  // 雷同的一对不在开头时同样要被抓住，且 path 指向后出现的那个候选。
  assert.throws(
    () => ensureThemeVariantsMatchProfile(variantsWithSignatures([
      signature(a), signature(b), signature(b)
    ]), creatorProfile),
    (error) => error instanceof OutputContractError
      && /V2 与 V3/u.test(error.message)
      && error.details.some((detail) => detail.path === "/variants/2")
  );
});

test("dramaticFunction 相同但 keyChoice、climax 或 emotionalPayoff 不同时放行", () => {
  const same = ["建立结果问题", "证明关系重量", "获得帮助", "亲手解决", "仪式收尾"];
  assert.doesNotThrow(() => ensureThemeVariantsMatchProfile(variantsWithSignatures([
    signature(same, "候选甲"),
    signature(same, "候选乙")
  ]), creatorProfile));
});

test("结构签名文本先 trim，只有首尾空白不同仍视为相同", () => {
  const same = ["建立结果问题", "证明关系重量", "获得帮助", "亲手解决", "仪式收尾"];
  const a = signature(same);
  const b = {
    dramaticFunctions: same.map((entry) => `  ${entry}\n`),
    keyChoice: ` ${a.keyChoice} `,
    climax: `\n${a.climax}\t`,
    emotionalPayoff: `${a.emotionalPayoff} `
  };
  assert.throws(
    () => ensureThemeVariantsMatchProfile(variantsWithSignatures([a, b]), creatorProfile),
    /存在结构签名相同的候选：V1 与 V2/u
  );
});

test("单个方案没有可比对象，不裁决", () => {
  const only = ["建立结果问题", "证明关系重量", "获得帮助", "亲手解决", "仪式收尾"];
  assert.doesNotThrow(
    () => ensureThemeVariantsMatchProfile(variantsWithSignatures([signature(only)]), creatorProfile)
  );
});

test("dramaticFunction 留空不能用来绕过分化判定", () => {
  const blank = ["", "", "", "", ""];
  assert.throws(
    () => ensureThemeVariantsMatchProfile(variantsWithSignatures([
      signature(blank),
      signature(blank)
    ]), creatorProfile),
    (error) => error instanceof OutputContractError
      && /必须填写非空 dramaticFunction/u.test(error.message)
  );
});
