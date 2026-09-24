import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fullStoryControlView, fullStoryTaskView } from "../public/full-story-control-ui.js";
import { loadAppUi, uiTask } from "./helpers/app-ui-harness.js";

const usage = { calls: 3, reportedCalls: 2, unreportedCalls: 1, usageComplete: false,
  totalTokens: 1234, costKnown: false, costCny: null };
const response = (result) => ({ ok: true, json: async () => ({ ok: true, result }) });
const tick = () => new Promise(setImmediate);
function task(controlState = "running", overrides = {}) {
  return uiTask("fullStory", "running", { progress: { controlState, streamedChars: 127 }, usage, ...overrides });
}
function artifact(artifactId, content, overrides = {}) {
  return { lineage: { artifactId, status: "current", revision: "r1", contentDigest: `${artifactId}-digest`,
    createdAt: "2026-09-09T01:00:00Z", ...overrides }, content };
}
function runFor(app, { stories = {}, selected = "V2" } = {}) {
  return { projectId: "project", runId: "run", latestArtifacts: {
    themeVariants: artifact("themeVariants", app.fixture.themeVariants),
    ...(selected ? { [`variant:${selected}`]: artifact(`variant:${selected}`, app.fixture.themeVariants.variants.find((v) => v.id === selected)) } : {}),
    ...Object.fromEntries(Object.entries(stories).map(([id, story]) => [`fullStory:${id}`, artifact(`fullStory:${id}`, story)]))
  } };
}

test("Full Story uses the director's sibling control group with independent accessible buttons", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const start = html.indexOf('id="fullStoryControls"');
  const group = html.slice(start, html.indexOf("</div>", start));
  assert.equal((group.match(/<button\b/g) || []).length, 3);
  assert.match(group, /id="generateFullStory"[\s\S]*?<\/button>\s*<button[^>]*id="terminateFullStory"[\s\S]*?<\/button>\s*<button[^>]*id="pauseFullStory"/);
  assert.match(group, /aria-label="终止本次完整剧情生成"/);
  assert.match(group, /aria-label="暂停生成完整剧情"/);
  assert.match(html, /继续会重新生成完整剧情，可能再次计费。终止会保留已有结果/);
  assert.doesNotMatch(html, /id="(?:pipelineUsage|releaseActiveTasks)"/);
});

test("Full Story reuses settled pause controls and preserves incomplete usage without inventing zero cost", () => {
  const starting = fullStoryControlView(null, { starting: true });
  assert.equal(starting.visible, true);
  assert.equal(starting.stopDisabled, true);
  assert.equal(starting.pauseDisabled, true);
  assert.equal(fullStoryControlView(task("pausing")).pauseDisabled, true);
  assert.equal(fullStoryControlView(task("pausing")).stopDisabled, false);
  assert.equal(fullStoryControlView(task("terminating")).stopDisabled, true);
  assert.equal(fullStoryControlView(task("paused")).pauseAction, "resume");
  const unknown = { ...usage, reportedCalls: 0, unreportedCalls: 3, totalTokens: 0, costKnown: true, costCny: 0 };
  const view = fullStoryTaskView(task("paused", { usage: unknown }));
  assert.match(view.message, /已暂停.*可能再次计费.*3 次请求未返回用量/);
  assert.doesNotMatch(view.message, /0 tokens|¥/);
  assert.equal(view.tone, "warn");
});

test("the actual create path disables controls before task creation and cannot submit twice", async () => {
  let resolveCommit;
  let resolveCreate;
  const calls = [];
  const app = await loadAppUi({ story: true, plan: true, fetch: async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, body });
    if (url === "/api/production/artifact/commit") return new Promise((resolve) => { resolveCommit = resolve; });
    if (url === "/api/tasks/create") return new Promise((resolve) => { resolveCreate = resolve; });
    throw new Error(`unexpected ${url}`);
  } });
  app.state.production.artifacts.themeVariants = artifact("themeVariants", app.fixture.themeVariants).lineage;
  app.updateTaskSnapshot(task("running", { status: "failed" }));
  const story = app.state.fullStories.V2;
  const plan = app.state.animationPlans.V2;
  const pending = app.generateFullStory({ force: true });
  await tick();
  assert.equal(app.elements.fullStoryControls.classList.contains("active"), true);
  assert.equal(app.elements.storyGenerate.disabled, true);
  assert.equal(app.elements.terminateFullStory.disabled, true);
  assert.equal(app.elements.pauseFullStory.disabled, true);
  await app.controlFullStory("terminate");
  await app.generateFullStory({ force: true });
  assert.equal(calls.length, 1);
  resolveCommit(response({ lineage: artifact("variant:V2", {}).lineage, staleArtifactIds: [] }));
  await tick();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.kind, "fullStory");
  assert.equal(calls[1].body.input.variantId, "V2");
  assert.equal(app.elements.pauseFullStory.disabled, true);
  resolveCreate(response({ task: task("terminating", { status: "cancelled", updatedAt: "2026-09-10T01:00:00Z" }) }));
  await pending;
  assert.equal(app.state.fullStories.V2, story);
  assert.equal(app.state.animationPlans.V2, plan);
  assert.match(app.elements.storyStatus.textContent, /已终止.*已有结果已保留.*1,234 tokens/);
  assert.equal(app.elements.storyStatus.className, "story-status warn");
});

test("repeated rendering of a paused Full Story keeps resume accessible and the existing Story and Plan", async () => {
  const app = await loadAppUi({ story: true, plan: true });
  const story = app.state.fullStories.V2;
  const plan = app.state.animationPlans.V2;
  app.updateTaskSnapshot(task("paused"));
  app.markRestoredTaskRunning(task("paused"));
  app.renderRoute();
  app.renderStoryPage();
  assert.equal(app.elements.storyGenerate.disabled, true);
  assert.equal(app.elements.pauseFullStory.disabled, false);
  assert.equal(app.elements.pauseFullStory.getAttribute("aria-label"), "继续生成完整剧情");
  assert.equal(app.elements.pauseFullStory.getAttribute("title"), "继续生成完整剧情");
  assert.equal(app.elements.fullStoryStartArrow.classList.contains("hidden"), true);
  assert.match(app.elements.storyStatus.textContent, /已暂停.*1,234 tokens.*1 次请求未返回用量/);
  assert.equal(app.state.fullStories.V2, story);
  assert.equal(app.state.animationPlans.V2, plan);
});

test("double pause is scoped to one root task and a stale poll cannot undo its settled pause", async () => {
  let resolveControl;
  const calls = [];
  const app = await loadAppUi({ fetch: async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return new Promise((resolve) => { resolveControl = resolve; });
  } });
  app.updateTaskSnapshot(task());
  const pending = app.controlFullStory("pause");
  await app.controlFullStory("pause");
  await app.controlFullStory("terminate");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/tasks/task-fullStory/control");
  assert.equal(calls[0].body.projectId, "project");
  assert.equal(calls[0].body.runId, "run");
  assert.equal(calls[0].body.action, "pause");
  assert.equal(app.elements.pauseFullStory.disabled, true);
  resolveControl(response(task("pausing", { updatedAt: "2026-09-10T01:00:00Z" })));
  await pending;
  assert.equal(app.elements.pauseFullStory.disabled, true);
  assert.equal(app.elements.terminateFullStory.disabled, false);
  app.updateTaskSnapshot(task("paused", { updatedAt: "2026-09-10T01:00:01Z" }));
  app.updateTaskSnapshot(task());
  assert.equal(app.elements.pauseFullStory.disabled, false);
  assert.equal(app.elements.pauseFullStory.getAttribute("aria-label"), "继续生成完整剧情");
  assert.match(app.elements.storyGenerate.querySelector("span").textContent, /已暂停/);
});

test("resume and terminate keep the same task and preserve completed content, media and usage", async () => {
  const calls = [];
  const app = await loadAppUi({ story: true, plan: true, fetch: async (url, options) => {
    const { action } = JSON.parse(options.body);
    calls.push({ url, action });
    return response(action === "resume" ? task("running", { updatedAt: "2026-09-10T01:00:00Z" })
      : task("terminating", { status: "cancelled", updatedAt: "2026-09-10T01:00:01Z", error: { message: "FULL_STORY_TERMINATED" } }));
  } });
  const output = app.state.output;
  const story = app.state.fullStories.V2;
  const plan = app.state.animationPlans.V2;
  app.state.shotVideoResults["V2:A01"] = { url: "/retained.mp4" };
  const media = app.state.shotVideoResults["V2:A01"];
  app.updateTaskSnapshot(task("paused"));
  await app.controlFullStory("resume");
  assert.equal(app.elements.pauseFullStory.getAttribute("aria-label"), "暂停生成完整剧情");
  await app.controlFullStory("terminate");
  assert.deepEqual(calls, ["resume", "terminate"].map((action) => ({ url: "/api/tasks/task-fullStory/control", action })));
  assert.equal(app.state.production.runId, "run");
  assert.equal(app.state.output, output);
  assert.equal(app.state.fullStories.V2, story);
  assert.equal(app.state.animationPlans.V2, plan);
  assert.equal(app.state.shotVideoResults["V2:A01"], media);
  const cancelled = app.state.taskSnapshots["task-fullStory"];
  assert.equal(cancelled.status, "cancelled");
  assert.deepEqual(cancelled.usage, usage);
  app.renderFullStoryTaskError({ task: cancelled, message: "任务以 cancelled 结束" }, "失败", "V2");
  app.renderStoryPage();
  assert.equal(app.elements.fullStoryControls.classList.contains("active"), false);
  assert.equal(app.elements.storyStatus.className, "story-status warn");
  assert.match(app.elements.storyStatus.textContent, /已终止.*已有结果已保留.*1,234 tokens.*1 次请求未返回用量/);
  assert.doesNotMatch(app.elements.storyStatus.textContent, /失败|FULL_STORY_TERMINATED/);
});

test("a control error unlocks retry while retaining the actual paused task", async () => {
  const app = await loadAppUi({ fetch: async () => { throw new Error("控制连接暂时失败"); } });
  app.updateTaskSnapshot(task("paused"));
  await app.controlFullStory("resume");
  assert.equal(app.elements.pauseFullStory.getAttribute("aria-label"), "继续生成完整剧情");
  assert.equal(app.elements.pauseFullStory.disabled, false);
  assert.equal(Object.keys(app.state.storyControlRequests).length, 0);
  assert.match(app.elements.storyStatus.textContent, /控制连接暂时失败/);
});

test("a terminate request which loses the commit race respects completed and does not clear existing results", async () => {
  const completed = task("running", { status: "completed", updatedAt: "2026-09-10T01:00:00Z",
    resultArtifactRefs: [{ artifactId: "fullStory:V2", revision: "r1", contentDigest: "fullStory:V2-digest" }] });
  const app = await loadAppUi({ story: true, plan: true, fetch: async () => response(completed) });
  const story = app.state.fullStories.V2;
  const plan = app.state.animationPlans.V2;
  app.state.production.artifacts["fullStory:V2"] = artifact("fullStory:V2", story).lineage;
  app.updateTaskSnapshot(task());
  await app.controlFullStory("terminate");
  assert.equal(app.state.taskSnapshots[completed.taskId].status, "completed");
  assert.equal(app.state.fullStories.V2, story);
  assert.equal(app.state.animationPlans.V2, plan);
  assert.equal(app.elements.fullStoryControls.classList.contains("active"), false);
  assert.equal(app.elements.storyStatus.className, "story-status ready");
  assert.match(app.elements.storyStatus.textContent, /任务已完成/);
  assert.doesNotMatch(app.elements.storyStatus.textContent, /终止|取消/);
});

test("another variant's active task blocks duplicate generation but cannot be controlled from this page", async () => {
  const calls = [];
  const app = await loadAppUi({ fetch: async (url) => { calls.push(url); throw new Error("unexpected control"); } });
  app.updateTaskSnapshot(task("paused", { targetArtifactIds: ["fullStory:V1"] }));
  app.renderStoryPage();
  assert.equal(app.elements.storyGenerate.disabled, true);
  assert.equal(app.elements.fullStoryControls.classList.contains("active"), false);
  assert.match(app.elements.storyStatus.textContent, /^V1 · .*已暂停/);
  await app.controlFullStory("terminate");
  await app.controlFullStory("resume");
  await app.generateFullStory({ force: true });
  assert.equal(calls.length, 0);
});

test("the selected root task wins over a newer different variant and a child task", async () => {
  const calls = [];
  const current = task("paused");
  const app = await loadAppUi({ fetch: async (url) => { calls.push(url); return response(current); } });
  app.updateTaskSnapshot(current);
  app.updateTaskSnapshot(task("running", { taskId: "other", targetArtifactIds: ["fullStory:V1"], createdAt: "2026-09-10T01:00:00Z" }));
  app.updateTaskSnapshot(task("running", { taskId: "child", parentTaskId: "parent", createdAt: "2026-09-10T02:00:00Z" }));
  app.renderStoryPage();
  assert.equal(app.selectedFullStoryTask().taskId, current.taskId);
  assert.equal(app.elements.pauseFullStory.getAttribute("aria-label"), "继续生成完整剧情");
  assert.doesNotMatch(app.elements.storyStatus.textContent, /^V1/);
  await app.controlFullStory("resume");
  assert.deepEqual(calls, ["/api/tasks/task-fullStory/control"]);
});

test("a late control response records only its own snapshot and cannot change the newly selected variant", async () => {
  let resolveControl;
  const app = await loadAppUi({ fetch: async () => new Promise((resolve) => { resolveControl = resolve; }) });
  app.updateTaskSnapshot(task());
  const pending = app.controlFullStory("pause");
  app.state.selectedVariantId = "V1";
  app.renderStoryPage();
  app.setStoryStatus("V1 当前页面状态", "ready");
  resolveControl(response(task("paused", { updatedAt: "2026-09-10T01:00:00Z" })));
  await pending;
  assert.equal(app.state.selectedVariantId, "V1");
  assert.equal(app.elements.storyStatus.textContent, "V1 当前页面状态");
  assert.equal(app.elements.fullStoryControls.classList.contains("active"), false);
  assert.equal(app.state.taskSnapshots["task-fullStory"].progress.controlState, "paused");
  app.state.selectedVariantId = "V2";
  app.renderStoryPage();
  assert.equal(app.elements.pauseFullStory.getAttribute("aria-label"), "继续生成完整剧情");
});

test("late responses from an older task or workspace cannot overwrite their replacement", async () => {
  for (const replaceWorkspace of [false, true]) {
    let resolveControl;
    const app = await loadAppUi({ fetch: async () => new Promise((resolve) => { resolveControl = resolve; }) });
    app.updateTaskSnapshot(task());
    const pending = app.controlFullStory("pause");
    if (replaceWorkspace) {
      app.browserWorkspace.beginChange();
      app.resetDirectorClientState();
      app.setStoryRunning(false);
    } else {
      app.updateTaskSnapshot(task("running", { taskId: "new-task", createdAt: "2026-09-10T02:00:00Z", updatedAt: "2026-09-10T02:00:00Z" }));
    }
    app.setStoryStatus("替换后的当前状态", "ready");
    resolveControl(response(task("paused", { updatedAt: "2026-09-10T01:00:00Z" })));
    await pending;
    assert.equal(app.elements.storyStatus.textContent, "替换后的当前状态");
    assert.equal(Object.keys(app.state.storyControlRequests).length, 0);
    if (replaceWorkspace) assert.equal(Object.keys(app.state.taskSnapshots).length, 0);
    else {
      assert.equal(app.selectedFullStoryTask().taskId, "new-task");
      assert.equal(app.elements.pauseFullStory.getAttribute("aria-label"), "暂停生成完整剧情");
    }
  }
});

test("actual paused Run restore attaches the same Full Story without creating or resuming a task", async () => {
  const urls = [];
  const waits = [];
  let run;
  const restored = task("paused");
  const app = await loadAppUi({ story: true, windowSetTimeout: (callback) => { waits.push(callback); }, fetch: async (url) => {
    urls.push(url);
    if (url === "/api/production/run/load") return response(run);
    if (url.startsWith("/api/tasks?")) return { ok: true, json: async () => ({ ok: true, tasks: [restored] }) };
    throw new Error(`unexpected ${url}`);
  } });
  run = runFor(app, { stories: { V2: app.fixture.fullStory } });
  assert.equal(await app.restoreActiveProductionRun({ projectId: "project", runId: "run" }), true);
  await tick();
  app.renderRoute();
  assert.equal(urls.length, 2);
  assert.equal(waits.length, 1);
  assert.equal(app.state.storyRunning, true);
  assert.equal(app.elements.pauseFullStory.disabled, false);
  assert.equal(app.elements.pauseFullStory.getAttribute("aria-label"), "继续生成完整剧情");
  assert.match(app.elements.storyStatus.textContent, /已暂停.*1,234 tokens/);
  assert.deepEqual(app.state.fullStories.V2, app.fixture.fullStory);
  app.browserWorkspace.beginChange();
  waits[0]();
  await tick();
});

for (const status of ["completed", "failed", "interrupted", "cancelled"]) {
  test(`terminal Full Story restore preserves ${status}, existing content and partial usage without polling`, async () => {
    const urls = [];
    let run;
    const restored = task("running", { status,
      resultArtifactRefs: [{ artifactId: "fullStory:V2", revision: "r1", contentDigest: "fullStory:V2-digest" }] });
    const app = await loadAppUi({ story: true, fetch: async (url) => {
      urls.push(url);
      if (url === "/api/production/run/load") return response(run);
      if (url.startsWith("/api/tasks?")) return { ok: true, json: async () => ({ ok: true, tasks: [restored] }) };
      throw new Error(`unexpected ${url}`);
    } });
    run = runFor(app, { stories: { V2: app.fixture.fullStory } });
    assert.equal(await app.restoreActiveProductionRun({ projectId: "project", runId: "run" }), true);
    app.renderRoute();
    assert.equal(urls.length, 2);
    assert.equal(app.elements.fullStoryControls.classList.contains("active"), false);
    assert.equal(app.elements.storyGenerate.disabled, false);
    assert.match(app.elements.storyStatus.textContent, /已确认消耗 1,234 tokens.*1 次请求未返回用量/);
    assert.deepEqual(app.state.fullStories.V2, app.fixture.fullStory);
    assert.equal(app.state.taskSnapshots[restored.taskId].status, status);
    assert.deepEqual(app.state.taskSnapshots[restored.taskId].usage, usage);
    if (status === "cancelled") {
      assert.equal(app.elements.storyStatus.className, "story-status warn");
      assert.match(app.elements.storyStatus.textContent, /已终止.*已有结果已保留/);
    }
  });
}

test("Full Story completion reload keeps a variant selected during loading and preserves both stories", async () => {
  const waits = [];
  let resolveLoad;
  const completed = task("running", { status: "completed", updatedAt: "2026-09-10T01:00:00Z",
    resultArtifactRefs: [{ artifactId: "fullStory:V2", revision: "r1", contentDigest: "fullStory:V2-digest" }] });
  const app = await loadAppUi({ story: true, windowSetTimeout: (callback) => { waits.push(callback); }, fetch: async (url) => {
    if (url.startsWith("/api/tasks/task-fullStory?")) return response(completed);
    if (url === "/api/production/run/load") return new Promise((resolve) => { resolveLoad = resolve; });
    throw new Error(`unexpected ${url}`);
  } });
  const storyV1 = { ...app.fixture.fullStory, selectedVariantId: "V1", title: "当前候选 V1 的完整剧情" };
  const storyV2 = { ...app.fixture.fullStory, title: "旧候选 V2 刚完成的完整剧情" };
  app.state.fullStories.V1 = storyV1;
  app.updateTaskSnapshot(task());
  app.markRestoredTaskRunning(task());
  const pending = app.attachRestoredStandaloneTask(task());
  await tick();
  assert.equal(waits.length, 1);
  waits[0]();
  await tick();
  assert.equal(typeof resolveLoad, "function");
  app.state.selectedVariantId = "V1";
  app.renderStoryPage();
  const shownStory = app.elements.fullStory.innerHTML;
  resolveLoad(response(runFor(app, { stories: { V1: storyV1, V2: storyV2 } })));
  await pending;
  assert.equal(app.state.selectedVariantId, "V1");
  assert.equal(app.elements.fullStory.innerHTML, shownStory);
  assert.equal(app.state.fullStories.V2.title, storyV2.title);
  assert.equal(app.state.fullStories.V1.title, storyV1.title);
  assert.equal(app.state.output.fullStory.selectedVariantId, "V1");
  assert.doesNotMatch(app.elements.storyStatus.textContent, /V2|任务已完成|失败/);
});

test("fresh Full Story generation cannot use its reload to switch back to an old variant", async () => {
  let resolveLoad;
  const app = await loadAppUi({ story: true, fetch: async (url) => {
    if (url === "/api/production/artifact/commit") return response({ lineage: artifact("variant:V2", {}).lineage });
    if (url === "/api/tasks/create") return response({ task: task("running", { status: "completed",
      resultArtifactRefs: [{ artifactId: "fullStory:V2", revision: "r1", contentDigest: "fullStory:V2-digest" }] }) });
    if (url === "/api/production/run/load") return new Promise((resolve) => { resolveLoad = resolve; });
    throw new Error(`unexpected ${url}`);
  } });
  app.state.production.artifacts.themeVariants = artifact("themeVariants", app.fixture.themeVariants).lineage;
  const storyV1 = { ...app.fixture.fullStory, selectedVariantId: "V1", title: "V1 当前剧情" };
  const storyV2 = { ...app.fixture.fullStory, title: "V2 新结果" };
  app.state.fullStories.V1 = storyV1;
  const pending = app.generateFullStory({ force: true });
  await tick();
  assert.equal(typeof resolveLoad, "function");
  app.state.selectedVariantId = "V1";
  app.renderStoryPage();
  const shownStory = app.elements.fullStory.innerHTML;
  resolveLoad(response(runFor(app, { stories: { V1: storyV1, V2: storyV2 } })));
  await pending;
  assert.equal(app.state.selectedVariantId, "V1");
  assert.equal(app.elements.fullStory.innerHTML, shownStory);
  assert.equal(app.state.fullStories.V2.title, "V2 新结果");
  assert.doesNotMatch(app.elements.storyStatus.textContent, /V2|旧页面|失败/);
});

test("an older variant's failed or cancelled restored task cannot replace the current story or its status", async () => {
  for (const status of ["failed", "cancelled"]) {
    const app = await loadAppUi({ story: true });
    const current = { ...app.fixture.fullStory, selectedVariantId: "V1", title: "当前 V1 剧情" };
    app.state.fullStories.V1 = current;
    app.state.selectedVariantId = "V1";
    app.renderStoryPage();
    const shown = app.elements.fullStory.innerHTML;
    app.setStoryStatus("V1 当前状态", "ready");
    await app.attachRestoredStandaloneTask(task("running", { status, error: { message: "V2 旧任务错误" } }));
    assert.equal(app.state.selectedVariantId, "V1");
    assert.equal(app.state.fullStories.V1, current);
    assert.equal(app.elements.fullStory.innerHTML, shown);
    assert.equal(app.elements.storyStatus.textContent, "V1 当前状态");
  }
});

test("preserving a live Full Story selection does not change initial Run restore selection rules", async () => {
  const app = await loadAppUi();
  const onlyVariants = runFor(app, { selected: null }).latestArtifacts;
  app.restoreRunArtifacts(onlyVariants);
  assert.equal(app.state.selectedVariantId, null);
  app.restoreRunArtifacts(onlyVariants, { selectedVariantId: "V2" });
  assert.equal(app.state.selectedVariantId, "V2");
  app.restoreRunArtifacts(onlyVariants, { selectedVariantId: "missing" });
  assert.equal(app.state.selectedVariantId, null);
  app.restoreRunArtifacts(runFor(app).latestArtifacts);
  assert.equal(app.state.selectedVariantId, "V2");
});
