import test from "node:test";
import assert from "node:assert/strict";
import { taskStatusView, rememberTaskSnapshot, latestTaskForTarget, shotVideoBatchStatusText } from "../public/task-status-ui.js";
import { loadAppUi, uiTask } from "./helpers/app-ui-harness.js";
import { describeProviderError } from "../src/provider-error-codes.js";
import { directorTaskView } from "../public/director-pipeline-ui.js";

test("4.0 分镜逐步显示阶段中文名，尚无字数时明确显示推理中", () => {
  const steps = { storyboardCharacterFacts: "整理角色事实", storyboardDesign: "设计分镜", storyboardReview: "审阅分镜",
    storyboardRevision: "按问题修订", storyboardReviewFinal: "终审复查" };
  for (const [index, [step, label]] of Object.entries(steps).entries()) {
    const task = uiTask("animationPlan", "running", { progress: { step, stepIndex: index + 1, stepMax: 5, streamedChars: 0 } });
    assert.equal(taskStatusView(task).message, `正在生成动画生产包 · 第 ${index + 1}/5 步 ${label} · 推理中…`);
  }
});

test("4.0 分镜正文为零时显示推理计数，沿用模型后缀", () => {
  const task = uiTask("animationPlan", "running", {
    progress: { step: "storyboardDesign", stepIndex: 1, stepMax: 4, streamedChars: 0, reasoningChars: 123 }
  });
  assert.equal(taskStatusView(task, { modelLabel: "fixture-model" }).message,
    "正在生成动画生产包 · fixture-model · 第 1/4 步 设计分镜 · 推理中（已推理 123 字）…");
  task.progress.reasoningChars = 0;
  assert.equal(taskStatusView(task).message, "正在生成动画生产包 · 第 1/4 步 设计分镜 · 推理中（已推理 0 字）…");
});

test("4.0 分镜正文大于零时显示正文计数，不再显示推理计数", () => {
  const task = uiTask("animationPlan", "running", {
    progress: { step: "storyboardReview", stepIndex: 3, stepMax: 5, streamedChars: 42, reasoningChars: 123 }
  });
  assert.equal(taskStatusView(task).message, "正在生成动画生产包 · 第 3/5 步 审阅分镜 · 已接收 42 字…");
});

test("无 step 的旧分镜、3.0、其它 kind 及排队文案逐字不变", () => {
  for (const [kind, label] of [["animationPlan", "动画生产包"], ["fullStory", "完整剧情"]]) {
    for (const streamedChars of [0, 32]) {
      const progress = { streamedChars, reasoningChars: 123,
        ...(kind === "fullStory" ? { step: "storyboardDesign", stepIndex: 1, stepMax: 4 } : {}) };
      assert.equal(taskStatusView(uiTask(kind, "running", { progress }), { modelLabel: "fixture-model" }).message,
        `正在生成${label} · fixture-model${streamedChars ? " · 已接收 32 字" : ""}…`);
    }
  }
  assert.equal(taskStatusView(uiTask("animationPlan", "queued", { progress: { step: "storyboardDesign" } })).message,
    "动画生产包任务正在排队…");
});

function arrearageTask(kind) {
  return uiTask(kind, "failed", { error: { code: "MODEL_HTTP_ERROR", category: "provider", message: "Qwen 请求失败（400）", details: [],
    providerError: describeProviderError({ provider: "Qwen", httpStatus: 400,
      payload: { error: { code: "Arrearage", message: "Arrearage: account overdue" } } }) } });
}

test("后台失败经轮询抛错与刷新渲染都显示欠费原因、指引和供应商原文", async () => {
  for (const kind of ["characterReferenceRefine", "animationPlan", "fullStory"]) {
    const app = await loadAppUi({ story: true, plan: true });
    const task = arrearageTask(kind);
    await assert.rejects(app.waitForDurableTask(task), error => {
      assert.match(error.message, /Qwen 请求失败（400）.*阿里云账户欠费.*阿里云控制台充值.*供应商原文：Arrearage/);
      assert.equal(error.code, "MODEL_HTTP_ERROR");
      assert.equal(error.category, "provider");
      return true;
    });
    app.renderRoute();
    app.renderStoryPage();
    const status = kind === "fullStory" ? app.elements.storyStatus : app.elements.animationStatus;
    assert.match(status.textContent, /阿里云账户欠费.*阿里云控制台充值.*供应商原文：Arrearage/);
  }
  assert.match(directorTaskView(arrearageTask("directorPipeline")).message, /阿里云账户欠费.*供应商原文：Arrearage/);
  assert.match(shotVideoBatchStatusText(arrearageTask("shotVideoBatch")), /阿里云账户欠费.*供应商原文：Arrearage/);
});

test("旧失败任务不带 providerError 时轮询与终态文案逐字不变", async () => {
  const task = uiTask("animationPlan", "failed", { error: { message: "旧错误原文" } });
  const app = await loadAppUi();
  await assert.rejects(app.waitForDurableTask(task), error => error.message === "旧错误原文");
  assert.equal(taskStatusView(task).message, "旧错误原文");
  assert.equal(shotVideoBatchStatusText({ ...task, kind: "shotVideoBatch" }), "旧错误原文");
});

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
