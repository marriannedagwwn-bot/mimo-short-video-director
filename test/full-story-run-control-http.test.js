import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mockAnalysis, mockReconstruction, mockBrief, mockVisualGuardrails,
  mockVariants, mockFullStory, mockNarrativeFullStory, mockAnimationPlan
} from "../src/mock.js";
import { lineageRef } from "../src/production-lineage.js";
import { FULL_STORY_BEAT_SCENE_POSTPASS_SCHEMA_VERSION } from "../src/full-story-beat-scene-postpass.js";
import { variantSourceResponse } from "./helpers/variant-source-response.js";

// Exercise server.js, real HTTP/SSE transport, validation, signing, task control
// and on-disk lineage. The only provider is a local fixture; its review pass is
// protocol data for this lifecycle test, not evidence of narrative quality.
const stages = ["analysis", "reconstruction", "brief", "visualGuardrails", "variants", "fullStory"];
const upstreamIds = ["referenceAnalysis", "sourceScriptReconstruction", "creativeBrief", "visualGuardrails", "themeVariants"];
const downstreamIds = ["fullStory:V1", "animationPlan:V1", "shotVideo:V1:A01"];
const input = {
  creatorProfile: { fixedCharacter: "小白子", vertical: "日常", constraints: "" },
  metadata: { duration: 45, width: 320, height: 180 },
  frames: Array.from({ length: 8 }, (_, index) => ({
    timestamp: index * 6, dataUrl: "data:image/jpeg;base64,Zml4dHVyZQ=="
  })),
  count: 3,
  transcript: "",
  modelOverrides: Object.fromEntries(stages.map((stage) => [stage, { provider: "Qwen", model: `${stage}-fixture` }]))
};

async function until(read, predicate, message, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  let value;
  while (Date.now() < end) {
    value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  assert.fail(`${message}: ${JSON.stringify(value)}`);
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

function postpassResponse(prompt) {
  const marker = "待审完整 Full Story JSON（这是本次唯一业务输入）：\n";
  if (!prompt.includes(marker)) return null;
  const story = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length));
  return {
    schemaVersion: FULL_STORY_BEAT_SCENE_POSTPASS_SCHEMA_VERSION,
    status: "pass",
    reviews: story.beatSheet.map((beat, beatIndex) => ({
      beatIndex, beat: beat.beat,
      sceneIds: [story.sceneScript[Math.min(beatIndex, story.sceneScript.length - 1)].sceneId],
      verdict: "pass", issueCode: "none", beatEvidence: "", sceneEvidence: "",
      nextStateEvidence: "", reason: "", completionId: ""
    })),
    completions: []
  };
}

async function fixture(t, { narrative = false } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mimo-full-story-control-http-"));
  const analysis = mockAnalysis(input);
  const reconstruction = mockReconstruction(input);
  const brief = mockBrief({ ...input, referenceAnalysis: analysis, sourceScriptReconstruction: reconstruction });
  const outputs = {
    analysis, reconstruction, brief,
    visualGuardrails: mockVisualGuardrails({ ...input, creativeBrief: brief }),
    variants: mockVariants(input)
  };
  const calls = [];
  const providerErrors = [];
  const provider = http.createServer(async (request, response) => {
    try {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      assert.equal(body.stream, true);
      assert.equal(body.stream_options.include_usage, true);
      const stage = body.model.replace(/-fixture$/u, "");
      assert.ok(stages.includes(stage));
      const prompt = body.messages.at(-1).content;
      const review = stage === "fullStory" ? postpassResponse(prompt) : null;
      const call = { stage, phase: review ? "postpass" : "main", closed: false, completed: false };
      calls.push(call);
      response.on("close", () => { call.closed = true; });
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      const send = (event) => response.write(`data: ${JSON.stringify(event)}\n\n`);
      send({ id: `fixture-${calls.length}`, choices: [{ delta: { content: "" }, finish_reason: null }] });
      const source = stage === "variants" ? variantSourceResponse(prompt) : null;
      const value = review || source || outputs[stage];
      assert.ok(value, `fixture output missing for ${stage}`);
      call.finish = () => {
        send({ choices: [{ delta: { content: JSON.stringify(value) }, finish_reason: null }] });
        send({ choices: [{ delta: {}, finish_reason: "stop" }] });
        send({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
        call.completed = true;
        response.end("data: [DONE]\n\n");
      };
      if (review && calls.filter((item) => item.phase === "postpass").length === 1) {
        send({ choices: [{ delta: { reasoning_content: "正在核对节拍" }, finish_reason: null }] });
        return; // Pause/terminate must close this actual HTTP response.
      }
      if (narrative && stage === "fullStory" && calls.filter((item) => item.stage === "fullStory").length === 1) {
        return; // The versioned format has only the primary operation to pause.
      }
      call.finish();
    } catch (error) {
      providerErrors.push(error.message);
      response.destroy(error);
    }
  });
  const providerPort = await listen(provider);
  const reserved = http.createServer();
  const port = await listen(reserved);
  await new Promise((resolve) => reserved.close(resolve));
  let logs = "";
  const child = spawn(process.execPath, [fileURLToPath(new URL("../server.js", import.meta.url))], {
    cwd: directory,
    // Explicit environment excludes user .env, credentials and existing state.
    env: {
      PATH: process.env.PATH, PORT: String(port), NODE_ENV: "test",
      QWEN_BASE_URL: `http://127.0.0.1:${providerPort}/v1`,
      QWEN_API_KEY: "local-http-fixture", QWEN_MODEL: "analysis-fixture",
      QWEN_MEDIA_MODE: "frames", QWEN_JSON_RETRY_ATTEMPTS: "0",
      WORKFLOW_PRODUCTION_STATE_DIR: path.join(directory, "production"),
      PARTIAL_REPAIR_DEBUG_DIR: path.join(directory, "debug"),
      MODEL_PRICE_CNY_PER_MILLION: stages.map((stage) => `${stage}-fixture=1/1`).join(",")
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  t.after(async () => {
    child.kill("SIGTERM");
    const force = setTimeout(() => child.kill("SIGKILL"), 1000);
    await exited;
    clearTimeout(force);
    const closed = new Promise((resolve) => provider.close(resolve));
    provider.closeAllConnections();
    await closed;
    await fs.rm(directory, { recursive: true, force: true });
    assert.deepEqual(providerErrors, [], "local provider protocol errors");
  });
  await until(() => logs, (value) => value.includes(`http://localhost:${port}`), "server did not start");
  const base = `http://127.0.0.1:${port}`;
  const json = async (route, body, expectedStatus = 200) => {
    const response = await fetch(`${base}${route}`, {
      ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5000)
    });
    const value = await response.json();
    assert.equal(response.status, expectedStatus, JSON.stringify(value));
    return value;
  };
  const pageId = randomUUID();
  let workspace = (await json("/api/browser-workspace/start", { pageId })).result.workspace;
  const uploadQuery = new URLSearchParams({ pageId, generation: String(workspace.generation), name: "fixture.mp4", type: "video/mp4", lastModified: "1" });
  const upload = await fetch(`${base}/api/browser-workspace/${workspace.id}/source?${uploadQuery}`, {
    method: "PUT", headers: { "Content-Type": "video/mp4" }, body: "synthetic video fixture"
  });
  assert.equal(upload.status, 200);
  workspace = (await upload.json()).result.workspace;
  const run = (await json("/api/production/run/start", {
    projectId: `project-${randomUUID()}`,
    workspaceId: workspace.id, workspaceGeneration: workspace.generation, workspacePageId: pageId,
    metadata: { creatorProfile: input.creatorProfile, sourceVideoDigest: workspace.source.digest }
  })).result;
  const ids = { projectId: run.projectId, runId: run.runId };
  const taskQuery = new URLSearchParams(ids);
  const getTask = async (taskId) => (await json(`/api/tasks/${taskId}?${taskQuery}`)).task;
  const loadRun = async () => (await json("/api/production/run/load", ids)).result;
  const director = (await json("/api/tasks/create", {
    ...ids, kind: "directorPipeline", input: { ...input, sourceVideoDigest: workspace.source.digest }
  }, 202)).task;
  await until(() => getTask(director.taskId), (task) => task.status === "completed", "fixture director failed");
  const current = (await loadRun()).latestArtifacts;
  const commit = async (artifactId, artifactType, content, dependencies, options = {}) => (
    await json("/api/production/artifact/commit", {
      ...ids, artifactId, artifactType, content, dependencies,
      requestId: randomUUID(), expectedCurrentRevision: null, ...options
    })
  ).result;
  const variant = current.themeVariants.content.variants[0];
  const candidate = await commit("variant:V1", "selectedVariant", variant, [lineageRef(current.themeVariants.lineage)]);
  const storyInput = {
    ...input, variant,
    creativeBrief: current.creativeBrief.content,
    visualGuardrails: current.visualGuardrails.content
  };
  const originalStory = mockFullStory(storyInput);
  const story = await commit("fullStory:V1", "fullStory", originalStory, [
    ...upstreamIds.map((id) => lineageRef(current[id].lineage)), lineageRef(candidate.lineage)
  ]);
  const plan = await commit("animationPlan:V1", "animationPlan", mockAnimationPlan({
    ...storyInput, fullStory: originalStory, animationPlanMode: "direct_shot", targetAspectRatio: "16:9"
  }), [lineageRef(candidate.lineage), lineageRef(story.lineage)], { createMediaNamespace: true });
  await commit("shotVideo:V1:A01", "shotVideo", {
    result: { outputUrl: "/fixture/original-A01.mp4" }, selectedIndex: 0
  }, [lineageRef(plan.lineage)]);
  outputs.fullStory = narrative ? mockNarrativeFullStory(storyInput) : structuredClone(originalStory);
  if (!narrative) outputs.fullStory.shootingPlan[0].practicalNote = "使用窗边自然光完成这次拍摄。";
  const createBody = {
    ...ids, kind: "fullStory",
    input: { variantId: "V1", creatorProfile: input.creatorProfile, candidateBinding: lineageRef(candidate.lineage), modelOverrides: input.modelOverrides }
  };
  const task = (await json("/api/tasks/create", createBody, 202)).task;
  return {
    calls, task, loadRun,
    control: (action) => json(`/api/tasks/${task.taskId}/control`, { ...ids, action }),
    getTask: () => getTask(task.taskId),
    getTasks: async () => (await json(`/api/tasks?${taskQuery}`)).tasks,
    recreate: () => json("/api/tasks/create", createBody, 202),
    async atPrimary() {
      await until(() => calls, (value) => value.some((call) => call.stage === "fullStory"), "Full Story provider not reached");
      return calls.find((call) => call.stage === "fullStory");
    },
    async atPostpass() {
      await until(() => calls, (value) => value.some((call) => call.phase === "postpass"), "Full Story postpass provider not reached");
      return calls.find((call) => call.phase === "postpass");
    }
  };
}

test("Full Story HTTP pause closes postpass, survives reattach and resumes the same task with cumulative usage", { timeout: 25000 }, async (t) => {
  const f = await fixture(t);
  const held = await f.atPostpass();
  const before = await f.loadRun();
  const { task: pausing } = await f.control("pause");
  assert.equal(pausing.taskId, f.task.taskId);
  const paused = await until(f.getTask, (task) => task.progress?.controlState === "paused", "Full Story never paused");
  assert.equal(paused.status, "running");
  await until(() => held.closed, Boolean, "paused postpass connection stayed open");
  assert.equal(held.completed, false);
  assert.equal(paused.usage.totalTokens, 15);
  assert.equal(paused.usage.unreportedCalls, 1);
  assert.equal(paused.usage.usageComplete, false);
  const reattached = (await f.getTasks()).find((task) => task.taskId === f.task.taskId);
  assert.equal(reattached.progress.controlState, "paused");
  assert.equal((await f.recreate()).task.taskId, f.task.taskId);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(f.calls.filter((call) => call.stage === "fullStory").map((call) => call.phase), ["main", "postpass"]);
  const during = await f.loadRun();
  for (const id of downstreamIds) assert.deepEqual(during.latestArtifacts[id], before.latestArtifacts[id]);
  const { task: resumed } = await f.control("resume");
  assert.equal(resumed.taskId, f.task.taskId);
  const completed = await until(f.getTask, (task) => task.status === "completed", "resumed Full Story failed");
  assert.equal(completed.usage.totalTokens, 45);
  assert.equal(completed.usage.unreportedCalls, 1);
  assert.equal(completed.usage.usageComplete, false);
  assert.deepEqual(f.calls.filter((call) => call.stage === "fullStory").map((call) => call.phase), ["main", "postpass", "main", "postpass"]);
  const after = await f.loadRun();
  for (const id of [...upstreamIds, "variant:V1"]) assert.deepEqual(after.latestArtifacts[id], before.latestArtifacts[id]);
  assert.equal(after.latestArtifacts["fullStory:V1"].lineage.status, "current");
  assert.notEqual(after.latestArtifacts["fullStory:V1"].lineage.revision, before.latestArtifacts["fullStory:V1"].lineage.revision);
  assert.equal(after.latestArtifacts["fullStory:V1"].content.shootingPlan[0].practicalNote, "使用窗边自然光完成这次拍摄。");
  for (const id of downstreamIds.slice(1)) {
    assert.equal(after.latestArtifacts[id].lineage.status, "stale");
    assert.deepEqual(after.latestArtifacts[id].content, before.latestArtifacts[id].content);
  }
});

test("Versioned Full Story HTTP pause resumes the same frozen task, commits once and invalidates old downstream media", { timeout: 25000 }, async (t) => {
  const f = await fixture(t, { narrative: true });
  const held = await f.atPrimary();
  const before = await f.loadRun();
  await f.control("pause");
  const paused = await until(f.getTask, (task) => task.progress?.controlState === "paused", "narrative operation never paused");
  await until(() => held.closed, Boolean, "primary connection stayed open");
  assert.equal(paused.taskId, f.task.taskId);
  assert.equal(paused.usage.unreportedCalls, 1);
  assert.equal((await f.recreate()).task.taskId, f.task.taskId);
  assert.deepEqual((await f.loadRun()).latestArtifacts, before.latestArtifacts);
  await f.control("resume");
  const completed = await until(f.getTask, (task) => task.status === "completed", "versioned operation did not complete");
  assert.equal(completed.taskId, f.task.taskId);
  assert.equal(completed.usage.totalTokens, 15);
  assert.equal(completed.usage.unreportedCalls, 1);
  assert.equal(completed.usage.usageComplete, false);
  assert.deepEqual(f.calls.filter((call) => call.stage === "fullStory").map((call) => call.phase), ["main", "main"]);
  held.finish();
  const after = await f.loadRun();
  const story = after.latestArtifacts["fullStory:V1"];
  assert.equal(story.content.schemaVersion, "full_story/1.1");
  assert.equal(Object.hasOwn(story.content, "beatSheet"), false);
  assert.equal(story.lineage.status, "current");
  for (const id of [...upstreamIds, "variant:V1"]) assert.deepEqual(after.latestArtifacts[id], before.latestArtifacts[id]);
  for (const id of downstreamIds.slice(1)) {
    assert.equal(after.latestArtifacts[id].lineage.status, "stale");
    assert.deepEqual(after.latestArtifacts[id].content, before.latestArtifacts[id].content);
  }
  const settled = await f.control("terminate");
  assert.equal(settled.task.status, "completed");
  assert.deepEqual((await f.loadRun()).latestArtifacts, after.latestArtifacts);
});

test("Full Story HTTP terminate aborts postpass and retains old current Story, Plan and media after a late provider response", { timeout: 20000 }, async (t) => {
  const f = await fixture(t);
  const held = await f.atPostpass();
  const before = await f.loadRun();
  const { task } = await f.control("terminate");
  assert.equal(task.status, "cancelled");
  assert.equal(task.usage.totalTokens, 15);
  assert.equal(task.usage.unreportedCalls, 1);
  assert.equal(task.usage.usageComplete, false);
  await until(() => held.closed, Boolean, "terminated postpass connection stayed open");
  assert.equal(held.completed, false);
  held.finish(); // The server must ignore a provider attempting to finish late.
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(f.calls.filter((call) => call.stage === "fullStory").map((call) => call.phase), ["main", "postpass"]);
  const after = await f.loadRun();
  assert.deepEqual(after.latestArtifacts, before.latestArtifacts);
  for (const id of downstreamIds) assert.equal(after.latestArtifacts[id].lineage.status, "current");
  assert.equal((await f.getTask()).status, "cancelled");
});
