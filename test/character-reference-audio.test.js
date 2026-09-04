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
