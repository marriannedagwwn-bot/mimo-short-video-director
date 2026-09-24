import test from "node:test";
import assert from "node:assert/strict";
import { mockVariants } from "../src/mock.js";
import { variantsPrompt } from "../src/prompts.js";
import {
  ensureOutputContract,
  ensureThemeVariantsMatchProfile,
  requiredSliceOfLifeCount,
  SLICE_OF_LIFE_MODE,
  OutputContractError
} from "../src/validation.js";

const creatorProfile = Object.freeze({
  fixedCharacter: "小白子，q版狼耳少女，村里的热心帮手",
  vertical: "治愈/温情/日常",
  constraints: ""
});

// 参考片基本不靠戏剧结构留人（《好朋友为你遮风挡雨》的主角从第 3 场起一直睡着），
// 而候选契约此前把施动性、悬念、承诺写成无条件硬要求。放开为两条路径后，
// 这里只裁决**能确定性判定的部分**：数枚举值的个数。
// 校验器**无法核实一个候选真的是生活片段**——那需要语义判断，只能靠真实回放观察。
function variantsWithModes(modes) {
  const value = mockVariants({ creatorProfile, count: modes.length });
  value.variants.forEach((variant, index) => {
    variant.narrativeMode = modes[index];
  });
  return value;
}

test("四个候选里少于两个生活型时明确失败", () => {
  const value = variantsWithModes(["dramatic", "dramatic", "dramatic", SLICE_OF_LIFE_MODE]);
  assert.throws(
    () => ensureThemeVariantsMatchProfile(value, creatorProfile),
    (error) => error instanceof OutputContractError
      && /只有 1 个/u.test(error.message)
      && /至少需要 2 个/u.test(error.message)
      && error.details.some((detail) =>
        detail.code === "STORY_CANDIDATE_NARRATIVE_MODE_MIX" && detail.path === "/variants")
  );
});

test("四个候选里有两个生活型时通过", () => {
  const value = variantsWithModes(["dramatic", SLICE_OF_LIFE_MODE, "dramatic", SLICE_OF_LIFE_MODE]);
  assert.doesNotThrow(() => ensureThemeVariantsMatchProfile(value, creatorProfile));
});

test("三个候选只要求一个生活型", () => {
  assert.doesNotThrow(() =>
    ensureThemeVariantsMatchProfile(
      variantsWithModes(["dramatic", "dramatic", SLICE_OF_LIFE_MODE]),
      creatorProfile
    )
  );
  assert.throws(
    () => ensureThemeVariantsMatchProfile(variantsWithModes(["dramatic", "dramatic", "dramatic"]), creatorProfile),
    (error) => error instanceof OutputContractError
      && error.details.some((detail) => detail.code === "STORY_CANDIDATE_NARRATIVE_MODE_MIX")
  );
});

test("单个候选不施加分布要求", () => {
  assert.doesNotThrow(() =>
    ensureThemeVariantsMatchProfile(variantsWithModes(["dramatic"]), creatorProfile)
  );
});

test("要求个数按候选总数确定性给出", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6].map(requiredSliceOfLifeCount),
    [1, 1, 1, 2, 2, 2]
  );
});

test("narrativeMode 是必填枚举，缺失或取值非法都失败", () => {
  const missing = mockVariants({ creatorProfile, count: 4 });
  delete missing.variants[0].narrativeMode;
  assert.throws(() => ensureOutputContract(missing, "themeVariants"), OutputContractError);

  const illegal = mockVariants({ creatorProfile, count: 4 });
  illegal.variants[0].narrativeMode = "生活片段";
  assert.throws(() => ensureOutputContract(illegal, "themeVariants"), OutputContractError);
});

test("mock 自己满足分布要求", () => {
  for (const count of [1, 2, 3, 4, 5, 6]) {
    const value = mockVariants({ creatorProfile, count });
    assert.doesNotThrow(
      () => ensureThemeVariantsMatchProfile(value, creatorProfile),
      `count=${count} 的 mock 过不了自己的分布校验`
    );
  }
});

test("提示词写明两条路径的差异与本批分布要求", () => {
  const prompt = variantsPrompt({
    count: 4,
    creatorProfile,
    creativeBrief: {},
    referenceAnalysis: {},
    visualGuardrails: {}
  });
  assert.match(prompt, /dramatic（剧情型）/);
  assert.match(prompt, /slice_of_life（生活片段型）/);
  // 放开的只有「必须有戏」这一层，四条戏剧约束必须标出只对路径 A 适用
  assert.equal(prompt.match(/\*\*仅 dramatic 适用\*\*/g).length, 4);
  assert.match(prompt, /至少 2 个必须是 slice_of_life/);

  const three = variantsPrompt({
    count: 3,
    creatorProfile,
    creativeBrief: {},
    referenceAnalysis: {},
    visualGuardrails: {}
  });
  assert.match(three, /至少 1 个必须是 slice_of_life/);
});
