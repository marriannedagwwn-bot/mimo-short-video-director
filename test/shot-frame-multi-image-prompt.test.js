import test from "node:test";
import assert from "node:assert/strict";
import { computePromptHash } from "../src/frame-dependency.js";
import { buildShotFrameMultiImagePrompt } from "../public/shot-frame-multi-image-prompt.js";

test("single-image provider prompt is the normalized endpoint prompt", () => {
  assert.equal(buildShotFrameMultiImagePrompt("  EndState prompt  ", 1), "EndState prompt");
});

test("multi-image provider prompt records candidate-count instructions in promptHash", async () => {
  const base = "EndState prompt";
  const fourCandidates = buildShotFrameMultiImagePrompt(base, 4);
  assert.match(fourCandidates, /4 张候选图/u);
  assert.notEqual(await computePromptHash(base), await computePromptHash(fourCandidates));
  assert.equal(
    await computePromptHash(fourCandidates),
    await computePromptHash(buildShotFrameMultiImagePrompt(base, 4))
  );
});
