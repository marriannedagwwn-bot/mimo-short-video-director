import test from "node:test";
import assert from "node:assert/strict";
import {
  buildShotVideoBatchReferenceAssets,
  createShotVideoBatchItems,
  requireShotVideoBatchAspectRatio,
  updateShotVideoBatchItem
} from "../src/shot-video-batch.js";

const image = "data:image/png;base64,aW1hZ2U=";
const audio = "data:audio/mpeg;base64,YXVkaW8=";

test("batch reads the signed aspect ratio from the animation plan strategy", () => {
  assert.equal(requireShotVideoBatchAspectRatio({
    productionStrategy: { targetAspectRatio: "16:9" }
  }), "16:9");
  assert.throws(
    () => requireShotVideoBatchAspectRatio({ productionStrategy: { targetAspectRatio: "1:1" } }),
    /productionStrategy\.targetAspectRatio 只允许 9:16 或 16:9/u
  );
});

test("batch all-reference assets use only characters related to the current direct shot", () => {
  const references = [
    { characterName: "小白", referenceImageDataUrl: image },
    { characterName: "阿青", referenceImageDataUrl: `${image}Mg==` }
  ];
  const assets = buildShotVideoBatchReferenceAssets({
    shotId: "S01",
    videoPrompt: "小白走进房间并回头。"
  }, references);
  assert.deepEqual(assets.map((item) => item.sourceCharacterName), ["小白"]);
  assert.equal(assets[0].source, "character_reference");
  assert.equal(assets[0].mediaType, "image");
});

test("batch includes signed voice references only for explicit dialogue speakers", () => {
  const references = [
    {
      characterName: "芙芙猫",
      referenceImageDataUrl: image,
      referenceAudioClips: [{
        id: "meow",
        label: "喵喵",
        fileName: "meow.mp3",
        mimeType: "audio/mpeg",
        dataUrl: audio,
        durationSeconds: 3,
        sizeBytes: 128
      }]
    },
    {
      characterName: "小白",
      referenceAudioClips: [{
        id: "hello",
        label: "对白",
        fileName: "hello.mp3",
        mimeType: "audio/mpeg",
        dataUrl: `${audio}Mg==`,
        durationSeconds: 3,
        sizeBytes: 128
      }]
    }
  ];
  const assets = buildShotVideoBatchReferenceAssets({
    shotId: "A01",
    videoPrompt: "芙芙猫抬头喵喵叫。",
    dialogueOrSubtitle: "芙芙猫：「喵～」"
  }, references);
  assert.deepEqual(assets.map((item) => item.mediaType), ["image", "audio"]);
  assert.equal(assets[1].source, "character_audio_reference");
  assert.equal(assets[1].sourceCharacterName, "芙芙猫");
});

test("batch keeps a visible non-speaking character image but omits its voice reference", () => {
  const references = [{
    characterName: "芙芙猫",
    referenceImageDataUrl: image,
    referenceAudioClips: [{
      id: "meow",
      label: "喵喵",
      fileName: "meow.mp3",
      mimeType: "audio/mpeg",
      dataUrl: audio,
      durationSeconds: 3,
      sizeBytes: 128
    }]
  }];
  const assets = buildShotVideoBatchReferenceAssets({
    shotId: "A01",
    videoPrompt: "芙芙猫始终完整出镜，跟在小白子脚边。",
    characterAction: "芙芙猫抬头看向果树。",
    dialogueOrSubtitle: "果园爷爷：「小白子来啦，正好帮爷爷摘几个果子。」小白子：「嗷呜～」"
  }, references);
  assert.deepEqual(assets.map((item) => item.mediaType), ["image"]);
  assert.equal(assets[0].sourceCharacterName, "芙芙猫");
});

test("batch rejects too many character voice references in one shot", () => {
  const referenceAudioClips = Array.from({ length: 4 }, (_, index) => ({
    id: `clip-${index}`,
    label: `叫声 ${index + 1}`,
    fileName: `clip-${index}.mp3`,
    mimeType: "audio/mpeg",
    dataUrl: `${audio}${index}`,
    durationSeconds: 3,
    sizeBytes: 128
  }));
  assert.throws(() => buildShotVideoBatchReferenceAssets({
    shotId: "A01",
    videoPrompt: "芙芙猫叫了起来。",
    dialogueOrSubtitle: "芙芙猫：「喵喵喵喵」"
  }, [{ characterName: "芙芙猫", referenceImageDataUrl: image, referenceAudioClips }]), /超过全能参考上限 3 段/u);
});

test("batch progress keeps existing videos and updates one shot without rewriting the others", () => {
  const items = createShotVideoBatchItems([
    { shotId: "S01" },
    { shotId: "S02" }
  ], (shot) => shot.shotId === "S01");
  assert.equal(items[0].status, "completed");
  assert.equal(items[1].status, "pending");
  const updated = updateShotVideoBatchItem(items, "S02", { status: "running", message: "生成中" });
  assert.equal(updated[0], items[0]);
  assert.deepEqual(updated[1], { shotId: "S02", status: "running", message: "生成中" });
});
