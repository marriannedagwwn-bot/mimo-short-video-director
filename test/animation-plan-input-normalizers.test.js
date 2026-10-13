import test from "node:test";
import assert from "node:assert/strict";
import {
  InputError,
  normalizeBackgroundMusicMode,
  requireAnimationPlanAspectRatio
} from "../src/validation.js";
import { normalizeShotVideoAspectRatio } from "../src/shot-video-generator.js";

// 这三个归一化函数在 4.0 自主分镜与镜头视频里仍在用。用例原在已删除的
// test/animation-plan-v3-direct-shot.test.js（3.0 direct_shot），随文件删除挪到这里，断言逐字保留。

test("背景音乐开关缺省关闭，只接受布尔值或两个合法字面量", () => {
  assert.equal(normalizeBackgroundMusicMode(undefined), "none");
  assert.equal(normalizeBackgroundMusicMode(null), "none");
  assert.equal(normalizeBackgroundMusicMode(false), "none");
  assert.equal(normalizeBackgroundMusicMode(true), "allowed");
  assert.equal(normalizeBackgroundMusicMode("none"), "none");
  assert.equal(normalizeBackgroundMusicMode("allowed"), "allowed");
  assert.throws(() => normalizeBackgroundMusicMode("off"), InputError);
  assert.throws(() => normalizeBackgroundMusicMode(1), InputError);
});

test("逐镜视频请求只接受计划支持的两个画幅", () => {
  assert.equal(normalizeShotVideoAspectRatio("9:16"), "9:16");
  assert.equal(normalizeShotVideoAspectRatio("16:9"), "16:9");
  assert.throws(() => normalizeShotVideoAspectRatio("1:1"), /aspectRatio 只允许 9:16 或 16:9/u);
});

test("分镜目标画幅只接受 9:16 与 16:9，其余明确拒绝", () => {
  assert.equal(requireAnimationPlanAspectRatio("9:16"), "9:16");
  assert.equal(requireAnimationPlanAspectRatio("16:9"), "16:9");
  assert.throws(() => requireAnimationPlanAspectRatio("1:1"), /targetAspectRatio 只允许 9:16 或 16:9/u);
});
