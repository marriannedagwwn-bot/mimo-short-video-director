import test from "node:test";
import assert from "node:assert/strict";
import {
  characterReferenceAudioClips,
  shotRelatedCharacterAudioClips,
  validateCharacterReferenceAudioClips
} from "../public/character-reference-audio.js";

const clip = (overrides = {}) => ({
  id: "meow",
  label: "喵喵",
  fileName: "meow.mp3",
  mimeType: "audio/mpeg",
  dataUrl: "data:audio/mpeg;base64,YXVkaW8=",
  durationSeconds: 3,
  sizeBytes: 128,
  ...overrides
});

test("character audio clips ignore malformed and non-audio data URLs", () => {
  assert.deepEqual(characterReferenceAudioClips({
    referenceAudioClips: [clip(), clip({ dataUrl: "data:image/png;base64,aW1hZ2U=" }), null]
  }), [clip()]);
});

test("character audio clips do not follow visual presence when the character has no dialogue", () => {
  const selected = shotRelatedCharacterAudioClips({
    shotId: "A01",
    videoPrompt: "芙芙猫始终完整出镜，跟在小白子脚边。",
    characterAction: "芙芙猫抬头看向果树。",
    dialogueOrSubtitle: "果园爷爷：「小白子来啦，正好帮爷爷摘几个果子。」小白子：「嗷呜～」"
  }, [
    { characterName: "芙芙猫", referenceAudioClips: [clip()] },
    { characterName: "小白", referenceAudioClips: [clip({ id: "hello", label: "对白" })] }
  ]);
  assert.deepEqual(selected, []);
});

test("character audio clips require the exact character name as an explicit dialogue speaker", () => {
  const selected = shotRelatedCharacterAudioClips({
    shotId: "A02",
    videoPrompt: "小白子和芙芙猫同时完整出镜。",
    dialogueOrSubtitle: "小白子：「嗷呜～」芙芙猫（轻声）：「喵～」"
  }, [
    { characterName: "小白", referenceAudioClips: [clip({ id: "wrong-prefix", label: "不应命中" })] },
    { characterName: "小白子", referenceAudioClips: [clip({ id: "howl", label: "嗷呜" })] },
    { characterName: "芙芙猫", referenceAudioClips: [clip()] }
  ]);
  assert.deepEqual(selected.map((item) => item.characterName), ["小白子", "芙芙猫"]);
  assert.deepEqual(selected.map((item) => item.clip.label), ["嗷呜", "喵喵"]);
});

test("character audio validation enforces clip count and total duration", () => {
  assert.equal(validateCharacterReferenceAudioClips([clip({ durationSeconds: 1 })]), "喵喵 时长必须在 2-15 秒之间。");
  assert.match(validateCharacterReferenceAudioClips([
    clip({ id: "1", durationSeconds: 6 }),
    clip({ id: "2", durationSeconds: 6 }),
    clip({ id: "3", durationSeconds: 6 })
  ]), /总时长不能超过 15 秒/u);
  assert.match(validateCharacterReferenceAudioClips([
    clip({ id: "1" }),
    clip({ id: "2" }),
    clip({ id: "3" }),
    clip({ id: "4" })
  ]), /最多上传 3 段/u);
});

// 说话人判定的边界行为。这些不是补充覆盖，而是锁住两个**方向相反**的承诺：
// ① 名字互为前缀时不得误命中（判定函数的注释里声称做到了，但原本没有用例锁住）；
// ② 漏判必须比误判安全——判不出说话人时宁可不发音频。误发一次的代价是整段样音
//    被当成背景音铺满全片（2026-09-03 A01 实测），漏发的代价只是这一镜没有音色参考。
test("角色名互为前缀时，说话人判定不会互相误命中", () => {
  // 角色叫「小白」，而台词的说话人是「小白子」——不能命中。
  assert.deepEqual(
    shotRelatedCharacterAudioClips(
      { dialogueOrSubtitle: "小白子：「嗷呜～」" },
      [{ characterName: "小白", referenceAudioClips: [clip()] }]
    ),
    []
  );
  // 反向同样不能命中。
  assert.deepEqual(
    shotRelatedCharacterAudioClips(
      { dialogueOrSubtitle: "小白：「嗷呜～」" },
      [{ characterName: "小白子", referenceAudioClips: [clip()] }]
    ),
    []
  );
  // exact 名字才算数。
  assert.deepEqual(
    shotRelatedCharacterAudioClips(
      { dialogueOrSubtitle: "小白子：「嗷呜～」" },
      [{ characterName: "小白子", referenceAudioClips: [clip()] }]
    ).map((item) => item.characterName),
    ["小白子"]
  );
});

test("判不出说话人时一律不发音频，宁可漏判也不误发", () => {
  const references = [{ characterName: "芙芙猫", referenceAudioClips: [clip()] }];
  const picks = (dialogueOrSubtitle) => shotRelatedCharacterAudioClips({ dialogueOrSubtitle }, references).length;

  // 会命中的写法：冒号标出说话人，允许表演括注、半角冒号、句中第二个说话人。
  assert.equal(picks("芙芙猫：「喵～」"), 1);
  assert.equal(picks("芙芙猫（轻声）：「喵呜」"), 1);
  assert.equal(picks("芙芙猫: 喵～"), 1);
  assert.equal(picks("小白子：「走吧」芙芙猫：「喵～」"), 1);

  // 只是被提到，不是说话人——这正是 A01 那一镜的形状，必须判 0。
  assert.equal(picks("小白子对芙芙猫说：「走吧」"), 0);
  // 把 soundDesign 式的描述写进对白字段也不算说话人。
  assert.equal(picks("芙芙猫轻轻叫了一声"), 0);
  // 没有冒号、或与他人并列的写法目前判不出说话人，按安全方向漏判。
  assert.equal(picks("芙芙猫「喵～」"), 0);
  assert.equal(picks("小白子和芙芙猫：「一起喵」"), 0);
  // 字段为空时同样不发。
  assert.equal(picks(""), 0);
});
