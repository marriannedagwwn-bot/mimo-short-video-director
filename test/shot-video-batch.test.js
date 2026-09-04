import test from "node:test";
import assert from "node:assert/strict";
import {
  buildShotVideoBatchReferenceAssets,
  createShotVideoBatchItems,
  requireShotVideoBatchAspectRatio,
  shotVideoBatchReferenceIssues,
  updateShotVideoBatchItem
} from "../src/shot-video-batch.js";
import {
  ALL_REFERENCE_MAX_AUDIOS,
  ALL_REFERENCE_MAX_IMAGES
} from "../public/all-reference-limits.js";

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

// ——— 批前预检（shotVideoBatchReferenceIssues）———
//
// 锁住的是「批量开工之前就能算出这一镜会不会被供应商拒掉」。此前批量只在首个待办镜头上
// 确认「至少有一项视觉参考」，第 7 镜的超限要等前 6 镜都付过费之后才暴露。

function voiceClips(count, { durationSeconds = 3 } = {}) {
  return Array.from({ length: count }, (_, index) => ({
    id: `clip-${index}`,
    label: `叫声 ${index + 1}`,
    fileName: `clip-${index}.mp3`,
    mimeType: "audio/mpeg",
    dataUrl: `${audio}${index}`,
    durationSeconds,
    sizeBytes: 128
  }));
}

test("每个角色单独看都合规的语音，合到一镜里超限时预检要抓住", () => {
  // 两个角色各 3 段：上传期的「每个角色最多 3 段」全部通过，但它们在同一镜都明确发声就是 6 段，
  // 超过供应商的「每个镜头最多 3 段」。这正是原本会把整批带走的那条路径。
  const references = [
    { characterName: "芙芙猫", referenceImageDataUrl: image, referenceAudioClips: voiceClips(3) },
    { characterName: "小白", referenceImageDataUrl: `${image}Mg==`, referenceAudioClips: voiceClips(3) }
  ];
  const issues = shotVideoBatchReferenceIssues({
    shotId: "A03",
    videoPrompt: "小白蹲下来摸芙芙猫，芙芙猫喵了一声。",
    dialogueOrSubtitle: "小白：「你还好吗？」芙芙猫：「喵～」"
  }, references);
  // 一镜的问题一次报全，不是报第一条就收工——用户改配置时才不用来回试。
  // 这一镜同时踩了两条：6 段超过每镜 3 段，6×3=18 秒也超过总时长上限。
  assert.deepEqual(issues.map((issue) => issue.code), [
    "SHOT_VIDEO_BATCH_REFERENCE_LIMIT",
    "SHOT_VIDEO_BATCH_REFERENCE_DURATION_INVALID"
  ]);
  assert.match(issues[0].message, /镜头 A03 关联 6 段角色参考声音/u);
  assert.match(issues[1].message, /总时长不能超过 15 秒，当前 18\.00 秒/u);
});

test("上一镜抽帧与角色参考图共用同一个 9 张上限", () => {
  const references = Array.from({ length: 5 }, (_, index) => ({
    characterName: `角色${index}`,
    referenceImageDataUrl: `${image}${index}`
  }));
  const shot = {
    shotId: "A02",
    videoPrompt: "角色0、角色1、角色2、角色3、角色4 一起走进院子。"
  };
  // 5 张角色图 + 5 张上一镜抽帧 = 10 > 9
  const withFrames = shotVideoBatchReferenceIssues(shot, references, { continuityFrameCount: 5 });
  assert.equal(withFrames.length, 1);
  assert.equal(withFrames[0].code, "SHOT_VIDEO_BATCH_REFERENCE_LIMIT");
  assert.match(withFrames[0].message, /需要 10 张参考图（角色参考图 5 张 \+ 上一镜抽帧 5 张）/u);
  // 同样的输入，没有抽帧时合规——两者分开数就会漏掉真正会失败的组合。
  assert.deepEqual(shotVideoBatchReferenceIssues(shot, references), []);
});

test("边界正好落在共享常量上，9 张放行、10 张拒绝", () => {
  const shot = { shotId: "A05", videoPrompt: "小白站在门前。" };
  const passing = shotVideoBatchReferenceIssues(shot, [{
    characterName: "小白",
    referenceImageDataUrl: image
  }], { continuityFrameCount: ALL_REFERENCE_MAX_IMAGES - 1 });
  assert.deepEqual(passing, []);
  const failing = shotVideoBatchReferenceIssues(shot, [{
    characterName: "小白",
    referenceImageDataUrl: image
  }], { continuityFrameCount: ALL_REFERENCE_MAX_IMAGES });
  assert.equal(failing.length, 1);
  assert.equal(failing[0].code, "SHOT_VIDEO_BATCH_REFERENCE_LIMIT");
  assert.equal(ALL_REFERENCE_MAX_AUDIOS, 3);
});

test("没有角色参考图的镜头，靠上一镜抽帧就算有视觉参考", () => {
  const shot = { shotId: "A04", videoPrompt: "空院子里雨水落进水缸。" };
  const firstShot = shotVideoBatchReferenceIssues(shot, []);
  assert.equal(firstShot.length, 1);
  assert.equal(firstShot[0].code, "SHOT_VIDEO_BATCH_REFERENCE_REQUIRED");
  assert.deepEqual(shotVideoBatchReferenceIssues(shot, [], { continuityFrameCount: 5 }), []);
});

test("预检与构建期判定不会各说各话", () => {
  // 两条路径共用一份判定：构建期抛错的输入，预检必须报同一个码和同一句话。
  // 视觉参考那条除外——构建期还不知道抽帧可不可用，那一条由知道的调用方裁决。
  const references = [{
    characterName: "芙芙猫",
    referenceImageDataUrl: image,
    referenceAudioClips: voiceClips(4)
  }];
  const shot = {
    shotId: "A01",
    videoPrompt: "芙芙猫叫了起来。",
    dialogueOrSubtitle: "芙芙猫：「喵喵喵喵」"
  };
  const issues = shotVideoBatchReferenceIssues(shot, references)
    .filter((issue) => issue.code !== "SHOT_VIDEO_BATCH_REFERENCE_REQUIRED");
  assert.ok(issues.length);
  assert.throws(
    () => buildShotVideoBatchReferenceAssets(shot, references),
    (error) => error.code === issues[0].code && error.message === issues[0].message
  );
});

test("供应商不接受的语音时长在预检就报出来", () => {
  const references = [{
    characterName: "芙芙猫",
    referenceImageDataUrl: image,
    referenceAudioClips: voiceClips(1, { durationSeconds: 1 })
  }];
  const issues = shotVideoBatchReferenceIssues({
    shotId: "A01",
    videoPrompt: "芙芙猫叫了起来。",
    dialogueOrSubtitle: "芙芙猫：「喵～」"
  }, references);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, "SHOT_VIDEO_BATCH_REFERENCE_DURATION_INVALID");
  assert.match(issues[0].message, /时长必须在 2-15 秒之间/u);
});
