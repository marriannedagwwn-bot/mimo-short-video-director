import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { DurableTaskStore } from "../src/durable-task-store.js";
import { ModelPipelineError } from "../src/model-errors.js";
import { ProductionStateError } from "../src/production-lineage.js";
import { ShotVideoProviderError } from "../src/shot-video-generator.js";
import { serializeServerError } from "../src/server-error.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const secret = "fixture-proxy-secret";
const invalidMessage = "macOS 系统代理配置无效，已阻止外部请求，请检查系统代理设置。";

function nestedProxyError(code = "SYSTEM_PROXY_CONFIG_INVALID") {
  const source = Object.assign(new Error(`https://user:${secret}@proxy.invalid/?token=${secret}`), {
    code, details: [{ authorization: `Bearer ${secret}` }]
  });
  return new TypeError("fetch failed", { cause: new Error(secret, { cause: source }) });
}

function assertProxyResponse(result, code, expectedMessage) {
  assert.equal(result.status, 503);
  assert.equal(result.body.code, code);
  assert.equal(result.body.category, "transport");
  assert.equal(result.body.origin, "system");
  assert.equal(result.body.retryable, false);
  assert.equal(result.body.error, expectedMessage);
  assert.deepEqual(result.body.details, []);
  assert.deepEqual(result.body.attempts, []);
  assert.doesNotMatch(JSON.stringify(result), /fixture-proxy-secret|proxy\.invalid|authorization/);
}

test("system proxy errors preserve a safe typed diagnosis through fetch cause wrappers", () => {
  assertProxyResponse(serializeServerError(nestedProxyError()), "SYSTEM_PROXY_CONFIG_INVALID", invalidMessage);
  const direct = Object.assign(new Error(secret), { code: "SYSTEM_PROXY_CONFIG_INVALID", details: [{ raw: secret }] });
  assertProxyResponse(serializeServerError(direct), "SYSTEM_PROXY_CONFIG_INVALID", invalidMessage);
});

test("system proxy causes take precedence over model pipeline wrappers without exposing raw attempts", () => {
  const error = new ModelPipelineError("fetch failed", {
    code: "MODEL_TRANSPORT_ERROR", category: "transport", origin: "provider",
    httpStatus: 502, retryable: true, cause: nestedProxyError(),
    diagnostics: [{ code: "NETWORK", path: "/", message: secret }],
    attempts: [{ attemptId: "attempt-fixture", message: secret }]
  });
  assertProxyResponse(serializeServerError(error), "SYSTEM_PROXY_CONFIG_INVALID", invalidMessage);
});

test("unknown codes and messages that mention system proxy codes keep existing error handling", () => {
  for (const error of [
    new Error("SYSTEM_PROXY_CONFIG_INVALID " + secret),
    Object.assign(new TypeError("fetch failed"), { code: "SYSTEM_PROXY_UNKNOWN", cause: new Error(secret) }),
    new TypeError("fetch failed", { cause: Object.assign(new Error(secret), { code: "ECONNRESET" }) })
  ]) {
    const result = serializeServerError(error);
    assert.equal(result.status, 500);
    assert.equal(result.body.code, "INTERNAL_ERROR");
    assert.equal(result.body.error, "服务器内部错误");
    assert.doesNotMatch(JSON.stringify(result.body), /fixture-proxy-secret/);
  }
});

test("durable error persistence keeps the safe proxy code for browser polling and legacy reconstruction", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mimo-proxy-error-store-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new DurableTaskStore({ rootDir: directory });
  const index = await store.readIndex("project-fixture", "run-fixture");
  store.createTaskUnlocked(index, {
    taskId: "task-fixture", requestId: "request-fixture", kind: "analysis",
    operationKey: "a".repeat(64), targetArtifactIds: ["referenceAnalysis"]
  });
  store.updateTaskUnlocked(index, "task-fixture", { status: "failed", error: nestedProxyError() });
  await store.writeIndexUnlocked(index);
  const stored = await fs.readFile(store.indexPath(index.projectId, index.runId), "utf8");
  assert.doesNotMatch(stored, /fixture-proxy-secret|proxy\.invalid|authorization|cause|stack/);
  const restored = (await store.getTask({ projectId: index.projectId, runId: index.runId, taskId: "task-fixture" })).error;
  assert.deepEqual(restored, {
    code: "SYSTEM_PROXY_CONFIG_INVALID", category: "transport", message: invalidMessage, details: []
  });
  // Browser waitForDurableTask displays task.error.message. Legacy routes
  // reconstruct ProductionStateError from these same persisted fields.
  const legacyError = new ProductionStateError(restored.message, {
    code: restored.code, httpStatus: 500, details: restored.details
  });
  legacyError.category = restored.category;
  assertProxyResponse(serializeServerError(legacyError), "SYSTEM_PROXY_CONFIG_INVALID", invalidMessage);
});

async function within(promise, timeoutMs = 8000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("isolated proxy error fixture timed out")), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

async function isolatedEntry(t, entry, extraEnv = {}, makeArgs = () => []) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mimo-proxy-error-entry-"));
  const preload = path.join(directory, "blocked-proxy.mjs");
  await fs.writeFile(preload, `import { initializeSystemProxy } from ${JSON.stringify(pathToFileURL(path.join(root, "src/system-proxy.js")).href)};
await initializeSystemProxy({
  platform: "darwin",
  readSnapshot: async () => ({ ProxyAutoConfigEnable: 1, ProxyAutoConfigURLString: "https://user:fixture-proxy-secret@pac.invalid" }),
  pollIntervalMs: 0, env: process.env
});
`);
  const args = await makeArgs(directory);
  const child = spawn(process.execPath, ["--import", preload, path.join(root, entry), ...args], {
    cwd: directory,
    env: {
      PATH: process.env.PATH, NODE_ENV: "test",
      WORKFLOW_PRODUCTION_STATE_DIR: path.join(directory, "production"),
      PARTIAL_REPAIR_DEBUG_DIR: path.join(directory, "debug"),
      ...extraEnv
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await within(exited, 2000).catch(() => child.kill("SIGKILL"));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, child, exited, stdout: () => stdout, stderr: () => stderr };
}

test("real video worker stderr keeps the safe Chinese proxy diagnosis visible in shot-video detail", { timeout: 12000 }, async (t) => {
  const f = await isolatedEntry(t, "workers/generic-http-worker.mjs", {}, async (directory) => {
    const config = path.join(directory, "provider.json");
    const request = path.join(directory, "request.json");
    await fs.writeFile(config, JSON.stringify({
      videoEndpoint: "https://controlled-provider.invalid/generate", videoModel: "fixture",
      timeoutMs: 1000, includeRawRequest: true
    }));
    await fs.writeFile(request, JSON.stringify({
      taskId: "task-fixture", capability: "first_last_frame_video_generation",
      provider: "VideoHTTP", prompt: "local diagnosis fixture", inputArtifacts: []
    }));
    return ["--config", config, "--request", request, "--output", path.join(directory, "output.mp4"), "--receipt", path.join(directory, "receipt.json")];
  });
  const result = await within(f.exited);
  assert.equal(result.code, 1);
  assert.match(f.stderr(), /SYSTEM_PROXY_AUTOMATIC_UNSUPPORTED/);
  assert.match(f.stderr(), /PAC.*已阻止外部请求/s);
  assert.doesNotMatch(f.stderr(), /fixture-proxy-secret|user:|pac\.invalid/);
  // runGenericWorker deliberately carries stderr in ShotVideoProviderError.
  const visible = serializeServerError(new ShotVideoProviderError(f.stderr().trim()));
  assert.equal(visible.status, 502);
  assert.equal(visible.body.code, "SHOT_VIDEO_PROVIDER_ERROR");
  assert.match(visible.body.detail, /PAC.*已阻止外部请求/s);
  assert.doesNotMatch(JSON.stringify(visible), /fixture-proxy-secret|user:|pac\.invalid/);
});

test("real server durable failure returns the safe proxy diagnosis after disk persistence", { timeout: 15000 }, async (t) => {
  const reserved = http.createServer();
  await new Promise((resolve) => reserved.listen(0, "127.0.0.1", resolve));
  const port = reserved.address().port;
  await new Promise((resolve) => reserved.close(resolve));
  const f = await isolatedEntry(t, "server.js", {
    PORT: String(port), QWEN_BASE_URL: "https://controlled-provider.invalid/v1",
    QWEN_API_KEY: "local-fixture", QWEN_MEDIA_MODE: "frames", QWEN_JSON_RETRY_ATTEMPTS: "0"
  });
  const base = `http://127.0.0.1:${port}`;
  const requestJson = async (route, body, expectedStatus = 200) => {
    const response = await fetch(base + route, {
      ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(3000)
    });
    const value = await response.json();
    assert.equal(response.status, expectedStatus, JSON.stringify(value));
    return value;
  };
  const deadline = Date.now() + 8000;
  while (!f.stdout().includes(`http://localhost:${port}`)) {
    assert.ok(Date.now() < deadline, f.stderr());
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  const pageId = randomUUID();
  let workspace = (await requestJson("/api/browser-workspace/start", { pageId })).result.workspace;
  const query = new URLSearchParams({ pageId, generation: String(workspace.generation), name: "fixture.mp4", type: "video/mp4", lastModified: "1" });
  const upload = await fetch(`${base}/api/browser-workspace/${workspace.id}/source?${query}`, {
    method: "PUT", headers: { "Content-Type": "video/mp4" }, body: "synthetic source fixture"
  });
  assert.equal(upload.status, 200);
  workspace = (await upload.json()).result.workspace;
  const creatorProfile = { fixedCharacter: "小白子", vertical: "日常", constraints: "" };
  const run = (await requestJson("/api/production/run/start", {
    projectId: "project-proxy-error", workspaceId: workspace.id,
    workspaceGeneration: workspace.generation, workspacePageId: pageId,
    metadata: { creatorProfile, sourceVideoDigest: workspace.source.digest }
  })).result;
  const ids = { projectId: run.projectId, runId: run.runId };
  const initial = (await requestJson("/api/tasks/create", {
    ...ids, kind: "directorPipeline", input: {
      creatorProfile, sourceVideoDigest: workspace.source.digest, count: 3,
      metadata: { duration: 45, width: 320, height: 180 },
      frames: Array.from({ length: 8 }, (_, index) => ({
        timestamp: index * 6, dataUrl: "data:image/jpeg;base64,Zml4dHVyZQ=="
      }))
    }
  }, 202)).task;
  let task = initial;
  while (["queued", "running"].includes(task.status)) {
    assert.ok(Date.now() < deadline, `task did not fail: ${JSON.stringify(task)}\n${f.stderr()}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
    task = (await requestJson(`/api/tasks/${task.taskId}?${new URLSearchParams(ids)}`)).task;
  }
  assert.equal(task.status, "failed");
  assert.equal(task.error.code, "SYSTEM_PROXY_AUTOMATIC_UNSUPPORTED");
  assert.equal(task.error.category, "transport");
  assert.match(task.error.message, /PAC.*已阻止外部请求/s);
  assert.deepEqual(task.error.details, []);
  const indexPath = path.join(f.directory, "production", ids.projectId, ids.runId, "tasks", "index.json");
  const persisted = JSON.parse(await fs.readFile(indexPath, "utf8"));
  assert.deepEqual(persisted.tasks[task.taskId].error, task.error);
  assert.doesNotMatch(JSON.stringify(task.error), /fixture-proxy-secret|pac\.invalid|cause|stack/);
});
