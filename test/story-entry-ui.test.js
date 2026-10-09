import test from "node:test";
import assert from "node:assert/strict";
import { loadAppUi } from "./helpers/app-ui-harness.js";
import { mockStoryEntryCandidates } from "../src/mock.js";
import { deriveStoryCandidateProjections } from "../src/validation.js";
import { storyPipelineTaskView } from "../public/director-pipeline-ui.js";

const plain = (value) => JSON.parse(JSON.stringify(value));
const profile = { fixedCharacter: "小满，八岁女孩", vertical: "治愈日常", constraints: "" };
const storySource = { schemaVersion: "story_source/1.0", storyMode: "fullStoryText", storyText: "雨天，小满捡到一只小猫。小满说：“别怕。”" };
const current = (content, artifactId) => ({ lineage: { artifactId, status: "current", revision: `${artifactId}-r1`, contentDigest: "d".repeat(64), dependencies: [] }, content });

function storyThemeVariants() {
  const [candidate] = mockStoryEntryCandidates({ creatorProfile: profile }).variants;
  return deriveStoryCandidateProjections({ variants: [{ id: "V1", ...candidate }] });
}

function recordingFetch(responses = {}) {
  const requests = [];
  const fetch = async (path, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ path, body });
    const result = typeof responses[path] === "function" ? responses[path](body) : responses[path];
    if (result === undefined) return { ok: false, status: 500, json: async () => ({ ok: false, error: "UI 测试桩：不放行这个请求" }) };
    return { ok: true, status: 200, json: async () => ({ ok: true, result }) };
  };
  return { fetch, requests };
}

test("剧情 Run 恢复：入口切到剧情、原文回填，候选卡没有换一批、对照原片体检和相似风险", async () => {
  const app = await loadAppUi();
  app.restoreRunMetadata({ entryMode: "story", storyMode: "fullStoryText", creatorProfile: profile });
  assert.equal(app.isStoryEntryMode(), true);
  assert.ok(app.document.body.className.includes("story-entry-mode"));
  const themeVariants = storyThemeVariants();
  app.restoreRunArtifacts({
    storySource: current(storySource, "storySource"),
    themeVariants: current(themeVariants, "themeVariants"),
    "variant:V1": current(themeVariants.variants[0], "variant:V1")
  });
  assert.equal(app.elements.storySourceText.value, storySource.storyText);
  assert.deepEqual(plain(app.state.output.storySource), storySource);
  assert.equal(app.state.selectedVariantId, "V1");
  const card = app.elements.variants.innerHTML;
  assert.ok(card.includes("按原文整理的故事"));
  assert.equal(card.includes("data-regenerate-variants"), false);
  assert.equal(card.includes("对照原片体检候选"), false);
  assert.equal(card.includes("相似风险"), false);
  // 参考视频 Run 恢复时回到视频入口。
  app.restoreRunMetadata({ creatorProfile: profile });
  assert.equal(app.isStoryEntryMode(), false);
  assert.equal(app.document.body.className.includes("story-entry-mode"), false);
});

test("剧情入口的请求体不带参考视频那三份上游（整个键都不出现）", async () => {
  const app = await loadAppUi();
  app.state.output.referenceAnalysis = { format: "视频" };
  app.state.output.sourceScriptReconstruction = { scenes: [] };
  app.state.output.creativeBrief = { storyEngine: {} };
  assert.deepEqual(Object.keys(app.videoUpstreamCopies()).sort(), ["creativeBrief", "referenceAnalysis", "sourceScriptReconstruction"]);
  app.state.entryMode = "story";
  assert.deepEqual(plain(app.videoUpstreamCopies()), {});
  const context = app.globalCharacterBoundaryContext();
  for (const key of ["referenceAnalysis", "sourceScriptReconstruction", "creativeBrief"]) {
    assert.equal(Object.hasOwn(context, key), false, key);
  }
});

test("剧情入口展开完整剧情：不请求展开前体检，不由页面提交选中记录，请求体不带原片上游", async () => {
  const { fetch, requests } = recordingFetch();
  const app = await loadAppUi({ fetch });
  app.state.entryMode = "story";
  app.state.output.referenceAnalysis = { format: "残留的视频上游" };
  app.state.production.artifacts["variant:V2"] = { artifactId: "variant:V2", status: "current", revision: "variant-V2-r1", contentDigest: "e".repeat(64), dependencies: [] };
  await app.startFullStory({ force: true });
  assert.equal(requests.some((request) => request.path === "/api/full-story-precheck"), false);
  assert.equal(requests.some((request) => request.path === "/api/production/artifact/commit"), false);
  const created = requests.find((request) => request.path === "/api/tasks/create");
  assert.ok(created, "直接创建完整剧情任务");
  assert.equal(created.body.kind, "fullStory");
  for (const key of ["referenceAnalysis", "sourceScriptReconstruction", "creativeBrief"]) {
    assert.equal(Object.hasOwn(created.body.input, key), false, key);
  }
  assert.equal(created.body.input.candidateBinding.revision, "variant-V2-r1");
});

test("剧情入口：选中记录没签发时，页面要求先完成剧情准备，而不是自己提交", async () => {
  const app = await loadAppUi();
  app.state.entryMode = "story";
  await assert.rejects(() => app.ensureSelectedVariantArtifact({ id: "V1" }), /继续剧情准备/);
});

test("剧情入口禁用生产包导出，时长选项写明没有原片时按 60 秒", async () => {
  const app = await loadAppUi({ story: true });
  app.updateStoryExportActions();
  assert.equal(app.elements.exportStoryPackage.disabled, false, "参考视频 Run 有剧情时可以导出");
  app.state.entryMode = "story";
  app.updateStoryExportActions();
  assert.equal(app.elements.exportStoryPackage.disabled, true);
  assert.equal(app.elements.exportStoryTestPackage.disabled, true);
  app.renderStoryDurationOptions();
  assert.ok(app.elements.storyDurationTarget.innerHTML.includes("剧情入口没有原片，按 60 秒"));
});

test("剧情准备进度：两步阶段随任务进度更新，按钮文字跟着入口变化", async () => {
  const app = await loadAppUi();
  app.state.entryMode = "story";
  const running = { taskId: "task-story", kind: "storyPipeline", status: "running", progress: { completedStages: 1, totalStages: 2, currentStage: "themeVariants" }, targetArtifactIds: [] };
  app.renderStoryPipelineTaskStatus(running);
  assert.equal(app.document.querySelector('[data-stage="guardrails"]').className, "done");
  assert.equal(app.document.querySelector('[data-stage="variants"]').className, "active");
  assert.equal(app.storyEntryRunLabel(running), "剧情准备中…");
  assert.equal(storyPipelineTaskView(running).message, "剧情准备中 1/2");
  const completed = { ...running, status: "completed", progress: { completedStages: 2, totalStages: 2, reusedStages: 1 } };
  app.renderStoryPipelineTaskStatus(completed);
  assert.equal(app.document.querySelector('[data-stage="variants"]').className, "done");
  assert.ok(storyPipelineTaskView(completed).message.startsWith("剧情准备完成 · 复用 1 个已有步骤"));
});

// 作废走的是真实的页面工作区客户端：先查有没有进行中的任务，再请求服务端清掉当前 Run。
function workspaceResetFetch() {
  const requests = [];
  const replies = {
    "/api/browser-workspace/start": { workspace: { id: "ws", generation: 1 } },
    "/api/browser-workspace/ws/reset-run": { workspace: { id: "ws", generation: 2 } }
  };
  const fetch = async (path) => {
    requests.push(path);
    if (path.startsWith("/api/tasks?")) return { ok: true, status: 200, json: async () => ({ ok: true, tasks: [] }) };
    if (replies[path]) return { ok: true, status: 200, json: async () => ({ ok: true, result: replies[path] }) };
    return { ok: false, status: 500, json: async () => ({ ok: false, error: "UI 测试桩：不放行这个请求" }) };
  };
  return { fetch, requests, resets: () => requests.filter((path) => path.endsWith("/reset-run")).length };
}

async function storyRunPage(fetch) {
  const app = await loadAppUi({ fetch });
  app.state.entryMode = "story";
  app.state.output.storySource = storySource;
  app.state.characterBoundaryProfile = profile;
  app.elements.storySourceText.value = storySource.storyText;
  app.elements.fixedCharacter.value = profile.fixedCharacter;
  app.elements.vertical.value = profile.vertical;
  app.elements.constraints.value = profile.constraints;
  return app;
}

test("改故事原文、切换剧情模式或改固定角色设定，都作废当前剧情 Run；只差首尾空白不算修改", async () => {
  let stub = workspaceResetFetch();
  let app = await storyRunPage(stub.fetch);
  app.elements.storySourceText.value = `  ${storySource.storyText}\n`;
  await app.handleStorySourceInput();
  assert.equal(stub.requests.length, 0, "规范化后与开 Run 时的原文相同");
  app.elements.storySourceText.value = `${storySource.storyText}喵。`;
  await app.handleStorySourceInput();
  assert.equal(stub.resets(), 1);
  assert.match(app.elements.error.textContent, /故事原文或剧情模式已修改/);
  assert.equal(app.state.output.storySource, undefined, "页面不再持有旧 Run 的原文");
  assert.ok(!app.state.production.runId);

  stub = workspaceResetFetch();
  app = await storyRunPage(stub.fetch);
  await app.handleStoryModeChange("characterOnly");
  assert.equal(stub.resets(), 1);

  stub = workspaceResetFetch();
  app = await storyRunPage(stub.fetch);
  app.elements.vertical.value = "科普";
  await app.handleProfileInput();
  assert.equal(stub.resets(), 1);
  assert.match(app.elements.error.textContent, /固定角色或创作设定已修改/);
});

test("台词核对：只在粘贴原文的剧情 Run 上请求，列出原文里找不到的台词", async () => {
  const report = { applicable: true, checked: 3, missing: [{ artifact: "fullStory", location: "S2", speaker: "小满", text: "你饿不饿？" }] };
  const { fetch, requests } = recordingFetch({ "/api/production/story-entry/dialogue-check": report });
  const app = await loadAppUi({ story: true, fetch });
  await app.refreshStoryDialogueCheck();
  assert.equal(requests.length, 0, "参考视频 Run 不请求台词核对");
  app.state.entryMode = "story";
  app.state.output.storySource = storySource;
  await app.refreshStoryDialogueCheck();
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].body.variantId, "V2");
  assert.ok(app.elements.storyDialogueCheck.innerHTML.includes("1 句在原文里找不到"));
  assert.ok(app.elements.storyDialogueCheck.innerHTML.includes("你饿不饿？"));
  assert.ok(app.elements.storyDialogueCheck.className.includes("warn"));
});
