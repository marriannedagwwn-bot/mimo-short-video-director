import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeStoryFilenameStem, storyPackageFilename } from "../public/export-filename.js";

test("production package filename uses the Full Story title", () => {
  assert.equal(storyPackageFilename({
    selectedVariant: { id: "V3", title: "候选标题" },
    fullStory: { title: "被遗忘的信箱" },
    animationPlan: { title: "被遗忘的信箱 · 动画生产包" }
  }), "被遗忘的信箱.json");
});

test("test package filename keeps the readable story title and a stable suffix", () => {
  assert.equal(storyPackageFilename({
    selectedVariant: { title: "雨天的屋檐下" },
    fullStory: {}
  }, { testPackage: true }), "雨天的屋檐下-测试包.json");
});

test("story filenames are filesystem-safe and have a readable fallback", () => {
  assert.equal(sanitizeStoryFilenameStem("  被遗忘的：信箱 / 最终版？  "), "被遗忘的：信箱-最终版？");
  assert.equal(storyPackageFilename({}), "未命名故事.json");
  assert.equal(storyPackageFilename({ fullStory: { title: "NUL" } }), "NUL-故事.json");
});
