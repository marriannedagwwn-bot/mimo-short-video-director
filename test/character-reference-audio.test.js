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

test("character audio clips follow the current shot cast selection", () => {
  const selected = shotRelatedCharacterAudioClips({
    shotId: "A01",
    videoPrompt: "芙芙猫抬头喵喵叫。"
  }, [
    { characterName: "芙芙猫", referenceAudioClips: [clip()] },
    { characterName: "小白", referenceAudioClips: [clip({ id: "hello", label: "对白" })] }
  ]);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].characterName, "芙芙猫");
  assert.equal(selected[0].clip.label, "喵喵");
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
