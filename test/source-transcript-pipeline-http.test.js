import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mockAnalysis, mockReconstruction, mockBrief, mockVisualGuardrails } from "../src/mock.js";
import { fakeReferenceToolsEnv, scriptVariantsOutput } from "./helpers/fake-reference-tools.js";

// AI 导演第一步「去配乐与转写」（2026-10-24）走真的 server.js、任务管理器与状态库；
// 本机工具用替身（helpers/fake-reference-tools.js），模型是本地 SSE 夹具。

const stages = ["analysis", "reconstruction", "brief", "visualGuardrails", "variants"];
const input = {
  creatorProfile: { fixedCharacter: "小白子", vertical: "日常", constraints: "" },
  metadata: { duration: 45, width: 320, height: 180 },
  frames: Array.from({ length: 8 }, (_, index) => ({ timestamp: index * 6, dataUrl: "data:image/jpeg;base64,Zml4dHVyZQ==" })),
  count: 3,
  transcript: "",
  modelOverrides: {
    ...Object.fromEntries(stages.slice(0, 4).map((stage) => [stage, { provider: "Qwen", model: `${stage}-fixture` }])),
    referenceRewrite: { provider: "MiMo", model: "variants-fixture" }
  }
};

async function until(read, predicate, message, timeoutMs = 10000) {
  const end = Date.now() + timeoutMs;
  let value;
  while (Date.now() < end) {
    value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`${message}: ${JSON.stringify(value)}`);
}

async function listen(server) {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return server.address().port;
}

async function fixture(t, { tools = true } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mimo-source-transcript-http-"));
  const analysis = mockAnalysis(input);
  const reconstruction = mockReconstruction(input);
  const brief = mockBrief({ ...input, referenceAnalysis: analysis, sourceScriptReconstruction: reconstruction });
  const outputs = {
    analysis, reconstruction, brief,
    visualGuardrails: mockVisualGuardrails({ ...input, creativeBrief: brief }),
    variants: scriptVariantsOutput({ count: input.count, characterName: "小白子" })
  };
  const calls = [];
  const provider = http.createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const stage = body.model.replace(/-fixture$/u, "");
    // 带图的请求 content 是数组（图片块＋文字块），只取文字。
    const content = body.messages.at(-1).content;
    const prompt = Array.isArray(content) ? content.map((part) => part?.text || "").join("") : String(content || "");
    calls.push({ stage, prompt });
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    const send = (event) => response.write(`data: ${JSON.stringify(event)}\n\n`);
    send({ choices: [{ delta: { content: JSON.stringify(outputs[stage]) }, finish_reason: null }] });
    send({ choices: [{ delta: {}, finish_reason: "stop" }] });
    send({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
    response.end("data: [DONE]\n\n");
  });
  const providerPort = await listen(provider);
  const reserved = http.createServer();
  const port = await listen(reserved);
  await new Promise((resolve) => reserved.close(resolve));
  let logs = "";
  const child = spawn(process.execPath, [fileURLToPath(new URL("../server.js", import.meta.url))], {
    cwd: directory,
    env: {
      ...(tools ? await fakeReferenceToolsEnv(directory) : { PATH: process.env.PATH }),
      PORT: String(port), NODE_ENV: "test",
      QWEN_BASE_URL: `http://127.0.0.1:${providerPort}/v1`, QWEN_API_KEY: "local-http-fixture",
      QWEN_MODEL: "analysis-fixture", QWEN_MEDIA_MODE: "frames", QWEN_JSON_RETRY_ATTEMPTS: "0",
      MIMO_BASE_URL: `http://127.0.0.1:${providerPort}/v1`, MIMO_API_KEY: "local-http-fixture", MIMO_JSON_RETRY_ATTEMPTS: "0",
      WORKFLOW_PRODUCTION_STATE_DIR: path.join(directory, "production")
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
  workspace = (await upload.json()).result.workspace;
  const run = (await json("/api/production/run/start", {
    projectId: `project-${randomUUID()}`,
    workspaceId: workspace.id, workspaceGeneration: workspace.generation, workspacePageId: pageId,
    metadata: { creatorProfile: input.creatorProfile, sourceVideo: { name: "fixture.mp4", duration: 45 }, sourceVideoDigest: workspace.source.digest }
  })).result;
  const ids = { projectId: run.projectId, runId: run.runId };
  const taskQuery = new URLSearchParams(ids);
  return {
    calls, ids, json,
    pipelineBody: { ...ids, kind: "directorPipeline", input: { ...input, sourceVideoDigest: workspace.source.digest } },
    getTask: async (taskId) => (await json(`/api/tasks/${taskId}?${taskQuery}`)).task,
    getTasks: async () => (await json(`/api/tasks?${taskQuery}`)).tasks,
    loadRun: async () => (await json("/api/production/run/load", ids)).result
  };
}

test("本机工具不齐：建任务之前就 409，写明缺什么，不建任何任务", { timeout: 20000 }, async (t) => {
  const f = await fixture(t, { tools: false });
  const error = await f.json("/api/tasks/create", f.pipelineBody, 409);
  assert.equal(error.code, "SOURCE_TRANSCRIPT_TOOLS_UNAVAILABLE");
  assert.match(error.error, /去配乐与转写用不了：REFERENCE_REWRITE_BANDIT_DIR 没有设置/u);
  assert.deepEqual(await f.getTasks(), []);
  assert.equal(f.calls.length, 0);
});

test("旧 Run 里没听过台词稿的分析会重跑；转写稿逐字进分析与还原；剧本变体的台词核对按剧本比", { timeout: 25000 }, async (t) => {
  const f = await fixture(t);
  // 照旧 Run 的样子先放一份没有任何依赖的分析。
  const old = (await f.json("/api/production/artifact/commit", {
    ...f.ids, artifactId: "referenceAnalysis", artifactType: "referenceAnalysis",
    content: mockAnalysis(input), dependencies: [], requestId: randomUUID(), expectedCurrentRevision: null
  })).result;
  const task = (await f.json("/api/tasks/create", f.pipelineBody, 202)).task;
  const done = await until(() => f.getTask(task.taskId), (value) => ["completed", "failed"].includes(value.status), "pipeline did not settle");
  assert.equal(done.status, "completed", JSON.stringify(done.error || null));
  assert.deepEqual(f.calls.map((call) => call.stage), ["analysis", "reconstruction", "brief", "visualGuardrails", "variants"]);
  const run = await f.loadRun();
  const transcript = run.latestArtifacts.sourceTranscript.content;
  assert.equal(transcript.schemaVersion, "source_transcript/1.0");
  assert.equal(transcript.separator, "bandit-v2-multi");
  assert.equal(transcript.voiceRecovery, "mel-roformer-kim-vocal-2");
  assert.equal(transcript.whisperEngine, "mlx-whisper");
  assert.match(transcript.text, /快进来（original-16k）/u);
  assert.match(transcript.text, /## B\. 人声轨转写（Bandit 对白＋捞回的叫声、笑声）\n\n```\n00:01\.0–00:02\.5  快进来（voice-16k）/u);
  assert.match(transcript.text, /- 人声轨：1\.00–2\.50/u);
  assert.notEqual(run.latestArtifacts.referenceAnalysis.lineage.revision, old.lineage.revision, "旧分析被重跑");
  for (const stage of ["analysis", "reconstruction"]) {
    assert.ok(f.calls.find((call) => call.stage === stage).prompt.includes(transcript.text), `${stage} 收到同一份转写稿`);
  }
  assert.equal(f.calls.find((call) => call.stage === "brief").prompt.includes(transcript.text), false);
  const variantsPrompt = f.calls.find((call) => call.stage === "variants").prompt;
  assert.ok(variantsPrompt.includes(transcript.text));
  assert.match(variantsPrompt, /前面附了 4 张图：原片按每秒 2 帧抽帧拼成的接触表/u);
  const themeVariants = run.latestArtifacts.themeVariants;
  assert.deepEqual(themeVariants.lineage.dependencies.map((item) => item.artifactId).sort(),
    ["creativeBrief", "referenceAnalysis", "sourceScriptReconstruction", "sourceTranscript", "visualGuardrails"]);
  assert.equal(themeVariants.content.materials.frameCount, 90);
  assert.equal(themeVariants.content.materials.targetDurationSeconds, 45, "没给剧情时长目标时与原片对齐");

  // 剧本变体的台词核对：原文是选中那篇的「标题＋剧本」。
  const variant = themeVariants.content.variants[0];
  const selected = (await f.json("/api/production/artifact/commit", {
    ...f.ids, artifactId: "variant:V1", artifactType: "selectedVariant", content: variant,
    dependencies: [{ artifactId: "themeVariants", revision: themeVariants.lineage.revision, contentDigest: themeVariants.lineage.contentDigest }],
    requestId: randomUUID(), expectedCurrentRevision: null
  })).result;
  assert.equal(selected.lineage.status, "current");
  const story = { sceneScript: [{ sceneId: "S1", dialogue: [{ speaker: "小白子", line: "嘿嘿！" }, { speaker: "小白子", line: "剧本里没有这句" }] }] };
  await f.json("/api/production/artifact/commit", {
    ...f.ids, artifactId: "fullStory:V1", artifactType: "fullStory", content: story,
    dependencies: [{ artifactId: "variant:V1", revision: selected.lineage.revision, contentDigest: selected.lineage.contentDigest }],
    requestId: randomUUID(), expectedCurrentRevision: null
  });
  const report = (await f.json("/api/production/story-entry/dialogue-check", { ...f.ids, variantId: "V1" })).result;
  assert.equal(report.applicable, true);
  assert.equal(report.checked, 2);
  assert.deepEqual(report.missing.map((item) => item.text), ["剧本里没有这句"]);
  // 旧格式候选没有可比的原文：明确拒绝。
  const error = await f.json("/api/production/story-entry/dialogue-check", { ...f.ids, variantId: "V9" }, 409);
  assert.equal(error.code, "DIALOGUE_CHECK_SOURCE_UNSUPPORTED");
});
