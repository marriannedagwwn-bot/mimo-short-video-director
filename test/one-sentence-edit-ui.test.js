import test from "node:test";
import assert from "node:assert/strict";
import { loadAppUi } from "./helpers/app-ui-harness.js";

// 一句话修改接进页面（2026-10-11）：导演助手的卡片带着用户的原话，确认后请求修改稿；
// 修改稿显示在被改的东西所在的位置；采纳由服务端签发、页面读回 Run；修改稿只在内存里。

const plain = (value) => JSON.parse(JSON.stringify(value));
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const lineage = (artifactId, revision = `${artifactId.replace(/:/gu, "-")}-r1`) => ({
  artifactId, status: "current", revision, contentDigest: "e".repeat(64), dependencies: []
});

function memoryStorage() {
  const map = new Map();
  return { map, getItem: (key) => (map.has(key) ? map.get(key) : null), setItem: (key, value) => { map.set(key, String(value)); }, removeItem: (key) => { map.delete(key); } };
}

// 网络桩：按路径给回复；回复可以是函数（拿到请求体再决定），也可以是一个 Promise（测试自己决定何时放行）。
function stubFetch(routes = {}) {
  const requests = [];
  const fetch = async (path, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ path, body });
    const route = routes[path];
    const answer = typeof route === "function" ? await route(body) : await route;
    if (!answer) return { ok: false, status: 500, json: async () => ({ ok: false, error: "UI 测试桩：不放行这个请求" }) };
    return { ok: answer.status ? answer.status < 400 : true, status: answer.status || 200, json: async () => answer.json || answer };
  };
  return { fetch, requests };
}

const DRAFT = Object.freeze({
  schemaVersion: "one-sentence-edit/1.0", target: "story", decision: "edit",
  patches: [{ sceneId: "S2", field: "visibleAction", find: "天气", replace: "大雨" }],
  note: "把天气改成大雨。", changes: [{ label: "S2 · 动作", sceneId: "S2", field: "visibleAction", before: "天气很糟", after: "大雨很糟" }],
  resultDigest: "a".repeat(64),
  metadata: { oneSentenceEdit: { provider: "MiMo", model: "mimo-v2.6-pro", providerCalls: 1, rejections: [] } },
  artifactId: "fullStory:V2", variantId: "V2", baseRevision: "fullStory-V2-r1",
  invalidation: { artifactIds: ["animationPlan:V2", "shotVideo:V2:A01", "shotVideoPrompt:V2:A01"],
    counts: { animationPlan: 1, shotVideoPrompt: 1, shotVideo: 1, characterImages: 0, other: 0 }, roleImagesLost: 1, roleImagesKept: 0 }
});

// 参考视频 Run：选中 V2，剧情是 1.1，有一份分镜、一条提示词、一条视频，一个角色已设人物参考图。
async function videoRunApp(options = {}) {
  const app = await loadAppUi({ story: true, plan: true, ...options });
  app.browserWorkspaceForTest.adopt({ id: "ws-test", generation: 1 });
  app.setSourceLoadingForTest(false);
  app.setDirectorAgentStartedForTest(true);
  app.elements.modelSettingsModal.className = "modal-backdrop hidden";
  app.elements.storyPage.className = "story-page";
  app.elements.fixedCharacter.value = "阿岚，社区修理师";
  app.elements.vertical.value = "治愈系日常";
  app.state.fullStories.V2 = { ...app.fixture.fullStory, schemaVersion: "full_story/1.1" };
  app.state.animationPlans.V2.characterReferencePrompts[0].referenceImageDataUrl = "data:image/png;base64,AAAA";
  app.state.production.artifacts = {
    themeVariants: lineage("themeVariants"),
    "variant:V2": lineage("variant:V2"),
    "fullStory:V2": lineage("fullStory:V2"),
    "animationPlan:V2": lineage("animationPlan:V2"),
    "shotVideoPrompt:V2:A01": lineage("shotVideoPrompt:V2:A01"),
    "shotVideo:V2:A01": lineage("shotVideo:V2:A01"),
    "shotVideo:V2:A02": { ...lineage("shotVideo:V2:A02"), status: "stale" }
  };
  return app;
}

const editStory = { id: "editStory", key: "editStory:V2", params: ["V2"] };

test("页面事实：剧情能不能改、采纳后会作废几样（只数当前版本），都从页面状态取；旧格式剧情不能改", async () => {
  const app = await videoRunApp();
  const edit = app.directorAgentFacts().edit;
  assert.equal(edit.storyEditable, true);
  assert.deepEqual(plain(edit.storyInvalidation), { counts: { animationPlan: 1, shotVideoPrompt: 1, shotVideo: 1, characterImages: 0 }, roleImagesLost: 1 });
  assert.deepEqual(plain(edit.storyboardInvalidation), { counts: { shotVideoPrompt: 1, shotVideo: 1, characterImages: 0 }, roleImagesKept: 1 });
  assert.equal(edit.pending, null);
  app.state.fullStories.V2 = app.fixture.fullStory;
  assert.equal(app.directorAgentFacts().edit.storyEditable, false, "旧格式（带 beatSheet 的）剧情不能用一句话改");
});

test("确认「按你的话修改剧情」：请求只带坐标、对象、基准版本与原话（参考视频 Run 加固定角色设定）；写稿期间导演助手说在忙；修改稿显示在剧情上方", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const network = stubFetch({ "/api/one-sentence-edit/draft": gate.then(() => ({ ok: true, result: DRAFT, usage: { calls: 1, totalTokens: 120 } })) });
  const app = await videoRunApp({ fetch: network.fetch });
  const outcome = app.executeDirectorAgentAction(editStory, { instruction: "第二场改成下大雨" });
  assert.equal(outcome.started, true);
  assert.match(outcome.text, /写好后显示在分场页上剧情的上方/u);
  const draftRequest = network.requests.find((request) => request.path === "/api/one-sentence-edit/draft");
  assert.deepEqual(Object.keys(draftRequest.body).sort(), ["baseRevision", "creatorProfile", "instruction", "projectId", "runId", "target", "variantId"]);
  assert.deepEqual([draftRequest.body.target, draftRequest.body.variantId, draftRequest.body.baseRevision, draftRequest.body.instruction],
    ["story", "V2", "fullStory-V2-r1", "第二场改成下大雨"]);
  assert.match(app.directorAgentFacts().busyText, /正在按你的话写剧情的修改稿/u);
  assert.deepEqual(app.directorAgentProgressNow().actions, [], "写稿期间不提别的动作");
  assert.match(app.elements.storyEditPreview.innerHTML, /正在按你的话写剧情的修改稿/u);
  // 写稿期间再点一张修改卡：不开第二份。
  assert.equal(app.executeDirectorAgentAction(editStory, { instruction: "再改一次" }).started, false);

  release();
  await tick(); await tick();
  assert.equal(app.oneSentenceEditEventForTest().type, "ready");
  const html = app.elements.storyEditPreview.innerHTML;
  assert.equal(app.elements.storyEditPreview.classList.contains("hidden"), false);
  assert.match(html, /剧情的修改稿（还没有生效）/u);
  assert.match(html, /你说的：「第二场改成下大雨」/u);
  assert.match(html, /S2 · 动作/u);
  assert.match(html, /采纳后作废：分镜、1 张已设为人物参考图的图（存在分镜里）、1 条单镜提示词、1 条镜头视频。/u);
  assert.match(html, /data-one-sentence-action="adopt"/u);
  const progress = app.directorAgentProgressNow();
  assert.equal(progress.waitingFor, "剧情的修改稿在分场页上剧情的上方，等你采纳或放弃。");
});

test("采纳：会作废东西时先问，问的话写明作废几样；不同意就什么都不发；同意后服务端签发，页面从服务端读回 Run", async () => {
  const confirms = [];
  let agree = false;
  const network = stubFetch({
    "/api/one-sentence-edit/draft": { ok: true, result: DRAFT },
    "/api/production/one-sentence-edit/adopt": { ok: true, result: { target: "story", artifactId: "fullStory:V2", staleArtifactIds: DRAFT.invalidation.artifactIds } },
    "/api/production/run/load": { ok: true, result: { projectId: "project", runId: "run", latestArtifacts: {
      "fullStory:V2": { lineage: { ...lineage("fullStory:V2", "fullStory-V2-r2"), createdAt: "2026-10-11T01:00:00Z" }, content: { ...DRAFT, schemaVersion: "full_story/1.1", sceneScript: [] } }
    } } }
  });
  const app = await videoRunApp({ fetch: network.fetch, confirm: (text) => { confirms.push(text); return agree; } });
  app.executeDirectorAgentAction(editStory, { instruction: "第二场改成下大雨" });
  await tick(); await tick();
  await app.adoptOneSentenceEdit();
  assert.equal(confirms.length, 1);
  assert.match(confirms[0], /采纳会签发新的剧情版本。\n采纳后作废：分镜、1 张已设为人物参考图的图（存在分镜里）、1 条单镜提示词、1 条镜头视频。\n要重新生成分镜。/u);
  assert.equal(network.requests.some((request) => request.path === "/api/production/one-sentence-edit/adopt"), false, "不同意就不发");
  assert.equal(app.oneSentenceEditForTest().status, "ready");

  agree = true;
  await app.adoptOneSentenceEdit();
  const adopt = network.requests.find((request) => request.path === "/api/production/one-sentence-edit/adopt");
  assert.deepEqual(Object.keys(adopt.body).sort(), ["baseRevision", "creatorProfile", "patches", "projectId", "resultDigest", "runId", "target", "variantId"]);
  assert.deepEqual(plain(adopt.body.patches), DRAFT.patches);
  assert.equal(adopt.body.resultDigest, DRAFT.resultDigest);
  assert.ok(network.requests.some((request) => request.path === "/api/production/run/load"), "采纳后从服务端读回 Run");
  assert.equal(app.oneSentenceEditForTest(), null);
  assert.equal(app.oneSentenceEditEventForTest().type, "adopted");
  assert.equal(app.state.production.artifacts["fullStory:V2"].revision, "fullStory-V2-r2");
  assert.equal(app.elements.storyEditPreview.classList.contains("hidden"), true);
});

test("修改稿过期：页面上那一版先变了就不发请求直接作废；服务端说版本已变（409）同样作废；其它失败留着修改稿并写明原因", async () => {
  const app = await videoRunApp({ fetch: stubFetch({ "/api/one-sentence-edit/draft": { ok: true, result: DRAFT } }).fetch, confirm: () => true });
  app.executeDirectorAgentAction(editStory, { instruction: "第二场改成下大雨" });
  await tick(); await tick();
  app.state.production.artifacts["fullStory:V2"] = lineage("fullStory:V2", "fullStory-V2-r9");
  assert.equal(app.expireStaleOneSentenceEdit(), true);
  assert.equal(app.oneSentenceEditForTest(), null);
  assert.equal(app.oneSentenceEditEventForTest().type, "expired");

  let status = 409;
  const network = stubFetch({
    "/api/one-sentence-edit/draft": { ok: true, result: DRAFT },
    "/api/production/one-sentence-edit/adopt": () => ({ status, json: { ok: false, code: status === 409 ? "ONE_SENTENCE_EDIT_BASE_CHANGED" : "ONE_SENTENCE_EDIT_TASK_ACTIVE", error: "有相关的步骤正在进行" } })
  });
  const busy = await videoRunApp({ fetch: network.fetch, confirm: () => true });
  status = 418;
  busy.executeDirectorAgentAction(editStory, { instruction: "第二场改成下大雨" });
  await tick(); await tick();
  await busy.adoptOneSentenceEdit();
  assert.equal(busy.oneSentenceEditForTest().status, "ready", "不是版本问题：修改稿留着");
  assert.match(busy.elements.storyEditPreview.innerHTML, /没有采纳：有相关的步骤正在进行/u);
  status = 409;
  await busy.adoptOneSentenceEdit();
  assert.equal(busy.oneSentenceEditForTest(), null);
  assert.equal(busy.oneSentenceEditEventForTest().type, "expired");
});

test("放弃什么都不变；没改成或写稿失败的只是收起来，结果已经报过一次", async () => {
  const declined = { ...DRAFT, decision: "decline", patches: [], changes: [], resultDigest: "", invalidation: null, note: "要加新角色，做不到。" };
  let answer = { ok: true, result: DRAFT };
  const network = stubFetch({ "/api/one-sentence-edit/draft": () => answer });
  const app = await videoRunApp({ fetch: network.fetch });
  app.executeDirectorAgentAction(editStory, { instruction: "第二场改成下大雨" });
  await tick(); await tick();
  app.discardOneSentenceEdit();
  assert.equal(app.oneSentenceEditEventForTest().type, "discarded");
  assert.equal(network.requests.filter((request) => request.path.startsWith("/api/production/")).length, 0);

  answer = { ok: true, result: declined };
  app.executeDirectorAgentAction(editStory, { instruction: "加一只小狗" });
  await tick(); await tick();
  assert.equal(app.oneSentenceEditEventForTest().type, "declined");
  assert.match(app.elements.storyEditPreview.innerHTML, /这句话没有改成/u);
  assert.match(app.elements.storyEditPreview.innerHTML, /要加新角色，做不到。/u);
  assert.equal(app.directorAgentFacts().edit.pending, null, "没改成的不算等决定");
  const eventId = app.oneSentenceEditEventForTest().id;
  app.discardOneSentenceEdit();
  assert.equal(app.oneSentenceEditEventForTest().id, eventId, "收起来不再报一次");

  answer = { status: 502, json: { ok: false, code: "MODEL_CONTENT_FILTERED", category: "content-filter", error: "被内容审核拦下" } };
  app.executeDirectorAgentAction(editStory, { instruction: "第二场改成下大雨" });
  await tick(); await tick();
  assert.deepEqual([app.oneSentenceEditEventForTest().type, app.oneSentenceEditEventForTest().contentFiltered], ["failed", true]);
  assert.match(app.elements.storyEditPreview.innerHTML, /修改稿没有写出来：被内容审核拦下/u);
});

test("剧情 Run 改剧情不带固定角色设定（服务端用开 Run 时那一份）；提示词修改也不带", async () => {
  const network = stubFetch({ "/api/one-sentence-edit/draft": { ok: true, result: { ...DRAFT, variantId: "V1", artifactId: "fullStory:V1" } } });
  const app = await videoRunApp({ fetch: network.fetch });
  app.state.entryMode = "story";
  app.state.storyMode = "fullStoryText";
  app.state.selectedVariantId = "V1";
  app.state.fullStories = { V1: { ...app.fixture.fullStory, schemaVersion: "full_story/1.1" } };
  app.state.production.artifacts = { storySource: lineage("storySource"), visualGuardrails: lineage("visualGuardrails"), "fullStory:V1": lineage("fullStory:V1") };
  app.executeDirectorAgentAction({ id: "editStory", key: "editStory:V1", params: ["V1"] }, { instruction: "第二场改成下大雨" });
  const body = network.requests.find((request) => request.path === "/api/one-sentence-edit/draft").body;
  assert.equal(Object.hasOwn(body, "creatorProfile"), false);
  await tick(); await tick();
  // 粘贴完整故事的 Run 里页面把剧情叫「可翻拍镜头」：修改稿、等决定的说明和总结都跟着叫。
  assert.match(app.elements.storyEditPreview.innerHTML, /可翻拍镜头的修改稿（还没有生效）/u);
  assert.equal(app.directorAgentProgressNow().waitingFor, "可翻拍镜头的修改稿在分场页上可翻拍镜头的上方，等你采纳或放弃。");
  assert.equal(app.oneSentenceEditEventForTest().storySlot, true);
  // 卡片上没有原话就不开始。
  app.discardOneSentenceEdit();
  assert.equal(app.executeDirectorAgentAction({ id: "editStory", key: "editStory:V1", params: ["V1"] }, {}).started, false);
});

test("单镜提示词的修改稿在弹窗里：写稿和签发期间不能关；等决定时关弹窗先问、关了就是放弃；修改稿没处理不能生成视频", async () => {
  const answers = [false, true];
  const app = await videoRunApp({ confirm: () => answers.shift() });
  const entry = { id: "e", status: "writing", target: "shotPrompt", variantId: "V2", shotId: "A01", artifactId: "shotVideoPrompt:V2:A01",
    runId: "run", baseRevision: "shotVideoPrompt-V2-A01-r1", instruction: "镜头慢一点", result: null, error: "", usage: null, adopting: false, adoptError: "" };
  app.setOneSentenceEditForTest(entry);
  Object.assign(app.state.shotVideoGeneration, { open: true, shotId: "A01", running: false });
  app.closeShotVideoGenerator();
  assert.equal(app.state.shotVideoGeneration.open, true);
  assert.match(app.elements.shotVideoStatus.textContent, /正在按你的话改这一镜的提示词，处理完再关闭/u);

  entry.status = "ready";
  entry.result = { ...DRAFT, target: "shotPrompt", shotId: "A01", patches: [{ find: "固定机位", replace: "缓慢推近" }], afterText: "改好的提示词", invalidation: { artifactIds: [], counts: {} } };
  app.renderOneSentenceEditHosts();
  assert.match(app.elements.shotPromptEditPreview.innerHTML, /镜头 A01 的视频提示词的修改稿（还没有生效）/u);
  assert.match(app.elements.shotPromptEditPreview.innerHTML, /改完之后的整段提示词/u);
  assert.match(app.elements.shotPromptEditPreview.innerHTML, /采纳后什么都不作废/u);
  await app.confirmGenerateShotVideo();
  assert.match(app.elements.shotVideoStatus.textContent, /这一镜的提示词修改稿还没处理：先采纳或放弃，再生成视频。/u);
  app.closeShotVideoGenerator();
  assert.equal(app.state.shotVideoGeneration.open, true, "不同意就不关");
  app.closeShotVideoGenerator();
  assert.equal(app.state.shotVideoGeneration.open, false);
  assert.equal(app.oneSentenceEditForTest(), null);
  assert.equal(app.oneSentenceEditEventForTest().type, "discarded");
  assert.equal(app.elements.shotPromptEditPreview.classList.contains("hidden"), true);
});

test("修改稿与原话只在页面内存里：整个流程不写任何浏览器存储", async () => {
  const sessionStorage = memoryStorage();
  const localStorage = memoryStorage();
  const network = stubFetch({
    "/api/one-sentence-edit/draft": { ok: true, result: DRAFT },
    "/api/production/one-sentence-edit/adopt": { ok: true, result: { target: "story", artifactId: "fullStory:V2", staleArtifactIds: [] } },
    "/api/production/run/load": { ok: true, result: { projectId: "project", runId: "run", latestArtifacts: {} } }
  });
  const app = await videoRunApp({ fetch: network.fetch, confirm: () => true, sessionStorage, localStorage });
  const before = JSON.stringify([...sessionStorage.map, ...localStorage.map]);
  app.executeDirectorAgentAction(editStory, { instruction: "第二场改成下大雨，这句话不能落盘" });
  await tick(); await tick();
  await app.adoptOneSentenceEdit();
  const after = JSON.stringify([...sessionStorage.map, ...localStorage.map]);
  assert.equal(after.includes("这句话不能落盘"), false);
  assert.equal(after.includes("one-sentence"), false);
  assert.ok(after.length >= before.length - 1000, "只检查新增内容，不要求存储为空");
});
