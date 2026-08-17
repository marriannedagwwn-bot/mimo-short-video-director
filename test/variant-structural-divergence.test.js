import test from "node:test";
import assert from "node:assert/strict";
import { mockVariants } from "../src/mock.js";
import { ensureThemeVariantsMatchProfile, OutputContractError } from "../src/validation.js";

const creatorProfile = Object.freeze({
  fixedCharacter: "小白子，q版狼耳少女，村里的热心帮手",
  vertical: "治愈/温情/日常",
  constraints: ""
});

function variantsWithShapes(shapes) {
  const value = mockVariants({ creatorProfile, count: shapes.length });
  value.variants.forEach((variant, index) => {
    variant.storyOutline.forEach((beat, beatIndex) => {
      beat.dramaticFunction = shapes[index][beatIndex];
    });
  });
  return value;
}

test("mock 变体自身结构分化，不会被自己的校验拦下", () => {
  const value = mockVariants({ creatorProfile, count: 4 });
  const sequences = value.variants.map(
    (variant) => variant.storyOutline.map((beat) => beat.dramaticFunction).join(" › ")
  );
  assert.equal(new Set(sequences).size, 4, "mock 四个方案应各自不同");
  assert.doesNotThrow(() => ensureThemeVariantsMatchProfile(value, creatorProfile));
});

test("所有方案共用同一条 dramaticFunction 序列时必须失败", () => {
  const same = ["建立结果问题", "证明关系重量", "获得帮助", "仪式收尾"];
  assert.throws(
    () => ensureThemeVariantsMatchProfile(variantsWithShapes([same, same, same]), creatorProfile),
    (error) => error instanceof OutputContractError
      && /共用同一条 dramaticFunction 序列/u.test(error.message)
  );
});

test("只要有一个方案结构不同就放行", () => {
  const a = ["建立结果问题", "证明关系重量", "获得帮助", "仪式收尾"];
  const b = ["建立结果问题", "证明关系重量", "获得帮助", "愿望没有完全达成，收在开放情绪"];
  assert.doesNotThrow(
    () => ensureThemeVariantsMatchProfile(variantsWithShapes([a, a, b]), creatorProfile)
  );
});

test("单个方案没有可比对象，不裁决", () => {
  const only = ["建立结果问题", "证明关系重量", "获得帮助", "仪式收尾"];
  assert.doesNotThrow(
    () => ensureThemeVariantsMatchProfile(variantsWithShapes([only]), creatorProfile)
  );
});

test("dramaticFunction 留空不能用来绕过分化判定", () => {
  const blank = ["", "", "", ""];
  assert.throws(
    () => ensureThemeVariantsMatchProfile(variantsWithShapes([blank, blank]), creatorProfile),
    (error) => error instanceof OutputContractError
      && /必须填写非空 dramaticFunction/u.test(error.message)
  );
});

