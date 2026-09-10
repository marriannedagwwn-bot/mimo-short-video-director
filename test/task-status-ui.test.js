import test from "node:test";
import assert from "node:assert/strict";
import { taskStatusView, rememberTaskSnapshot, latestTaskForTarget, shotVideoBatchStatusText } from "../public/task-status-ui.js";
import { loadAppUi, uiTask } from "./helpers/app-ui-harness.js";

for (const existing of [false, true]) for (const status of ["queued", "running"]) {
  test(`Full Story refresh and repeat render preserve ${status}; existing story=${existing}`, async () => {
    const app = await loadAppUi({ story: existing });
    const task = uiTask("fullStory", status, { progress: { streamedChars: 127 } });
    app.updateTaskSnapshot(task, { render: false });
    app.markRestoredTaskRunning(task);
    app.renderRoute();
    app.renderStoryPage();
    assert.equal(app.elements.storyGenerate.disabled, true);
    assert.match(app.elements.storyGenerate.querySelector("span").textContent, status === "queued" ? /排队/ : /生成中/);
    assert.match(app.elements.storyStatus.textContent, status === "queued" ? /正在排队/ : /正在生成完整剧情.*127 字/);
    assert.equal(app.elements.storyStatus.className, "story-status active");
  });
}

for (const kind of ["animationPlan", "animationPromptRewrite", "characterReferenceRefine"]) {
  test(`${kind} restores the actual operation above an already generated Plan`, async () => {
    const app = await loadAppUi({ story: true, plan: true });
    const task = uiTask(kind);
    app.updateTaskSnapshot(task, { render: false });
    app.markRestoredTaskRunning(task);
    app.renderRoute();
    assert.equal(app.elements.animationGenerate.disabled, true);
    assert.equal(app.elements.animationStatus.textContent, taskStatusView(task, { modelLabel: "mimo-v2.5" }).message);
    assert.equal(app.elements.animationStatus.className, "story-status active");
  });
}

test("latest target failure survives route rendering and another variant is not mislabeled", async () => {
  const app = await loadAppUi();
  app.updateTaskSnapshot(uiTask("fullStory", "interrupted", { error: { message: "服务重启，请重新提交" } }));
  app.renderStoryPage();
  assert.match(app.elements.storyStatus.textContent, /服务重启，请重新提交/);
  assert.equal(app.elements.storyGenerate.disabled, false);
  app.state.selectedVariantId = "V1";
  app.renderStoryPage();
  assert.equal(app.elements.storyStatus.textContent, "准备生成完整剧情。");
});

test("active task for another variant displays its target and cannot be submitted twice", async () => {
  const app = await loadAppUi();
  app.updateTaskSnapshot(uiTask("fullStory", "queued", { targetArtifactIds: ["fullStory:V1"] }));
  app.renderStoryPage();
  assert.match(app.elements.storyStatus.textContent, /^V1 · .*排队/);
  assert.equal(app.elements.storyGenerate.disabled, true);
});

for (const kind of ["characterReferenceImages", "shotFrameImage", "shotVideo"]) {
  test(`${kind} dialog opening keeps restored queued state despite missing browser-only input`, async () => {
    const app = await loadAppUi({ story: true, plan: true });
    app.updateTaskSnapshot(uiTask(kind, "queued"), { render: false });
    app.markRestoredTaskRunning(uiTask(kind, "queued"));
    if (kind === "characterReferenceImages") app.openCharacterImageGenerator();
    else if (kind === "shotFrameImage") await app.openShotFrameImageGenerator("A01", "start");
    else await app.openShotVideoGenerator("A01");
    const [button, status] = kind === "characterReferenceImages" ? [app.elements.generateCharacterImages, app.elements.characterImageStatus]
      : kind === "shotFrameImage" ? [app.elements.confirmGenerateShotFrameImage, app.elements.shotFrameImageStatus]
        : [app.elements.confirmGenerateShotVideo, app.elements.shotVideoStatus];
    assert.equal(button.disabled, true);
    assert.match(status.textContent, /排队/);
    assert.equal(status.className, "story-status active");
  });
}

test("active batch ownership blocks duplicate single-shot generation even after its child completes", async () => {
  const app = await loadAppUi({ story: true, plan: true });
  app.updateTaskSnapshot(uiTask("shotVideo", "completed"), { render: false });
  app.updateTaskSnapshot(uiTask("shotVideoBatch", "running", { progress: { controlState: "paused" } }), { render: false });
  await app.openShotVideoGenerator("A01");
  assert.equal(app.elements.confirmGenerateShotVideo.disabled, true);
  assert.match(app.elements.shotVideoStatus.textContent, /属于批量任务.*已暂停/);
  assert.equal(app.elements.confirmGenerateShotVideo.querySelector("span").textContent, "批量任务已暂停");
});

test("reopening character images keeps the task's frozen count and reports returned progress", async () => {
  const app = await loadAppUi({ story: true, plan: true });
  const task = uiTask("characterReferenceImages", "running", { progress: { expectedCount: 4, readyCount: 1 } });
  app.elements.characterImageCount.value = "1";
  app.updateTaskSnapshot(task, { render: false });
  app.markRestoredTaskRunning(task);
  app.openCharacterImageGenerator();
  assert.equal(app.elements.characterImageCount.value, "4");
  assert.match(app.elements.characterImageStatus.textContent, /1\/4 张/);
});

test("a stopped batch unlocks an open video dialog while keeping missing-reference validation", async () => {
  const app = await loadAppUi({ story: true, plan: true });
  app.updateTaskSnapshot(uiTask("shotVideoBatch", "running", { progress: { controlState: "paused" } }), { render: false });
  await app.openShotVideoGenerator("A01");
  app.updateTaskSnapshot(uiTask("shotVideoBatch", "interrupted", { error: { message: "批量任务因服务重启中断" } }));
  await app.updateShotVideoGeneratorPreview();
  assert.equal(app.elements.closeShotVideoModal.disabled, false);
  assert.equal(app.elements.shotVideoCount.disabled, false);
  assert.equal(app.elements.confirmGenerateShotVideo.disabled, true);
  assert.match(app.elements.shotVideoStatus.textContent, /批量任务因服务重启中断/);
});

test("director artifact re-render retains the active stage and standalone variants progress", async () => {
  const app = await loadAppUi();
  app.updateTaskSnapshot(uiTask("directorPipeline", "running", { progress: { currentStage: "themeVariants", completedStages: 4 } }));
  app.renderCurrentMainOutputs();
  assert.equal(app.document.querySelector('[data-stage="variants"]').className, "active");
  const director = app.state.taskSnapshots[app.state.directorTaskId];
  assert.equal(director.status, "running");
  assert.equal(director.progress.completedStages, 4);
  const variants = uiTask("variants", "queued", { createdAt: "2026-09-09T02:00:00Z" });
  app.updateTaskSnapshot(variants);
  assert.equal(app.state.taskSnapshots[variants.taskId].status, "queued");
  assert.equal(app.document.querySelector('[data-stage="variants"]').className, "active");
});

test("out-of-order polling never revives a terminal task; selection is exact and newest", () => {
  const snapshots = {};
  const failed = uiTask("fullStory", "failed");
  rememberTaskSnapshot(snapshots, failed);
  assert.equal(rememberTaskSnapshot(snapshots, { ...failed, status: "running", updatedAt: "2026-09-09T02:00:00Z" }), false);
  rememberTaskSnapshot(snapshots, uiTask("fullStory", "queued", { taskId: "new", createdAt: "2026-09-09T03:00:00Z" }));
  assert.equal(latestTaskForTarget(snapshots, { artifactId: "fullStory:V2" }).taskId, "new");
  assert.equal(latestTaskForTarget(snapshots, { artifactId: "fullStory:V1" }), null);
});

test("media card task overlay survives a Run artifact reload and repeat Plan render", async () => {
  const app = await loadAppUi({ story: true, plan: true });
  app.updateTaskSnapshot(uiTask("shotVideo", "running"));
  app.state.shotVideoResults = {};
  app.renderAnimationPlan(app.fixture.animationPlan);
  assert.equal(app.shotVideoStateItem("A01").status, "running");
  assert.match(app.elements.animationPlan.innerHTML, /正在生成镜头视频/);
});

test("failure from an old Plan revision cannot label media in the current Plan", async () => {
  const app = await loadAppUi({ story: true, plan: true });
  app.state.production.artifacts["animationPlan:V2"] = { status: "current", revision: "new", contentDigest: "new-digest" };
  app.updateTaskSnapshot(uiTask("shotVideo", "failed", { frozenDependencies: [{ artifactId: "animationPlan:V2", revision: "old", contentDigest: "old-digest" }] }), { render: false });
  assert.equal(app.shotVideoStateItem("A01"), null);
  app.renderAnimationPlan(app.fixture.animationPlan);
  assert.equal(app.shotVideoStateItem("A01"), null);
});

test("completed task is shown only for its exact current result revision", async () => {
  const app = await loadAppUi({ story: true });
  const ref = { artifactId: "fullStory:V2", revision: "r1", contentDigest: "d1" };
  app.state.production.artifacts[ref.artifactId] = { ...ref, status: "current" };
  app.updateTaskSnapshot(uiTask("fullStory", "completed", { resultArtifactRefs: [ref] }));
  app.renderStoryPage();
  assert.match(app.elements.storyStatus.textContent, /任务已完成/);
  app.state.production.artifacts[ref.artifactId].revision = "r2";
  app.renderStoryPage();
  assert.doesNotMatch(app.elements.storyStatus.textContent, /任务已完成/);
});

for (const status of ["completed", "failed", "conflicted", "interrupted", "abandoned", "cancelled"]) {
  test(`${status} releases busy presentation and batch never falls back to preparing another shot`, () => {
    assert.equal(taskStatusView(uiTask("fullStory", status)).busy, false);
    assert.doesNotMatch(shotVideoBatchStatusText(uiTask("shotVideoBatch", status)), /准备下一镜|正在生成|等待服务器/);
  });
}
