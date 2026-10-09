import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { ProductionStateStore } from "../src/production-state-store.js";
import { STORY_ENTRY_SYSTEM_PROMPT } from "../src/story-entry-prompts.js";
import { FIXTURE_PNG_DATA_URL, STORY_ENTRY_FIXTURE_TEXT, createStoryEntryRuntime } from "./helpers/story-entry-runtime.js";

const dependencyIds = (entry) => entry.lineage.dependencies.map((ref) => ref.artifactId).sort();

test("真实 HTTP / Durable Task：从剧情开始 → 角色边界 → 单个候选 → 完整剧情 → 4.0 分镜 → 单镜提示词", async () => {
  const runtime = await createStoryEntryRuntime();
  try {
    const { api, post, wait, requests, creatorProfile, storySource } = runtime;

    // 故事里找不到固定角色的名字时先问一句，确认后才建 Run。
    const missingName = await post("/api/production/run/story/start", {
      metadata: { creatorProfile: { ...creatorProfile, fixedCharacter: "小满，八岁女孩" } },
      storySource
    });
    assert.equal(missingName.status, 409);
    assert.equal(missingName.json.code, "STORY_ENTRY_PROTAGONIST_NAME_MISSING");
    const badInput = await post("/api/production/run/story/start", { metadata: { creatorProfile }, storySource: { storyMode: "characterOnly", storyText: "多余的正文" } });
    assert.equal(badInput.status, 400);
    assert.equal(badInput.json.code, "STORY_ENTRY_INPUT_INVALID");

    const started = await api("/api/production/run/story/start", { metadata: { creatorProfile }, storySource });
    const run = { projectId: started.production.projectId, runId: started.production.runId };
    assert.equal(started.production.metadata.entryMode, "story");
    assert.equal(started.production.metadata.storyMode, "fullStoryText");
    assert.equal(started.production.metadata.storySourceDigest, started.production.artifacts.storySource.contentDigest);
    assert.equal(JSON.stringify(started.production.metadata).includes(STORY_ENTRY_FIXTURE_TEXT), false, "原文不进 Run 元数据");

    // 两步流水线：只用文字、用剧情入口的系统提示；结束时服务端签发 variant:V1。
    const pipeline = await api("/api/tasks/create", { ...run, kind: "storyPipeline", input: { creatorProfile, targetDurationSeconds: 60 } });
    const pipelineTask = await wait(pipeline.task, run);
    assert.equal(pipelineTask.status, "completed", JSON.stringify(pipelineTask.error));
    assert.equal(requests.length, 2);
    for (const request of requests) {
      assert.equal(request.messages.find((row) => row.role === "system")?.content, STORY_ENTRY_SYSTEM_PROMPT);
      assert.ok(request.messages.every((row) => typeof row.content === "string"), "请求里没有图片或视频");
    }
    let state = await api("/api/production/run/load", { ...run, includeContent: true });
    const guardrails = state.latestArtifacts.visualGuardrails;
    assert.deepEqual(guardrails.content.sourceSimilarityRules, []);
    assert.deepEqual(dependencyIds(guardrails), ["storySource"]);
    assert.deepEqual(dependencyIds(state.latestArtifacts.themeVariants), ["storySource", "visualGuardrails"]);
    assert.equal(state.latestArtifacts.themeVariants.content.variants.length, 1);
    const selection = state.latestArtifacts["variant:V1"];
    assert.equal(selection.lineage.artifactType, "selectedVariant");
    assert.deepEqual(dependencyIds(selection), ["themeVariants"]);
    assert.deepEqual(selection.content, state.latestArtifacts.themeVariants.content.variants[0]);
    for (const absent of ["referenceAnalysis", "sourceScriptReconstruction", "creativeBrief"]) {
      assert.equal(state.latestArtifacts[absent], undefined, absent);
    }

    // 再跑一次流水线：三个目标都已是 current，全部复用、不重复签发 variant:V1。
    const again = await api("/api/tasks/create", { ...run, kind: "storyPipeline", input: { creatorProfile, targetDurationSeconds: 60 } });
    assert.equal((await wait(again.task, run)).status, "completed");
    state = await api("/api/production/run/load", { ...run, includeContent: true });
    assert.equal(state.latestArtifacts["variant:V1"].lineage.revision, selection.lineage.revision);
    assert.equal(requests.length, 2);

    // 完整剧情：依赖 storySource 链，不依赖参考视频那三份上游。
    const story = await api("/api/tasks/create", { ...run, kind: "fullStory", input: {
      variantId: "V1", creatorProfile, fullStorySchemaVersion: "full_story/1.2", targetDurationSeconds: 60,
      visualGuardrails: state.latestArtifacts.visualGuardrails.content,
      themeVariants: state.latestArtifacts.themeVariants.content,
      variant: state.latestArtifacts["variant:V1"].content
    } });
    const storyTask = await wait(story.task, run);
    assert.equal(storyTask.status, "completed", JSON.stringify(storyTask.error));
    state = await api("/api/production/run/load", { ...run, includeContent: true });
    const fullStory = state.latestArtifacts["fullStory:V1"];
    assert.deepEqual(dependencyIds(fullStory), ["storySource", "themeVariants", "variant:V1", "visualGuardrails"]);
    assert.deepEqual(fullStory.content, runtime.fullStory);
    const storyPrompt = requests.find((request) => request.messages.some((row) => row.role === "user" && row.content.includes("你现在进入 AI 导演的“完整剧情”阶段")));
    const storyUser = storyPrompt.messages.find((row) => row.role === "user").content;
    assert.ok(storyUser.includes(JSON.stringify(STORY_ENTRY_FIXTURE_TEXT)), "完整剧情提示词带用户原文");
    assert.equal(storyUser.includes("原片"), false);

    // 带着参考视频上游的副本来请求，说明页面拿错了 Run，直接拒绝。
    const wrongCopy = await post("/api/tasks/create", { ...run, kind: "fullStory", input: { variantId: "V1", creatorProfile, referenceAnalysis: { format: "x" } } });
    assert.equal(wrongCopy.status, 400);
    assert.equal(wrongCopy.json.code, "STORY_ENTRY_INPUT_INVALID");

    // 4.0 分镜：依赖 storySource、角色边界、选中记录和完整剧情。
    const plan = await api("/api/tasks/create", { ...run, kind: "animationPlan", input: {
      variantId: "V1", creatorProfile, animationPlanVersion: "4.0", animationPlanMode: "direct_shot", targetAspectRatio: "16:9", backgroundMusicEnabled: false
    } });
    const planTask = await wait(plan.task, run);
    assert.equal(planTask.status, "completed", JSON.stringify(planTask.error));
    state = await api("/api/production/run/load", { ...run, includeContent: true });
    const planEntry = state.latestArtifacts["animationPlan:V1"];
    assert.equal(planEntry.content.promptSchemaVersion, "4.0");
    assert.deepEqual(dependencyIds(planEntry), ["fullStory:V1", "storySource", "variant:V1", "visualGuardrails"]);
    const designPrompt = requests.find((request) => request.messages.some((row) => row.role === "user" && row.content.includes("任务：将完整 Full Story")));
    assert.ok(designPrompt.messages.find((row) => row.role === "user").content.includes("对白不可改"), "粘贴原文的 Run 锁定分镜台词");
    const v3Plan = await post("/api/tasks/create", { ...run, kind: "animationPlan", input: { variantId: "V1", creatorProfile, animationPlanMode: "direct_shot" } });
    assert.equal(v3Plan.json.code, "STORY_ENTRY_PLAN_VERSION_UNSUPPORTED");

    // 单镜提示词沿用原路径，不受入口影响。
    const productionContext = { projectId: run.projectId, runId: run.runId, planArtifactId: planEntry.lineage.artifactId,
      planRevision: planEntry.lineage.revision, planDigest: planEntry.lineage.contentDigest, mediaNamespace: planEntry.lineage.mediaNamespace };
    const shotPrompt = await api("/api/tasks/create", { ...run, kind: "shotVideoPrompt", input: { variantId: "V1", shotId: "A01", productionContext, videoProvider: "Seedance", videoModel: "doubao-seedance-2-0-260128" } });
    assert.equal((await wait(shotPrompt.task, run)).status, "completed");

    // 角色参考图：不要求参考视频那三份上游，角色边界按剧情入口的摘要验。
    const images = await api("/api/tasks/create", { ...run, kind: "characterReferenceImages", input: {
      variantId: "V1", roleIndex: 0, count: 1, prompt: "协议测试的角色参考图提示词",
      referenceImageDataUrl: FIXTURE_PNG_DATA_URL, referenceImageName: "ref.png", creatorProfile, productionContext
    } });
    const imagesTask = await wait(images.task, run);
    assert.equal(imagesTask.status, "completed", JSON.stringify(imagesTask.error));
    assert.equal(runtime.imageRequests.length, 1);
    state = await api("/api/production/run/load", { ...run, includeContent: true });
    assert.equal(state.latestArtifacts["characterImages:V1:0"].content.results.length, 1);

    // 人物精修：同样按剧情入口的摘要验边界，写回新的分镜版本。
    const refine = await api("/api/tasks/create", { ...run, kind: "characterReferenceRefine", input: {
      variantId: "V1", roleIndex: 0, imageName: "ref.png", imageDataUrl: FIXTURE_PNG_DATA_URL, creatorProfile
    } });
    const refineTask = await wait(refine.task, run);
    assert.equal(refineTask.status, "completed", JSON.stringify(refineTask.error));
    state = await api("/api/production/run/load", { ...run, includeContent: true });
    assert.notEqual(state.latestArtifacts["animationPlan:V1"].lineage.revision, planEntry.lineage.revision);
    assert.equal(state.latestArtifacts["animationPlan:V1"].content.characterReferencePrompts[0].referenceImageAdded, true);
    assert.deepEqual(dependencyIds(state.latestArtifacts["animationPlan:V1"]), ["fullStory:V1", "storySource", "variant:V1", "visualGuardrails"]);

    // 台词核对只出报告。
    const report = await api("/api/production/story-entry/dialogue-check", { ...run, variantId: "V1" });
    assert.equal(report.applicable, true);
    assert.ok(Number.isInteger(report.checked));
    assert.ok(Array.isArray(report.missing));

    // 参考视频专用的步骤、浏览器改写原文、导出生产包，在剧情 Run 上一律拒绝。
    const director = await post("/api/tasks/create", { ...run, kind: "directorPipeline", input: { creatorProfile } });
    assert.equal(director.status, 409);
    assert.equal(director.json.code, "TASK_ENTRY_MODE_MISMATCH");
    const variants = await post("/api/tasks/create", { ...run, kind: "variants", input: { creatorProfile } });
    assert.equal(variants.json.code, "TASK_ENTRY_MODE_MISMATCH");
    const overwrite = await post("/api/production/artifact/commit", { ...run, artifactId: "storySource", artifactType: "storySource",
      content: { ...storySource, storyText: "改过的故事" }, dependencies: [], requestId: "browser-overwrite", expectedCurrentRevision: state.latestArtifacts.storySource.lineage.revision });
    assert.equal(overwrite.status, 403);
    assert.equal(overwrite.json.code, "STORY_SOURCE_SERVER_ONLY");
    const seal = await post("/api/production/package/seal", { ...run, payload: { selectedVariant: state.latestArtifacts["variant:V1"].content, fullStory: fullStory.content } });
    assert.equal(seal.json.code, "PRODUCTION_PACKAGE_ENTRY_MODE_UNSUPPORTED");

    // 原文不进 Task Store。
    const persisted = await fs.readFile(path.join(runtime.root, "state", run.projectId, run.runId, "tasks/index.json"), "utf8");
    assert.equal(persisted.includes(STORY_ENTRY_FIXTURE_TEXT), false);
    assert.equal(persisted.includes("别怕，我带你进屋"), false);

    // 绕过接口直接改写 storySource（模拟篡改）：后续任务因摘要对不上而拒绝。
    const store = new ProductionStateStore({ rootDir: path.join(runtime.root, "state") });
    await store.commitArtifact({ ...run, artifactId: "storySource", artifactType: "storySource",
      content: { ...storySource, storyText: `${STORY_ENTRY_FIXTURE_TEXT}（被改过）` }, dependencies: [], requestId: "tamper",
      expectedCurrentRevision: state.latestArtifacts.storySource.lineage.revision });
    const tampered = await post("/api/tasks/create", { ...run, kind: "storyPipeline", input: { creatorProfile } });
    assert.equal(tampered.status, 409);
    assert.equal(tampered.json.code, "STORY_SOURCE_TAMPERED");
  } finally {
    await runtime.close();
  }
});

test("参考视频 Run 上不能跑剧情入口的流水线", async () => {
  const runtime = await createStoryEntryRuntime({ storyMode: "characterOnly" });
  try {
    const video = await runtime.api("/api/production/run/start", { metadata: { creatorProfile: runtime.creatorProfile } });
    const run = { projectId: video.projectId, runId: video.runId };
    const rejected = await runtime.post("/api/tasks/create", { ...run, kind: "storyPipeline", input: { creatorProfile: runtime.creatorProfile } });
    assert.equal(rejected.status, 409);
    assert.equal(rejected.json.code, "TASK_ENTRY_MODE_MISMATCH");
    // 只给角色设定的 Run 能照常走完两步。
    const started = await runtime.api("/api/production/run/story/start", { metadata: { creatorProfile: runtime.creatorProfile }, storySource: runtime.storySource });
    const storyRun = { projectId: started.production.projectId, runId: started.production.runId };
    const pipeline = await runtime.api("/api/tasks/create", { ...storyRun, kind: "storyPipeline", input: { creatorProfile: runtime.creatorProfile, targetDurationSeconds: 60 } });
    const task = await runtime.wait(pipeline.task, storyRun);
    assert.equal(task.status, "completed", JSON.stringify(task.error));
    const candidatePrompt = runtime.requests.find((request) => request.messages.some((row) => row.role === "user" && row.content.includes("原创一个可以实际拍摄的短视频故事候选")));
    assert.ok(candidatePrompt, "只给角色设定时走原创候选提示词");
    // 页面带来的 creatorProfile 与开 Run 时记录的不一致：拒绝。
    const mismatch = await runtime.post("/api/tasks/create", { ...storyRun, kind: "storyPipeline", input: { creatorProfile: { ...runtime.creatorProfile, vertical: "科普" } } });
    assert.equal(mismatch.status, 409);
    assert.equal(mismatch.json.code, "TASK_BROWSER_ARTIFACT_MISMATCH");
  } finally {
    await runtime.close();
  }
});
