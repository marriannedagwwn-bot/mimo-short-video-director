import test from "node:test";
import assert from "node:assert/strict";
import { loadAppUi } from "./helpers/app-ui-harness.js";

// 2026-10-10：首页停在「从剧情开始」时导入参考视频的测试包，页面没有切回参考视频入口，
// 导入的故事（V2）被当成剧情 Run 处理——剧情 Run 只认故事位 V1，于是分场页显示不出来，看起来就是导入失效。
// 现在导入后按新 Run 的元数据设入口，与刷新恢复同一个函数（restoreRunMetadata）。

const response = (result) => ({ ok: true, status: 200, json: async () => ({ ok: true, result }) });

async function importIntoStoryEntryPage(metadata) {
  const production = { projectId: "imported-project", runId: "imported-run", artifacts: {}, metadata };
  const app = await loadAppUi({ story: true, plan: true, fetch: async (url, options) => {
    const body = JSON.parse(options.body);
    if (url === "/api/browser-workspace/start") return response({ workspace: { id: "workspace", generation: 0 } });
    assert.equal(url, "/api/production/package/import");
    return response({ workspace: { id: "workspace", generation: 1, source: null, run: production }, payload: body.package, production });
  } });
  // 用户先在首页选了「从剧情开始 · 粘贴完整故事」。
  app.state.entryMode = "story";
  app.state.storyMode = "fullStoryText";
  app.document.body.classList.add("story-entry-mode");
  app.document.body.classList.add("story-source-mode");
  const payload = { selectedVariant: app.fixture.themeVariants.variants[1], themeVariants: app.fixture.themeVariants,
    fullStory: app.fixture.fullStory, animationPlan: app.fixture.animationPlan };
  await app.importStoryTestPackage(new File([JSON.stringify(payload)], "test-package.json", { type: "application/json" }));
  return app;
}

test("剧情入口页面导入参考视频的测试包：切回参考视频入口，导入的故事照常显示", async () => {
  const app = await importIntoStoryEntryPage({ creatorProfile: { fixedCharacter: "阿岚，社区修理师", vertical: "治愈", constraints: "" } });
  assert.equal(app.state.entryMode, "video");
  assert.equal(app.document.body.className.includes("story-entry-mode"), false);
  assert.equal(app.document.body.className.includes("story-source-mode"), false);
  assert.equal(app.elements.entryModeVideo.checked, true);
  assert.equal(app.state.selectedVariantId, "V2");
  assert.equal(app.location.pathname, "/story/V2");
  assert.deepEqual(app.state.fullStories.V2, app.fixture.fullStory);
  // 分场页不再显示「这个页面没有对应的故事」。
  assert.doesNotMatch(app.elements.storyStatus.textContent, /没有对应的故事/u);
  assert.match(app.elements.storyPackageStatus.textContent, /已校验并隔离导入 V2/u);
});

test("导入后的入口只认新 Run 的元数据：服务端没给元数据时按参考视频入口", async () => {
  const app = await importIntoStoryEntryPage(undefined);
  assert.equal(app.state.entryMode, "video");
});
