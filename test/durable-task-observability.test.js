import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProductionRunCoordinator } from "../src/production-run-coordinator.js";
import { ProductionStateStore } from "../src/production-state-store.js";
import { DurableTaskStore } from "../src/durable-task-store.js";
import { DurableTaskManager } from "../src/durable-task-manager.js";
import { durableTaskHeartbeat, runWithDurableTaskContext } from "../src/durable-task-context.js";
import { WorkflowService } from "../src/workflow.js";
import { createStoryboardPlan } from "../src/storyboard-workflow.js";
import { storyboardDesignFromPlan } from "../src/storyboard-contract.js";
import { fullStoryCharacterRegistryInput, mockFullStoryCharacterRegistry } from "../src/full-story-character-registry.js";
import { catalog } from "../src/storyboard-editorial-utils.js";
import { MimoClient, ModelResponseError } from "../src/mimo-client.js";
import { QwenClient } from "../src/qwen-client.js";
import { ModelPipelineError } from "../src/model-errors.js";
import { serializeServerError } from "../src/server-error.js";
import { taskStatusView } from "../public/task-status-ui.js";

async function withManager(operation) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "mimo-task-observability-"));
  const coordinator = new ProductionRunCoordinator();
  const productionStore = new ProductionStateStore({ rootDir, coordinator });
  const taskStore = new DurableTaskStore({ rootDir });
  const manager = new DurableTaskManager({ productionStore, taskStore, coordinator });
  try {
    const run = await productionStore.createRun({ projectId: "observability" });
    await operation({ rootDir, taskStore, manager, run });
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
}

async function storyboardFixture(hasRegistry) {
  const workflow = new WorkflowService();
  const source = {
    frames: Array.from({ length: 3 }, (_, timestamp) => ({ timestamp, dataUrl: "data:image/jpeg;base64,AA==" })),
    metadata: { name: "fixture", duration: 60, width: 1080, height: 1920 },
    creatorProfile: { fixedCharacter: "阿岚，社区修理师", vertical: "动画", constraints: "" }, count: 4
  };
  const upstream = await workflow.run(source), variant = upstream.themeVariants.variants[0];
  const fullStory = await workflow.createFullStory({ ...source, ...upstream, variant,
    ...(hasRegistry ? { fullStorySchemaVersion: "full_story/1.2" } : {}) });
  const input = { ...source, ...upstream, variant, fullStory, animationPlanVersion: "4.0", targetAspectRatio: "16:9" };
  const { animationPlan } = await createStoryboardPlan(workflow, input);
  return { workflow, input, design: storyboardDesignFromPlan(animationPlan) };
}

for (const hasRegistry of [false, true]) for (const revise of [false, true]) {
  test(`4.0 Durable Task 阶段开始即落盘，心跳合并且下一步计数清零：角色表=${hasRegistry}，修订=${revise}`, async () => {
    const { workflow, input, design } = await storyboardFixture(hasRegistry);
    const evidence = catalog(design, "P").find(row => row.path.join("/") === "shotPlan/0/beats/0/visibleAction");
    const cleanReview = { strengths: ["保留已有动作"], guidance: [], items: [] };
    const report = { ...cleanReview, items: [{ ref: "I1", reportedProblem: "动作终点需明确",
      originalEvidence: [{ id: evidence.id, quote: evidence.value }], guidance: "交代动作终点" }] };
    const responses = [
      ...(!hasRegistry ? [mockFullStoryCharacterRegistry(fullStoryCharacterRegistryInput(input.fullStory, input.creatorProfile))] : []),
      design, revise ? report : cleanReview,
      ...(revise ? [
        { repairs: [{ ref: "I1", disposition: "revise", patches: [{ path: evidence.path, find: evidence.value,
          replace: `${evidence.value}动作结束后停稳。` }], note: "明确动作终点，保留原动作" }] }, cleanReview
      ] : [])
    ];
    const steps = [...(!hasRegistry ? ["storyboardCharacterFacts"] : []), "storyboardDesign", "storyboardReview",
      ...(revise ? ["storyboardRevision", "storyboardReviewFinal"] : [])];
    await withManager(async ({ manager, taskStore, run }) => {
      let calls = 0, taskId;
      const stepMax = hasRegistry ? 4 : 5;
      workflow.clients.MiMo = { async generateJson() {
        const expected = { step: steps[calls], stepIndex: calls + 1, stepMax };
        const before = (await taskStore.readIndex(run.projectId, run.runId)).tasks[taskId];
        assert.deepEqual(before.progress, { controlState: "running", retainedCount: 7, ...expected, streamedChars: 0, reasoningChars: 0 });
        // Same API as both clients; count-only updates must not erase step/control progress.
        await durableTaskHeartbeat({ streamedChars: 0, reasoningChars: 21 });
        await durableTaskHeartbeat({ streamedChars: 8 });
        const after = (await taskStore.readIndex(run.projectId, run.runId)).tasks[taskId];
        assert.deepEqual(after.progress, { ...before.progress, streamedChars: 8, reasoningChars: 21 });
        assert.equal(after.phase, before.phase);
        return responses[calls++];
      } };
      workflow.stageDefaults.animationPlan = { provider: "MiMo", model: "fixture-model" };
      const created = await manager.createTask({ ...run, kind: "animationPlan", targetArtifactIds: ["animationPlan:V1"],
        prepare: async () => ({ input, progress: { controlState: "running", retainedCount: 7 } }),
        execute: (frozenInput, context) => runWithDurableTaskContext(context, async () => {
          taskId = context.taskId;
          const result = await createStoryboardPlan(workflow, frozenInput);
          assert.equal(result.animationPlan.promptSchemaVersion, "4.0");
          assert.equal(result.metadata.storyboard.providerCalls, steps.length);
          return {};
        }) });
      const completed = await manager.waitForTask({ ...run, taskId: created.task.taskId });
      assert.equal(completed.task.status, "completed", JSON.stringify(completed.task.error));
      assert.equal(calls, steps.length);
      assert.equal(completed.task.progress.stepIndex, steps.length);
      assert.equal(completed.task.progress.stepMax, stepMax, "无问题直接结束，不回写总步数");
      const disk = await fs.readFile(taskStore.indexPath(run.projectId, run.runId), "utf8");
      assert.doesNotMatch(disk, /data:image|viewingIntent|visibleAction|reasoning_content|systemPrompt/);
    });
  });
}

for (const [provider, Client] of [["MiMo", MimoClient], ["Qwen", QwenClient]]) {
  test(`${provider} 实际 SSE 客户端的计数心跳不覆盖 Durable Task step，也不保存推理或正文`, async (t) => {
    const reasoning = "只留在客户端里的推理", content = '{"ok":true}';
    const encoder = new TextEncoder();
    const events = [
      { choices: [{ delta: { reasoning_content: reasoning } }] },
      { choices: [{ delta: { content }, finish_reason: "stop" }] }
    ];
    const chunks = events.map(value => encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
    let time = Date.now(), reads = 0;
    let heartbeatWritten = Promise.resolve();
    t.mock.method(Date, "now", () => time);
    t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
      async pull(controller) {
        // Model the ten-second gap without sleeping: let the preceding write finish.
        await heartbeatWritten;
        if (reads < chunks.length) {
          time += 10_001;
          controller.enqueue(chunks[reads++]);
        }
        else controller.close();
      }
    }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } }));
    await withManager(async ({ manager, taskStore, run }) => {
      const initial = { step: "storyboardDesign", stepIndex: 2, stepMax: 5, controlState: "running" };
      const created = await manager.createTask({ ...run, kind: "animationPlan", targetArtifactIds: ["animationPlan:V1"],
        prepare: async () => ({ input: { prompt: "private-prompt" }, progress: initial }),
        execute: (input, context) => {
          const heartbeats = [];
          return runWithDurableTaskContext({ ...context, heartbeat: (...args) => {
            const pending = context.heartbeat(...args);
            heartbeatWritten = pending;
            heartbeats.push(pending);
            return pending;
          } }, async () => {
            const client = new Client({ baseUrl: "https://fixture.invalid", model: "fixture-model", apiKey: "fixture" });
            const result = await client.requestCompletion({ prompt: input.prompt });
            assert.equal(result.content, content);
            // Await the actual fire-and-forget writes, without wall-clock polling.
            await Promise.all(heartbeats);
            assert.equal(heartbeats.length, 2);
            const task = (await taskStore.readIndex(run.projectId, run.runId)).tasks[context.taskId];
            assert.deepEqual(task.progress, { ...initial, streamedChars: content.length, reasoningChars: reasoning.length });
            return {};
          });
        } });
      const result = await manager.waitForTask({ ...run, taskId: created.task.taskId });
      assert.equal(result.task.status, "completed", JSON.stringify(result.task.error));
      const disk = await fs.readFile(taskStore.indexPath(run.projectId, run.runId), "utf8");
      assert.doesNotMatch(disk, /private-prompt|只留在客户端|reasoning_content|fixture\.invalid|apiKey/);
    });
    assert.equal(reads, 2);
  });
}

function arrearageError() {
  return new ModelResponseError("Qwen 请求失败（400）", JSON.stringify({
    error: { code: "Arrearage", message: "Arrearage: Access denied, please make sure your account is in good standing." },
    request_id: "qwen-fixture", prompt: "private-provider-prompt", headers: { authorization: "private-header" }
  }), 400, { provider: "Qwen", code: "MODEL_HTTP_ERROR" });
}

for (const wrapped of [false, true]) {
  test(`Durable Task 欠费错误持久化同一份供应商解释，原错误字段不变：pipeline=${wrapped}`, async () => {
    const error = wrapped ? new ModelPipelineError("Qwen 请求失败（400）", {
      category: "provider", code: "MODEL_HTTP_ERROR", retryable: true, cause: arrearageError()
    }) : arrearageError();
    await withManager(async ({ manager, taskStore, run }) => {
      const created = await manager.createTask({ ...run, kind: "characterReferenceRefine", targetArtifactIds: ["animationPlan:V1"],
        input: { prompt: "private-task-prompt", imageDataUrl: "data:image/jpeg;base64,AA==" },
        execute: async () => { throw error; } });
      const result = await manager.waitForTask({ ...run, taskId: created.task.taskId });
      assert.equal(result.task.status, "failed");
      const disk = await fs.readFile(taskStore.indexPath(run.projectId, run.runId), "utf8");
      const stored = JSON.parse(disk).tasks[created.task.taskId].error;
      const { providerError, ...unchanged } = stored;
      assert.deepEqual(unchanged, { code: "MODEL_HTTP_ERROR", category: wrapped ? "provider" : "unknown", message: error.message, details: [] });
      assert.deepEqual(providerError, serializeServerError(error).body.providerError);
      assert.equal(providerError.title, "阿里云账户欠费");
      assert.match(providerError.providerMessage, /Arrearage/);
      assert.equal(providerError.retryable, false);
      if (wrapped) assert.equal(error.retryable, true, "展示解释不得改变原重试语义");
      assert.doesNotMatch(disk, /private-provider-prompt|private-header|private-task-prompt|data:image|authorization|imageDataUrl/);
      const loaded = await new DurableTaskStore({ rootDir: taskStore.rootDir }).readIndex(run.projectId, run.runId);
      assert.deepEqual(loaded.tasks[created.task.taskId].error, stored);
      const message = taskStatusView(result.task).message;
      assert.match(message, /阿里云账户欠费/);
      assert.match(message, /阿里云控制台充值/);
      assert.match(message, /供应商原文：Arrearage/);
    });
  });
}

test("Durable Task 未识别错误不添加 providerError，旧记录重载与失败文字不变", async () => {
  await withManager(async ({ manager, taskStore, run }) => {
    const created = await manager.createTask({ ...run, kind: "animationPlan", targetArtifactIds: ["animationPlan:V1"],
      input: {}, execute: async () => { throw new Error("未识别的失败原文"); } });
    const result = await manager.waitForTask({ ...run, taskId: created.task.taskId });
    assert.equal(result.task.status, "failed");
    const index = await new DurableTaskStore({ rootDir: taskStore.rootDir }).readIndex(run.projectId, run.runId);
    assert.deepEqual(index.tasks[created.task.taskId].error, {
      code: "TASK_FAILED", category: "unknown", message: "未识别的失败原文", details: []
    });
    assert.equal(Object.hasOwn(result.task.error, "providerError"), false);
    assert.equal(taskStatusView(result.task).message, "未识别的失败原文");
  });
});

test("providerError 落盘前脱敏 Data URL 与 Base64，限长且只保留 HTTP 出口定义的字段", async () => {
  const error = new ModelResponseError("Qwen 请求失败（400）", JSON.stringify({
    error: { code: "Arrearage", message: `Arrearage data:image/jpeg;base64,AA== ${"X".repeat(100)} ${"长".repeat(400)}` },
    request_id: "id".repeat(100), prompt: "private-prompt", requestBody: { dataUrl: "private-data" },
    headers: { authorization: "private-header" }
  }), 400, { provider: "Qwen" });
  await withManager(async ({ manager, taskStore, run }) => {
    const created = await manager.createTask({ ...run, kind: "animationPlan", targetArtifactIds: ["animationPlan:V1"],
      input: {}, execute: async () => { throw error; } });
    const result = await manager.waitForTask({ ...run, taskId: created.task.taskId });
    const { providerError } = result.task.error;
    assert.deepEqual(Object.keys(providerError).sort(), ["provider", "code", "httpStatus", "matchedBy", "title", "guidance",
      "retryable", "docUrl", "providerMessage", "requestId"].sort());
    assert.match(providerError.providerMessage, /\[data-url-redacted\].*\[base64-redacted\]/);
    assert.ok(providerError.providerMessage.length <= 300);
    assert.ok(providerError.requestId.length <= 120);
    const disk = await fs.readFile(taskStore.indexPath(run.projectId, run.runId), "utf8");
    assert.doesNotMatch(disk, /data:image|X{80}|private-prompt|requestBody|private-data|private-header|authorization/);
  });
});
