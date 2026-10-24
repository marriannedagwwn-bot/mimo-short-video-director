import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { ensureReferenceRewriteContract } from "../src/reference-rewrite.js";

// 参考片仿写（2026-10-24）走真的 server.js、任务管理器与状态库。
// 演示模式（不配任何模型）不跑本机工具，能免费走完整个任务；配了模型而本机工具不齐时，建任务之前就 409。

const serverPath = fileURLToPath(new URL("../server.js", import.meta.url));
const creatorProfile = { fixedCharacter: "咕嘎：穿企鹅连体衣的小女孩", vertical: "治愈", constraints: "" };

async function until(read, predicate, message, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  let value;
  while (Date.now() < end) {
    value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`${message}: ${JSON.stringify(value)}`);
}

async function startServer(t, extraEnv = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mimo-reference-rewrite-http-"));
  const port = 20000 + Math.floor(Math.random() * 20000);
  let logs = "";
  // 不继承用户的 .env、密钥、代理与已有状态。
  const child = spawn(process.execPath, [serverPath], {
    cwd: directory,
    env: {
      PATH: process.env.PATH,
      PORT: String(port),
      NODE_ENV: "test",
      WORKFLOW_PRODUCTION_STATE_DIR: path.join(directory, "production"),
      ...extraEnv
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
    await fs.rm(directory, { recursive: true, force: true });
  });
  await until(() => logs, (value) => value.includes(`http://localhost:${port}`) || child.exitCode !== null, "server did not start");
  assert.equal(child.exitCode, null, logs);
  const base = `http://127.0.0.1:${port}`;
  const call = async (route, body, expectedStatus = 200) => {
    const response = await fetch(`${base}${route}`, {
      ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5000)
    });
    const value = await response.json();
    assert.equal(response.status, expectedStatus, JSON.stringify(value));
    return value;
  };
  const videoRun = async () => {
    const pageId = randomUUID();
    let workspace = (await call("/api/browser-workspace/start", { pageId })).result.workspace;
    const query = new URLSearchParams({ pageId, generation: String(workspace.generation), name: "撑伞.mp4", type: "video/mp4", lastModified: "1" });
    const upload = await fetch(`${base}/api/browser-workspace/${workspace.id}/source?${query}`, {
      method: "PUT", headers: { "Content-Type": "video/mp4" }, body: "synthetic video fixture"
    });
    assert.equal(upload.status, 200);
    workspace = (await upload.json()).result.workspace;
    const run = (await call("/api/production/run/start", {
      workspaceId: workspace.id, workspaceGeneration: workspace.generation, workspacePageId: pageId,
      metadata: { creatorProfile, sourceVideo: { name: "撑伞.mp4", duration: 51 }, sourceVideoDigest: workspace.source.digest }
    })).result;
    return { projectId: run.projectId, runId: run.runId };
  };
  return { call, videoRun };
}

test("演示模式：在参考视频 Run 上跑完任务，提交 referenceRewrite，内容过契约；健康检查报可用", { timeout: 30_000 }, async (t) => {
  const server = await startServer(t);
  const health = await server.call("/api/health");
  assert.deepEqual(health.referenceRewrite, { available: true, demo: true, reason: "", missing: [] });
  assert.equal(health.modelStages.referenceRewrite.provider, "Claude");
  assert.equal(health.modelStages.referenceRewrite.model, "claude-opus-5-5");
  assert.equal(health.modelStages.referenceRewrite.effort, "xhigh");

  const ids = await server.videoRun();
  await server.call("/api/tasks/create", { ...ids, kind: "referenceRewrite", input: { targetDurationSeconds: 19 } }, 400);
  const created = await server.call("/api/tasks/create", { ...ids, kind: "referenceRewrite", input: { targetDurationSeconds: 51 } }, 202);
  const query = new URLSearchParams(ids);
  const task = await until(
    async () => (await server.call(`/api/tasks/${created.task.taskId}?${query}`)).task,
    (value) => !["queued", "running"].includes(value.status),
    "task did not finish"
  );
  assert.equal(task.status, "completed", JSON.stringify(task.error));
  assert.deepEqual(task.targetArtifactIds, ["referenceRewrite"]);
  const run = (await server.call("/api/production/run/load", { ...ids, includeContent: true })).result;
  const entry = run.latestArtifacts.referenceRewrite;
  assert.equal(entry.lineage.status, "current");
  const content = entry.content;
  assert.equal(content.schemaVersion, "reference_rewrite/1.0");
  ensureReferenceRewriteContract({ original: content.original, drafts: content.drafts });
  assert.equal(content.materials.demo, true);
  assert.equal(content.materials.targetDurationSeconds, 51);
  assert.deepEqual(content.model, { provider: "demo", model: "demo", effort: "", providerCalls: 0, rejectedAttempts: 0 });
  assert.equal(JSON.stringify(task).includes("data:image"), false, "任务记录里没有图片");
});

test("只能在绑着页面工作区的参考视频 Run 上建；剧情 Run 上 409", { timeout: 30_000 }, async (t) => {
  const server = await startServer(t);
  const bare = (await server.call("/api/production/run/start", { metadata: { creatorProfile, sourceVideoDigest: "a".repeat(64) } })).result;
  const noWorkspace = await server.call("/api/tasks/create", { projectId: bare.projectId, runId: bare.runId, kind: "referenceRewrite", input: { targetDurationSeconds: 51 } }, 409);
  assert.equal(noWorkspace.code, "TASK_SOURCE_MEDIA_REQUIRED");

  const pageId = randomUUID();
  const workspace = (await server.call("/api/browser-workspace/start", { pageId })).result.workspace;
  const story = (await server.call("/api/production/run/story/start", {
    workspaceId: workspace.id, workspaceGeneration: workspace.generation, workspacePageId: pageId,
    metadata: { creatorProfile },
    storySource: { storyMode: "fullStoryText", storyText: "咕嘎在雨里给大叔撑伞。" }
  })).result;
  const wrongEntry = await server.call("/api/tasks/create", {
    projectId: story.production.projectId, runId: story.production.runId, kind: "referenceRewrite", input: { targetDurationSeconds: 51 }
  }, 409);
  assert.equal(wrongEntry.code, "TASK_ENTRY_MODE_MISMATCH");
});

test("配了模型而本机工具不齐：健康检查写明缺什么，建任务之前 409，不建任务", { timeout: 30_000 }, async (t) => {
  // 只配 Claude（指向一个不会被调用的地址）：工作流是 live，参考片仿写默认用 Claude。
  const server = await startServer(t, { CLAUDE_API_KEY: "fixture", CLAUDE_API_BASE_URL: "http://127.0.0.1:9" });
  const health = await server.call("/api/health");
  assert.equal(health.referenceRewrite.available, false);
  assert.match(health.referenceRewrite.reason, /REFERENCE_REWRITE_BANDIT_DIR 没有设置/u);
  const ids = await server.videoRun();
  const rejected = await server.call("/api/tasks/create", { ...ids, kind: "referenceRewrite", input: { targetDurationSeconds: 51 } }, 409);
  assert.equal(rejected.code, "REFERENCE_REWRITE_TOOLS_UNAVAILABLE");
  const tasks = (await server.call(`/api/tasks?${new URLSearchParams(ids)}`)).tasks;
  assert.deepEqual(tasks, []);
});
