import test from "node:test";
import assert from "node:assert/strict";
import {
  buildShotVideoBatchReferenceAssets,
  createShotVideoBatchItems,
  requireShotVideoBatchAspectRatio,
  updateShotVideoBatchItem
} from "../src/shot-video-batch.js";

const image = "data:image/png;base64,aW1hZ2U=";

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
