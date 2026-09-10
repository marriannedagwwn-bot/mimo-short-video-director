import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { directorControlView, directorTaskView } from "../public/director-pipeline-ui.js";
import { formatStageUsageSuffix, mergeStageUsage } from "../public/token-usage-format.js";
import { loadAppUi, uiTask } from "./helpers/app-ui-harness.js";

function task(controlState = "running", overrides = {}) {
  return uiTask("directorPipeline", "running", {
    progress: { controlState, currentStage: "creativeBrief", completedStages: 2 }, ...overrides
  });
}
const response = (result) => ({ ok: true, json: async () => ({ ok: true, result }) });
const usage = { calls: 3, reportedCalls: 2, unreportedCalls: 1, usageComplete: false,
  totalTokens: 1234, costKnown: false, costCny: null };

test("director controls are sibling buttons with accessible names and restart disclosure", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const start = html.indexOf('id="directorControls"');
  const group = html.slice(start, html.indexOf("</div>", start));
  assert.equal((group.match(/<button\b/g) || []).length, 3);
  assert.match(group, /id="runWorkflow"[\s\S]*?<\/button>\s*<button[^>]*id="terminateDirector"[\s\S]*?<\/button>\s*<button[^>]*id="pauseDirector"/);
  assert.match(group, /aria-label="终止本次 AI 导演"/);
  assert.match(group, /aria-label="暂停当前阶段"/);
  assert.match(html, /继续会重新执行当前阶段，可能再次计费/);
  assert.doesNotMatch(html, /id="(?:pipelineUsage|releaseActiveTasks)"/);
});

test("creation and settling transitions do not allow premature or duplicate control requests", () => {
  const creating = directorControlView(null, { starting: true });
  assert.equal(creating.visible, true);
  assert.equal(creating.stopDisabled, true);
  assert.equal(creating.pauseDisabled, true);
  assert.equal(directorControlView(task("pausing")).pauseDisabled, true);
  assert.equal(directorControlView(task("pausing")).stopDisabled, false);
  assert.equal(directorControlView(task("terminating")).stopDisabled, true);
  assert.equal(directorControlView(task("terminating")).pauseDisabled, true);
  assert.equal(directorControlView(task("paused")).pauseAction, "resume");
  assert.equal(directorControlView(task("paused"), { pendingAction: "resume" }).pauseDisabled, true);
});

test("a restored pause and repeat output rendering keep resume accessible and completed stages intact", async () => {
  const app = await loadAppUi();
  app.setRunning(true);
  app.updateTaskSnapshot(task("paused", { usage }));
  app.renderCurrentMainOutputs();
  assert.equal(Object.hasOwn(app.elements, "pipelineUsage"), false);
  assert.equal(Object.hasOwn(app.elements, "releaseActiveTasks"), false);
  assert.equal(app.elements.run.disabled, true);
  assert.equal(app.elements.pauseDirector.disabled, false);
  assert.equal(app.elements.pauseDirector.getAttribute("aria-label"), "继续当前阶段");
  assert.equal(app.elements.pauseDirector.getAttribute("title"), "继续当前阶段");
  assert.equal(app.elements.directorStartArrow.classList.contains("hidden"), true);
  assert.equal(app.document.querySelector('[data-stage="analysis"]').className, "done");
  assert.equal(app.document.querySelector('[data-stage="brief"]').className, "paused");
  const paused = app.state.taskSnapshots[app.state.directorTaskId];
  assert.equal(paused.progress.controlState, "paused");
  assert.deepEqual(paused.usage, usage);
});

test("pause keeps a stage which just committed marked completed", async () => {
  const app = await loadAppUi();
  app.updateTaskSnapshot(task("paused", { progress: { controlState: "paused", currentStage: "sourceScriptReconstruction", completedStages: 2 } }));
  assert.equal(app.document.querySelector('[data-stage="script"]').className, "done");
});

test("double clicking sends one scoped pause request and waits for a settled server pause", async () => {
  let resolveControl;
  const calls = [];
  const app = await loadAppUi({ fetch: async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return new Promise((resolve) => { resolveControl = resolve; });
  } });
  app.updateTaskSnapshot(task());
  app.directorArtifactSynchronizer.markRendered(task(), 2);
  const pending = app.controlDirectorPipeline("pause");
  await app.controlDirectorPipeline("pause");
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api\/tasks\/task-directorPipeline\/control$/);
  assert.equal(calls[0].body.projectId, "project");
  assert.equal(calls[0].body.runId, "run");
  assert.equal(calls[0].body.action, "pause");
  assert.equal(app.elements.pauseDirector.disabled, true);
  resolveControl(response(task("pausing", { updatedAt: "2026-09-10T02:00:00Z" })));
  await pending;
  assert.equal(app.elements.pauseDirector.disabled, true);
  assert.equal(app.elements.terminateDirector.disabled, false);
  app.updateTaskSnapshot(task("paused", { updatedAt: "2026-09-10T02:00:01Z" }));
  assert.equal(app.elements.pauseDirector.disabled, false);
  assert.equal(app.elements.pauseDirector.getAttribute("aria-label"), "继续当前阶段");
  // A slow pre-pause poll cannot switch the confirmed pause back to running.
  app.updateTaskSnapshot(task());
  assert.match(app.elements.run.querySelector("span").textContent, /已暂停/);
});

test("resume and terminate use the same task; cancellation retains Run content and confirmed usage", async () => {
  const calls = [];
  const app = await loadAppUi({ fetch: async (_url, options) => {
    const { action } = JSON.parse(options.body);
    calls.push(action);
    return response(action === "resume" ? task("running", { updatedAt: "2026-09-10T02:00:00Z", usage })
      : task("terminating", { status: "cancelled", updatedAt: "2026-09-10T02:00:01Z", usage }));
  } });
  const output = app.state.output;
  app.updateTaskSnapshot(task("paused"));
  app.directorArtifactSynchronizer.markRendered(task(), 2);
  await app.controlDirectorPipeline("resume");
  assert.equal(app.elements.pauseDirector.getAttribute("aria-label"), "暂停当前阶段");
  await app.controlDirectorPipeline("terminate");
  assert.deepEqual(calls, ["resume", "terminate"]);
  assert.equal(app.state.production.runId, "run");
  assert.equal(app.state.output, output);
  assert.equal(app.elements.terminateDirector.classList.contains("hidden"), true);
  const cancelled = app.state.taskSnapshots[app.state.directorTaskId];
  assert.equal(cancelled.status, "cancelled");
  assert.deepEqual(cancelled.usage, usage);
  assert.equal(app.document.querySelector('[data-stage="brief"]').className, "stopped");
  assert.equal(app.document.querySelector('[data-stage="analysis"]').className, "done");
  assert.equal(app.document.querySelector('[data-stage="script"]').className, "done");
  app.renderDirectorTaskError({ task: cancelled, message: "cancelled" }, "失败");
  assert.equal(app.elements.error.textContent, "");
  app.renderCurrentMainOutputs();
  assert.equal(app.state.taskSnapshots[app.state.directorTaskId].status, "cancelled");
  assert.deepEqual(app.state.taskSnapshots[app.state.directorTaskId].usage, usage);
  assert.equal(app.document.querySelector('[data-stage="brief"]').className, "stopped");
});

test("control failure unlocks retry without falsely switching paused state", async () => {
  const app = await loadAppUi({ fetch: async () => { throw new Error("控制连接暂时失败"); } });
  app.updateTaskSnapshot(task("paused"));
  await app.controlDirectorPipeline("resume");
  assert.equal(app.elements.pauseDirector.getAttribute("aria-label"), "继续当前阶段");
  assert.equal(app.elements.pauseDirector.disabled, false);
  assert.equal(app.state.directorControlRequest, null);
  assert.match(app.elements.error.textContent, /控制连接暂时失败/);
});

test("a late control response cannot overwrite a replacement workspace or reset its controls", async () => {
  let resolveControl;
  const app = await loadAppUi({ fetch: async () => new Promise((resolve) => { resolveControl = resolve; }) });
  app.updateTaskSnapshot(task());
  const pending = app.controlDirectorPipeline("pause");
  app.browserWorkspace.beginChange();
  app.resetDirectorClientState();
  app.setRunning(false);
  app.elements.error.textContent = "新工作区";
  resolveControl(response(task("paused")));
  await pending;
  assert.equal(app.state.directorTaskId, "");
  assert.equal(Object.keys(app.state.taskSnapshots).length, 0);
  assert.equal(app.elements.directorControls.classList.contains("active"), false);
  assert.equal(app.elements.error.textContent, "新工作区");
});

for (const status of ["completed", "failed", "interrupted", "cancelled"]) {
  test(`actual Run restore preserves ${status} and partial usage without polling terminal work`, async () => {
    const restored = task("running", { status, usage });
    const urls = [];
    const app = await loadAppUi({ fetch: async (url) => {
      urls.push(url);
      if (url === "/api/production/run/load") return response({ projectId: "project", runId: "run", latestArtifacts: {} });
      if (url.startsWith("/api/tasks?")) return { ok: true, json: async () => ({ ok: true, tasks: [restored] }) };
      throw new Error(`unexpected ${url}`);
    } });
    assert.equal(await app.restoreActiveProductionRun({ projectId: "project", runId: "run" }), true);
    assert.equal(urls.length, 2);
    const snapshot = app.state.taskSnapshots[app.state.directorTaskId];
    assert.equal(snapshot.status, status);
    assert.deepEqual(snapshot.usage, usage);
    assert.equal(app.elements.directorControls.classList.contains("active"), false);
  });
}

test("actual paused Run restore attaches existing task without creating or resuming it", async () => {
  const urls = [];
  const waits = [];
  const restored = task("paused", { progress: { controlState: "paused", currentStage: "referenceAnalysis", completedStages: 0 }, usage });
  const app = await loadAppUi({ windowSetTimeout: (callback) => { waits.push(callback); }, fetch: async (url) => {
    urls.push(url);
    if (url === "/api/production/run/load") return response({ projectId: "project", runId: "run", latestArtifacts: {} });
    if (url.startsWith("/api/tasks?")) return { ok: true, json: async () => ({ ok: true, tasks: [restored] }) };
    throw new Error(`unexpected ${url}`);
  } });
  assert.equal(await app.restoreActiveProductionRun({ projectId: "project", runId: "run" }), true);
  await new Promise(setImmediate);
  assert.equal(urls.length, 2);
  assert.equal(waits.length, 1);
  assert.equal(app.state.running, true);
  assert.equal(app.elements.pauseDirector.getAttribute("aria-label"), "继续当前阶段");
  assert.equal(app.elements.pauseDirector.disabled, false);
  app.browserWorkspace.beginChange();
  waits[0]();
  await new Promise(setImmediate);
});

test("unknown-only usage remains visible and never implies zero cost or a full token total", () => {
  const unknown = { ...usage, reportedCalls: 0, unreportedCalls: 3, totalTokens: 0, costKnown: true, costCny: 0 };
  assert.equal(formatStageUsageSuffix(unknown), " · 3 次请求未返回用量");
  assert.match(directorTaskView(task("paused", { usage: unknown })).message, /3 次请求未返回用量/);
  assert.doesNotMatch(formatStageUsageSuffix(unknown), /0 tokens|¥|本次消耗/);
  const merged = mergeStageUsage([unknown, { calls: 1, totalTokens: 12, costKnown: true, costCny: 0.01 }]);
  assert.equal(merged.reportedCalls, 1);
  assert.equal(merged.unreportedCalls, 3);
  assert.equal(merged.usageComplete, false);
  assert.equal(merged.costKnown, false);
  assert.equal(formatStageUsageSuffix(merged), " · 已确认消耗 12 tokens · 3 次请求未返回用量");
});
