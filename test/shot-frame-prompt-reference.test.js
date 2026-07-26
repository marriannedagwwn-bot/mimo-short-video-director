import test from "node:test";
import assert from "node:assert/strict";
import { buildShotFrameImagePrompt } from "../public/shot-frame-prompt.js";
import { buildFrameReferenceManifest } from "../public/shot-reference-images.js";

test("characters omitted from the provider manifest retain their text appearance fallback", async () => {
  const references = [{
    characterName: "角色甲",
    appearancePrompt: "短发，深色夹克",
    referenceImageDataUrl: "data:image/png;base64,AA=="
  }, {
    characterName: "角色乙",
    appearancePrompt: "长发，浅色围巾",
    referenceImageDataUrl: "data:image/png;base64,AQ=="
  }];
  const manifest = await buildFrameReferenceManifest({
    frameKind: "start",
    characterReferences: references,
    maxProviderImages: 1
  });
  const prompt = buildShotFrameImagePrompt({
    frameKind: "start",
    characterReferences: references,
    referenceManifest: manifest,
    shot: {
      startFramePrompt: "角色甲站在画面左侧，角色乙站在画面右侧。",
      endFramePrompt: "两人转头看向门口。"
    }
  });

  assert.match(prompt, new RegExp(manifest.providerImages[0].token, "u"));
  assert.match(prompt, /角色：角色乙/u);
  assert.match(prompt, /长发，浅色围巾/u);
});
