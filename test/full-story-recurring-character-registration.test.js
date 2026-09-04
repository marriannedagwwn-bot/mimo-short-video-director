import test from "node:test";
import assert from "node:assert/strict";
import { mockFullStory } from "../src/mock.js";
import { fullStoryPrompt } from "../src/prompts.js";
import {
  FULL_STORY_RECURRING_CHARACTER_MIN_SCENES,
  ensureOutputContract,
  OutputContractError
} from "../src/validation.js";

const context = Object.freeze({
  creatorProfile: { fixedCharacter: "小白子，q版狼耳少女", vertical: "治愈/温情/日常", constraints: "" },
  variant: { id: "V1", title: "测试变体" }
});

const story = () => mockFullStory(context);

function putInScenes(value, name, sceneIndexes) {
  sceneIndexes.forEach((index) => {
    const scene = value.sceneScript[index];
    if (!scene.characters.includes(name)) scene.characters.push(name);
  });
  return value;
}

function registrationReasons(value) {
  try {
    ensureOutputContract(value, "fullStory");
    return [];
  } catch (error) {
    if (!(error instanceof OutputContractError)) throw error;
    return error.details
      .filter((detail) => detail.code === "FULL_STORY_SCENE_CHARACTER_NOT_REGISTERED")
      .map((detail) => detail.reason);
  }
}

test("门槛是「出镜 ≥ 2 场」", () => {
  assert.equal(FULL_STORY_RECURRING_CHARACTER_MIN_SCENES, 2);
});

// 既有明确契约：一次性场次型配角允许不登记。给「放学孩童们」填 helpingAction 是荒谬的。
// 按 124 份历史 Full Story 标定，这个区分本来就在数据里：只出镜 1 场的角色 51% 未登记，
// 出镜 2 场以上未登记只占 4%–11%。
test("只出镜一场的临时配角不需要登记", () => {
  assert.deepEqual(registrationReasons(putInScenes(story(), "放学孩童们", [0])), []);
});

test("跨场复现的未登记角色明确失败，并报出他出镜了哪几场", () => {
  const reasons = registrationReasons(putInScenes(story(), "奶奶", [1, 2, 3]));
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /「奶奶」在 3 场里出镜/u);
  assert.match(reasons[0], /只出镜一场的临时配角不受此约束/u);
});

test("同一个角色只报一条，不是每场报一次", () => {
  assert.equal(registrationReasons(putInScenes(story(), "奶奶", [0, 1, 2, 3, 4])).length, 1);
});

test("登记进 helpers 之后通过", () => {
  const value = putInScenes(story(), "奶奶", [1, 2, 3]);
  value.characterBible.helpers.push({
    nameOrLabel: "奶奶",
    functionInStory: "一起劳作的邻居长辈",
    relationshipToProtagonist: "邻居长辈",
    helpingAction: "用竹竿敲高处的柿子"
  });
  assert.deepEqual(registrationReasons(value), []);
});

// 这条检查真正的价值不是补一张登记表，而是让 visibleAction 扫描重新能工作：
// 扫描名单只来自 characterBible，未登记的角色对它完全隐形。
test("未登记会让可见事实扫描隐形，补上登记后同一句话立刻被抓住", () => {
  const value = story();
  value.sceneScript[0].characters = [value.characterBible.protagonist.name];
  value.sceneScript[0].visibleAction = "小白子走过院子。远处，奶奶正拿着长竹竿打柿子。";
  putInScenes(value, "奶奶", [1, 2]);

  const codes = (input) => {
    try { ensureOutputContract(input, "fullStory"); return []; }
    catch (error) { return error.details.map((detail) => detail.code); }
  };

  const before = codes(value);
  assert.ok(before.includes("FULL_STORY_SCENE_CHARACTER_NOT_REGISTERED"));
  assert.ok(
    !before.includes("FULL_STORY_SCENE_VISUAL_CHARACTER_MISSING"),
    "未登记时扫描看不见这个名字——这正是要修的隐形"
  );

  value.characterBible.helpers.push({
    nameOrLabel: "奶奶",
    functionInStory: "邻居长辈",
    relationshipToProtagonist: "邻居长辈",
    helpingAction: "打柿子"
  });
  assert.ok(
    codes(value).includes("FULL_STORY_SCENE_VISUAL_CHARACTER_MISSING"),
    "补上登记后，S1 里那句「奶奶正拿着长竹竿打柿子」必须被抓住"
  );
});

test("带身份后缀的标准名只报名称不精确，不重复报未登记", () => {
  const value = story();
  const name = value.characterBible.protagonist.name;
  value.sceneScript[0].characters = [`${name}（穿校服）`];
  value.sceneScript[1].characters = [`${name}（穿校服）`];
  assert.throws(
    () => ensureOutputContract(value, "fullStory"),
    (error) => error.details.some((d) => d.code === "FULL_STORY_SCENE_CHARACTER_NAME_INEXACT")
      && !error.details.some((d) => d.code === "FULL_STORY_SCENE_CHARACTER_NOT_REGISTERED")
  );
});

// 校验器硬失败必须同时出现在提示词里，否则模型不知道规则，只会反复撞死在最贵的阶段：
// 实测有一版直接失败在「芙芙猫出镜 6 场未登记」，补上这条后同一份通过。
test("跨场登记规则必须写进提示词，不能只在校验器里", () => {
  const text = fullStoryPrompt({ variant: {}, creativeBrief: {}, creatorProfile: {} });
  assert.match(text, /在两场或更多场次里出镜的角色，必须登记进 characterBible/u);
  assert.match(text, /只出镜一场的临时配角（路过的邻居、放学的孩子们）不需要登记/u);
});
