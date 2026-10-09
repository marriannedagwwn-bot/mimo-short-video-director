import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { loadAppUi } from "./helpers/app-ui-harness.js";
import { CHARACTER_ART_STYLE_STORAGE_KEY } from "../public/character-art-style.js";
import { CHARACTER_EXPRESSION_RULES_STORAGE_KEY } from "../public/character-expression-rules.js";

function recordingFetch() {
  const requests = [];
  const fetch = async (path, options = {}) => {
    requests.push({ path, body: options.body ? JSON.parse(options.body) : null });
    return { ok: false, status: 500, json: async () => ({ ok: false, error: "UI 测试桩：不放行这个请求" }) };
  };
  return { fetch, requests };
}

const currentLineage = (artifactId, extra = {}) => ({
  artifactId, status: "current", revision: `${artifactId.replace(/:/gu, "-")}-r1`, contentDigest: "e".repeat(64), dependencies: [], ...extra
});

test("角色画风：第一次没有存档时填默认画风，下拉里是四个预设；读取时压掉多余空白", async () => {
  const app = await loadAppUi();
  app.restoreCharacterArtStyle();
  assert.equal(app.elements.characterArtStyle.value, "二维日系动画");
  assert.equal((app.elements.characterArtStylePresets.innerHTML.match(/<option /gu) || []).length, 4);
  app.elements.characterArtStyle.value = "  水彩\n绘本 ";
  assert.equal(app.characterArtStyle(), "水彩 绘本");
});

test("角色画风存档：有存档按存档恢复；清空后存空串，刷新后仍是不指定；只写画风自己的 key", async () => {
  const saved = new Map();
  const writes = [];
  const storage = {
    getItem: (key) => (saved.has(key) ? saved.get(key) : null),
    setItem: (key, value) => { writes.push(key); saved.set(key, String(value)); },
    removeItem: (key) => saved.delete(key)
  };
  const app = await loadAppUi({ storage });
  saved.set(CHARACTER_ART_STYLE_STORAGE_KEY, "水彩绘本");
  app.restoreCharacterArtStyle();
  assert.equal(app.elements.characterArtStyle.value, "水彩绘本");

  writes.length = 0;
  app.elements.characterArtStyle.value = "";
  app.saveCharacterArtStyle();
  assert.deepEqual(writes, [CHARACTER_ART_STYLE_STORAGE_KEY]);
  assert.equal(saved.get(CHARACTER_ART_STYLE_STORAGE_KEY), "");
  app.restoreCharacterArtStyle();
  assert.equal(app.elements.characterArtStyle.value, "", "清空就是不指定，刷新后不回填默认画风");
  assert.equal(app.characterArtStyle(), "");
});

test("启动时删掉旧的角色表情规则存档；页面不再写它（长期设置仍是七项）", async () => {
  const source = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const start = source.indexOf("async function init()");
  const init = source.slice(start, source.indexOf("bindEvents();", start));
  assert.ok(init.includes("localStorage.removeItem(CHARACTER_EXPRESSION_RULES_STORAGE_KEY);"));
  assert.ok(init.indexOf("removeItem(CHARACTER_EXPRESSION_RULES_STORAGE_KEY)") < init.indexOf("restoreCharacterArtStyle();"));
  assert.equal(source.includes("localStorage.setItem(CHARACTER_EXPRESSION_RULES_STORAGE_KEY"), false);
  assert.notEqual(CHARACTER_ART_STYLE_STORAGE_KEY, CHARACTER_EXPRESSION_RULES_STORAGE_KEY);
});

test("生成分镜：请求带角色画风，不再带角色表情规则", async () => {
  const { fetch, requests } = recordingFetch();
  const app = await loadAppUi({ fetch, story: true });
  app.state.entryMode = "story";
  app.state.storyMode = "characterOnly";
  app.state.production.artifacts["variant:V2"] = currentLineage("variant:V2");
  app.elements.characterArtStyle.value = "二维日系动画";
  await app.generateAnimationPlan({ force: true });
  const created = requests.find((request) => request.path === "/api/tasks/create");
  assert.equal(created.body.kind, "animationPlan");
  assert.equal(created.body.input.artStyle, "二维日系动画");
  assert.equal(Object.hasOwn(created.body.input, "characterExpressionRules"), false);
});

test("角色参考图：不上传也能生成；提示词第一行随上传与移除变化并带分镜画风；请求里没有图片字段", async () => {
  const { fetch, requests } = recordingFetch();
  const app = await loadAppUi({ fetch, story: true, plan: true });
  const plan = app.state.animationPlans.V2;
  app.state.animationPlans.V2 = { ...plan, productionStrategy: { ...plan.productionStrategy, artStyle: "二维日系动画" } };
  app.elements.characterImageRole.value = "0";
  app.elements.characterImageCount.value = "1";

  app.renderCharacterImagePromptPreview();
  const textOnly = app.elements.characterImagePromptPreview.value.split("\n");
  assert.equal(textOnly[0], "生成一张角色参考图。");
  assert.ok(textOnly.includes("画风：二维日系动画"));

  app.state.characterImageGeneration.referenceImageDataUrl = "data:image/png;base64,AA==";
  app.renderCharacterImagePromptPreview();
  assert.equal(app.elements.characterImagePromptPreview.value.split("\n")[0], "参考我上传的这张图片，生成一张角色参考图。");

  // 「移除参考图」：回到只按文字出图，界面不再显示已载入的图。
  app.elements.characterImagePreviewWrap.classList.remove("hidden");
  app.resetCharacterImageReference();
  assert.equal(app.state.characterImageGeneration.referenceImageDataUrl, "");
  assert.ok(app.elements.characterImagePreviewWrap.className.includes("hidden"));
  assert.match(app.elements.characterImageDropHint.textContent, /可以不上传/u);
  app.renderCharacterImagePromptPreview();

  app.state.production.artifacts["animationPlan:V2"] = currentLineage("animationPlan:V2", { mediaNamespace: "media-1" });
  await app.generateCharacterReferenceImages();
  const created = requests.find((request) => request.path === "/api/tasks/create");
  assert.ok(created, "没有上传参考图也发出了出图请求");
  assert.equal(created.body.kind, "characterReferenceImages");
  for (const key of ["referenceImageDataUrl", "referenceImageName"]) assert.equal(Object.hasOwn(created.body.input, key), false, key);
  assert.equal(created.body.input.prompt.split("\n")[0], "生成一张角色参考图。");
});

test("角色参考图：当前角色没有可用提示词时只显示占位提示，不把提示文字当成提示词发出去", async () => {
  const { fetch, requests } = recordingFetch();
  const app = await loadAppUi({ fetch, story: true, plan: true });
  const plan = app.state.animationPlans.V2;
  app.state.animationPlans.V2 = { ...plan, characterReferencePrompts: [{ characterName: "", identity: "", appearancePrompt: "" }] };
  app.elements.characterImageRole.value = "0";
  app.renderCharacterImagePromptPreview();
  assert.equal(app.elements.characterImagePromptPreview.value, "");
  assert.equal(app.elements.characterImagePromptPreview.placeholder, "当前角色没有可用的角色参考提示词。");
  await app.generateCharacterReferenceImages();
  assert.equal(requests.some((request) => request.path === "/api/tasks/create"), false);
});
