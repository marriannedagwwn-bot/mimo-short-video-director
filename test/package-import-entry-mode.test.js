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

// ---- 剧情 Run 的 3.1 包（2026-10-10）----

const storySource = { schemaVersion: "story_source/1.0", storyMode: "fullStoryText", storyText: "阿岚在雨里捡到一只小猫。" };
const lineage = (artifactId, dependencies = []) => ({
  schemaVersion: "1.0", artifactId, artifactType: artifactId.split(":")[0] === "variant" ? "selectedVariant" : artifactId.split(":")[0],
  revision: `${artifactId.replace(/:/gu, "-")}-r1`, contentDigest: "e".repeat(64), status: "current",
  dependencies: dependencies.map((id) => ({ artifactId: id, revision: `${id.replace(/:/gu, "-")}-r1`, contentDigest: "e".repeat(64) }))
});

test("剧情 Run 导出：请求只带导出信息和剧情、分镜两份副本，原文、设定、候选一律不发", async () => {
  const app = await loadAppUi({ story: true, plan: true });
  app.state.entryMode = "story";
  app.state.storyMode = "fullStoryText";
  app.state.selectedVariantId = "V1";
  app.state.fullStories = { V1: app.fixture.fullStory };
  app.state.animationPlans = {};
  app.state.output.storySource = storySource;
  const pack = app.selectedStoryPackage();
  assert.deepEqual(Object.keys(pack).sort(), ["animationPlan", "exportedAt", "fullStory", "mode", "modelInfo"]);
  assert.deepEqual(pack.fullStory, app.fixture.fullStory);
  assert.equal(pack.animationPlan, null);
  assert.equal(JSON.stringify(pack).includes("小猫"), false, "原文不由页面发出");
});

test("导入剧情 Run 的包：读回服务端的 Run，切到剧情入口、原文填回、进故事位 V1；页面用的是服务端内容", async () => {
  const calls = [];
  const serverStory = { ...structuredClone((await loadAppUi({ story: true })).fixture.fullStory), selectedVariantId: "V1", title: "服务端读回的标题" };
  const production = {
    projectId: "imported-project", runId: "imported-run", lineageSchemaVersion: "1.0",
    metadata: { entryMode: "story", storyMode: "fullStoryText", storySourceDigest: "e".repeat(64), creatorProfile: { fixedCharacter: "阿岚，社区修理师", vertical: "治愈", constraints: "" } },
    artifacts: {}
  };
  const loadedRun = {
    ...production,
    latestArtifacts: {
      storySource: { lineage: lineage("storySource"), content: storySource },
      visualGuardrails: { lineage: lineage("visualGuardrails", ["storySource"]), content: { fixedCharacterBoundary: { characterName: "阿岚" } } },
      "fullStory:V1": { lineage: lineage("fullStory:V1", ["storySource", "visualGuardrails"]), content: serverStory }
    }
  };
  const app = await loadAppUi({ fetch: async (url, options) => {
    const body = options?.body ? JSON.parse(options.body) : null;
    calls.push(url);
    if (url === "/api/browser-workspace/start") return response({ workspace: { id: "workspace", generation: 0 } });
    if (url === "/api/production/package/import") {
      return response({ workspace: { id: "workspace", generation: 1, source: null, run: production }, payload: body.package, production });
    }
    if (url === "/api/production/run/load") return response(loadedRun);
    return { ok: false, status: 500, json: async () => ({ ok: false, error: `UI 测试桩：${url}` }) };
  } });
  // 首页停在参考视频入口。
  app.state.entryMode = "video";
  const payload = { packageVersion: "3.1", entryMode: "story", storyMode: "fullStoryText", storySource,
    fullStory: { ...serverStory, title: "包里的标题（页面不应该用它）" } };
  await app.importStoryTestPackage(new File([JSON.stringify(payload)], "story-package.json", { type: "application/json" }));
  assert.ok(calls.includes("/api/production/run/load"), "剧情包走刷新恢复那条路");
  assert.equal(app.state.entryMode, "story");
  assert.equal(app.state.storyMode, "fullStoryText");
  assert.equal(app.state.selectedVariantId, "V1");
  assert.equal(app.location.pathname, "/story/V1");
  assert.equal(app.elements.storySourceText.value, storySource.storyText, "原文填回输入框");
  assert.deepEqual(app.state.output.storySource, storySource);
  assert.equal(app.state.fullStories.V1.title, "服务端读回的标题");
  assert.match(app.elements.storyPackageStatus.textContent, /已校验并隔离导入剧情 Run/u);
});

test("导入剧情包时导演助手不看半截状态：读回之前不观察，读回之后说换了 Run、按新进度提议", async () => {
  const serverStory = { ...structuredClone((await loadAppUi({ story: true })).fixture.fullStory), selectedVariantId: "V1" };
  const production = {
    projectId: "imported-project", runId: "imported-run", lineageSchemaVersion: "1.0",
    metadata: { entryMode: "story", storyMode: "fullStoryText", storySourceDigest: "e".repeat(64), creatorProfile: { fixedCharacter: "阿岚，社区修理师", vertical: "治愈", constraints: "" } },
    artifacts: {}
  };
  const loadedRun = {
    ...production,
    latestArtifacts: {
      storySource: { lineage: lineage("storySource"), content: storySource },
      visualGuardrails: { lineage: lineage("visualGuardrails", ["storySource"]), content: { fixedCharacterBoundary: { characterName: "阿岚" } } },
      "fullStory:V1": { lineage: lineage("fullStory:V1", ["storySource", "visualGuardrails"]), content: serverStory }
    }
  };
  const app = await loadAppUi({ story: true, plan: true, fetch: async (url, options) => {
    const body = options?.body ? JSON.parse(options.body) : null;
    if (url === "/api/browser-workspace/start") return response({ workspace: { id: "workspace", generation: 0 } });
    if (url === "/api/production/package/import") {
      return response({ workspace: { id: "workspace", generation: 1, source: null, run: production }, payload: body.package, production });
    }
    if (url === "/api/production/run/load") {
      // 读回慢一点：导入途中排上的刷新先跑（真实页面里就是这样撞上的）。
      await new Promise((resolve) => setTimeout(resolve, 20));
      return response(loadedRun);
    }
    return { ok: false, status: 500, json: async () => ({ ok: false, error: `UI 测试桩：${url}` }) };
  } });
  app.browserWorkspaceForTest.adopt({ id: "workspace", generation: 0 });
  app.setSourceLoadingForTest(false);
  app.setDirectorAgentStartedForTest(true);
  app.elements.modelSettingsModal.className = "modal-backdrop hidden";
  app.elements.fixedCharacter.value = "阿岚，社区修理师";
  app.elements.vertical.value = "治愈";
  // 页面上原来是一个参考视频 Run，导演助手已经打过招呼。
  app.refreshDirectorAgentNow();
  const before = app.directorAgent.messages.length;
  await app.importStoryTestPackage(new File([JSON.stringify({ packageVersion: "3.1" })], "story-package.json", { type: "application/json" }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  app.refreshDirectorAgentNow();
  const added = app.directorAgent.messages.slice(before).map((message) => message.text);
  assert.ok(added.includes("已经换成新的 Run。"), added.join(" | "));
  assert.equal(added.some((text) => /改过了|拆好了/u.test(text)), false, `半截状态不该被报出来：${added.join(" | ")}`);
  assert.equal(app.directorAgent.messages.at(-1).card?.state, "pending");
});

test("导入参考视频的包仍按原来的路恢复，不读回 Run", async () => {
  const calls = [];
  const production = { projectId: "imported-project", runId: "imported-run", artifacts: {}, metadata: {} };
  const app = await loadAppUi({ story: true, plan: true, fetch: async (url, options) => {
    calls.push(url);
    const body = JSON.parse(options.body);
    if (url === "/api/browser-workspace/start") return response({ workspace: { id: "workspace", generation: 0 } });
    return response({ workspace: { id: "workspace", generation: 1, source: null, run: production }, payload: body.package, production });
  } });
  const payload = { selectedVariant: app.fixture.themeVariants.variants[1], themeVariants: app.fixture.themeVariants, fullStory: app.fixture.fullStory };
  await app.importStoryTestPackage(new File([JSON.stringify(payload)], "video-package.json", { type: "application/json" }));
  assert.deepEqual(calls, ["/api/browser-workspace/start", "/api/production/package/import"]);
  assert.equal(app.state.selectedVariantId, "V2");
});
