import test from "node:test";
import assert from "node:assert/strict";
import { loadAppUi } from "./helpers/app-ui-harness.js";

// 导演助手接进页面（2026-10-09）：从真实页面状态取数；执行器调的就是原有按钮背后的函数；
// 卡片核对项变了就作废；对话请求不记进正在进行的那一步的用量；快捷按钮不发请求。

const currentLineage = (artifactId, extra = {}) => ({
  artifactId, status: "current", revision: `${artifactId.replace(/:/gu, "-")}-r1`, contentDigest: "e".repeat(64), dependencies: [], ...extra
});

function recordingFetch(handler = () => null) {
  const requests = [];
  const fetch = async (path, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ path, body });
    const answer = handler(path, body);
    if (answer) return { ok: true, status: 200, json: async () => answer };
    return { ok: false, status: 500, json: async () => ({ ok: false, error: "UI 测试桩：不放行这个请求" }) };
  };
  return { fetch, requests };
}

// 页面恢复完、模型设置弹窗关着、在分场页上。
async function readyApp(options = {}) {
  const app = await loadAppUi(options);
  app.browserWorkspaceForTest.adopt({ id: "ws-test", generation: 1 });
  app.setSourceLoadingForTest(false);
  app.setDirectorAgentStartedForTest(true);
  app.elements.modelSettingsModal.className = "modal-backdrop hidden";
  app.elements.storyPage.className = "story-page";
  app.elements.fixedCharacter.value = "阿岚，社区修理师";
  app.elements.vertical.value = "治愈系日常";
  return app;
}

// 「粘贴完整故事」：拆好了镜头（fullStory:V1），还没有分镜。
async function storySlotApp(options = {}) {
  const app = await readyApp({ story: true, ...options });
  app.state.entryMode = "story";
  app.state.storyMode = "fullStoryText";
  app.state.selectedVariantId = "V1";
  app.state.fullStories = { V1: app.fixture.fullStory };
  app.state.animationPlans = {};
  app.state.output.storySource = { storyMode: "fullStoryText", storyText: "原文" };
  app.state.production.artifacts = { storySource: currentLineage("storySource"), visualGuardrails: currentLineage("visualGuardrails"), "fullStory:V1": currentLineage("fullStory:V1") };
  app.elements.characterArtStyle.value = "二维日系动画";
  return app;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("从真实页面状态取数：参考视频入口的候选、选中的故事、4.0 分镜与旧版分镜都认得出来", async () => {
  const app = await readyApp({ story: true, plan: true });
  app.state.production.artifacts = {
    themeVariants: currentLineage("themeVariants"),
    "fullStory:V2": currentLineage("fullStory:V2"),
    "animationPlan:V2": currentLineage("animationPlan:V2")
  };
  const facts = app.directorAgentFacts();
  assert.equal(facts.entryMode, "video");
  assert.equal(facts.restored, true);
  assert.deepEqual(facts.candidates.map((candidate) => candidate.id), ["V1", "V2", "V3"]);
  assert.equal(facts.chosenVariantId, "V2");
  assert.equal(facts.pipeline.done, true);
  assert.equal(facts.story.exists, true);
  // 夹具里是 4.0 分镜：照常当成分镜读出镜头与角色，没有旧版版本号。
  assert.equal(facts.legacyPlanVersion, "");
  assert.deepEqual(facts.plan.shots.map((shot) => shot.shotId), app.fixture.animationPlan.shotPlan.map((shot) => shot.shotId));
  assert.deepEqual(facts.plan.roles.map((role) => role.name), app.fixture.animationPlan.characterReferencePrompts.map((row) => row.characterName));
  // 镜头视频只剩 Seedance / MiniMax，没选过时兜底 Seedance（2026-10-11 之前兜底是可灵）。
  assert.match(facts.models.video, /^Seedance/u);
  assert.equal(Object.hasOwn(facts.models, "videoSupportsStoryboard"), false);
  assert.equal(JSON.stringify(facts).includes("data:image"), false, "不读计划里的图片数据");

  // 旧版分镜（2.0/3.0，2026-10-11 起不再支持）：不当成分镜，只报实际版本，文案按版本写。
  app.state.animationPlans.V2 = { promptSchemaVersion: "3.0", selectedVariantId: "V2", productionStrategy: { targetAspectRatio: "9:16" },
    shotPlan: [{ shotId: "A01" }], characterReferencePrompts: [{ characterName: "固定主角", referenceImageDataUrl: "data:image/png;base64,AA==" }] };
  const legacy = app.directorAgentFacts();
  assert.equal(legacy.plan, null);
  assert.equal(legacy.legacyPlanVersion, "3.0");
  assert.equal(JSON.stringify(legacy).includes("data:image"), false, "不读旧计划里的图片数据");
  const progress = app.directorAgentProgressNow();
  // 有下一步时 waitingFor 照常为空，按版本写的说明进 notes。
  assert.equal(progress.waitingFor, "");
  assert.deepEqual(progress.notes, ["这是旧版 3.0 分镜，已不再支持（只支持 4.0 自主分镜）。请重新生成分镜。"]);
  assert.equal(progress.next.key, "generateStoryboard:V2");
  assert.equal(progress.next.label, "重新生成分镜");
  app.state.animationPlans.V2 = { ...app.state.animationPlans.V2, promptSchemaVersion: "2.0" };
  assert.match(app.directorAgentProgressNow().notes[0], /^这是旧版 2\.0 分镜/u);
});

test("4.0 分镜：角色先于镜头；没有出过参考图的角色、没有视频的镜头都在清单里", async () => {
  const app = await storySlotApp();
  app.state.animationPlans = { V1: {
    promptSchemaVersion: "4.0",
    productionStrategy: { targetAspectRatio: "16:9", artStyle: "二维日系动画" },
    shotPlan: [{ shotId: "A01", durationSeconds: 10 }, { shotId: "A02", durationSeconds: 6 }],
    characterReferencePrompts: [{ characterName: "阿岚" }, { characterName: "老周", referenceImageAdded: true }]
  } };
  app.state.production.artifacts["animationPlan:V1"] = currentLineage("animationPlan:V1", { mediaNamespace: "media-1" });
  const facts = app.directorAgentFacts();
  assert.deepEqual(facts.plan.roles.map((role) => role.hasImage), [false, true]);
  assert.equal(facts.plan.seconds, 16);
  const progress = app.directorAgentProgressNow();
  assert.equal(progress.next.key, "openCharacterImages:V1:0");
});

test("确认执行：调的就是「生成分镜」按钮背后的同一个函数，请求带当前画风", async () => {
  const { fetch, requests } = recordingFetch();
  const app = await storySlotApp({ fetch });
  const progress = app.directorAgentProgressNow();
  assert.equal(progress.next.key, "generateStoryboard:V1");
  const card = app.directorAgent.showNext(progress);
  await app.confirmDirectorAgentCard(card.id);
  assert.equal(app.directorAgent.card(card.id).card.state, "done");
  assert.equal(app.directorAgent.card(card.id).card.stateText, "已开始生成分镜。");
  await tick();
  const created = requests.find((request) => request.path === "/api/tasks/create");
  assert.ok(created, "发起了分镜任务");
  assert.equal(created.body.kind, "animationPlan");
  assert.equal(created.body.input.artStyle, "二维日系动画");
});

test("点确认之前卡片上的设置变了：卡片作废，不发任何请求，并给出新的建议", async () => {
  const { fetch, requests } = recordingFetch();
  const app = await storySlotApp({ fetch });
  const card = app.directorAgent.showNext(app.directorAgentProgressNow());
  app.elements.characterArtStyle.value = "水彩绘本";
  await app.confirmDirectorAgentCard(card.id);
  assert.equal(app.directorAgent.card(card.id).card.state, "void");
  assert.match(app.directorAgent.card(card.id).card.stateText, /作废/u);
  assert.equal(requests.length, 0);
  const fresh = app.directorAgent.messages.at(-1);
  assert.equal(fresh.card.state, "pending");
  assert.ok(fresh.card.lines.some((line) => line.includes("画风 水彩绘本")));
});

test("「下一步」「现在到哪了」不调用模型；「先不」只改卡片状态", async () => {
  const { fetch, requests } = recordingFetch();
  const app = await storySlotApp({ fetch });
  app.directorAgentQuick("next");
  app.directorAgentQuick("status");
  assert.equal(requests.length, 0);
  const card = app.directorAgent.messages.find((message) => message.card);
  app.dismissDirectorAgentCard(card.id);
  assert.equal(card.card.state, "dismissed");
  assert.match(app.directorAgent.messages.at(-1).text, /现在做到/u);
});

test("打字交给模型：单独请求，不记进正在进行的那一步的用量；回复里的编号出卡片", async () => {
  const { fetch, requests } = recordingFetch((path) => path === "/api/director-agent/turn"
    ? { ok: true, result: { turn: { actionKey: "generateStoryboard:V1", reply: "可以生成分镜了。" }, metadata: {} }, usage: { totalTokens: 1200, calls: 1 } }
    : null);
  const app = await storySlotApp({ fetch });
  // 模型设置里给「导演助手」单独选的模型要随请求发出去（它在模型设置表里登记过，才过得了白名单）。
  app.state.modelOverrides = { directorAgent: { provider: "Qwen", model: "qwen3.7-max" } };
  app.beginStageUsage();
  await app.sendDirectorAgentMessage("下一步做什么");
  const usage = app.endStageUsage();
  assert.ok(!usage || !Number(usage.totalTokens), "对话的花费没有混进正在进行的那一步");
  const sent = requests.find((request) => request.path === "/api/director-agent/turn");
  assert.equal(sent.body.message, "下一步做什么");
  assert.equal(sent.body.progress.nextKey, "generateStoryboard:V1");
  assert.deepEqual(sent.body.modelOverrides, { directorAgent: { provider: "Qwen", model: "qwen3.7-max" } });
  const agent = app.directorAgent.messages.find((message) => message.role === "agent");
  assert.equal(agent.text, "可以生成分镜了。");
  assert.match(agent.meta, /1,200 tokens/u);
  assert.equal(app.directorAgent.messages.at(-1).card.key, "generateStoryboard:V1");
});

test("模型没回答：如实显示原因，不拿确定性答案顶替", async () => {
  const { fetch } = recordingFetch();
  const app = await storySlotApp({ fetch });
  await app.sendDirectorAgentMessage("继续");
  const last = app.directorAgent.messages.at(-1);
  assert.equal(last.role, "error");
  assert.match(last.text, /没有回答/u);
  assert.equal(app.directorAgent.pendingTurn, false);
});

test("开始按钮能不能点：抽出 setupReadiness 之后行为不变，并能说出原因", async () => {
  const app = await readyApp();
  app.state.entryMode = "story";
  app.state.storyMode = "fullStoryText";
  app.elements.storySourceText.value = "";
  app.validateReady();
  assert.equal(app.elements.run.disabled, true);
  app.elements.storySourceText.value = "阿岚在雨里捡到一只小猫。";
  app.validateReady();
  assert.equal(app.elements.run.disabled, false);
  app.elements.vertical.value = "";
  app.validateReady();
  assert.equal(app.elements.run.disabled, true);
  assert.match(app.setupReadiness().reason, /垂直赛道/u);
  app.elements.vertical.value = "治愈系日常";
  app.state.directorTaskId = "task-story";
  app.state.taskSnapshots["task-story"] = { taskId: "task-story", kind: "storyPipeline", status: "running" };
  app.validateReady();
  assert.equal(app.elements.run.disabled, true);

  app.state.entryMode = "video";
  app.state.directorTaskId = "";
  app.state.frames = [];
  app.validateReady();
  assert.equal(app.elements.run.disabled, true);
  assert.equal(app.setupReadiness().reason, "要继续这个 Run，需要重新上传同一个参考视频。");
  app.state.production.runId = "";
  assert.equal(app.setupReadiness().reason, "先上传参考视频。");
  app.state.frames = [{}, {}, {}];
  app.validateReady();
  assert.equal(app.elements.run.disabled, false);
});

test("页面初始化（含读模型设置）完成之前：不观察、不发消息、卡片和快捷按钮都不响应", async () => {
  const { fetch, requests } = recordingFetch();
  const app = await storySlotApp({ fetch });
  app.setDirectorAgentStartedForTest(false);
  assert.equal(app.directorAgentFacts().restored, false);
  assert.deepEqual(app.directorAgentProgressNow().actions, []);
  app.elements.directorAgentInput.value = "下一步";
  await app.submitDirectorAgentInput();
  app.directorAgentQuick("next");
  assert.equal(requests.length, 0);
  assert.equal(app.directorAgent.messages.length, 0);
  app.refreshDirectorAgentNow();
  assert.equal(app.elements.directorAgentSend.disabled, true);
  app.setDirectorAgentStartedForTest(true);
  app.refreshDirectorAgentNow();
  assert.equal(app.elements.directorAgentSend.disabled, false);
  assert.match(app.directorAgent.messages[0].text, /导演助手/u);
});

test("展开与收起只改页面样式，不写任何存储", async () => {
  const writes = [];
  const storage = { getItem: () => null, setItem: (key) => writes.push(key), removeItem() {} };
  const app = await loadAppUi({ storage });
  app.setDirectorAgentOpen(true);
  assert.equal(app.elements.directorAgentPanel.className.includes("hidden"), false);
  assert.ok(app.document.body.className.includes("director-agent-open"));
  assert.equal(app.elements.directorAgentToggle.getAttribute("aria-expanded"), "true");
  app.setDirectorAgentOpen(false);
  assert.ok(app.elements.directorAgentPanel.className.includes("hidden"));
  assert.deepEqual(writes, []);
});
