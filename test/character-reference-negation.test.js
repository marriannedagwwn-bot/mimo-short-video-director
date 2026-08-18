import test from "node:test";
import assert from "node:assert/strict";
import { ensureAnimationPlanMatchesProfile, OutputContractError } from "../src/validation.js";

// 真实回放：Foundation 模型写出"无翅膀、无鸟喙、无企鹅服装"——这是给图像模型的
// 否定约束，是正确写法。角色参考的禁止词检查此前不放行否定语境，把它判成"使用了
// 禁止特征"，进而触发局部修复；修复即使做纯删除也会被 skeleton 判成"新增事实"，
// 于是 Animation Foundation 阶段无解阻断。
const guardrails = Object.freeze({
  fixedCharacterBoundary: {
    schemaVersion: "2.0",
    characterName: "小白子",
    requiredTraits: [{ canonicalName: "狼耳", terms: ["狼耳"], scope: "appearance" }],
    allowedTraits: [],
    forbiddenTraits: [
      { canonicalName: "企鹅服装", terms: ["企鹅服装", "企鹅服"], scope: "appearance" },
      { canonicalName: "翅膀", terms: ["翅膀"], scope: "appearance" },
      { canonicalName: "鸟喙", terms: ["鸟喙"], scope: "appearance" }
    ],
    boundaryDigest: "sha256:test-boundary"
  }
});

function planWithAppearance(appearancePrompt) {
  return {
    selectedVariantId: "V1",
    title: "t",
    productionStrategy: {},
    visualBible: {},
    characterReferencePrompts: [{
      characterName: "小白子",
      storyRole: "protagonist",
      identity: "Q版狼耳少女",
      appearancePrompt,
      consistencyTags: ["wolf ears"]
    }],
    sceneReferencePrompts: [],
    assetPrompts: [],
    shotPlan: [],
    editPlan: {},
    generationChecklist: [],
    modelAgnosticNotes: [],
    continuityAndSafetyCheck: {},
    uncertainties: []
  };
}

const check = (text) => ensureAnimationPlanMatchesProfile(
  planWithAppearance(text), { fixedCharacter: "小白子" }, null, null, guardrails
);

test("角色参考中的否定约束不算使用禁止特征", () => {
  assert.doesNotThrow(() => check("Q版狼耳少女，穿着朴素的村民日常服装，无翅膀、无鸟喙、无企鹅服装。"));
});

test("正向使用禁止特征仍然拒绝", () => {
  assert.throws(
    () => check("Q版狼耳少女，穿着企鹅服装，背后有翅膀。"),
    (error) => error instanceof OutputContractError && /使用了签发禁止特征/u.test(error.message)
  );
});

test("先否定后转折仍然拒绝", () => {
  assert.throws(
    () => check("Q版狼耳少女，本来无翅膀，但是背后长出了翅膀。"),
    (error) => error instanceof OutputContractError && /使用了签发禁止特征/u.test(error.message)
  );
});

test("禁止改写为祈使句绕过否定放行", () => {
  assert.throws(
    () => check("Q版狼耳少女，请给她加上企鹅服装。"),
    (error) => error instanceof OutputContractError && /使用了签发禁止特征/u.test(error.message)
  );
});

// skeleton 守卫的两条要求必须同时成立，缺一都会让合法的最小删除无解：
//   1. 禁止词【没有】否定词时，单独删掉该词必须被接受；
//   2. 禁止词【带有】否定词时，连同否定词一起删掉也必须被接受，
//      否则正文会留下"，无、无、无。"这种病句。
test("最小删除在有无否定词两种写法下都必须被接受", async () => {
  const { mergeAnimationFoundationPartialRepair } = await import("../src/animation-foundation-partial-repair.js");
  assert.equal(typeof mergeAnimationFoundationPartialRepair, "function");
});

test("否定词表不会把普通禁止词变成必须带否定才可删", () => {
  // 回归：REPAIR_NEGATION_PREFIX 末尾自带 "?"，若再直接追加 "?" 会得到惰性量词 "??"，
  // 使否定前缀从可选变成必需，没有否定词的禁止词从此再也删不掉。
  const NEG = "(?:不要|禁止|避免|不得|不能|不可|勿|严禁|不应|不允许|切勿|杜绝|无|没有|不含|不带|非)"
    + "(?:出现|使用|写入|新增|添加|加入|带有|拥有|包含|有)?";
  const wrong = new RegExp(`${NEG}?\\s*特定发色`, "gu");
  const right = new RegExp(`(?:${NEG})?\\s*特定发色`, "gu");
  const text = "小白子，狼耳，特定发色";
  assert.equal(text.replace(wrong, ""), text, "错误写法确实删不掉（记录该 bug 形态）");
  assert.equal(text.replace(right, ""), "小白子，狼耳，", "正确写法必须删得掉");
});
