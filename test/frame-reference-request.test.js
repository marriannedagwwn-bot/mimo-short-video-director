import test from "node:test";
import assert from "node:assert/strict";
import {
  assertFrameDependencyHash,
  normalizeEndpointReferenceImages
} from "../src/frame-reference-request.js";
import { InputError } from "../src/validation.js";

const startReference = {
  role: "start_frame",
  dataUrl: "data:image/png;base64,AA==",
  sourceShotId: "S01"
};

test("inherit and transition accept exactly one matching start-frame reference", () => {
  for (const frameReferenceMode of ["inherit", "transition"]) {
    assert.deepEqual(normalizeEndpointReferenceImages([startReference], {
      frameKind: "end",
      frameReferenceMode,
      shotId: "S01"
    }), [startReference]);
    assert.throws(() => normalizeEndpointReferenceImages([], {
      frameKind: "end",
      frameReferenceMode,
      shotId: "S01"
    }), /必须且只能提供一张/u);
  }
});

test("independent allows no start image and rejects one supplied as provider input", () => {
  assert.deepEqual(normalizeEndpointReferenceImages(undefined, {
    frameKind: "end",
    frameReferenceMode: "independent",
    shotId: "S01"
  }), []);
  assert.throws(() => normalizeEndpointReferenceImages([startReference], {
    frameKind: "end",
    frameReferenceMode: "independent",
    shotId: "S01"
  }), /不接受 start_frame/u);
});

test("endpoint references enforce role, data URL and source shot identity", () => {
  const input = (reference) => normalizeEndpointReferenceImages([reference], {
    frameKind: "end",
    frameReferenceMode: "inherit",
    shotId: "S01"
  });
  assert.throws(() => input({ ...startReference, role: "character_reference" }), /role 必须是 start_frame/u);
  assert.throws(() => input({ ...startReference, dataUrl: "https://example.invalid/start.png" }), /Data URL/u);
  assert.throws(() => input({ ...startReference, sourceShotId: "S02" }), /匹配当前镜头/u);
});

test("legacy requests remain valid only when they do not claim endpoint references", () => {
  assert.deepEqual(normalizeEndpointReferenceImages(undefined, {
    frameKind: "end",
    frameReferenceMode: "",
    shotId: "S01"
  }), []);
  assert.throws(() => normalizeEndpointReferenceImages([startReference], {
    frameKind: "end",
    frameReferenceMode: "",
    shotId: "S01"
  }), /必须与 frameReferenceMode 一起/u);
});

test("dependency mismatch exposes the stable service error code before provider use", () => {
  assert.equal(assertFrameDependencyHash("", "dep:v1:authority"), "dep:v1:authority");
  assert.equal(assertFrameDependencyHash("dep:v1:authority", "dep:v1:authority"), "dep:v1:authority");
  assert.throws(
    () => assertFrameDependencyHash("dep:v1:client", "dep:v1:authority"),
    (error) => error instanceof InputError
      && error.message === "FRAME_DEPENDENCY_MISMATCH"
      && error.details[0]?.code === "FRAME_DEPENDENCY_MISMATCH"
  );
});
