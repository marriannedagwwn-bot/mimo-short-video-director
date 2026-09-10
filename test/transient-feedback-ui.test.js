import test from "node:test";
import assert from "node:assert/strict";
import { loadAppUi, uiTask } from "./helpers/app-ui-harness.js";

const packageHelp = "可导入/导出完整剧情与动画镜头生产包，避免重复请求模型。";
const importedMessage = "已校验并隔离导入 V2：完整剧情 + 动画生产包；旧媒体未混入。";
const response = (result) => ({ ok: true, json: async () => ({ ok: true, result }) });
const tick = () => new Promise(setImmediate);

function assertPackageHelp(app) {
  assert.equal(app.elements.storyPackageStatus.textContent, packageHelp);
  assert.equal(app.elements.storyPackageStatus.className, "");
}

// The imported download module reads the browser globals at call time. Supply
// that DOM/timer boundary without replacing any application/download function.
function useDownloadDom(t, app) {
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  const nativeSetTimeout = globalThis.setTimeout;
  const timers = [];
  Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: app.document });
  globalThis.setTimeout = (callback, delay, ...args) => {
    const timer = nativeSetTimeout(callback, delay, ...args);
    if (delay === 60_000) { timer.unref(); timers.push(timer); }
    return timer;
  };
  t.after(() => {
    for (const timer of timers) clearTimeout(timer);
    globalThis.setTimeout = nativeSetTimeout;
    if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor);
    else delete globalThis.document;
  });
  return app.document.body.childNodes;
}

for (const action of ["saveModelSettings", "resetModelSettings"]) {
  test(`${action} feedback belongs to the current modal opening and leaves applied settings intact`, async () => {
    const app = await loadAppUi();
    app.openModelSettings();
    await app[action]();
    assert.match(app.elements.modelSettingsStatus.textContent, /已应用|已恢复后端默认模型/);
    const settings = JSON.stringify({ overrides: app.state.modelOverrides, stages: app.state.modelStages,
      storyProvider: app.state.storyProvider, storyModel: app.state.storyModel });
    app.closeModelSettings();
    app.openModelSettings();
    assert.equal(app.elements.modelSettingsStatus.textContent, "");
    assert.equal(app.elements.modelSettingsStatus.className.trim(), "story-status");
    assert.equal(JSON.stringify({ overrides: app.state.modelOverrides, stages: app.state.modelStages,
      storyProvider: app.state.storyProvider, storyModel: app.state.storyModel }), settings);
  });
}

test("reopening model settings retains a still-running prompt rewrite and its disabled actions", async () => {
  const app = await loadAppUi({ story: true, plan: true });
  app.state.animationPromptRewriting = true;
  app.elements.saveModelSettings.disabled = true;
  app.elements.resetModelSettings.disabled = true;
  app.setModelSettingsStatus("正在重写当前视频提示词…", "active");
  const plan = app.state.animationPlans.V2;
  app.closeModelSettings();
  app.openModelSettings();
  assert.equal(app.elements.modelSettingsStatus.textContent, "正在重写当前视频提示词…");
  assert.equal(app.elements.modelSettingsStatus.className, "story-status active");
  assert.equal(app.elements.saveModelSettings.disabled, true);
  assert.equal(app.elements.resetModelSettings.disabled, true);
  assert.equal(app.state.animationPlans.V2, plan);
});

test("a package confirmation survives repeat rendering of the same Story context", async () => {
  const app = await loadAppUi({ story: true, plan: true });
  app.renderStoryPage();
  app.setStoryPackageStatus(importedMessage, "ready");
  const story = app.state.fullStories.V2;
  const plan = app.state.animationPlans.V2;
  app.renderStoryPage();
  app.renderRoute();
  assert.equal(app.elements.storyPackageStatus.textContent, importedMessage);
  assert.equal(app.elements.storyPackageStatus.className, "ready");
  assert.equal(app.state.fullStories.V2, story);
  assert.equal(app.state.animationPlans.V2, plan);
});

test("returning to the director clears package feedback before reentering the same Story", async () => {
  const app = await loadAppUi({ story: true, plan: true });
  app.renderStoryPage();
  app.setStoryPackageStatus(importedMessage, "ready");
  const story = app.state.fullStories.V2;
  const plan = app.state.animationPlans.V2;
  app.backToMainResults();
  assertPackageHelp(app);
  assert.equal(app.location.pathname, "/");
  app.navigateToStory("V2");
  assertPackageHelp(app);
  assert.equal(app.state.fullStories.V2, story);
  assert.equal(app.state.animationPlans.V2, plan);
});

for (const field of ["projectId", "runId", "selectedVariantId"]) {
  test(`changing ${field} clears package feedback even when the Story view stays open`, async () => {
    const app = await loadAppUi({ story: true, plan: true });
    app.state.fullStories.V1 = { ...app.fixture.fullStory, selectedVariantId: "V1" };
    app.renderStoryPage();
    app.setStoryPackageStatus(importedMessage, "ready");
    const stories = app.state.fullStories;
    if (field === "selectedVariantId") app.navigateToStory("V1");
    else {
      app.state.production[field] = `new-${field}`;
      app.renderStoryPage();
    }
    assertPackageHelp(app);
    assert.equal(app.state.fullStories, stories);
  });
}

test("new Run reset clears both package feedback and its success styling", async () => {
  const app = await loadAppUi({ story: true });
  app.renderStoryPage();
  app.setStoryPackageStatus(importedMessage, "ready");
  app.resetDirectorClientState();
  assertPackageHelp(app);
});

for (const confirmed of [false, true]) {
  test(`regenerating candidates clears old package feedback only after confirmation=${confirmed}`, async () => {
    let resolveCreate;
    let calls = 0;
    const app = await loadAppUi({ story: true, plan: true, confirm: () => confirmed, fetch: async (url) => {
      calls += 1;
      assert.equal(url, "/api/tasks/create");
      return new Promise((resolve) => { resolveCreate = resolve; });
    } });
    app.state.output.creativeBrief = {};
    app.state.output.visualGuardrails = {};
    app.renderStoryPage();
    app.setStoryPackageStatus(importedMessage, "ready");
    const story = app.state.fullStories.V2;
    const plan = app.state.animationPlans.V2;
    const pending = app.regenerateThemeVariants();
    await tick();
    const textAfterConfirmation = app.elements.storyPackageStatus.textContent;
    const toneAfterConfirmation = app.elements.storyPackageStatus.className;
    if (confirmed) resolveCreate(response({ task: uiTask("variants", "failed", { error: { message: "受控的生成失败" } }) }));
    await pending;
    assert.equal(calls, confirmed ? 1 : 0);
    assert.equal(textAfterConfirmation, confirmed ? packageHelp : importedMessage);
    assert.equal(toneAfterConfirmation, confirmed ? "" : "ready");
    assert.equal(app.state.fullStories.V2, story);
    assert.equal(app.state.animationPlans.V2, plan);
  });
}

for (const action of ["exportStoryTestPackage", "exportCurrentStoryPackage"]) {
  test(`${action} still downloads after leaving and returning but cannot revive its old feedback`, async (t) => {
    let resolveSeal;
    let sealed;
    const app = await loadAppUi({ story: true, plan: true, fetch: async (url, options) => {
      assert.equal(url, "/api/production/package/seal");
      sealed = { ...JSON.parse(options.body).payload, packageSignature: "controlled-signature" };
      return new Promise((resolve) => { resolveSeal = resolve; });
    } });
    const mounted = useDownloadDom(t, app);
    app.renderStoryPage();
    const story = app.state.fullStories.V2;
    const plan = app.state.animationPlans.V2;
    const pending = app[action]();
    app.backToMainResults();
    app.navigateToStory("V2");
    resolveSeal(response(sealed));
    await pending;
    assert.equal(mounted.filter((node) => node.tagName === "FORM" && node.submitted).length, 1);
    assertPackageHelp(app);
    assert.equal(app.state.fullStories.V2, story);
    assert.equal(app.state.animationPlans.V2, plan);
  });
}

test("a current iframe download error remains visible while its late error after navigation is ignored", async (t) => {
  const app = await loadAppUi({ story: true, fetch: async (_url, options) => response(JSON.parse(options.body).payload) });
  const mounted = useDownloadDom(t, app);
  app.renderStoryPage();
  await app.exportStoryTestPackage();
  assert.match(app.elements.storyPackageStatus.textContent, /已发起下载/);
  const frame = mounted.find((node) => node.tagName === "IFRAME");
  frame.contentDocument = { body: { textContent: JSON.stringify({ ok: false, error: { message: "本次下载失败" } }) } };
  frame.onload();
  assert.equal(app.elements.storyPackageStatus.textContent, "本次下载失败");
  assert.equal(app.elements.storyPackageStatus.className, "error");
  app.backToMainResults();
  frame.contentDocument.body.textContent = JSON.stringify({ ok: false, error: { message: "旧下载的迟到错误" } });
  frame.onload();
  assertPackageHelp(app);
});

for (const action of ["exportStoryTestPackage", "exportCurrentStoryPackage"]) {
  test(`${action} cannot put an old seal failure into a replacement workspace`, async () => {
    let rejectSeal;
    const app = await loadAppUi({ story: true, fetch: async () => new Promise((_resolve, reject) => { rejectSeal = reject; }) });
    app.renderStoryPage();
    const pending = app[action]();
    app.browserWorkspace.beginChange();
    app.resetDirectorClientState();
    app.setStoryStatus("新工作区的当前提示", "ready");
    rejectSeal(new Error("旧工作区签发失败"));
    await pending;
    assertPackageHelp(app);
    assert.equal(app.elements.storyStatus.textContent, "新工作区的当前提示");
  });
}

test("a valid package import adopts its new Run and keeps its new confirmation after the internal reset", async () => {
  const calls = [];
  const production = { projectId: "imported-project", runId: "imported-run", artifacts: {} };
  const app = await loadAppUi({ story: true, plan: true, fetch: async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, body });
    if (url === "/api/browser-workspace/start") return response({ workspace: { id: "workspace", generation: 0 } });
    assert.equal(url, "/api/production/package/import");
    return response({ workspace: { id: "workspace", generation: 1, source: null, run: production },
      payload: body.package, production });
  } });
  const payload = { selectedVariant: app.fixture.themeVariants.variants[1], themeVariants: app.fixture.themeVariants,
    fullStory: app.fixture.fullStory, animationPlan: app.fixture.animationPlan };
  app.renderStoryPage();
  app.setStoryPackageStatus("上一个操作的错误", "error");
  await app.importStoryTestPackage(new File([JSON.stringify(payload)], "test-package.json", { type: "application/json" }));
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.workspaceId, "workspace");
  assert.equal(calls[1].body.workspaceGeneration, 0);
  assert.equal(app.state.production.projectId, production.projectId);
  assert.equal(app.state.production.runId, production.runId);
  assert.equal(app.state.selectedVariantId, "V2");
  assert.equal(app.location.pathname, "/story/V2");
  assert.deepEqual(app.state.fullStories.V2, payload.fullStory);
  assert.deepEqual(app.state.animationPlans.V2, payload.animationPlan);
  assert.match(app.elements.storyPackageStatus.textContent, /已校验并隔离导入 V2.*完整剧情.*动画生产包/);
  assert.equal(app.elements.storyPackageStatus.className, "ready");
  const message = app.elements.storyPackageStatus.textContent;
  app.renderStoryPage();
  assert.equal(app.elements.storyPackageStatus.textContent, message);
});

test("a late package file read failure cannot overwrite feedback after returning to the director", async () => {
  let rejectFile;
  const app = await loadAppUi({ story: true });
  app.renderStoryPage();
  const story = app.state.fullStories.V2;
  const pending = app.importStoryTestPackage({ text: () => new Promise((_resolve, reject) => { rejectFile = reject; }) });
  app.backToMainResults();
  rejectFile(new Error("旧文件读取失败"));
  await pending;
  assertPackageHelp(app);
  assert.equal(app.state.fullStories.V2, story);
});
