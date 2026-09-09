import test from "node:test";
import assert from "node:assert/strict";
import { mockFullStory } from "../src/mock.js";
import { fullStoryPrompt, variantsPrompt } from "../src/prompts.js";
import { ensureOutputContract } from "../src/validation.js";

const input = {
  creatorProfile: { fixedCharacter: "小白子，q版猫耳少女", vertical: "日常" },
  creativeBrief: {},
  variant: { id: "V3", title: "迷路的蒲公英", characterSetup: { protagonist: "小白子" } }
};

function storyWithSubject({ name, action, character = false }) {
  const story = mockFullStory(input);
  story.characterBible.helpers = [];
  delete story.characterBible.careRecipient;
  if (character) story.characterBible.careRecipient = {
    nameOrLabel: name,
    identity: "候选已设定的被照料角色",
    explicitNeed: "需要陪伴",
    implicitNeed: "安心休息",
    relationshipToProtagonist: "被照料的伙伴"
  };
  story.sceneScript.forEach((scene) => {
    scene.characters = ["小白子", ...(character ? [name] : [])];
    scene.visibleAction = action;
    scene.shotAndSound = `中景拍摄${name}，保留现场声。`;
    scene.dialogue = [];
    scene.offscreenSoundSources = [];
  });
  story.keyProps = character ? [] : [{
    prop: name, storyFunction: "主角照料的物件", visualUse: action, avoidSimilarityNote: "沿用本片设定"
  }];
  return story;
}

test("两阶段都明确区分角色与普通物件，且不以是否会说话区分角色", () => {
  const candidatePrompt = variantsPrompt({ ...input, count: 4 });
  const storyPrompt = fullStoryPrompt(input);
  for (const prompt of [candidatePrompt, storyPrompt]) {
    assert.match(prompt, /人物、动物/u);
    assert.match(prompt, /已明确具有自主行为与互动的拟人角色/u);
    assert.match(prompt, /普通植物、物件/u);
  }
  assert.match(storyPrompt, /不要求角色必须会说话或是行动发起者/u);
  assert.match(storyPrompt, /若旧候选把普通植物或物件称为 careRecipient，仍按正文实际行为保留为道具/u);
  assert.match(storyPrompt, /保留其全部剧情动作与可见细节，写入 keyProps 和 visibleAction/u);
  assert.match(storyPrompt, /不得为通过校验添加五官、对白或自主行为/u);
});

test("候选省略 careRecipient 时，本次提示词不再提供这个键的填写模板", () => {
  const before = structuredClone(input);
  const prompt = fullStoryPrompt(input);
  assert.match(prompt, /本次 characterBible 只输出 protagonist 和 helpers，禁止新增 careRecipient 键/u);
  assert.doesNotMatch(prompt, /"careRecipient":\{"nameOrLabel":""/u);
  assert.deepEqual(input, before);
});

test("候选已有被照料角色时保留填写模板，也保留普通物件的省略分支", () => {
  for (const name of ["奶奶", "小猫", "蒲公英精灵", "普通盆栽"]) {
    const candidateInput = structuredClone(input);
    candidateInput.variant.characterSetup.careRecipient = name;
    const prompt = fullStoryPrompt(candidateInput);
    assert.ok(prompt.includes(`当前 Variant 登记的 careRecipient 是 ${JSON.stringify(name)}`));
    assert.match(prompt, /"careRecipient":\{"nameOrLabel":""/u);
    assert.match(prompt, /若它只是普通植物或物件，则保留剧情与道具事实，整个省略 careRecipient/u);
    assert.doesNotMatch(prompt, /本次 characterBible 只输出 protagonist 和 helpers/u);
  }
});

for (const [name, action] of [
  ["蒲公英", "小白子双手捧着蒲公英，跑到坡顶后吹散种子。"],
  ["盆栽", "小白子给盆栽浇水，把花盆搬到窗边。"],
  ["布偶", "小白子把布偶放在腿上，补好开线的胳膊。"]
]) test(`普通${name}保留动作和道具事实，不要求写进角色表`, () => {
  const story = storyWithSubject({ name, action });
  const before = structuredClone(story);
  assert.doesNotThrow(() => ensureOutputContract(story, "fullStory"));
  assert.deepEqual(story, before);
});

for (const [name, action] of [
  ["奶奶", "小白子陪奶奶坐在院子里，奶奶闭着眼休息。"],
  ["小猫", "小白子守着熟睡的小猫，把毯子盖在它身上。"],
  ["蒲公英精灵", "小白子伸出手，蒲公英精灵主动跳上她的手掌挥手回应。"]
]) test(`${name}仍可作为被照料角色，漏登记仍然失败`, () => {
  const story = storyWithSubject({ name, action, character: true });
  assert.doesNotThrow(() => ensureOutputContract(story, "fullStory"));
  story.sceneScript[0].characters = ["小白子"];
  assert.throws(() => ensureOutputContract(story, "fullStory"), (error) => {
    assert.ok(error.details.some((detail) => detail.code === "FULL_STORY_SCENE_VISUAL_CHARACTER_MISSING"));
    return true;
  });
});

test("历史蒲公英跨字段冲突仍明确失败，不自动选边或删除业务字段", () => {
  const story = storyWithSubject({ name: "蒲公英", action: "小白子捧起蒲公英。", character: true });
  story.sceneScript.forEach((scene) => { scene.characters = ["小白子"]; });
  const before = structuredClone(story);
  assert.throws(() => ensureOutputContract(story, "fullStory"));
  assert.deepEqual(story, before);
});
