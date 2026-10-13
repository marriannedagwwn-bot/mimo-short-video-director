import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createStoryEntryRuntime } from "./helpers/story-entry-runtime.js";
import { createStoryboardRuntime } from "./helpers/storyboard-runtime.js";
import { ONE_SENTENCE_EDIT_PROMPT_MARKER, ONE_SENTENCE_EDIT_SYSTEM_PROMPT } from "../src/one-sentence-edit-prompts.js";
import { MODEL_OUTPUT_LOG_SCOPES } from "../src/full-model-output-log.js";
import { ONE_SENTENCE_EDIT_STAGE } from "../src/one-sentence-edit.js";
import { lineageRef } from "../src/production-lineage.js";
import { ANIMATION_PLAN_VERSION_UNSUPPORTED, SHOT_VIDEO_PROMPT_VERSION, legacyAnimationPlanMessage } from "../public/storyboard-plan.js";

// 一句话修改的真实 HTTP（2026-10-11）：修改稿接口只出修改稿；采纳接口由服务端重新应用同一组修改、
// 核对摘要、以与上一版完全相同的依赖签发。假模型服务只按测试塞好的回复答，没有真实模型结果。

const dependencyRefs = (entry) => entry.lineage.dependencies.map((ref) => `${ref.artifactId}@${ref.revision}`).sort();
const editRequests = (requests) => requests.filter((request) => request.messages.some((row) => row.role === "user"
  && String(row.content).includes(ONE_SENTENCE_EDIT_PROMPT_MARKER)));

test("剧情 Run：剧情、分镜、单镜提示词各走一遍「修改稿 → 采纳」；依赖不变、原文不变、作废范围与规则一致，仍能导出 3.1 包", async () => {
  const runtime = await createStoryEntryRuntime();
  try {
    const { api, post, wait, creatorProfile, storySource, requests, oneSentenceEditReplies } = runtime;
    const started = await api("/api/production/run/story/start", { metadata: { creatorProfile }, storySource });
    const run = { projectId: started.production.projectId, runId: started.production.runId };
    assert.equal((await wait((await api("/api/tasks/create", { ...run, kind: "storyPipeline", input: { creatorProfile, targetDurationSeconds: 60 } })).task, run)).status, "completed");
    let state = await api("/api/production/run/load", { ...run, includeContent: true });
    const sourceBefore = state.latestArtifacts.storySource.lineage;
    const storyR1 = state.latestArtifacts["fullStory:V1"];

    // 1. 改剧情：还没有分镜，什么都不作废。
    oneSentenceEditReplies.push({ decision: "edit", patches: [{ sceneId: "S2", field: "visibleAction", find: "天气和路程", replace: "大雨和路程" }], note: "把天气改成大雨。" });
    const storyDraft = await post("/api/one-sentence-edit/draft", { ...run, target: "story", variantId: "V1", baseRevision: storyR1.lineage.revision, instruction: "第二场改成下大雨" });
    assert.equal(storyDraft.status, 200, JSON.stringify(storyDraft.json));
    const draft = storyDraft.json.result;
    assert.deepEqual([draft.decision, draft.artifactId, draft.baseRevision], ["edit", "fullStory:V1", storyR1.lineage.revision]);
    assert.deepEqual(draft.invalidation.artifactIds, []);
    assert.equal(storyDraft.json.usage.calls, 1, "修改稿的用量挂在信封上");
    const sent = editRequests(requests).at(-1);
    assert.equal(sent.messages.find((row) => row.role === "system").content, ONE_SENTENCE_EDIT_SYSTEM_PROMPT);
    assert.ok(sent.messages.find((row) => row.role === "user").content.includes("<<<\n第二场改成下大雨\n>>>"));
    state = await api("/api/production/run/load", { ...run, includeContent: true });
    assert.equal(state.latestArtifacts["fullStory:V1"].lineage.revision, storyR1.lineage.revision, "修改稿不签发任何东西");

    const adopted = await post("/api/production/one-sentence-edit/adopt", { ...run, target: "story", variantId: "V1",
      baseRevision: draft.baseRevision, patches: draft.patches, resultDigest: draft.resultDigest });
    assert.equal(adopted.status, 200, JSON.stringify(adopted.json));
    state = await api("/api/production/run/load", { ...run, includeContent: true });
    const storyR2 = state.latestArtifacts["fullStory:V1"];
    assert.equal(storyR2.lineage.revision, "fullStory-V1-r2");
    assert.equal(storyR2.lineage.contentDigest, draft.resultDigest, "签发的就是预览里那一份");
    assert.deepEqual(dependencyRefs(storyR2), dependencyRefs(storyR1), "依赖与上一版完全相同");
    assert.equal(storyR2.content.sceneScript[1].visibleAction, storyR1.content.sceneScript[1].visibleAction.replace("天气和路程", "大雨和路程"));
    assert.deepEqual(state.latestArtifacts.storySource.lineage, sourceBefore, "原文永远不动");
    assert.equal(state.metadata.storySourceDigest, sourceBefore.contentDigest);
    // 同一份修改稿不能采纳两次：基准版本已经变了。
    const again = await post("/api/production/one-sentence-edit/adopt", { ...run, target: "story", variantId: "V1",
      baseRevision: draft.baseRevision, patches: draft.patches, resultDigest: draft.resultDigest });
    assert.deepEqual([again.status, again.json.code], [409, "ONE_SENTENCE_EDIT_BASE_CHANGED"]);

    // 2. 生成分镜、写 A01 的提示词，再改分镜：作废那条提示词，签发新的媒体命名空间。
    const planTask = await api("/api/tasks/create", { ...run, kind: "animationPlan", input: {
      variantId: "V1", creatorProfile, animationPlanVersion: "4.0", targetAspectRatio: "16:9", backgroundMusicEnabled: false, artStyle: "二维日系动画"
    } });
    assert.equal((await wait(planTask.task, run)).status, "completed");
    state = await api("/api/production/run/load", { ...run, includeContent: true });
    let planEntry = state.latestArtifacts["animationPlan:V1"];
    const productionContext = (entry) => ({ projectId: run.projectId, runId: run.runId, planArtifactId: entry.lineage.artifactId,
      planRevision: entry.lineage.revision, planDigest: entry.lineage.contentDigest, mediaNamespace: entry.lineage.mediaNamespace });
    const writePrompt = async (entry) => {
      const created = await api("/api/tasks/create", { ...run, kind: "shotVideoPrompt", input: { variantId: "V1", shotId: "A01", productionContext: productionContext(entry), videoProvider: "Seedance", videoModel: "doubao-seedance-2-0-260128" } });
      assert.equal((await wait(created.task, run)).status, "completed");
    };
    await writePrompt(planEntry);
    const beat = planEntry.content.shotPlan[1].beats[0].visibleAction;
    const find = beat.slice(0, 6);
    oneSentenceEditReplies.push({ decision: "edit", patches: [{ path: ["shotPlan", "1", "beats", "0", "visibleAction"], find, replace: `${find}（慢一点）` }], note: "A02 放慢。" });
    const boardDraft = await post("/api/one-sentence-edit/draft", { ...run, target: "storyboard", variantId: "V1", baseRevision: planEntry.lineage.revision, instruction: "A02 放慢一点" });
    assert.equal(boardDraft.status, 200, JSON.stringify(boardDraft.json));
    assert.deepEqual(boardDraft.json.result.invalidation.artifactIds, ["shotVideoPrompt:V1:A01"]);
    assert.equal(boardDraft.json.result.invalidation.counts.shotVideoPrompt, 1);
    const boardAdopt = await post("/api/production/one-sentence-edit/adopt", { ...run, target: "storyboard", variantId: "V1",
      baseRevision: boardDraft.json.result.baseRevision, patches: boardDraft.json.result.patches, resultDigest: boardDraft.json.result.resultDigest });
    assert.equal(boardAdopt.status, 200, JSON.stringify(boardAdopt.json));
    assert.deepEqual(boardAdopt.json.result.staleArtifactIds, ["shotVideoPrompt:V1:A01"]);
    state = await api("/api/production/run/load", { ...run, includeContent: true });
    const planR2 = state.latestArtifacts["animationPlan:V1"];
    assert.equal(planR2.lineage.revision, "animationPlan-V1-r2");
    assert.ok(planR2.lineage.mediaNamespace?.includes(planR2.lineage.revision), "分镜签发新的媒体命名空间（按新版本号）");
    assert.notEqual(planR2.lineage.mediaNamespace, planEntry.lineage.mediaNamespace);
    assert.deepEqual(dependencyRefs(planR2), dependencyRefs(planEntry));
    assert.equal(state.latestArtifacts["shotVideoPrompt:V1:A01"].lineage.status, "stale");

    // 3. 重新写 A01 的提示词，再只改它：什么都不作废，模型与对应的分镜原样保留。
    planEntry = planR2;
    await writePrompt(planEntry);
    state = await api("/api/production/run/load", { ...run, includeContent: true });
    const promptR = state.latestArtifacts["shotVideoPrompt:V1:A01"];
    const fragment = promptR.content.videoPrompt.includes("固定机位") ? "固定机位" : promptR.content.videoPrompt.split("\n")[1].slice(0, 6);
    oneSentenceEditReplies.push({ decision: "edit", patches: [{ find: fragment, replace: `${fragment}，镜头缓慢推近` }], note: "加了推近。" });
    const promptDraft = await post("/api/one-sentence-edit/draft", { ...run, target: "shotPrompt", variantId: "V1", shotId: "A01", baseRevision: promptR.lineage.revision, instruction: "A01 镜头慢慢推近" });
    assert.equal(promptDraft.status, 200, JSON.stringify(promptDraft.json));
    assert.deepEqual(promptDraft.json.result.invalidation.artifactIds, []);
    assert.ok(promptDraft.json.result.afterText.includes("镜头缓慢推近"));
    const promptAdopt = await post("/api/production/one-sentence-edit/adopt", { ...run, target: "shotPrompt", variantId: "V1", shotId: "A01",
      baseRevision: promptR.lineage.revision, patches: promptDraft.json.result.patches, resultDigest: promptDraft.json.result.resultDigest });
    assert.equal(promptAdopt.status, 200, JSON.stringify(promptAdopt.json));
    assert.deepEqual(promptAdopt.json.result.staleArtifactIds, []);
    state = await api("/api/production/run/load", { ...run, includeContent: true });
    const promptR2 = state.latestArtifacts["shotVideoPrompt:V1:A01"];
    assert.deepEqual({ ...promptR2.content, videoPrompt: "" }, { ...promptR.content, videoPrompt: "" });
    assert.deepEqual(dependencyRefs(promptR2), dependencyRefs(promptR));
    assert.equal(state.latestArtifacts["animationPlan:V1"].lineage.revision, planR2.lineage.revision, "改提示词不动分镜");

    // 4. 有分镜之后再改剧情：分镜与提示词作废。
    const storyNow = state.latestArtifacts["fullStory:V1"];
    oneSentenceEditReplies.push({ decision: "edit", patches: [{ sceneId: "S3", field: "dialogue", find: "没事，东西没坏。", replace: "" }], note: "删了这句。" });
    const storyDraft2 = await post("/api/one-sentence-edit/draft", { ...run, target: "story", variantId: "V1", baseRevision: storyNow.lineage.revision, instruction: "第三场那句台词删掉" });
    assert.equal(storyDraft2.status, 200, JSON.stringify(storyDraft2.json));
    assert.deepEqual(storyDraft2.json.result.invalidation.counts, { animationPlan: 1, shotVideoPrompt: 1, shotVideo: 0, characterImages: 0, other: 0 });

    // 3.1 测试包：改过的剧情与分镜仍然按依赖图签出、导入核对通过（依赖没变）。
    const sealed = await api("/api/production/package/seal", { ...run, payload: {
      exportedAt: "2026-10-11T00:00:00.000Z", mode: "live", modelInfo: {}, fullStory: storyNow.content, animationPlan: state.latestArtifacts["animationPlan:V1"].content
    } });
    assert.equal(sealed.packageVersion, "3.1");
    const imported = await api("/api/production/package/import", { package: sealed });
    assert.ok(imported.production.runId, "导入建出隔离的新 Run");
    const storyAdopt2 = await post("/api/production/one-sentence-edit/adopt", { ...run, target: "story", variantId: "V1",
      baseRevision: storyNow.lineage.revision, patches: storyDraft2.json.result.patches, resultDigest: storyDraft2.json.result.resultDigest });
    assert.equal(storyAdopt2.status, 200, JSON.stringify(storyAdopt2.json));
    assert.deepEqual(storyAdopt2.json.result.staleArtifactIds.sort(), ["animationPlan:V1", "shotVideoPrompt:V1:A01"]);

    // 原话不落盘：不进 Run、任务记录，也不进模型输出日志以外的地方（日志只记模型的回复）。
    const stateFiles = fs.readdirSync(`${runtime.root}/state`, { recursive: true }).filter((file) => String(file).endsWith(".json"));
    for (const file of stateFiles) {
      const text = fs.readFileSync(`${runtime.root}/state/${file}`, "utf8");
      for (const instruction of ["第二场改成下大雨", "A02 放慢一点", "A01 镜头慢慢推近", "第三场那句台词删掉"]) {
        assert.equal(text.includes(instruction), false, `${file} 里出现了用户原话`);
      }
    }
  } finally {
    await runtime.close();
  }
});

test("剧情 Run：请求里不收任何副本；做不到时写 decline；修改稿被改动、基准版本已变都 409", async () => {
  const runtime = await createStoryEntryRuntime();
  try {
    const { api, post, wait, creatorProfile, storySource, oneSentenceEditReplies } = runtime;
    const started = await api("/api/production/run/story/start", { metadata: { creatorProfile }, storySource });
    const run = { projectId: started.production.projectId, runId: started.production.runId };
    assert.equal((await wait((await api("/api/tasks/create", { ...run, kind: "storyPipeline", input: { creatorProfile, targetDurationSeconds: 60 } })).task, run)).status, "completed");
    const state = await api("/api/production/run/load", { ...run, includeContent: true });
    const story = state.latestArtifacts["fullStory:V1"];
    const base = { ...run, target: "story", variantId: "V1", baseRevision: story.lineage.revision };

    for (const [body, code] of [
      [{ ...base, instruction: "改一下", fullStory: story.content }, "ONE_SENTENCE_EDIT_INPUT_INVALID"],
      [{ ...base, instruction: "改一下", storySource: {} }, "ONE_SENTENCE_EDIT_INPUT_INVALID"],
      [{ ...base, instruction: "改一下", shotId: "A01" }, "ONE_SENTENCE_EDIT_INPUT_INVALID"],
      [{ ...base, instruction: "改一下", target: "title" }, "ONE_SENTENCE_EDIT_INPUT_INVALID"],
      [{ ...base, instruction: "改一下", variantId: "V2" }, "ONE_SENTENCE_EDIT_BASE_CHANGED"],
      // 剧情 Run 用开 Run 时那份设定；页面带来的副本对不上就拒（与其它剧情 Run 的请求同一个核对）。
      [{ ...base, instruction: "改一下", creatorProfile: { ...creatorProfile, vertical: "科普" } }, "TASK_BROWSER_ARTIFACT_MISMATCH"]
    ]) {
      const response = await post("/api/one-sentence-edit/draft", body);
      assert.equal(response.json.code, code, JSON.stringify(body));
      assert.ok([400, 409].includes(response.status));
    }
    const empty = await post("/api/one-sentence-edit/draft", { ...base, instruction: "  " });
    assert.equal(empty.status, 400);
    assert.match(empty.json.error, /instruction 不能为空/u);

    oneSentenceEditReplies.push({ decision: "decline", patches: [], note: "加新角色要登记出镜名单，一句话修改做不到。" });
    const declined = await post("/api/one-sentence-edit/draft", { ...base, instruction: "加一只小狗" });
    assert.equal(declined.status, 200);
    assert.deepEqual([declined.json.result.decision, declined.json.result.invalidation], ["decline", null]);

    oneSentenceEditReplies.push({ decision: "edit", patches: [{ sceneId: "S2", field: "visibleAction", find: "天气和路程", replace: "大雨和路程" }], note: "改了。" });
    const draft = (await post("/api/one-sentence-edit/draft", { ...base, instruction: "第二场下大雨" })).json.result;
    const adopt = (overrides) => post("/api/production/one-sentence-edit/adopt", { ...base, patches: draft.patches, resultDigest: draft.resultDigest, ...overrides });
    assert.deepEqual([(await adopt({ resultDigest: "0".repeat(64) })).json.code], ["ONE_SENTENCE_EDIT_RESULT_MISMATCH"]);
    assert.deepEqual([(await adopt({ patches: [{ ...draft.patches[0], replace: "小雨和路程" }] })).json.code], ["ONE_SENTENCE_EDIT_RESULT_MISMATCH"]);
    assert.deepEqual([(await adopt({ patches: [{ ...draft.patches[0], find: "原文里没有的话" }] })).json.code], ["ONE_SENTENCE_EDIT_RESULT_MISMATCH"]);
    assert.deepEqual([(await adopt({ resultDigest: "不是摘要" })).json.code], ["ONE_SENTENCE_EDIT_INPUT_INVALID"]);
    assert.deepEqual([(await adopt({ instruction: "采纳时不收原话" })).json.code], ["ONE_SENTENCE_EDIT_INPUT_INVALID"]);
    const unchanged = await api("/api/production/run/load", { ...run, includeContent: false });
    assert.equal(unchanged.latestArtifacts["fullStory:V1"].lineage.revision, story.lineage.revision, "被拒的采纳什么都不签发");
    assert.equal((await adopt({})).status, 200);
    assert.deepEqual([(await adopt({})).json.code], ["ONE_SENTENCE_EDIT_BASE_CHANGED"]);
  } finally {
    await runtime.close();
  }
});

test("参考视频 Run：改剧情要带固定角色设定核对边界签名；相关步骤正在进行时 409；依赖与上一版相同", async () => {
  const runtime = await createStoryboardRuntime();
  try {
    const { api, wait, variant, input, oneSentenceEditReplies } = runtime;
    // 这个夹具的 run 是整份 Run 摘要；一句话修改的请求只收坐标，多带任何键都会 400。
    const run = { projectId: runtime.run.projectId, runId: runtime.run.runId };
    const post = async (route, body) => {
      const response = await fetch(runtime.base + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: response.status, json: await response.json() };
    };
    const planTask = await api("/api/tasks/create", { ...run, kind: "animationPlan", input: {
      variantId: variant.id, creatorProfile: input.creatorProfile, animationPlanVersion: "4.0", targetAspectRatio: "16:9", backgroundMusicEnabled: false
    } });
    assert.equal((await wait(planTask.task)).status, "completed");
    let state = await api("/api/production/run/load", { ...run, includeContent: true });
    const storyId = `fullStory:${variant.id}`;
    const story = state.latestArtifacts[storyId];
    const scene = story.content.sceneScript[0];
    const find = scene.visibleAction.slice(0, 4);
    const base = { ...run, target: "story", variantId: variant.id, baseRevision: story.lineage.revision };

    const noProfile = await post("/api/one-sentence-edit/draft", { ...base, instruction: "第一场慢一点" });
    assert.deepEqual([noProfile.status, noProfile.json.code], [400, "ONE_SENTENCE_EDIT_INPUT_INVALID"]);
    const wrongProfile = await post("/api/one-sentence-edit/draft", { ...base, instruction: "第一场慢一点", creatorProfile: { ...input.creatorProfile, vertical: "科普" } });
    assert.equal(wrongProfile.status, 400, "固定角色设定与边界签名对不上");
    assert.equal(runtime.requests.filter((request) => JSON.stringify(request).includes(ONE_SENTENCE_EDIT_PROMPT_MARKER)).length, 0, "被拒的请求一次都没调用模型");

    // A01 的提示词正在写（假模型扣住不答）：改分镜会让它白写，409。
    const planEntry = state.latestArtifacts[`animationPlan:${variant.id}`];
    runtime.holdPrompt();
    const promptTask = await api("/api/tasks/create", { ...run, kind: "shotVideoPrompt", input: { variantId: variant.id, shotId: "A01",
      productionContext: { ...run, planArtifactId: planEntry.lineage.artifactId, planRevision: planEntry.lineage.revision, planDigest: planEntry.lineage.contentDigest, mediaNamespace: planEntry.lineage.mediaNamespace },
      videoProvider: "Seedance", videoModel: "doubao-seedance-2-0-260128" } });
    for (let i = 0; i < 100 && !runtime.promptPending(); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    const busy = await post("/api/one-sentence-edit/draft", { ...run, target: "storyboard", variantId: variant.id, baseRevision: planEntry.lineage.revision,
      instruction: "A01 慢一点", creatorProfile: input.creatorProfile });
    assert.deepEqual([busy.status, busy.json.code], [409, "ONE_SENTENCE_EDIT_TASK_ACTIVE"]);
    runtime.releasePrompt();
    assert.equal((await wait(promptTask.task)).status, "completed");

    oneSentenceEditReplies.push({ decision: "edit", patches: [{ sceneId: scene.sceneId, field: "visibleAction", find, replace: `${find}（慢一点）` }], note: "改了。" });
    const draft = await post("/api/one-sentence-edit/draft", { ...base, instruction: "第一场慢一点", creatorProfile: input.creatorProfile });
    assert.equal(draft.status, 200, JSON.stringify(draft.json));
    assert.deepEqual(draft.json.result.invalidation.counts, { animationPlan: 1, shotVideoPrompt: 1, shotVideo: 0, characterImages: 0, other: 0 });
    const adopted = await post("/api/production/one-sentence-edit/adopt", { ...base, patches: draft.json.result.patches,
      resultDigest: draft.json.result.resultDigest, creatorProfile: input.creatorProfile });
    assert.equal(adopted.status, 200, JSON.stringify(adopted.json));
    state = await api("/api/production/run/load", { ...run, includeContent: true });
    assert.deepEqual(dependencyRefs(state.latestArtifacts[storyId]), dependencyRefs(story));
    assert.equal(state.latestArtifacts[`animationPlan:${variant.id}`].lineage.status, "stale");
  } finally {
    await runtime.close();
  }
});

test("旧 2.0/3.0/无版本分镜：改分镜、改单镜提示词的修改稿与采纳都 409 ANIMATION_PLAN_VERSION_UNSUPPORTED（与其它读 Plan 的路由同一道守卫），不调模型、不签发", async () => {
  const runtime = await createStoryboardRuntime();
  try {
    const { store, variant, input, requests } = runtime;
    const run = { projectId: runtime.run.projectId, runId: runtime.run.runId };
    const post = async (route, body) => {
      const response = await fetch(runtime.base + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: response.status, json: await response.json() };
    };
    const loaded = await store.loadRun({ ...run, includeContent: true });
    const storyRef = lineageRef(loaded.latestArtifacts[`fullStory:${variant.id}`].lineage);
    const planId = `animationPlan:${variant.id}`;
    const promptId = `shotVideoPrompt:${variant.id}:A01`;
    let planRevision = null;
    let promptRevision = null;
    for (const [version, content] of [
      ["3.0", { promptSchemaVersion: "3.0", shotPlan: [{ shotId: "A01" }] }],
      ["2.0", { promptSchemaVersion: "2.0", shotPlan: [{ shotId: "A01", startFrame: {}, endFrame: {} }] }],
      ["unversioned", { shotPlan: [{ shotId: "A01" }] }]
    ]) {
      // 绕过提交口直接写进状态库，模拟删除之前就存在的旧 Run（状态库本身不按 Plan 版本拒收）。
      const plan = await store.commitArtifact({ ...run, artifactId: planId, artifactType: "animationPlan",
        content: { ...content, selectedVariantId: variant.id }, dependencies: [storyRef], requestId: `legacy-ose-plan-${version.replace(".", "-")}`,
        expectedCurrentRevision: planRevision, createMediaNamespace: true });
      planRevision = plan.lineage.revision;
      const prompt = await store.commitArtifact({ ...run, artifactId: promptId, artifactType: "shotVideoPrompt",
        content: { schemaVersion: SHOT_VIDEO_PROMPT_VERSION, shotId: "A01", planDigest: plan.lineage.contentDigest, videoPrompt: "测试" },
        dependencies: [lineageRef(plan.lineage)], requestId: `legacy-ose-prompt-${version.replace(".", "-")}`, expectedCurrentRevision: promptRevision });
      promptRevision = prompt.lineage.revision;
      const storyboard = { ...run, target: "storyboard", variantId: variant.id, baseRevision: planRevision, creatorProfile: input.creatorProfile };
      const shotPrompt = { ...run, target: "shotPrompt", variantId: variant.id, shotId: "A01", baseRevision: promptRevision };
      for (const [route, body] of [
        ["/api/one-sentence-edit/draft", { ...storyboard, instruction: "A01 慢一点" }],
        ["/api/production/one-sentence-edit/adopt", { ...storyboard, patches: [], resultDigest: "0".repeat(64) }],
        ["/api/one-sentence-edit/draft", { ...shotPrompt, instruction: "A01 镜头推近" }],
        ["/api/production/one-sentence-edit/adopt", { ...shotPrompt, patches: [], resultDigest: "0".repeat(64) }]
      ]) {
        const response = await post(route, body);
        const label = `${version} ${body.target} ${route}`;
        assert.deepEqual([response.status, response.json.code], [409, ANIMATION_PLAN_VERSION_UNSUPPORTED], `${label}: ${JSON.stringify(response.json)}`);
        assert.equal(response.json.error, legacyAnimationPlanMessage(version), label);
      }
      const after = await store.loadRun({ ...run, includeContent: false });
      assert.equal(after.latestArtifacts[planId].lineage.revision, planRevision, `${version}：被拒的采纳不签发分镜`);
      assert.equal(after.latestArtifacts[promptId].lineage.revision, promptRevision, `${version}：被拒的采纳不签发提示词`);
    }
    assert.equal(requests.filter((request) => JSON.stringify(request).includes(ONE_SENTENCE_EDIT_PROMPT_MARKER)).length, 0, "旧分镜上一次都不调用模型");
  } finally {
    await runtime.close();
  }
});

test("源码登记：路由只出修改稿、采纳在生产状态接口里、阶段默认值 ≥32768、侧车 scope 排在导演助手之前", () => {
  const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  assert.match(server, /"\/api\/one-sentence-edit\/draft": \(body\) => oneSentenceEditDraft\(body\),/u);
  assert.match(server, /if \(pathname === "\/api\/production\/one-sentence-edit\/adopt"\) \{\n\s+return adoptOneSentenceEdit\(body\);/u);
  assert.match(server, /oneSentenceEdit: stageSetting\(\n\s+provider,\n\s+source\.model,\n\s+Math\.max\(Number\(source\.maxCompletionTokens\) \|\| 0, 32768\)/u);
  assert.match(server, /MODEL_OUTPUT_LOG_SCOPES\.ONE_SENTENCE_EDIT,\n[^\n]*\n\s+MODEL_OUTPUT_LOG_SCOPES\.DIRECTOR_AGENT\n\];/u);
  assert.equal(MODEL_OUTPUT_LOG_SCOPES.ONE_SENTENCE_EDIT, ONE_SENTENCE_EDIT_STAGE);
  const workflow = fs.readFileSync(new URL("../src/workflow.js", import.meta.url), "utf8");
  assert.match(workflow, /oneSentenceEdit: \{ provider, model: "", maxCompletionTokens: 32768 \}/u);
  assert.match(workflow, /oneSentenceEdit: "一句话修改"/u);
  const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /\{ key: "oneSentenceEdit", label: "一句话修改", [^\n]*optional: true \}/u);
  // 修改稿与原话只在页面内存里。
  for (const file of ["one-sentence-edit-ui.js"]) {
    const source = fs.readFileSync(new URL(`../public/${file}`, import.meta.url), "utf8");
    assert.equal(/\b(?:localStorage|sessionStorage|indexedDB)\s*\./u.test(source), false, file);
  }
  const block = app.slice(app.indexOf("// ---- 一句话修改（2026-10-11，导演 Agent 第三期）----"), app.indexOf("function bindOneSentenceEditEvents"));
  assert.ok(block.length > 1000);
  assert.equal(/\b(?:localStorage|sessionStorage|indexedDB)\s*\./u.test(block), false, "app.js 的一句话修改部分不碰浏览器存储");
});
