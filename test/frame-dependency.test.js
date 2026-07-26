import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDependencyPayload,
  canonicalize,
  computeDependencyHash,
  computePromptHash,
  hashDataUrl,
  normalizePromptText
} from "../src/frame-dependency.js";

const firstImage = "data:image/png;base64,AAECAwQ=";
const sameFirstImageWithDifferentMetadata = "data:application/octet-stream;base64,AAECAwQ=";
const secondImage = "data:image/png;base64,BQYHCAk=";
const endState = {
  environment: { sceneId: "scene-1", lighting: "left window light" },
  subjects: [{ name: "A", pose: "right hand on the cup" }]
};
const references = [{
  role: "character",
  contentHash: "character-a-hash",
  characterName: "A",
  ignoredField: "not part of the dependency"
}];

test("canonicalize sorts object keys while preserving array order", () => {
  assert.equal(
    canonicalize({ z: 1, a: { d: 4, b: 2 }, list: [{ y: 2, x: 1 }, 3] }),
    '{"a":{"b":2,"d":4},"list":[{"x":1,"y":2},3],"z":1}'
  );
  assert.notEqual(canonicalize({ list: [1, 2] }), canonicalize({ list: [2, 1] }));
});

test("hashDataUrl hashes decoded raw bytes instead of data URL metadata", async () => {
  assert.equal(await hashDataUrl(firstImage), await hashDataUrl(sameFirstImageWithDifferentMetadata));
  assert.notEqual(await hashDataUrl(firstImage), await hashDataUrl(secondImage));
});

test("dependencyHash is stable across object key order and ignores non-hard fields", async () => {
  const base = {
    startImageDataUrl: firstImage,
    endState,
    referenceImages: references,
    frameReferenceMode: "inherit",
    imagePrompt: "version one",
    changes: { subject: "moves" },
    videoPrompt: "movement"
  };
  const reordered = {
    ...base,
    endState: {
      subjects: [{ pose: "right hand on the cup", name: "A" }],
      environment: { lighting: "left window light", sceneId: "scene-1" }
    },
    imagePrompt: "rewritten wording",
    changes: { camera: "push in" },
    videoPrompt: "different movement"
  };
  assert.equal(await computeDependencyHash(base), await computeDependencyHash(reordered));
});

test("dependencyHash changes with each hard dependency", async () => {
  const base = {
    startImageDataUrl: firstImage,
    endState,
    referenceImages: references,
    frameReferenceMode: "transition"
  };
  const expected = await computeDependencyHash(base);
  assert.notEqual(await computeDependencyHash({ ...base, startImageDataUrl: secondImage }), expected);
  assert.notEqual(await computeDependencyHash({
    ...base,
    endState: { ...endState, subjects: [{ name: "A", pose: "left hand on the cup" }] }
  }), expected);
  assert.notEqual(await computeDependencyHash({
    ...base,
    referenceImages: [{ ...references[0], contentHash: "updated-character-hash" }]
  }), expected);
  assert.notEqual(await computeDependencyHash({
    ...base,
    referenceImages: [
      references[0],
      { role: "character", contentHash: "character-b-hash", characterName: "B" }
    ]
  }), expected);
  assert.notEqual(await computeDependencyHash({ ...base, frameReferenceMode: "inherit" }), expected);
});

test("reference image order is a dependency", async () => {
  const a = { role: "character", contentHash: "a", characterName: "A" };
  const b = { role: "character", contentHash: "b", characterName: "B" };
  const input = {
    startImageDataUrl: firstImage,
    endState,
    frameReferenceMode: "inherit"
  };
  assert.notEqual(
    await computeDependencyHash({ ...input, referenceImages: [a, b] }),
    await computeDependencyHash({ ...input, referenceImages: [b, a] })
  );
});

test("independent dependencies always ignore the start image", async () => {
  const base = {
    endState,
    referenceImages: references,
    frameReferenceMode: "independent"
  };
  assert.equal(
    await computeDependencyHash({ ...base, startImageDataUrl: firstImage }),
    await computeDependencyHash({ ...base, startImageDataUrl: secondImage })
  );
  const payload = await buildDependencyPayload({ ...base, startImageDataUrl: firstImage });
  assert.equal(payload.startImageHash, null);
});

test("inherit and transition dependencies require a start image", async () => {
  await assert.rejects(
    computeDependencyHash({ endState, referenceImages: [], frameReferenceMode: "inherit" }),
    /requires a start image/u
  );
  await assert.rejects(
    computeDependencyHash({ endState, referenceImages: [], frameReferenceMode: "transition" }),
    /requires a start image/u
  );
});

test("promptHash normalizes line endings and outer whitespace only", async () => {
  assert.equal(normalizePromptText(" \r\nfirst\r\nsecond\r "), "first\nsecond");
  assert.equal(
    await computePromptHash(" \r\nfirst\r\nsecond\r "),
    await computePromptHash("first\nsecond")
  );
  assert.notEqual(await computePromptHash("first\nsecond"), await computePromptHash("second\nfirst"));
  assert.notEqual(await computePromptHash("first  second"), await computePromptHash("first second"));
});
