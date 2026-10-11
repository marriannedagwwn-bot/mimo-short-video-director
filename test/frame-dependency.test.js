import test from "node:test";
import assert from "node:assert/strict";
import { canonicalize } from "../src/frame-dependency.js";

// 首尾帧的依赖哈希（computeDependencyHash / computePromptHash / buildDependencyPayload /
// normalizePromptText / hashDataUrl）已随首尾帧删除（2026-10-11）。canonicalize 仍被角色边界、
// Cast 与角色登记使用，这里只留它的用例。

test("canonicalize sorts object keys while preserving array order", () => {
  assert.equal(
    canonicalize({ z: 1, a: { d: 4, b: 2 }, list: [{ y: 2, x: 1 }, 3] }),
    '{"a":{"b":2,"d":4},"list":[{"x":1,"y":2},3],"z":1}'
  );
  assert.notEqual(canonicalize({ list: [1, 2] }), canonicalize({ list: [2, 1] }));
});
