import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mockAnalysis, mockReconstruction, mockBrief, mockVisualGuardrails, mockVariants } from "../src/mock.js";
import { variantSourceResponse } from "./helpers/variant-source-response.js";

// Real server.js, HTTP routes, Task Manager, validators, signing and on-disk
// stores. Only the remote model is replaced by a controlled local SSE server;
// the synthetic media bytes are not decoded or sent to a paid provider.
const stages = ["analysis", "reconstruction", "brief", "visualGuardrails", "variants"];
const artifactIds = ["referenceAnalysis", "sourceScriptReconstruction", "creativeBrief", "visualGuardrails", "themeVariants"];
const input = {
  creatorProfile: { fixedCharacter: "小白子", vertical: "日常", constraints: "" },
  metadata: { duration: 45, width: 320, height: 180 },
  frames: Array.from({ length: 8 }, (_, index) => ({
    timestamp: index * 6,
    dataUrl: "data:image/jpeg;base64,Zml4dHVyZQ=="
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

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mimo-director-control-http-"));
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
      const call = { stage, closed: false, completed: false };
      calls.push(call);
      response.on("close", () => { call.closed = true; });
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      const send = (event) => response.write(`data: ${JSON.stringify(event)}\n\n`);
      send({ id: `fixture-${calls.length}`, choices: [{ delta: { content: "" }, finish_reason: null }] });
      if (stage === "brief" && calls.filter((item) => item.stage === "brief").length === 1) {
        send({ choices: [{ delta: { reasoning_content: "正在构思" }, finish_reason: null }] });
        return; // Held until the application aborts this real HTTP response.
      }
      const prompt = body.messages.at(-1).content;
      const sourceSelection = stage === "variants" ? variantSourceResponse(prompt) : null;
      send({ choices: [{ delta: { content: JSON.stringify(sourceSelection || outputs[stage]) }, finish_reason: null }] });
      send({ choices: [{ delta: {}, finish_reason: "stop" }] });
      send({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
      call.completed = true;
      response.end("data: [DONE]\n\n");
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
    // No user .env, credentials, proxy variables or existing state are inherited.
    cwd: directory,
    env: {
      PATH: process.env.PATH,
      PORT: String(port),
      NODE_ENV: "test",
      QWEN_BASE_URL: `http://127.0.0.1:${providerPort}/v1`,
      QWEN_API_KEY: "local-http-fixture",
      QWEN_MODEL: "analysis-fixture",
      QWEN_MEDIA_MODE: "frames",
      QWEN_JSON_RETRY_ATTEMPTS: "0",
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
    const providerClosed = new Promise((resolve) => provider.close(resolve));
    provider.closeAllConnections();
    await providerClosed;
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
  const query = new URLSearchParams({ pageId, generation: String(workspace.generation), name: "fixture.mp4", type: "video/mp4", lastModified: "1" });
  const upload = await fetch(`${base}/api/browser-workspace/${workspace.id}/source?${query}`, {
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
  const task = (await json("/api/tasks/create", {
    ...ids, kind: "directorPipeline", input: { ...input, sourceVideoDigest: workspace.source.digest }
  }, 202)).task;
  const taskQuery = new URLSearchParams(ids);
  return {
    calls, task,
    control: (action) => json(`/api/tasks/${task.taskId}/control`, { ...ids, action }),
    getTask: async () => (await json(`/api/tasks/${task.taskId}?${taskQuery}`)).task,
    getTasks: async () => (await json(`/api/tasks?${taskQuery}`)).tasks,
    loadRun: async () => (await json("/api/production/run/load", ids)).result,
    async atBrief() {
      await until(() => calls, (value) => value.some((item) => item.stage === "brief"), "Brief provider not reached");
      return calls.find((item) => item.stage === "brief");
    }
  };
}

test("director HTTP pause aborts the active stage; resume redoes only that stage and keeps prior revisions", { timeout: 25000 }, async (t) => {
  const f = await fixture(t);
  const held = await f.atBrief();
  const before = await f.loadRun();
  const beforeTasks = await f.getTasks();
  const interruptedChild = beforeTasks.find((task) => task.kind === "brief");
  assert.ok(interruptedChild);
  const pausedResponse = await f.control("pause");
  assert.equal(pausedResponse.task.taskId, f.task.taskId);
  const paused = await until(f.getTask, (task) => task.progress?.controlState === "paused", "director never paused");
  assert.equal(paused.status, "running");
  await until(() => held.closed, Boolean, "paused provider connection stayed open");
  assert.equal(held.completed, false);
  assert.deepEqual(f.calls.map((call) => call.stage), ["analysis", "reconstruction", "brief"]);
  const during = await f.loadRun();
  assert.equal(during.latestArtifacts.creativeBrief, undefined);
  assert.equal(paused.usage.totalTokens, 30);
  assert.equal(paused.usage.unreportedCalls, 1);
  assert.equal(paused.usage.usageComplete, false);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(f.calls.length, 3, "pause must not trigger an automatic retry");
  const resumedResponse = await f.control("resume");
  assert.equal(resumedResponse.task.taskId, f.task.taskId);
  const completed = await until(f.getTask, (task) => task.status === "completed", "resumed director did not complete");
  const after = await f.loadRun();
  for (const artifactId of artifactIds.slice(0, 2)) {
    assert.equal(after.latestArtifacts[artifactId].lineage.revision, before.latestArtifacts[artifactId].lineage.revision);
    assert.equal(after.latestArtifacts[artifactId].lineage.contentDigest, before.latestArtifacts[artifactId].lineage.contentDigest);
  }
  assert.ok(artifactIds.every((id) => after.latestArtifacts[id]?.lineage.status === "current"));
  assert.deepEqual(f.calls.map((call) => call.stage), ["analysis", "reconstruction", "brief", "brief", "visualGuardrails", "variants", "variants"]);
  const children = (await f.getTasks()).filter((task) => task.kind === "brief");
  assert.equal(children.length, 2);
  const resumedChild = children.find((task) => task.status === "completed");
  assert.notEqual(resumedChild.requestId, interruptedChild.requestId);
  assert.equal(completed.usage.totalTokens, 90);
  assert.equal(completed.usage.unreportedCalls, 1);
  assert.equal(completed.usage.usageComplete, false);
});

test("director HTTP terminate closes the active request, reports known plus unknown usage and blocks later commits", { timeout: 20000 }, async (t) => {
  const f = await fixture(t);
  const held = await f.atBrief();
  const before = await f.loadRun();
  const { task } = await f.control("terminate");
  assert.equal(task.status, "cancelled");
  await until(() => held.closed, Boolean, "terminated provider connection stayed open");
  assert.equal(held.completed, false);
  assert.equal(task.usage.totalTokens, 30);
  assert.equal(task.usage.unreportedCalls, 1);
  assert.equal(task.usage.usageComplete, false);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(f.calls.map((call) => call.stage), ["analysis", "reconstruction", "brief"]);
  const after = await f.loadRun();
  for (const id of artifactIds.slice(0, 2)) assert.deepEqual(after.latestArtifacts[id], before.latestArtifacts[id]);
  for (const id of artifactIds.slice(2)) assert.equal(after.latestArtifacts[id], undefined);
  assert.equal((await f.getTask()).status, "cancelled");
});
