import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProductionRunCoordinator } from "../src/production-run-coordinator.js";
import { ProductionStateStore } from "../src/production-state-store.js";
import { DurableTaskStore } from "../src/durable-task-store.js";
import { DurableTaskManager } from "../src/durable-task-manager.js";
import { contentDigest } from "../src/production-lineage.js";
import { getConfig } from "../src/config.js";
import { recordModelUsage, runWithUsageAccounting } from "../src/token-usage.js";

async function withManager(run, managerOptions = {}) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "mimo-durable-task-test-"));
  let nextId = 0;
  const coordinator = new ProductionRunCoordinator();
  const productionStore = new ProductionStateStore({
    rootDir,
    coordinator,
    idFactory: () => `production-${++nextId}`
  });
  const taskStore = new DurableTaskStore({ rootDir });
  const manager = new DurableTaskManager({
    productionStore,
    taskStore,
    coordinator,
    idFactory: () => `task-${++nextId}`,
    pools: {
      workflow: { limit: 2, queueLimit: 8 },
      media: { limit: 4, queueLimit: 8 }
    },
    ...managerOptions
  });
  try {
    await run({ rootDir, coordinator, productionStore, taskStore, manager });
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
}

async function waitUntil(operation, predicate, timeoutMs = 1_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await operation();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("waitUntil timeout");
}

async function within(operation, timeoutMs = 5_000) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`operation exceeded ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("Durable Task executes outside the request and commits its declared Artifact", async () => {
  await withManager(async ({ productionStore, manager }) => {
    const productionRun = await productionStore.createRun({ projectId: "project-task" });
    const created = await manager.createTask({
      projectId: productionRun.projectId,
      runId: productionRun.runId,
      kind: "analysis",
      targetArtifactIds: ["referenceAnalysis"],
      input: { source: "fixture" },
      execute: async (_input, context) => {
        await context.recordStage("running");
        await context.beforeProviderCall("provider_call", 1_000);
        await context.afterProviderCall("validation");
        const committed = await context.commitArtifact({
          artifactId: "referenceAnalysis",
          artifactType: "referenceAnalysis",
          content: { summary: "durable" }
        });
        return { resultArtifactRefs: [committed.lineage] };
      }
    });
    assert.equal(created.task.status, "queued");
    const completed = await manager.waitForTask({
      projectId: productionRun.projectId,
      runId: productionRun.runId,
      taskId: created.task.taskId
    });
    assert.equal(completed.task.status, "completed");
    const loaded = await productionStore.loadRun({ ...productionRun, includeContent: true });
    assert.deepEqual(loaded.latestArtifacts.referenceAnalysis.content, { summary: "durable" });
  });
});

test("director pipeline keeps running after the browser poller disappears at Creative Brief", async () => {
  await withManager(async ({ productionStore, manager }) => {
    const productionRun = await productionStore.createRun({ projectId: "project-browser-refresh" });
    const targets = [
      "referenceAnalysis",
      "sourceScriptReconstruction",
      "creativeBrief",
      "visualGuardrails",
      "themeVariants"
    ];
    let releaseAfterRefresh;
    let markBriefCommitted;
    const afterRefresh = new Promise((resolve) => { releaseAfterRefresh = resolve; });
    const briefCommitted = new Promise((resolve) => { markBriefCommitted = resolve; });
    const created = await manager.createTask({
      ...productionRun,
      kind: "directorPipeline",
      targetArtifactIds: targets,
      execute: async (_input, context) => {
        for (let index = 0; index < targets.length; index += 1) {
          const artifactId = targets[index];
          await context.commitArtifact({
            artifactId,
            artifactType: artifactId,
            content: { stage: artifactId }
          });
          if (artifactId === "creativeBrief") {
            markBriefCommitted();
            await afterRefresh;
          }
        }
      }
    });

    // 到这里没有任何 waitForTask/polling waiter；等价于浏览器在 Brief 阶段刷新。
    await briefCommitted;
    const midway = await productionStore.loadRun({ ...productionRun, includeContent: false });
    assert.equal(midway.latestArtifacts.creativeBrief.lineage.status, "current");
    assert.equal(midway.latestArtifacts.visualGuardrails, undefined);
    assert.equal((await manager.getTaskById(created.task.taskId)).status, "running");

    releaseAfterRefresh();
    const completed = await manager.waitForTask({ ...productionRun, taskId: created.task.taskId });
    assert.equal(completed.task.status, "completed");
    const finalRun = await productionStore.loadRun({ ...productionRun, includeContent: false });
    assert.ok(targets.every((artifactId) => finalRun.latestArtifacts[artifactId]?.lineage?.status === "current"));
  });
});

test("a failed director parent aggregates completed and failing child usage", async () => {
  await withManager(async ({ productionStore, manager }) => {
    const productionRun = await productionStore.createRun({ projectId: "project-parent-failed-usage" });
    const firstUsage = {
      calls: 1,
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      costCny: 0.1,
      costKnown: true,
      byModel: [{
        provider: "Fixture",
        model: "first-model",
        calls: 1,
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        costCny: 0.1
      }]
    };
    const created = await manager.createTask({
      ...productionRun,
      kind: "directorPipeline",
      targetArtifactIds: ["referenceAnalysis", "sourceScriptReconstruction"],
      execute: async (_input, context) => {
        await context.runChild({
          kind: "analysis",
          targetArtifactIds: ["referenceAnalysis"],
          input: { stage: 1 },
          execute: async () => ({ usage: firstUsage })
        });
        await context.runChild({
          kind: "reconstruction",
          targetArtifactIds: ["sourceScriptReconstruction"],
          input: { stage: 2 },
          execute: async () => runWithUsageAccounting(async () => {
            recordModelUsage({
              provider: "Fixture",
              model: "failed-model",
              usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 }
            });
            throw new Error("fixture provider failure");
          }, {
            prices: new Map([["failed-model", { inputPerMillion: 1_000, outputPerMillion: 2_000 }]])
          })
        });
      }
    });

    const terminal = await manager.waitForTask({ ...productionRun, taskId: created.task.taskId });
    assert.equal(terminal.task.status, "failed");
    assert.equal(terminal.task.usage.calls, 2);
    assert.equal(terminal.task.usage.promptTokens, 30);
    assert.equal(terminal.task.usage.completionTokens, 10);
    assert.equal(terminal.task.usage.totalTokens, 40);
    assert.equal(terminal.task.usage.costCny, 0.13);
    assert.deepEqual(terminal.task.usage.byModel.map((item) => item.model), ["first-model", "failed-model"]);
  });
});

test("completion progress merges without dropping persisted input digests", async () => {
  await withManager(async ({ productionStore, manager }) => {
    const productionRun = await productionStore.createRun({ projectId: "project-progress-merge" });
    const promptDigest = "a".repeat(64);
    const created = await manager.createTask({
      ...productionRun,
      kind: "analysis",
      targetArtifactIds: ["referenceAnalysis"],
      progress: { promptDigest, readyCount: 0 },
      prepare: async () => ({
        input: {},
        progress: { promptDigest, readyCount: 0 }
      }),
      execute: async () => ({ progress: { readyCount: 1 } })
    });
    const completed = await manager.waitForTask({ ...productionRun, taskId: created.task.taskId });
    assert.deepEqual(completed.task.progress, { promptDigest, readyCount: 1 });
  });
});

test("Coordinator-held Task commit uses commitArtifactUnlocked and does not deadlock", async () => {
  await withManager(async ({ coordinator, productionStore, taskStore }) => {
    const productionRun = await productionStore.createRun({ projectId: "project-lock" });
    const result = await Promise.race([
      coordinator.withRunLock(productionRun.projectId, productionRun.runId, async () => {
        const manifest = await productionStore.readManifest(productionRun.projectId, productionRun.runId);
        const index = await taskStore.readIndex(productionRun.projectId, productionRun.runId);
        const committed = await productionStore.commitArtifactUnlocked(manifest, {
          projectId: productionRun.projectId,
          runId: productionRun.runId,
          artifactId: "referenceAnalysis",
          artifactType: "referenceAnalysis",
          content: { summary: "unlocked" },
          dependencies: [],
          requestId: "request-unlocked",
          expectedCurrentRevision: null
        });
        await taskStore.writeIndexUnlocked(index);
        return committed.lineage.revision;
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("deadlock")), 1_000))
    ]);
    assert.equal(result, "referenceAnalysis-r1");
  });
});

test("Coordinator-held commit, Stage update, and Run load use only unlocked store paths", async () => {
  await withManager(async ({ coordinator, productionStore, taskStore }) => {
    const productionRun = await productionStore.createRun({ projectId: "project-all-unlocked" });
    const result = await within(() => coordinator.withRunLock(
      productionRun.projectId,
      productionRun.runId,
      async () => {
        const manifest = await productionStore.readManifest(productionRun.projectId, productionRun.runId);
        const index = await taskStore.readIndex(productionRun.projectId, productionRun.runId);
        await productionStore.recordStageUnlocked(manifest, {
          ...productionRun,
          stageId: "referenceAnalysis",
          status: "running",
          requestId: "request-all-unlocked"
        });
        const committed = await productionStore.commitArtifactUnlocked(manifest, {
          ...productionRun,
          artifactId: "referenceAnalysis",
          artifactType: "referenceAnalysis",
          content: { summary: "all-unlocked" },
          dependencies: [],
          requestId: "request-all-unlocked",
          expectedCurrentRevision: null
        });
        const loaded = await productionStore.loadRunUnlocked(manifest, { includeContent: true });
        await taskStore.writeIndexUnlocked(index);
        return {
          revision: committed.lineage.revision,
          stageStatus: loaded.stages.referenceAnalysis.status,
          content: loaded.latestArtifacts.referenceAnalysis.content
        };
      }
    ));
    assert.deepEqual(result, {
      revision: "referenceAnalysis-r1",
      stageStatus: "completed",
      content: { summary: "all-unlocked" }
    });
  });
});

test("conditional terminal Stage cannot overwrite a newer request", async () => {
  await withManager(async ({ productionStore }) => {
    const productionRun = await productionStore.createRun({ projectId: "project-stage" });
    await productionStore.recordStage({
      ...productionRun,
      stageId: "referenceAnalysis",
      status: "running",
      requestId: "request-new"
    });
    const result = await productionStore.recordStage({
      ...productionRun,
      stageId: "referenceAnalysis",
      status: "interrupted",
      requestId: "request-old",
      expectedRequestId: "request-old",
      error: { message: "data:image/png;base64,QUJDREVGRw==", code: "TASK_INTERRUPTED" }
    });
    assert.equal(result.applied, false);
    const loaded = await productionStore.loadRun({ ...productionRun, includeContent: false });
    assert.equal(loaded.stages.referenceAnalysis.status, "running");
    assert.equal(loaded.stages.referenceAnalysis.requestId, "request-new");
  });
});

test("active idempotent operation is reused before capacity checks; different operation stays busy", async () => {
  await withManager(async ({ productionStore, manager }) => {
    const productionRun = await productionStore.createRun({ projectId: "project-idempotency" });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const definition = {
      ...productionRun,
      kind: "analysis",
      targetArtifactIds: ["referenceAnalysis"],
      input: { version: 1 },
      execute: async () => gate
    };
    const first = await manager.createTask(definition);
    await waitUntil(
      () => manager.getTaskById(first.task.taskId),
      (task) => task.status === "running"
    );
    const duplicate = await manager.createTask(definition);
    assert.equal(duplicate.reused, true);
    assert.equal(duplicate.task.taskId, first.task.taskId);
    await assert.rejects(
      manager.createTask({ ...definition, input: { version: 2 } }),
      (error) => error.code === "TASK_TARGET_BUSY"
    );
    await assert.rejects(
      manager.createTask({ ...definition, targetArtifactIds: ["creativeBrief"], input: { version: 3 } }),
      (error) => error.code === "TASK_CAPACITY_EXCEEDED"
    );
    await manager.releaseTask({ ...productionRun, taskId: first.task.taskId });
    release({});
  }, {
    pools: {
      workflow: { limit: 1, queueLimit: 0 },
      media: { limit: 1, queueLimit: 0 }
    }
  });
});

test("pipeline claims all five targets before any child work begins", async () => {
  await withManager(async ({ productionStore, manager }) => {
    const productionRun = await productionStore.createRun({ projectId: "project-five-claims" });
    let resume;
    const gate = new Promise((resolve) => { resume = resolve; });
    const targets = [
      "referenceAnalysis",
      "sourceScriptReconstruction",
      "creativeBrief",
      "visualGuardrails",
      "themeVariants"
    ];
    const created = await manager.createTask({
      ...productionRun,
      kind: "directorPipeline",
      targetArtifactIds: targets,
      execute: async () => gate
    });
    await waitUntil(() => manager.getTaskById(created.task.taskId), (task) => task.status === "running");
    for (const artifactId of targets) {
      await assert.rejects(
        productionStore.commitArtifact({
          ...productionRun,
          artifactId,
          artifactType: artifactId,
          requestId: `browser-${artifactId}`,
          content: { browser: true },
          dependencies: []
        }),
        (error) => error.code === "TASK_TARGET_BUSY"
      );
    }
    await manager.releaseTask({ ...productionRun, taskId: created.task.taskId });
    resume({});
  });
});

test("target guard leaves unclaimed browser and import-style commits available", async () => {
  await withManager(async ({ productionStore }) => {
    const productionRun = await productionStore.createRun({ projectId: "project-unclaimed-commit" });
    const committed = await productionStore.commitArtifact({
      ...productionRun,
      artifactId: "referenceAnalysis",
      artifactType: "referenceAnalysis",
      requestId: "import-unclaimed",
      expectedCurrentRevision: null,
      dependencies: [],
      content: { imported: true }
    });
    assert.equal(committed.lineage.revision, "referenceAnalysis-r1");
  });
});

test("queued request byte budget rejects only the operation that would exceed it", async () => {
  await withManager(async ({ productionStore, manager }) => {
    const productionRun = await productionStore.createRun({ projectId: "project-byte-budget" });
    let releaseRunning;
    const runningGate = new Promise((resolve) => { releaseRunning = resolve; });
    const first = await manager.createTask({
      ...productionRun,
      kind: "analysis",
      targetArtifactIds: ["referenceAnalysis"],
      requestBytes: 10,
      execute: async () => runningGate
    });
    await waitUntil(() => manager.getTaskById(first.task.taskId), (task) => task.status === "running");
    const queued = await manager.createTask({
      ...productionRun,
      kind: "brief",
      targetArtifactIds: ["creativeBrief"],
      requestBytes: 80,
      execute: async () => new Promise(() => {})
    });
    assert.equal(queued.task.status, "queued");
    await assert.rejects(
      manager.createTask({
        ...productionRun,
        kind: "variants",
        targetArtifactIds: ["themeVariants"],
        requestBytes: 30,
        execute: async () => ({})
      }),
      (error) => error.code === "TASK_CAPACITY_EXCEEDED"
    );
    await manager.releaseTask({ ...productionRun, taskId: first.task.taskId });
    await manager.releaseTask({ ...productionRun, taskId: queued.task.taskId });
    releaseRunning({});
  }, {
    maxQueuedBytes: 100,
    pools: {
      workflow: { limit: 1, queueLimit: 8 },
      media: { limit: 1, queueLimit: 8 }
    }
  });
});

test("provider progress can renew the watchdog beyond the original total wall time", async () => {
  await withManager(async ({ productionStore, manager }) => {
    const productionRun = await productionStore.createRun({ projectId: "project-renew" });
    const created = await manager.createTask({
      ...productionRun,
      kind: "fullStory",
      targetArtifactIds: ["fullStory:V1"],
      execute: async (_input, context) => {
        for (let index = 0; index < 3; index += 1) {
          await context.beforeProviderCall(`call_${index}`, 500);
          await new Promise((resolve) => setTimeout(resolve, 100));
          await context.afterProviderCall(`returned_${index}`);
        }
        const committed = await context.commitArtifact({
          artifactId: "fullStory:V1",
          artifactType: "fullStory",
          content: { completed: true }
        });
        return { resultArtifactRefs: [committed.lineage] };
      }
    });
    const completed = await manager.waitForTask({ ...productionRun, taskId: created.task.taskId });
    assert.equal(completed.task.status, "completed");
  }, { localStallMs: 250, providerGraceMs: 250 });
});

test("Full Story and multi-batch Animation Plan can both outlive their initial watchdog window", async () => {
  await withManager(async ({ productionStore, manager }) => {
    const productionRun = await productionStore.createRun({ projectId: "project-renew-multi-kind" });
    for (const [kind, artifactId, callCount] of [
      ["fullStory", "fullStory:V1", 3],
      ["animationPlan", "animationPlan:V1", 7]
    ]) {
      const created = await manager.createTask({
        ...productionRun,
        kind,
        targetArtifactIds: [artifactId],
        execute: async (_input, context) => {
          for (let index = 0; index < callCount; index += 1) {
            await context.beforeProviderCall(`${kind}_call_${index + 1}`, 500);
            await new Promise((resolve) => setTimeout(resolve, 100));
            await context.afterProviderCall(`${kind}_returned_${index + 1}`, { completedCalls: index + 1 });
          }
          const committed = await context.commitArtifact({
            artifactId,
            artifactType: kind,
            content: { kind, callCount }
          });
          return { resultArtifactRefs: [committed.lineage] };
        }
      });
      const completed = await manager.waitForTask({ ...productionRun, taskId: created.task.taskId });
      assert.equal(completed.task.status, "completed");
      assert.equal(completed.task.progress.completedCalls, callCount);
    }
  }, { localStallMs: 250, providerGraceMs: 250 });
});

test("a genuinely stalled task fails and releases its target", async () => {
  await withManager(async ({ productionStore, taskStore, manager }) => {
    const productionRun = await productionStore.createRun({ projectId: "project-stall" });
    const created = await manager.createTask({
      ...productionRun,
      kind: "analysis",
      targetArtifactIds: ["referenceAnalysis"],
      execute: async () => new Promise(() => {})
    });
    const completed = await manager.waitForTask({ ...productionRun, taskId: created.task.taskId });
    assert.equal(completed.task.status, "failed");
    assert.equal(completed.task.error.code, "TASK_STALLED");
    const index = await taskStore.readIndex(productionRun.projectId, productionRun.runId);
    assert.equal(index.claims.referenceAnalysis, undefined);
  }, { localStallMs: 25 });
});

test("dependency change before provider call produces conflicted with zero paid calls", async () => {
  await withManager(async ({ productionStore, manager }) => {
    const productionRun = await productionStore.createRun({ projectId: "project-conflict" });
    const dependency = await productionStore.commitArtifact({
      ...productionRun,
      artifactId: "variant:V1",
      artifactType: "selectedVariant",
      requestId: "request-dependency-1",
      expectedCurrentRevision: null,
      dependencies: [],
      content: { id: "V1", version: 1 }
    });
    let resume;
    const gate = new Promise((resolve) => { resume = resolve; });
    let providerCalls = 0;
    const created = await manager.createTask({
      ...productionRun,
      kind: "fullStory",
      targetArtifactIds: ["fullStory:V1"],
      dependencyIds: ["variant:V1"],
      execute: async (_input, context) => {
        await gate;
        await context.beforeProviderCall("provider", 100);
        providerCalls += 1;
      }
    });
    await waitUntil(() => manager.getTaskById(created.task.taskId), (task) => task.status === "running");
    await productionStore.commitArtifact({
      ...productionRun,
      artifactId: "variant:V1",
      artifactType: "selectedVariant",
      requestId: "request-dependency-2",
      expectedCurrentRevision: dependency.lineage.revision,
      dependencies: [],
      content: { id: "V1", version: 2 }
    });
    resume();
    const completed = await manager.waitForTask({ ...productionRun, taskId: created.task.taskId });
    assert.equal(completed.task.status, "conflicted");
    assert.equal(providerCalls, 0);
  });
});

test("dependency change during a provider call produces conflicted after one call and no commit", async () => {
  await withManager(async ({ productionStore, manager }) => {
    const productionRun = await productionStore.createRun({ projectId: "project-mid-call-conflict" });
    const dependency = await productionStore.commitArtifact({
      ...productionRun,
      artifactId: "variant:V1",
      artifactType: "selectedVariant",
      requestId: "request-mid-dependency-1",
      expectedCurrentRevision: null,
      dependencies: [],
      content: { id: "V1", version: 1 }
    });
    let providerStarted;
    const started = new Promise((resolve) => { providerStarted = resolve; });
    let returnProvider;
    const providerGate = new Promise((resolve) => { returnProvider = resolve; });
    let providerCalls = 0;
    const created = await manager.createTask({
      ...productionRun,
      kind: "fullStory",
      targetArtifactIds: ["fullStory:V1"],
      dependencyIds: ["variant:V1"],
      execute: async (_input, context) => {
        await context.beforeProviderCall("provider", 1_000);
        providerCalls += 1;
        providerStarted();
        await providerGate;
        await context.afterProviderCall("provider_returned");
        return context.commitArtifact({
          artifactId: "fullStory:V1",
          artifactType: "fullStory",
          content: { shouldNotCommit: true }
        });
      }
    });
    await started;
    await productionStore.commitArtifact({
      ...productionRun,
      artifactId: "variant:V1",
      artifactType: "selectedVariant",
      requestId: "request-mid-dependency-2",
      expectedCurrentRevision: dependency.lineage.revision,
      dependencies: [],
      content: { id: "V1", version: 2 }
    });
    returnProvider();
    const completed = await manager.waitForTask({ ...productionRun, taskId: created.task.taskId });
    assert.equal(providerCalls, 1);
    assert.equal(completed.task.status, "conflicted");
    assert.equal(completed.task.error.code, "TASK_FROZEN_CONTEXT_CONFLICT");
    const run = await productionStore.loadRun({ ...productionRun, includeContent: false });
    assert.equal(run.latestArtifacts["fullStory:V1"], undefined);
  });
});

test("commit revision and stale-dependency errors are the only other conflicted producers", async () => {
  for (const conflictCode of ["ARTIFACT_REVISION_CONFLICT", "ARTIFACT_DEPENDENCY_STALE"]) {
    await withManager(async ({ productionStore, manager }) => {
      const productionRun = await productionStore.createRun({ projectId: `project-${conflictCode.toLowerCase()}` });
      const created = await manager.createTask({
        ...productionRun,
        kind: "analysis",
        targetArtifactIds: ["referenceAnalysis"],
        execute: async () => {
          const error = new Error(conflictCode);
          error.code = conflictCode;
          throw error;
        }
      });
      const completed = await manager.waitForTask({ ...productionRun, taskId: created.task.taskId });
      assert.equal(completed.task.status, "conflicted");
      assert.equal(completed.task.error.code, conflictCode);
    });
  }
});

// 目标的期望版本与状态库提交门同一口径：latest 那一版，不论是否 stale。
// 此前这里把 stale 目标冻结成 null，而提交门比的是 latest，于是任何已失效目标重新生成
// 都必然以 ARTIFACT_REVISION_CONFLICT 收场——模型调用可能已经做完、钱已经花了。
async function seedStaleTarget(productionStore, productionRun) {
  const upstream = await productionStore.commitArtifact({
    ...productionRun, artifactId: "referenceAnalysis", artifactType: "referenceAnalysis",
    requestId: "stale-upstream-1", expectedCurrentRevision: null, dependencies: [], content: { version: 1 }
  });
  const target = await productionStore.commitArtifact({
    ...productionRun, artifactId: "creativeBrief", artifactType: "creativeBrief",
    requestId: "stale-target-1", expectedCurrentRevision: null,
    dependencies: [upstream.lineage], content: { brief: "old" }
  });
  const next = await productionStore.commitArtifact({
    ...productionRun, artifactId: "referenceAnalysis", artifactType: "referenceAnalysis",
    requestId: "stale-upstream-2", expectedCurrentRevision: upstream.lineage.revision,
    dependencies: [], content: { version: 2 }
  });
  assert.deepEqual(next.staleArtifactIds, ["creativeBrief"]);
  return target.lineage;
}

test("a stale target regenerates: the task freezes its stale revision and commits the next one", async () => {
  await withManager(async ({ productionStore, manager }) => {
    const productionRun = await productionStore.createRun({ projectId: "project-stale-target" });
    const stale = await seedStaleTarget(productionStore, productionRun);
    const created = await manager.createTask({
      ...productionRun, kind: "brief", targetArtifactIds: ["creativeBrief"], dependencyIds: ["referenceAnalysis"],
      execute: async (_input, context) => {
        await context.beforeProviderCall("provider", 1_000);
        await context.afterProviderCall("provider_returned");
        const committed = await context.commitArtifact({
          artifactId: "creativeBrief", artifactType: "creativeBrief", content: { brief: "regenerated" }
        });
        return { resultArtifactRefs: [committed.lineage] };
      }
    });
    assert.equal(created.task.targetExpectedRevisions.creativeBrief, stale.revision);
    const completed = await manager.waitForTask({ ...productionRun, taskId: created.task.taskId });
    assert.equal(completed.task.status, "completed", JSON.stringify(completed.task.error || null));
    const run = await productionStore.loadRun({ ...productionRun, includeContent: true });
    assert.equal(run.latestArtifacts.creativeBrief.lineage.status, "current");
    assert.notEqual(run.latestArtifacts.creativeBrief.lineage.revision, stale.revision);
    assert.deepEqual(run.latestArtifacts.creativeBrief.content, { brief: "regenerated" });
  });
});

test("a stale target still conflicts when someone else commits a newer revision during the task", async () => {
  await withManager(async ({ productionStore, manager }) => {
    const productionRun = await productionStore.createRun({ projectId: "project-stale-target-race" });
    const stale = await seedStaleTarget(productionStore, productionRun);
    const upstream = (await productionStore.loadRun({ ...productionRun, includeContent: false }))
      .latestArtifacts.referenceAnalysis.lineage;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const created = await manager.createTask({
      ...productionRun, kind: "brief", targetArtifactIds: ["creativeBrief"], dependencyIds: ["referenceAnalysis"],
      execute: async (_input, context) => {
        await gate;
        return context.commitArtifact({
          artifactId: "creativeBrief", artifactType: "creativeBrief", content: { brief: "late" }
        });
      }
    });
    await waitUntil(() => manager.getTaskById(created.task.taskId), (task) => task.status === "running");
    // 另一条写入路径（没有 claim 时浏览器快速提交仍然可用）抢先签发了下一版。
    // 这里只能绕开 claim 直接写状态库来模拟——它证明的是锁内复检仍然拦得住，不是提交入口放行了它。
    const manifest = await productionStore.readManifest(productionRun.projectId, productionRun.runId);
    const winner = await productionStore.commitArtifactUnlocked(manifest, {
      ...productionRun, artifactId: "creativeBrief", artifactType: "creativeBrief",
      requestId: "someone-else", expectedCurrentRevision: stale.revision,
      dependencies: [upstream], content: { brief: "winner" }
    });
    release();
    const completed = await manager.waitForTask({ ...productionRun, taskId: created.task.taskId });
    assert.equal(completed.task.status, "conflicted");
    const run = await productionStore.loadRun({ ...productionRun, includeContent: true });
    assert.equal(run.latestArtifacts.creativeBrief.lineage.revision, winner.lineage.revision);
    assert.deepEqual(run.latestArtifacts.creativeBrief.content, { brief: "winner" });
  });
});

test("abandoned runner cannot commit a late result", async () => {
  await withManager(async ({ productionStore, manager }) => {
    const productionRun = await productionStore.createRun({ projectId: "project-abandon" });
    let resume;
    const gate = new Promise((resolve) => { resume = resolve; });
    const created = await manager.createTask({
      ...productionRun,
      kind: "analysis",
      targetArtifactIds: ["referenceAnalysis"],
      execute: async (_input, context) => {
        await gate;
        return context.commitArtifact({
          artifactId: "referenceAnalysis",
          artifactType: "referenceAnalysis",
          content: { late: true }
        });
      }
    });
    await waitUntil(() => manager.getTaskById(created.task.taskId), (task) => task.status === "running");
    const released = await manager.releaseTask({ ...productionRun, taskId: created.task.taskId });
    assert.equal(released.status, "abandoned");
    resume();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const run = await productionStore.loadRun({ ...productionRun, includeContent: false });
    assert.equal(run.latestArtifacts.referenceAnalysis, undefined);
  });
});

test("stalled runner cannot commit after the watchdog released its target", async () => {
  await withManager(async ({ productionStore, manager }) => {
    const productionRun = await productionStore.createRun({ projectId: "project-stalled-late" });
    let resume;
    const gate = new Promise((resolve) => { resume = resolve; });
    const created = await manager.createTask({
      ...productionRun,
      kind: "analysis",
      targetArtifactIds: ["referenceAnalysis"],
      execute: async (_input, context) => {
        await gate;
        return context.commitArtifact({
          artifactId: "referenceAnalysis",
          artifactType: "referenceAnalysis",
          content: { lateAfterStall: true }
        });
      }
    });
    const stalled = await manager.waitForTask({ ...productionRun, taskId: created.task.taskId });
    assert.equal(stalled.task.status, "failed");
    assert.equal(stalled.task.error.code, "TASK_STALLED");
    resume();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const run = await productionStore.loadRun({ ...productionRun, includeContent: false });
    assert.equal(run.latestArtifacts.referenceAnalysis, undefined);
  }, { localStallMs: 25 });
});

test("same Task finalize is idempotent before expected revision comparison", async () => {
  await withManager(async ({ productionStore, manager }) => {
    const productionRun = await productionStore.createRun({ projectId: "project-finalize" });
    let revisions = [];
    const created = await manager.createTask({
      ...productionRun,
      kind: "analysis",
      targetArtifactIds: ["referenceAnalysis"],
      execute: async (_input, context) => {
        const first = await context.commitArtifact({
          artifactId: "referenceAnalysis",
          artifactType: "referenceAnalysis",
          content: { stable: true }
        });
        const second = await context.commitArtifact({
          artifactId: "referenceAnalysis",
          artifactType: "referenceAnalysis",
          content: { stable: true }
        });
        revisions = [first.lineage.revision, second.lineage.revision];
        return { resultArtifactRefs: [second.lineage] };
      }
    });
    const completed = await manager.waitForTask({ ...productionRun, taskId: created.task.taskId });
    assert.equal(completed.task.status, "completed");
    assert.deepEqual(revisions, ["referenceAnalysis-r1", "referenceAnalysis-r1"]);
  });
});

test("legacy synchronous waiter shares its production requestId with the Task finalize", async () => {
  await withManager(async ({ productionStore, manager }) => {
    const productionRun = await productionStore.createRun({ projectId: "project-legacy-waiter" });
    const first = await productionStore.commitArtifact({
      ...productionRun,
      artifactId: "shotVideo:V1:A01",
      artifactType: "shotVideo",
      requestId: "browser-old-video",
      expectedCurrentRevision: null,
      dependencies: [],
      content: { status: "ready", selectedIndex: 0, result: { outputUrl: "/old.mp4" } }
    });
    const requestId = "browser-new-video";
    const content = { status: "ready", selectedIndex: 0, result: { outputUrl: "/new.mp4" } };
    const created = await manager.createTask({
      ...productionRun,
      kind: "shotVideo",
      pool: "media",
      targetArtifactIds: ["shotVideo:V1:A01"],
      productionRequestToken: {
        artifactId: "shotVideo:V1:A01",
        requestId,
        expectedCurrentRevision: first.lineage.revision
      },
      execute: async (_input, context) => {
        const committed = await context.commitArtifact({
          artifactId: "shotVideo:V1:A01",
          artifactType: "shotVideo",
          content
        });
        return { resultArtifactRefs: [committed.lineage] };
      }
    });
    assert.equal(created.task.requestId, requestId);
    const completed = await manager.waitForTask({ ...productionRun, taskId: created.task.taskId });
    assert.equal(completed.task.status, "completed");
    assert.equal(completed.task.resultArtifactRefs[0].revision, "shotVideo-V1-A01-r2");

    // 旧页面在同步响应回来后仍会执行一次浏览器 finalize。因为它与 Task
    // 共用 requestId，这里应当复用 r2，而不是拿冻结的 r1 再触发 revision conflict。
    const duplicate = await productionStore.commitArtifact({
      ...productionRun,
      artifactId: "shotVideo:V1:A01",
      artifactType: "shotVideo",
      requestId,
      expectedCurrentRevision: first.lineage.revision,
      dependencies: [],
      content
    });
    assert.equal(duplicate.reused, true);
    assert.equal(duplicate.lineage.revision, "shotVideo-V1-A01-r2");
  });
});

test("legacy production token is checked before a provider Task can start", async () => {
  await withManager(async ({ productionStore, manager }) => {
    const productionRun = await productionStore.createRun({ projectId: "project-legacy-stale-token" });
    const current = await productionStore.commitArtifact({
      ...productionRun,
      artifactId: "shotVideo:V1:A01",
      artifactType: "shotVideo",
      requestId: "browser-current-video",
      expectedCurrentRevision: null,
      dependencies: [],
      content: { status: "ready", result: { outputUrl: "/current.mp4" } }
    });
    let executeCount = 0;
    await assert.rejects(
      manager.createTask({
        ...productionRun,
        kind: "shotVideo",
        pool: "media",
        targetArtifactIds: ["shotVideo:V1:A01"],
        productionRequestToken: {
          artifactId: "shotVideo:V1:A01",
          requestId: "browser-stale-video",
          expectedCurrentRevision: null
        },
        execute: async () => { executeCount += 1; }
      }),
      (error) => error.code === "ARTIFACT_REVISION_CONFLICT"
        && error.details?.[0]?.actualRevision === current.lineage.revision
    );
    assert.equal(executeCount, 0);
  });
});

test("different requestId cannot reuse an identical Artifact finalize", async () => {
  await withManager(async ({ productionStore }) => {
    const productionRun = await productionStore.createRun({ projectId: "project-finalize-request-scope" });
    const first = await productionStore.commitArtifact({
      ...productionRun,
      artifactId: "referenceAnalysis",
      artifactType: "referenceAnalysis",
      requestId: "request-first",
      expectedCurrentRevision: null,
      dependencies: [],
      content: { stable: true }
    });
    const second = await productionStore.commitArtifact({
      ...productionRun,
      artifactId: "referenceAnalysis",
      artifactType: "referenceAnalysis",
      requestId: "request-second",
      expectedCurrentRevision: first.lineage.revision,
      dependencies: [],
      content: { stable: true }
    });
    assert.equal(first.reused, false);
    assert.equal(second.reused, false);
    assert.equal(second.lineage.revision, "referenceAnalysis-r2");
  });
});

test("task paths reject traversal and terminal reasons redact data URLs", async () => {
  await withManager(async ({ productionStore, taskStore }) => {
    assert.throws(() => taskStore.tasksDirectory("../escape", "run-safe"));
    await assert.rejects(
      taskStore.getTask({ projectId: "project-safe", runId: "run-safe", taskId: "../escape" }),
      (error) => error.code === "PRODUCTION_IDENTIFIER_INVALID"
    );
    const productionRun = await productionStore.createRun({ projectId: "project-redact" });
    const index = await taskStore.readIndex(productionRun.projectId, productionRun.runId);
    const created = taskStore.createTaskUnlocked(index, {
      taskId: "task-sanitize",
      requestId: "request-sanitize",
      kind: "characterReferenceImages",
      operationKey: contentDigest({ sanitize: true }),
      targetArtifactIds: ["characterImages:V1:0"],
      progress: {
        prompt: "do not persist",
        promptTokens: "not usage and must not bypass prompt redaction",
        promptDigest: "a".repeat(64),
        imageDataUrl: `data:image/png;base64,${"A".repeat(120)}`
      },
      usage: {
        calls: 1,
        promptTokens: 12,
        completionTokens: 3,
        totalTokens: 15,
        byModel: [{ provider: "Fixture", model: "fixture-model", promptTokens: 12, completionTokens: 3, totalTokens: 15 }]
      }
    });
    assert.equal(created.task.progress.prompt, undefined);
    assert.equal(created.task.progress.promptTokens, undefined);
    assert.equal(created.task.progress.imageDataUrl, undefined);
    assert.equal(created.task.progress.promptDigest, "a".repeat(64));
    assert.equal(created.task.usage.promptTokens, 12);
    assert.equal(created.task.usage.byModel[0].promptTokens, 12);
    await productionStore.recordStage({
      ...productionRun,
      stageId: "referenceAnalysis",
      status: "running",
      requestId: "request-redact"
    });
    await productionStore.recordStage({
      ...productionRun,
      stageId: "referenceAnalysis",
      status: "conflicted",
      requestId: "request-redact",
      expectedRequestId: "request-redact",
      error: { code: "CONFLICT", message: `secret data:image/png;base64,${"A".repeat(120)}` }
    });
    const run = await productionStore.loadRun({ ...productionRun, includeContent: false });
    assert.equal(run.stages.referenceAnalysis.status, "conflicted");
    assert.doesNotMatch(JSON.stringify(run.stages.referenceAnalysis), /data:image|A{80}/u);
  });
});

test("every Stage terminal status uses the same sensitive-reason redaction", async () => {
  await withManager(async ({ productionStore }) => {
    const productionRun = await productionStore.createRun({ projectId: "project-stage-terminal-redaction" });
    for (const status of ["failed", "conflicted", "interrupted", "abandoned", "cancelled"]) {
      const stageId = `stage-${status}`;
      const requestId = `request-${status}`;
      await productionStore.recordStage({ ...productionRun, stageId, status: "running", requestId });
      await productionStore.recordStage({
        ...productionRun,
        stageId,
        status,
        requestId,
        expectedRequestId: requestId,
        error: {
          code: `TEST_${status.toUpperCase()}`,
          message: `secret data:image/png;base64,${"A".repeat(120)}`,
          details: [{ code: "PRIVATE", reason: `token ${"B".repeat(120)}` }]
        }
      });
    }
    const run = await productionStore.loadRun({ ...productionRun, includeContent: false });
    for (const status of ["failed", "conflicted", "interrupted", "abandoned", "cancelled"]) {
      const serialized = JSON.stringify(run.stages[`stage-${status}`]);
      assert.equal(run.stages[`stage-${status}`].status, status);
      assert.doesNotMatch(serialized, /data:image|A{80}|B{80}/u);
    }
  });
});

test("lock-free snapshot and task polling do not enter the Run Coordinator", async () => {
  await withManager(async ({ coordinator, productionStore, taskStore }) => {
    const productionRun = await productionStore.createRun({ projectId: "project-read" });
    let lockCalls = 0;
    const original = coordinator.withRunLock.bind(coordinator);
    coordinator.withRunLock = async (...args) => {
      lockCalls += 1;
      return original(...args);
    };
    await productionStore.readCurrentLineageSnapshot({ ...productionRun });
    await productionStore.loadRun({ ...productionRun, includeContent: false });
    await taskStore.listTasks({ ...productionRun });
    assert.equal(lockCalls, 0);
  });
});

test("lineage snapshots and Task sidecar reads stay lock-free and under 200ms while the Run lock is held", async () => {
  await withManager(async ({ coordinator, productionStore, taskStore }) => {
    const productionRun = await productionStore.createRun({ projectId: "project-read-latency" });
    const lockStarted = new Promise((resolve) => {
      void coordinator.withRunLock(productionRun.projectId, productionRun.runId, async () => {
        resolve();
        await new Promise((release) => setTimeout(release, 250));
      });
    });
    await lockStarted;
    const startedAt = performance.now();
    const [snapshot, tasks] = await Promise.all([
      productionStore.readCurrentLineageSnapshot({ ...productionRun }),
      taskStore.listTasks({ ...productionRun })
    ]);
    const elapsedMs = performance.now() - startedAt;
    assert.equal(snapshot.projectId, productionRun.projectId);
    assert.deepEqual(tasks, []);
    assert.ok(elapsedMs < 200, `lock-free reads took ${elapsedMs.toFixed(1)}ms`);
  });
});

test("release is idempotent and a late second finalize cannot change the terminal state", async () => {
  await withManager(async ({ productionStore, manager }) => {
    const productionRun = await productionStore.createRun({ projectId: "project-release-idempotent" });
    const created = await manager.createTask({
      ...productionRun,
      kind: "analysis",
      targetArtifactIds: ["referenceAnalysis"],
      execute: async () => new Promise(() => {})
    });
    await waitUntil(() => manager.getTaskById(created.task.taskId), (task) => task.status === "running");
    const first = await manager.releaseTask({ ...productionRun, taskId: created.task.taskId });
    const second = await manager.releaseTask({ ...productionRun, taskId: created.task.taskId });
    assert.equal(first.status, "abandoned");
    assert.equal(second.status, "abandoned");
    assert.equal(await manager.completeTask(created.task.taskId, {}), false);
    assert.equal((await manager.getTaskById(created.task.taskId)).status, "abandoned");
  }, { localStallMs: 5_000 });
});

test("shot video batch pause and resume are persisted without releasing its claims", async () => {
  await withManager(async ({ productionStore, manager }) => {
    const productionRun = await productionStore.createRun({ projectId: "project-video-batch-pause" });
    const created = await manager.createTask({
      ...productionRun,
      kind: "shotVideoBatch",
      pool: "media",
      targetArtifactIds: ["shotVideo:V1:S01"],
      progress: { controlState: "running", totalShots: 1 },
      execute: async () => new Promise(() => {})
    });
    await waitUntil(() => manager.getTaskById(created.task.taskId), (task) => task.status === "running");
    const paused = await manager.controlTask({ ...productionRun, taskId: created.task.taskId, action: "pause" });
    assert.equal(paused.status, "running");
    assert.equal(paused.progress.controlState, "paused");
    const resumed = await manager.controlTask({ ...productionRun, taskId: created.task.taskId, action: "resume" });
    assert.equal(resumed.status, "running");
    assert.equal(resumed.progress.controlState, "running");
    assert.equal((await manager.getTaskById(created.task.taskId)).progress.controlState, "running");
    await manager.releaseTask({ ...productionRun, taskId: created.task.taskId });
  }, { localStallMs: 5_000 });
});

test("terminating a shot video batch is durable and rejects late completion", async () => {
  await withManager(async ({ productionStore, manager }) => {
    const productionRun = await productionStore.createRun({ projectId: "project-video-batch-terminate" });
    const targetArtifactId = "shotVideo:V1:S01";
    const created = await manager.createTask({
      ...productionRun,
      kind: "shotVideoBatch",
      pool: "media",
      targetArtifactIds: [targetArtifactId],
      execute: async () => new Promise(() => {})
    });
    await waitUntil(() => manager.getTaskById(created.task.taskId), (task) => task.status === "running");
    const terminated = await manager.controlTask({
      ...productionRun,
      taskId: created.task.taskId,
      action: "terminate"
    });
    assert.equal(terminated.status, "cancelled");
    assert.equal(terminated.error.code, "SHOT_VIDEO_BATCH_TERMINATED");
    assert.equal(await manager.completeTask(created.task.taskId, {}), false);
    const replacement = await manager.createTask({
      ...productionRun,
      kind: "shotVideo",
      pool: "media",
      targetArtifactIds: [targetArtifactId],
      execute: async () => ({})
    });
    assert.equal(replacement.reused, false);
    await manager.waitForTask({ ...productionRun, taskId: replacement.task.taskId });
  }, { localStallMs: 5_000 });
});

test("DURABLE_TASK_MAX_CONCURRENCY=1 configures real queued execution defaults", () => {
  const previous = process.env.DURABLE_TASK_MAX_CONCURRENCY;
  process.env.DURABLE_TASK_MAX_CONCURRENCY = "1";
  try {
    const config = getConfig();
    assert.equal(config.durableTasks.pools.workflow.limit, 1);
    assert.equal(config.durableTasks.pools.media.limit, 1);
    assert.equal(config.durableTasks.pools.workflow.queueLimit, 8);
    assert.equal(config.durableTasks.maxQueuedBytes, 140 * 1024 * 1024);
  } finally {
    if (previous === undefined) delete process.env.DURABLE_TASK_MAX_CONCURRENCY;
    else process.env.DURABLE_TASK_MAX_CONCURRENCY = previous;
  }
});

test("pipeline restart interrupts the third child, preserves usage, and retries from the first missing target", async () => {
  await withManager(async ({ coordinator, productionStore, taskStore, manager }) => {
    const productionRun = await productionStore.createRun({ projectId: "project-pipeline-resume" });
    const targets = [
      "referenceAnalysis",
      "sourceScriptReconstruction",
      "creativeBrief",
      "visualGuardrails",
      "themeVariants"
    ];
    await coordinator.withRunLock(productionRun.projectId, productionRun.runId, async () => {
      const manifest = await productionStore.readManifest(productionRun.projectId, productionRun.runId);
      const index = await taskStore.readIndex(productionRun.projectId, productionRun.runId);
      taskStore.createTaskUnlocked(index, {
        taskId: "task-resume-parent",
        requestId: "request-resume-parent",
        kind: "directorPipeline",
        status: "running",
        operationKey: contentDigest({ task: "resume-parent" }),
        targetArtifactIds: targets
      });
      for (let childIndex = 0; childIndex < 3; childIndex += 1) {
        const artifactId = targets[childIndex];
        const childId = `task-resume-child-${childIndex + 1}`;
        const requestId = `request-resume-child-${childIndex + 1}`;
        taskStore.createTaskUnlocked(index, {
          taskId: childId,
          parentTaskId: "task-resume-parent",
          ownerTaskId: "task-resume-parent",
          requestId,
          kind: `pipelineStage${childIndex + 1}`,
          status: "running",
          operationKey: contentDigest({ task: childId }),
          targetArtifactIds: [artifactId],
          usage: {
            calls: 1,
            promptTokens: 10,
            completionTokens: 5,
            totalTokens: 15,
            costCny: 0.1,
            byModel: []
          }
        });
        if (childIndex < 2) {
          await productionStore.commitArtifactUnlocked(manifest, {
            ...productionRun,
            artifactId,
            artifactType: artifactId,
            requestId,
            expectedCurrentRevision: null,
            dependencies: [],
            content: { completedStage: childIndex + 1 }
          });
          taskStore.updateTaskUnlocked(index, childId, { status: "completed", completedAt: new Date() }, { activeOnly: true });
        }
      }
      await taskStore.writeIndexUnlocked(index);
    });

    await manager.reconcileInterruptedTasks();
    const interruptedParent = await taskStore.getTask({ ...productionRun, taskId: "task-resume-parent" });
    const interruptedChild = await taskStore.getTask({ ...productionRun, taskId: "task-resume-child-3" });
    assert.equal(interruptedParent.status, "interrupted");
    assert.equal(interruptedChild.status, "interrupted");
    assert.equal(interruptedParent.usage.calls, 3);
    assert.match(interruptedParent.error.message, /可能已经计费/u);

    const executed = [];
    const retried = await manager.createTask({
      ...productionRun,
      kind: "directorPipeline",
      targetArtifactIds: targets,
      input: { serverSelectedResume: true },
      execute: async (_input, context) => {
        const run = await productionStore.loadRun({ ...productionRun, includeContent: false });
        for (const artifactId of targets) {
          if (run.latestArtifacts?.[artifactId]?.lineage?.status === "current") continue;
          executed.push(artifactId);
          await context.commitArtifact({ artifactId, artifactType: artifactId, content: { resumed: artifactId } });
        }
      }
    });
    const completed = await manager.waitForTask({ ...productionRun, taskId: retried.task.taskId });
    assert.equal(completed.task.status, "completed");
    assert.deepEqual(executed, targets.slice(2));
    const run = await productionStore.loadRun({ ...productionRun, includeContent: false });
    assert.equal(run.latestArtifacts.referenceAnalysis.lineage.revision, "referenceAnalysis-r1");
    assert.equal(run.latestArtifacts.sourceScriptReconstruction.lineage.revision, "sourceScriptReconstruction-r1");
  });
});

test("startup reconciliation interrupts in-memory-only tasks and releases claims", async () => {
  await withManager(async ({ coordinator, productionStore, taskStore, manager }) => {
    const productionRun = await productionStore.createRun({ projectId: "project-restart" });
    await coordinator.withRunLock(productionRun.projectId, productionRun.runId, async () => {
      const index = await taskStore.readIndex(productionRun.projectId, productionRun.runId);
      taskStore.createTaskUnlocked(index, {
        taskId: "task-restart",
        requestId: "request-restart",
        kind: "analysis",
        status: "running",
        operationKey: contentDigest({ restart: true }),
        targetArtifactIds: ["referenceAnalysis"]
      });
      await taskStore.writeIndexUnlocked(index);
    });
    await manager.reconcileInterruptedTasks();
    const task = await taskStore.getTask({ ...productionRun, taskId: "task-restart" });
    assert.equal(task.status, "interrupted");
    assert.match(task.error.message, /可能已经计费/u);
    const index = await taskStore.readIndex(productionRun.projectId, productionRun.runId);
    assert.equal(index.claims.referenceAnalysis, undefined);
  });
});

test("startup reconciliation recovers an Artifact committed by the same requestId", async () => {
  await withManager(async ({ coordinator, productionStore, taskStore, manager }) => {
    const productionRun = await productionStore.createRun({ projectId: "project-recover-commit" });
    await coordinator.withRunLock(productionRun.projectId, productionRun.runId, async () => {
      const manifest = await productionStore.readManifest(productionRun.projectId, productionRun.runId);
      const index = await taskStore.readIndex(productionRun.projectId, productionRun.runId);
      taskStore.createTaskUnlocked(index, {
        taskId: "task-recover",
        requestId: "request-recover",
        kind: "analysis",
        status: "running",
        operationKey: contentDigest({ recover: true }),
        targetArtifactIds: ["referenceAnalysis"]
      });
      await productionStore.commitArtifactUnlocked(manifest, {
        ...productionRun,
        artifactId: "referenceAnalysis",
        artifactType: "referenceAnalysis",
        requestId: "request-recover",
        expectedCurrentRevision: null,
        content: { committedBeforeCrash: true },
        dependencies: []
      });
      await taskStore.writeIndexUnlocked(index);
    });
    await manager.reconcileInterruptedTasks();
    const task = await taskStore.getTask({ ...productionRun, taskId: "task-recover" });
    assert.equal(task.status, "completed");
    assert.equal(task.resultArtifactRefs[0].artifactId, "referenceAnalysis");
  });
});

test("startup reconciliation completes all five children and their pipeline parent", async () => {
  await withManager(async ({ coordinator, productionStore, taskStore, manager }) => {
    const productionRun = await productionStore.createRun({ projectId: "project-recover-pipeline" });
    const targets = [
      "referenceAnalysis",
      "sourceScriptReconstruction",
      "creativeBrief",
      "visualGuardrails",
      "themeVariants"
    ];
    await coordinator.withRunLock(productionRun.projectId, productionRun.runId, async () => {
      const manifest = await productionStore.readManifest(productionRun.projectId, productionRun.runId);
      const index = await taskStore.readIndex(productionRun.projectId, productionRun.runId);
      taskStore.createTaskUnlocked(index, {
        taskId: "task-recover-pipeline-parent",
        requestId: "request-recover-pipeline-parent",
        kind: "directorPipeline",
        status: "running",
        operationKey: contentDigest({ recover: "pipeline-parent" }),
        targetArtifactIds: targets
      });
      const dependencies = [];
      for (let position = 0; position < targets.length; position += 1) {
        const artifactId = targets[position];
        const taskId = `task-recover-pipeline-child-${position + 1}`;
        const requestId = `request-recover-pipeline-child-${position + 1}`;
        taskStore.createTaskUnlocked(index, {
          taskId,
          parentTaskId: "task-recover-pipeline-parent",
          ownerTaskId: "task-recover-pipeline-parent",
          requestId,
          kind: `pipelineStage${position + 1}`,
          status: "running",
          operationKey: contentDigest({ recover: taskId }),
          targetArtifactIds: [artifactId]
        });
        const committed = await productionStore.commitArtifactUnlocked(manifest, {
          ...productionRun,
          artifactId,
          artifactType: artifactId,
          requestId,
          expectedCurrentRevision: null,
          dependencies,
          content: { recoveredStage: position + 1 }
        });
        dependencies.push(committed.lineage);
      }
      await taskStore.writeIndexUnlocked(index);
    });

    await manager.reconcileInterruptedTasks();
    const tasks = await taskStore.listTasks(productionRun);
    const parent = tasks.find((task) => task.taskId === "task-recover-pipeline-parent");
    assert.equal(parent.status, "completed");
    assert.equal(parent.resultArtifactRefs.length, 5);
    assert.ok(tasks.filter((task) => task.parentTaskId === parent.taskId).every((task) => task.status === "completed"));
    const index = await taskStore.readIndex(productionRun.projectId, productionRun.runId);
    assert.deepEqual(index.claims, {});
  });
});

function signalWait(signal) {
  signal.throwIfAborted();
  return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
}

const directorKnownUsage = {
  calls: 1, promptTokens: 10, completionTokens: 5, totalTokens: 15,
  costCny: 0.01, costKnown: true,
  byModel: [{ provider: "Fixture", model: "fixture", calls: 1, promptTokens: 10, completionTokens: 5, totalTokens: 15, costCny: 0.01 }]
};

test("director pause closes the attempt, retains claims and completed stages, and resume redoes only the interrupted stage", async () => {
  await withManager(async ({ productionStore, taskStore, manager }) => {
    const run = await productionStore.createRun({ projectId: "project-director-controls" });
    const targets = ["referenceAnalysis", "sourceScriptReconstruction", "creativeBrief"];
    const attempts = Object.fromEntries(targets.map((id) => [id, 0]));
    const signals = [];
    const created = await manager.createTask({
      ...run, kind: "directorPipeline", targetArtifactIds: targets,
      execute: async (_input, root) => {
        for (const artifactId of targets) {
          const snapshot = await productionStore.loadRun({ ...run, includeContent: false });
          if (snapshot.latestArtifacts[artifactId]?.lineage.status === "current") continue;
          await root.runChild({ kind: artifactId, targetArtifactIds: [artifactId], execute: async (_data, context) => {
            await context.beforeProviderCall("provider", 10_000);
            context.providerRequestStarted();
            const attempt = ++attempts[artifactId];
            signals.push(context.signal);
            if (artifactId === targets[1] && attempt <= 2) {
              try { await signalWait(context.signal); } finally {
                // Second interrupted response has delivered a real usage report.
                if (attempt === 2) context.captureUsage(directorKnownUsage);
              }
            }
            context.captureUsage(directorKnownUsage);
            await context.afterProviderCall("validation");
            await context.commitArtifact({ artifactId, artifactType: artifactId, content: { attempt } });
            return { usage: directorKnownUsage };
          } });
        }
      }
    });
    const control = (action) => manager.controlTask({ ...run, taskId: created.task.taskId, action });
    await waitUntil(() => attempts[targets[1]], (value) => value === 1);
    const originalRevision = (await productionStore.loadRun({ ...run, includeContent: false })).latestArtifacts[targets[0]].lineage.revision;
    await control("pause");
    let paused = await waitUntil(() => manager.getTaskById(created.task.taskId), (task) => task.progress.controlState === "paused");
    assert.equal(paused.status, "running");
    assert.equal(signals[1].aborted, true);
    assert.equal(paused.usage.calls, 2);
    assert.equal(paused.usage.unreportedCalls, 1);
    assert.equal(paused.usage.totalTokens, 15);
    assert.equal(paused.usage.costCny, null);
    assert.equal(manager.watchdogs.has(created.task.taskId), false);
    await control("pause");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(attempts[targets[1]], 1, "pause never automatically reissues a provider request");
    const index = await taskStore.readIndex(run.projectId, run.runId);
    assert.ok(targets.every((id) => index.claims[id] === created.task.taskId));
    await assert.rejects(productionStore.commitArtifact({ ...run, artifactId: targets[0], artifactType: targets[0], content: { changed: true } }), (error) => error.code === "TASK_TARGET_BUSY");
    await control("resume");
    await waitUntil(() => attempts[targets[1]], (value) => value === 2);
    await control("pause");
    paused = await waitUntil(() => manager.getTaskById(created.task.taskId), (task) => task.progress.controlState === "paused");
    assert.equal(paused.usage.calls, 3);
    assert.equal(paused.usage.totalTokens, 30);
    assert.equal(paused.usage.unreportedCalls, 1);
    await control("resume");
    const result = await manager.waitForTask({ ...run, taskId: created.task.taskId });
    assert.equal(result.task.status, "completed", JSON.stringify(result.task.error));
    assert.deepEqual(Object.values(attempts), [1, 3, 1]);
    assert.equal(result.task.usage.calls, 5);
    assert.equal(result.task.usage.reportedCalls, 4);
    assert.equal(result.task.usage.unreportedCalls, 1);
    assert.equal(result.task.usage.usageComplete, false);
    assert.equal(result.task.usage.totalTokens, 60);
    assert.equal((await productionStore.loadRun({ ...run, includeContent: false })).latestArtifacts[targets[0]].lineage.revision, originalRevision);
    const children = (await taskStore.listTasks(run)).filter((task) => task.parentTaskId);
    assert.equal(new Set(children.map((task) => task.requestId)).size, 5);
    assert.equal(children.filter((task) => task.status === "interrupted").length, 2);
  // Paused watchdog removal is asserted above; disk I/O under the full suite
  // must not be mistaken for a stalled active operation.
  }, { localStallMs: 1000 });
});

test("director termination aborts current request, records unknown usage, releases all claims and preserves committed content", async () => {
  await withManager(async ({ productionStore, taskStore, manager }) => {
    const run = await productionStore.createRun({ projectId: "project-director-stop" });
    let contextSeen;
    const created = await manager.createTask({
      ...run, kind: "directorPipeline", targetArtifactIds: ["referenceAnalysis", "creativeBrief"],
      execute: async (_input, root) => {
        await root.commitArtifact({ artifactId: "referenceAnalysis", artifactType: "referenceAnalysis", content: { retained: true } });
        await root.runChild({ kind: "creativeBrief", targetArtifactIds: ["creativeBrief"], execute: async (_data, context) => {
          await context.beforeProviderCall("provider", 10_000);
          context.providerRequestStarted();
          contextSeen = context;
          await signalWait(context.signal);
        } });
      }
    });
    await waitUntil(() => contextSeen, Boolean);
    const cancelled = await manager.controlTask({ ...run, taskId: created.task.taskId, action: "terminate" });
    assert.equal(cancelled.status, "cancelled");
    assert.equal(contextSeen.signal.aborted, true);
    assert.equal(cancelled.usage.calls, 1);
    assert.equal(cancelled.usage.unreportedCalls, 1);
    assert.equal(cancelled.usage.usageComplete, false);
    assert.equal(cancelled.usage.costCny, null);
    await assert.rejects(contextSeen.commitArtifact({ artifactId: "creativeBrief", artifactType: "creativeBrief", content: {} }), (error) => ["TASK_OWNERSHIP_LOST", "DIRECTOR_RUN_TERMINATED"].includes(error.code));
    const loaded = await productionStore.loadRun({ ...run, includeContent: true });
    assert.equal(loaded.latestArtifacts.referenceAnalysis.content.retained, true);
    assert.equal(loaded.latestArtifacts.creativeBrief, undefined);
    assert.deepEqual((await taskStore.readIndex(run.projectId, run.runId)).claims, {});
    assert.equal((await manager.controlTask({ ...run, taskId: created.task.taskId, action: "terminate" })).status, "cancelled");
  });
});

test("director pause after response blocks a late commit and retains received usage", async () => {
  await withManager(async ({ productionStore, manager }) => {
    const run = await productionStore.createRun({ projectId: "project-director-before-commit" });
    let release;
    let reached = false;
    const gate = new Promise((resolve) => { release = resolve; });
    const created = await manager.createTask({ ...run, kind: "directorPipeline", targetArtifactIds: ["creativeBrief"], execute: async (_input, root) => {
      await root.runChild({ kind: "creativeBrief", targetArtifactIds: ["creativeBrief"], execute: async (_data, context) => {
        await context.beforeProviderCall("provider", 10_000);
        context.providerRequestStarted();
        context.captureUsage(directorKnownUsage);
        await context.afterProviderCall("validation");
        reached = true;
        await gate;
        await context.commitArtifact({ artifactId: "creativeBrief", artifactType: "creativeBrief", content: {} });
      } });
    } });
    await waitUntil(() => reached, Boolean);
    await manager.controlTask({ ...run, taskId: created.task.taskId, action: "pause" });
    await assert.rejects(manager.controlTask({ ...run, taskId: created.task.taskId, action: "resume" }), (error) => error.code === "TASK_CONTROL_PAUSE_PENDING");
    release();
    const paused = await waitUntil(() => manager.getTaskById(created.task.taskId), (task) => task.progress.controlState === "paused");
    assert.equal(paused.usage.totalTokens, 15);
    assert.equal(paused.usage.unreportedCalls, 0);
    assert.equal((await productionStore.loadRun({ ...run, includeContent: false })).latestArtifacts.creativeBrief, undefined);
    await manager.controlTask({ ...run, taskId: created.task.taskId, action: "terminate" });
    await waitUntil(() => manager.runtimes.size, (size) => size === 0);
    await waitUntil(() => manager.pools.workflow.running, (count) => count === 0);
  });
});

test("forced release of a parked director wakes its runner and frees its pool slot", async () => {
  await withManager(async ({ productionStore, manager }) => {
    const run = await productionStore.createRun({ projectId: "project-director-release" });
    let reached = false;
    const created = await manager.createTask({ ...run, kind: "directorPipeline", targetArtifactIds: ["creativeBrief"], execute: async (_input, context) => {
      await context.beforeProviderCall("provider", 10_000);
      context.providerRequestStarted();
      reached = true;
      await signalWait(context.signal);
    } });
    await waitUntil(() => reached, Boolean);
    await manager.controlTask({ ...run, taskId: created.task.taskId, action: "pause" });
    await waitUntil(() => manager.getTaskById(created.task.taskId), (task) => task.progress.controlState === "paused");
    assert.equal((await manager.releaseTask({ ...run, taskId: created.task.taskId })).status, "abandoned");
    await waitUntil(() => manager.pools.workflow.running, (count) => count === 0);
    assert.equal(manager.runtimes.size, 0);
    assert.equal(manager.watchdogs.size, 0);
  });
});

test("queued director can pause, resume, and terminate without waiting for an occupied workflow slot", async () => {
  await withManager(async ({ productionStore, manager }) => {
    const firstRun = await productionStore.createRun({ projectId: "project-director-queue-first" });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const first = await manager.createTask({ ...firstRun, kind: "fixture", targetArtifactIds: ["creativeBrief"], execute: async () => gate });
    await waitUntil(() => manager.getTaskById(first.task.taskId), (task) => task.status === "running");
    const secondRun = await productionStore.createRun({ projectId: "project-director-queue-second" });
    let calls = 0;
    const second = await manager.createTask({ ...secondRun, kind: "directorPipeline", targetArtifactIds: ["creativeBrief"], execute: async () => { calls += 1; } });
    const control = (action) => manager.controlTask({ ...secondRun, taskId: second.task.taskId, action });
    assert.equal((await control("pause")).progress.controlState, "paused");
    assert.equal((await control("resume")).progress.controlState, "running");
    assert.equal((await control("pause")).progress.controlState, "paused");
    assert.equal((await control("terminate")).status, "cancelled");
    assert.equal(calls, 0);
    assert.equal(manager.runtimes.has(second.task.taskId), false);
    assert.equal(manager.queuedBytes, 0);
    release();
    await manager.waitForTask({ ...firstRun, taskId: first.task.taskId });
  }, { pools: { workflow: { limit: 1, queueLimit: 8 } } });
});

test("director watchdog closes the active child and totals received and unknown usage before ending the parent", async () => {
  await withManager(async ({ productionStore, manager }) => {
    const run = await productionStore.createRun({ projectId: "project-director-stall-usage" });
    let signal;
    let reached = false;
    const created = await manager.createTask({ ...run, kind: "directorPipeline", targetArtifactIds: ["creativeBrief"], execute: async (_input, root) => {
      await root.runChild({ kind: "creativeBrief", targetArtifactIds: ["creativeBrief"], execute: async (_data, context) => {
        await context.beforeProviderCall("first_provider", 10_000);
        context.providerRequestStarted();
        context.captureUsage(directorKnownUsage);
        await context.beforeProviderCall("second_provider", 10_000);
        context.providerRequestStarted();
        signal = context.signal;
        reached = true;
        await signalWait(signal);
      } });
    } });
    await waitUntil(() => reached, Boolean);
    await manager.finishWithStatus(created.task.taskId, "failed", { code: "TASK_STALLED", message: "fixture watchdog" });
    const task = await manager.getTaskById(created.task.taskId);
    assert.equal(signal.aborted, true);
    assert.equal(task.usage.calls, 2);
    assert.equal(task.usage.totalTokens, 15);
    assert.equal(task.usage.unreportedCalls, 1);
    await waitUntil(() => manager.pools.workflow.running, (count) => count === 0);
  });
});

test("reconciliation marks a paused director interrupted and never dispatches its captured input", async () => {
  await withManager(async ({ productionStore, taskStore, coordinator, manager }) => {
    const run = await productionStore.createRun({ projectId: "project-director-paused-restart" });
    let calls = 0;
    const created = await manager.createTask({ ...run, kind: "directorPipeline", targetArtifactIds: ["creativeBrief"], execute: async (_input, context) => {
      await context.beforeProviderCall("provider", 10_000);
      context.providerRequestStarted();
      calls += 1;
      await signalWait(context.signal);
    } });
    await waitUntil(() => calls, (value) => value === 1);
    await manager.controlTask({ ...run, taskId: created.task.taskId, action: "pause" });
    await waitUntil(() => manager.getTaskById(created.task.taskId), (task) => task.progress.controlState === "paused");
    const restarted = new DurableTaskManager({ productionStore, taskStore, coordinator });
    await restarted.reconcileInterruptedTasks();
    assert.equal((await restarted.getTaskById(created.task.taskId)).status, "interrupted");
    assert.equal(calls, 1);
    assert.equal(restarted.runtimes.size, 0);
    assert.deepEqual((await taskStore.readIndex(run.projectId, run.runId)).claims, {});
    // The old process would no longer exist after a real restart.
    manager.stopDirectorRuntime(created.task.taskId, { code: "PROCESS_EXIT", message: "fixture cleanup" });
    await waitUntil(() => manager.pools.workflow.running, (count) => count === 0);
  });
});

test("rapid resume then pause and terminate releases the original parked gate without dispatching a new request", async (t) => {
  await withManager(async ({ productionStore, taskStore, manager }) => {
    const run = await productionStore.createRun({ projectId: "project-director-control-race" });
    let providerCalls = 0;
    const created = await manager.createTask({
      ...run, kind: "directorPipeline", targetArtifactIds: ["creativeBrief"],
      execute: async (_input, root) => root.runChild({
        kind: "creativeBrief", targetArtifactIds: ["creativeBrief"],
        execute: async (_data, context) => {
          await context.beforeProviderCall("provider", 10_000);
          context.providerRequestStarted();
          providerCalls += 1;
          await signalWait(context.signal);
        }
      })
    });
    const control = (action) => manager.controlTask({ ...run, taskId: created.task.taskId, action });
    await waitUntil(() => providerCalls, (count) => count === 1);
    await control("pause");
    await waitUntil(() => manager.getTaskById(created.task.taskId), (task) => task.progress.controlState === "paused");
    const runtime = manager.runtimes.get(created.task.taskId);
    const originalGate = runtime.resumeGate;
    const resumePersisted = Promise.withResolvers();
    const releaseResume = Promise.withResolvers();
    const updateTaskAtomic = manager.updateTaskAtomic.bind(manager);
    let holdResume = true;
    t.mock.method(manager, "updateTaskAtomic", async (...args) => {
      const result = await updateTaskAtomic(...args);
      // The resume transition is persisted and its Run lock released, but its
      // continuation has not resolved the gate. Let the next pause run here.
      if (holdResume && runtime.controlState === "running") {
        holdResume = false;
        resumePersisted.resolve();
        await releaseResume.promise;
      }
      return result;
    });
    try {
      const resuming = control("resume");
      await within(() => resumePersisted.promise);
      await control("pause");
      assert.notEqual(runtime.resumeGate, originalGate);
      assert.equal(providerCalls, 1);
      releaseResume.resolve();
      await resuming;
      await within(() => originalGate.promise);
      const pausedAgain = await waitUntil(() => manager.getTaskById(created.task.taskId), (task) => task.progress.controlState === "paused");
      assert.equal(pausedAgain.status, "running", "the new pause must not terminalize the parent");
      assert.equal(providerCalls, 1, "resume superseded by pause must not reissue the stage");
      const cancelled = await control("terminate");
      assert.equal(cancelled.status, "cancelled");
      await waitUntil(() => manager.pools.workflow.running, (count) => count === 0);
      assert.equal(manager.runtimes.size, 0);
      assert.equal(manager.watchdogs.size, 0);
      assert.equal(providerCalls, 1);
      assert.deepEqual((await taskStore.readIndex(run.projectId, run.runId)).claims, {});
      assert.equal((await taskStore.listTasks(run)).filter((task) => task.parentTaskId).length, 1);
    } finally {
      releaseResume.resolve();
      originalGate.resolve();
      runtime.resumeGate?.resolve();
      await control("terminate");
      await waitUntil(() => manager.pools.workflow.running, (count) => count === 0);
    }
  });
});

test("an ignored stale watchdog leaves a paused director waiter pending until a real terminal transition", async () => {
  await withManager(async ({ productionStore, taskStore, manager }) => {
    const run = await productionStore.createRun({ projectId: "project-director-stale-watchdog" });
    let providerCalls = 0;
    const created = await manager.createTask({
      ...run, kind: "directorPipeline", targetArtifactIds: ["creativeBrief"],
      execute: async (_input, context) => {
        await context.beforeProviderCall("provider", 10_000);
        context.providerRequestStarted();
        providerCalls += 1;
        await signalWait(context.signal);
      }
    });
    const args = { ...run, taskId: created.task.taskId };
    await waitUntil(() => providerCalls, (count) => count === 1);
    let waiterOutcome;
    const waiting = manager.waitForTask(args).then((outcome) => {
      waiterOutcome = outcome;
      return outcome;
    });
    await waitUntil(() => manager.waiters.get(args.taskId)?.length, (count) => count === 1);
    try {
      await manager.controlTask({ ...args, action: "pause" });
      await waitUntil(() => manager.getTaskById(args.taskId), (task) => task.progress.controlState === "paused");
      const applied = await manager.finishWithStatus(args.taskId, "failed", { code: "TASK_STALLED", message: "watchdog dispatched before pause" });
      assert.equal(applied, false);
      assert.equal((await manager.getTaskById(args.taskId)).status, "running");
      assert.equal(manager.waiters.get(args.taskId)?.length, 1, "an ignored watchdog must not remove or notify the waiter");
      assert.equal(waiterOutcome, undefined);
      assert.equal((await taskStore.readIndex(run.projectId, run.runId)).claims.creativeBrief, args.taskId);
      assert.equal(providerCalls, 1);
    } finally {
      await manager.controlTask({ ...args, action: "terminate" });
    }
    assert.equal((await within(() => waiting)).task.status, "cancelled");
    await waitUntil(() => manager.pools.workflow.running, (count) => count === 0);
  });
});

function fullStoryUsage(calls = 1) {
  return {
    calls, promptTokens: calls * 10, completionTokens: calls * 5, totalTokens: calls * 15,
    costCny: calls * 0.01, costKnown: true,
    byModel: [{ provider: "Fixture", model: "story-frozen", calls, promptTokens: calls * 10, completionTokens: calls * 5, totalTokens: calls * 15, costCny: calls * 0.01 }]
  };
}

let storySeedRequest = 0;
async function seedStoryControlArtifact(productionStore, run, input) {
  const current = await productionStore.loadRun({ ...run, includeContent: false });
  const lineage = current.latestArtifacts[input.artifactId]?.lineage;
  return productionStore.commitArtifact({
    ...run,
    ...input,
    requestId: `request-story-fixture-${++storySeedRequest}`,
    // 与状态库提交门同一口径：latest 那一版，不论是否 stale。
    expectedCurrentRevision: lineage?.revision || null,
    dependencies: input.dependencies || []
  });
}

test("Full Story resume uses a new request for the same root and frozen input, totaling primary and interrupted postpass usage", async () => {
  await withManager(async ({ productionStore, taskStore, manager }) => {
    const run = await productionStore.createRun({ projectId: "project-story-controls" });
    const dependency = await seedStoryControlArtifact(productionStore, run, { artifactId: "creativeBrief", artifactType: "creativeBrief", content: { premise: "frozen" } });
    const contexts = [];
    const requestIds = [];
    const secondReady = Promise.withResolvers();
    const finishSecond = Promise.withResolvers();
    let prepared = 0;
    const created = await manager.createTask({
      ...run, kind: "fullStory", targetArtifactIds: ["fullStory:V1"], dependencyIds: ["creativeBrief"],
      modelSnapshot: { provider: "Fixture", model: "story-frozen" },
      prepare: () => { prepared += 1; return { input: { promptSource: "private frozen input" } }; },
      execute: async (input, context) => {
        assert.deepEqual(input, { promptSource: "private frozen input" });
        contexts.push(context);
        requestIds.push((await context.getTask()).requestId);
        await context.beforeProviderCall("primary", 10_000);
        context.providerRequestStarted();
        context.captureUsage(fullStoryUsage(1));
        await context.afterProviderCall("primary_done");
        await context.beforeProviderCall("postpass", 10_000);
        context.providerRequestStarted();
        if (contexts.length === 1) await signalWait(context.signal);
        secondReady.resolve();
        await finishSecond.promise;
        context.captureUsage(fullStoryUsage(2));
        await context.afterProviderCall("validated");
        await context.commitArtifact({ artifactId: "fullStory:V1", artifactType: "fullStory", content: { story: "finished" } });
        return { usage: fullStoryUsage(2) };
      }
    });
    const args = { ...run, taskId: created.task.taskId };
    try {
      await waitUntil(() => manager.runtimes.get(args.taskId)?.providerCalls, (calls) => calls === 2);
      await manager.controlTask({ ...args, action: "pause" });
      let paused = await waitUntil(() => manager.getTaskById(args.taskId), (task) => task.progress.controlState === "paused");
      assert.equal(paused.status, "running");
      assert.equal(paused.usage.calls, 2);
      assert.equal(paused.usage.reportedCalls, 1);
      assert.equal(paused.usage.unreportedCalls, 1);
      assert.equal(paused.usage.totalTokens, 15);
      assert.equal(paused.usage.costCny, null);
      assert.equal(contexts[0].signal.reason.code, "FULL_STORY_PAUSED");
      assert.equal(manager.watchdogs.has(args.taskId), false);
      assert.equal((await taskStore.readIndex(run.projectId, run.runId)).claims["fullStory:V1"], args.taskId);
      assert.equal((await productionStore.loadRun({ ...run, includeContent: false })).stages["fullStory:V1"].status, "interrupted");
      await manager.controlTask({ ...args, action: "pause" });
      assert.equal(contexts.length, 1);
      await manager.controlTask({ ...args, action: "resume" });
      await within(() => secondReady.promise);
      assert.equal(prepared, 1, "continuing must not rebuild input against current artifacts");
      assert.notEqual(requestIds[0], requestIds[1]);
      const continuing = await manager.getTaskById(args.taskId);
      assert.equal(continuing.taskId, created.task.taskId);
      assert.equal(continuing.progress.attempt, 2);
      assert.equal(continuing.requestId, requestIds[1]);
      assert.equal(continuing.frozenDependencies[0].contentDigest, dependency.lineage.contentDigest);
      assert.deepEqual(continuing.modelSnapshot, { provider: "Fixture", model: "story-frozen" });
      contexts[0].captureUsage(fullStoryUsage(99));
      await assert.rejects(contexts[0].updateUsage(fullStoryUsage(99)), { code: "FULL_STORY_PAUSED" });
      await assert.rejects(contexts[0].commitArtifact({ artifactId: "fullStory:V1", artifactType: "fullStory", content: { late: true } }), { code: "FULL_STORY_PAUSED" });
      finishSecond.resolve();
      const result = await manager.waitForTask(args);
      assert.equal(result.task.status, "completed");
      assert.equal(result.task.usage.calls, 4);
      assert.equal(result.task.usage.reportedCalls, 3);
      assert.equal(result.task.usage.unreportedCalls, 1);
      assert.equal(result.task.usage.usageComplete, false);
      assert.equal(result.task.usage.totalTokens, 45);
      assert.equal(result.task.usage.byModel[0].calls, 3);
      const manifest = await productionStore.readManifest(run.projectId, run.runId);
      assert.equal(manifest.artifacts.find((artifact) => artifact.artifactId === "fullStory:V1").requestId, requestIds[1]);
      assert.deepEqual((await taskStore.readIndex(run.projectId, run.runId)).claims, {});
      assert.equal((await taskStore.listTasks(run)).length, 1, "attempts retain the same durable root");
      assert.doesNotMatch(await fs.readFile(taskStore.indexPath(run.projectId, run.runId), "utf8"), /private frozen input/);
    } finally {
      finishSecond.resolve();
      await manager.controlTask({ ...args, action: "terminate" });
      await waitUntil(() => manager.pools.workflow.running, (count) => count === 0);
    }
  });
});

test("Full Story repeated pauses accumulate each attempt once and keep unknown calls distinct", async () => {
  await withManager(async ({ productionStore, manager }) => {
    const run = await productionStore.createRun({ projectId: "project-story-repeat-pauses" });
    let attempts = 0;
    const created = await manager.createTask({ ...run, kind: "fullStory", targetArtifactIds: ["fullStory:V1"], execute: async (_input, context) => {
      await context.beforeProviderCall("provider", 10_000);
      context.providerRequestStarted();
      attempts += 1;
      if (attempts === 2) context.captureUsage(fullStoryUsage());
      await signalWait(context.signal);
    } });
    const args = { ...run, taskId: created.task.taskId };
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await waitUntil(() => attempts, (count) => count === attempt);
      await manager.controlTask({ ...args, action: "pause" });
      const paused = await waitUntil(() => manager.getTaskById(args.taskId), (task) => task.progress.controlState === "paused");
      assert.equal(paused.usage.calls, attempt);
      assert.equal(paused.usage.reportedCalls, attempt >= 2 ? 1 : 0);
      assert.equal(paused.usage.unreportedCalls, attempt >= 2 ? attempt - 1 : 1);
      if (attempt < 3) await manager.controlTask({ ...args, action: "resume" });
    }
    const result = await manager.controlTask({ ...args, action: "terminate" });
    assert.equal(result.status, "cancelled");
    assert.equal(result.usage.calls, 3);
    assert.equal(result.usage.totalTokens, 15);
    assert.equal(result.usage.unreportedCalls, 2);
    await waitUntil(() => manager.pools.workflow.running, (count) => count === 0);
  });
});

test("Full Story pause before commit blocks the old result and resume replaces only at a new successful commit", async () => {
  await withManager(async ({ productionStore, manager }) => {
    const run = await productionStore.createRun({ projectId: "project-story-before-commit" });
    const oldStory = await seedStoryControlArtifact(productionStore, run, { artifactId: "fullStory:V1", artifactType: "fullStory", content: { original: true } });
    const oldPlan = await seedStoryControlArtifact(productionStore, run, { artifactId: "animationPlan:V1", artifactType: "animationPlan", dependencies: [oldStory.lineage], content: { originalPlan: true }, createMediaNamespace: true });
    const ready = Promise.withResolvers();
    const release = Promise.withResolvers();
    let attempts = 0;
    const created = await manager.createTask({ ...run, kind: "fullStory", targetArtifactIds: ["fullStory:V1"], execute: async (_input, context) => {
      attempts += 1;
      await context.beforeProviderCall("provider", 10_000);
      context.providerRequestStarted();
      context.captureUsage(fullStoryUsage());
      if (attempts === 1) { ready.resolve(); await release.promise; }
      await context.commitArtifact({ artifactId: "fullStory:V1", artifactType: "fullStory", content: { attempt: attempts } });
      return { usage: fullStoryUsage() };
    } });
    const args = { ...run, taskId: created.task.taskId };
    await within(() => ready.promise);
    await manager.controlTask({ ...args, action: "pause" });
    await assert.rejects(manager.controlTask({ ...args, action: "resume" }), { code: "TASK_CONTROL_PAUSE_PENDING" });
    release.resolve();
    const paused = await waitUntil(() => manager.getTaskById(args.taskId), (task) => task.progress.controlState === "paused");
    assert.equal(paused.targetExpectedRevisions["fullStory:V1"], oldStory.lineage.revision);
    let loaded = await productionStore.loadRun({ ...run, includeContent: true });
    assert.deepEqual(loaded.latestArtifacts["fullStory:V1"].content, { original: true });
    assert.equal(loaded.latestArtifacts["animationPlan:V1"].lineage.status, "current");
    assert.equal(loaded.latestArtifacts["animationPlan:V1"].lineage.mediaNamespace, oldPlan.lineage.mediaNamespace);
    await manager.controlTask({ ...args, action: "resume" });
    const result = await manager.waitForTask(args);
    assert.equal(result.task.status, "completed");
    assert.equal(result.task.usage.calls, 2);
    assert.equal(result.task.usage.totalTokens, 30);
    loaded = await productionStore.loadRun({ ...run, includeContent: true });
    assert.deepEqual(loaded.latestArtifacts["fullStory:V1"].content, { attempt: 2 });
    assert.equal(loaded.latestArtifacts["animationPlan:V1"].lineage.status, "stale");
  });
});

test("Full Story control after commit is a no-op even if an upstream change already made the result stale", async () => {
  await withManager(async ({ productionStore, manager }) => {
    const run = await productionStore.createRun({ projectId: "project-story-after-commit" });
    await seedStoryControlArtifact(productionStore, run, { artifactId: "creativeBrief", artifactType: "creativeBrief", content: { version: 1 } });
    const committed = Promise.withResolvers();
    const release = Promise.withResolvers();
    let calls = 0;
    let signal;
    const created = await manager.createTask({ ...run, kind: "fullStory", targetArtifactIds: ["fullStory:V1"], dependencyIds: ["creativeBrief"], execute: async (_input, context) => {
      calls += 1;
      signal = context.signal;
      await context.commitArtifact({ artifactId: "fullStory:V1", artifactType: "fullStory", content: { completed: true } });
      committed.resolve();
      await release.promise;
      return {};
    } });
    const args = { ...run, taskId: created.task.taskId };
    try {
      await within(() => committed.promise);
      const beforeChange = await manager.controlTask({ ...args, action: "pause" });
      assert.equal(beforeChange.progress.controlState, "running");
      await seedStoryControlArtifact(productionStore, run, { artifactId: "creativeBrief", artifactType: "creativeBrief", content: { version: 2 } });
      assert.equal((await productionStore.loadRun({ ...run, includeContent: false })).latestArtifacts["fullStory:V1"].lineage.status, "stale");
      for (const action of ["pause", "resume", "terminate"]) {
        const task = await manager.controlTask({ ...args, action });
        assert.equal(task.progress.controlState, "running");
      }
      assert.equal(signal.aborted, false);
      release.resolve();
      assert.equal((await manager.waitForTask(args)).task.status, "completed");
      assert.equal(calls, 1);
    } finally { release.resolve(); }
  });
});

test("a Candidate dependency change while Full Story is paused conflicts before another provider call", async () => {
  await withManager(async ({ productionStore, taskStore, manager }) => {
    const run = await productionStore.createRun({ projectId: "project-story-paused-conflict" });
    await seedStoryControlArtifact(productionStore, run, { artifactId: "variant:V1", artifactType: "variant", content: { id: "V1", version: 1 } });
    let calls = 0;
    const created = await manager.createTask({ ...run, kind: "fullStory", targetArtifactIds: ["fullStory:V1"], dependencyIds: ["variant:V1"], execute: async (_input, context) => {
      await context.beforeProviderCall("provider", 10_000);
      context.providerRequestStarted();
      calls += 1;
      await signalWait(context.signal);
    } });
    const args = { ...run, taskId: created.task.taskId };
    await waitUntil(() => calls, (count) => count === 1);
    await manager.controlTask({ ...args, action: "pause" });
    await waitUntil(() => manager.getTaskById(args.taskId), (task) => task.progress.controlState === "paused");
    await seedStoryControlArtifact(productionStore, run, { artifactId: "variant:V1", artifactType: "variant", content: { id: "V1", version: 2 } });
    await manager.controlTask({ ...args, action: "resume" });
    const result = await manager.waitForTask(args);
    assert.equal(result.task.status, "conflicted");
    assert.equal(result.task.error.code, "TASK_FROZEN_CONTEXT_CONFLICT");
    assert.equal(calls, 1);
    assert.equal(result.task.usage.calls, 1);
    assert.equal(result.task.usage.unreportedCalls, 1);
    assert.deepEqual((await taskStore.readIndex(run.projectId, run.runId)).claims, {});
  });
});

test("terminating Full Story retains current Story, Plan and media while blocking a late commit", async () => {
  await withManager(async ({ productionStore, taskStore, manager }) => {
    const run = await productionStore.createRun({ projectId: "project-story-terminate" });
    const story = await seedStoryControlArtifact(productionStore, run, { artifactId: "fullStory:V1", artifactType: "fullStory", content: { retained: true } });
    const plan = await seedStoryControlArtifact(productionStore, run, { artifactId: "animationPlan:V1", artifactType: "animationPlan", dependencies: [story.lineage], content: { retained: true }, createMediaNamespace: true });
    await seedStoryControlArtifact(productionStore, run, { artifactId: "shotVideo:V1:A01", artifactType: "shotVideo", dependencies: [plan.lineage], content: { retained: true } });
    let contextSeen;
    const created = await manager.createTask({ ...run, kind: "fullStory", targetArtifactIds: ["fullStory:V1"], execute: async (_input, context) => {
      await context.beforeProviderCall("provider", 10_000);
      context.providerRequestStarted();
      contextSeen = context;
      await signalWait(context.signal);
    } });
    const args = { ...run, taskId: created.task.taskId };
    await waitUntil(() => contextSeen, Boolean);
    const cancelled = await manager.controlTask({ ...args, action: "terminate" });
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.error.code, "FULL_STORY_TERMINATED");
    assert.equal(cancelled.usage.calls, 1);
    assert.equal(cancelled.usage.unreportedCalls, 1);
    await assert.rejects(contextSeen.commitArtifact({ artifactId: "fullStory:V1", artifactType: "fullStory", content: { late: true } }), { code: "FULL_STORY_TERMINATED" });
    const loaded = await productionStore.loadRun({ ...run, includeContent: true });
    for (const artifactId of ["fullStory:V1", "animationPlan:V1", "shotVideo:V1:A01"]) {
      assert.equal(loaded.latestArtifacts[artifactId].lineage.status, "current");
      assert.equal(loaded.latestArtifacts[artifactId].content.retained, true);
    }
    assert.equal(loaded.latestArtifacts["animationPlan:V1"].lineage.mediaNamespace, plan.lineage.mediaNamespace);
    assert.deepEqual((await taskStore.readIndex(run.projectId, run.runId)).claims, {});
    assert.equal((await manager.controlTask({ ...args, action: "terminate" })).status, "cancelled");
    await waitUntil(() => manager.pools.workflow.running, (count) => count === 0);
  });
});

test("queued Full Story can pause, resume and terminate without provider work or a premature watchdog", async () => {
  await withManager(async ({ productionStore, manager }) => {
    const firstRun = await productionStore.createRun({ projectId: "project-story-queue-first" });
    const release = Promise.withResolvers();
    const first = await manager.createTask({ ...firstRun, kind: "fixture", targetArtifactIds: ["creativeBrief"], execute: () => release.promise });
    await waitUntil(() => manager.getTaskById(first.task.taskId), (task) => task.status === "running");
    const run = await productionStore.createRun({ projectId: "project-story-queue" });
    let calls = 0;
    const created = await manager.createTask({ ...run, kind: "fullStory", targetArtifactIds: ["fullStory:V1"], input: { queued: true }, execute: async () => { calls += 1; } });
    const args = { ...run, taskId: created.task.taskId };
    const paused = await manager.controlTask({ ...args, action: "pause" });
    assert.equal(paused.status, "queued");
    assert.equal(paused.progress.controlState, "paused");
    const resumed = await manager.controlTask({ ...args, action: "resume" });
    assert.equal(resumed.requestId, created.task.requestId);
    assert.equal(manager.watchdogs.has(args.taskId), false);
    await manager.controlTask({ ...args, action: "pause" });
    assert.equal((await manager.controlTask({ ...args, action: "terminate" })).status, "cancelled");
    assert.equal(calls, 0);
    assert.equal(manager.queuedBytes, 0);
    assert.equal(manager.runtimes.has(args.taskId), false);
    release.resolve();
    await manager.waitForTask({ ...firstRun, taskId: first.task.taskId });
  }, { pools: { workflow: { limit: 1, queueLimit: 8 } } });
});

test("restart interrupts a paused Full Story and keeps its cumulative usage without resubmitting", async () => {
  await withManager(async ({ productionStore, taskStore, coordinator, manager }) => {
    const run = await productionStore.createRun({ projectId: "project-story-paused-restart" });
    let calls = 0;
    const created = await manager.createTask({ ...run, kind: "fullStory", targetArtifactIds: ["fullStory:V1"], execute: async (_input, context) => {
      await context.beforeProviderCall("provider", 10_000);
      context.providerRequestStarted();
      calls += 1;
      if (calls === 2) context.captureUsage(fullStoryUsage());
      await signalWait(context.signal);
    } });
    const args = { ...run, taskId: created.task.taskId };
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await waitUntil(() => calls, (count) => count === attempt);
      await manager.controlTask({ ...args, action: "pause" });
      await waitUntil(() => manager.getTaskById(args.taskId), (task) => task.progress.controlState === "paused");
      if (attempt === 1) await manager.controlTask({ ...args, action: "resume" });
    }
    const restarted = new DurableTaskManager({ productionStore, taskStore, coordinator });
    await restarted.reconcileInterruptedTasks();
    const interrupted = await restarted.getTaskById(args.taskId);
    assert.equal(interrupted.status, "interrupted");
    assert.equal(interrupted.usage.calls, 2);
    assert.equal(interrupted.usage.totalTokens, 15);
    assert.equal(interrupted.usage.unreportedCalls, 1);
    assert.equal(restarted.runtimes.size, 0);
    assert.equal(calls, 2);
    assert.deepEqual((await taskStore.readIndex(run.projectId, run.runId)).claims, {});
    manager.stopDirectorRuntime(args.taskId, { code: "PROCESS_EXIT", message: "fixture process exit" });
    await waitUntil(() => manager.pools.workflow.running, (count) => count === 0);
  });
});

test("release of a paused Full Story wakes its gate and keeps accumulated usage", async () => {
  await withManager(async ({ productionStore, taskStore, manager }) => {
    const run = await productionStore.createRun({ projectId: "project-story-paused-release" });
    let started = false;
    const created = await manager.createTask({ ...run, kind: "fullStory", targetArtifactIds: ["fullStory:V1"], execute: async (_input, context) => {
      await context.beforeProviderCall("provider", 10_000);
      context.providerRequestStarted();
      started = true;
      await signalWait(context.signal);
    } });
    const args = { ...run, taskId: created.task.taskId };
    await waitUntil(() => started, Boolean);
    await manager.controlTask({ ...args, action: "pause" });
    await waitUntil(() => manager.getTaskById(args.taskId), (task) => task.progress.controlState === "paused");
    assert.equal((await manager.releaseTask(args)).status, "abandoned");
    await waitUntil(() => manager.pools.workflow.running, (count) => count === 0);
    assert.equal(manager.runtimes.size, 0);
    assert.equal(manager.watchdogs.size, 0);
    assert.equal((await manager.getTaskById(args.taskId)).usage.unreportedCalls, 1);
    assert.deepEqual((await taskStore.readIndex(run.projectId, run.runId)).claims, {});
  });
});

test("a queued heartbeat from an old Full Story attempt cannot mutate its resumed progress or watchdog", async (t) => {
  await withManager(async ({ productionStore, manager }) => {
    const run = await productionStore.createRun({ projectId: "project-story-old-heartbeat" });
    const contexts = [];
    const created = await manager.createTask({ ...run, kind: "fullStory", targetArtifactIds: ["fullStory:V1"], execute: async (_input, context) => {
      contexts.push(context);
      await context.beforeProviderCall("provider", 10_000);
      context.providerRequestStarted();
      await context.heartbeat({ currentAttempt: contexts.length });
      await signalWait(context.signal);
    } });
    const args = { ...run, taskId: created.task.taskId };
    await waitUntil(() => manager.runtimes.get(args.taskId)?.providerCalls, (calls) => calls === 1);
    const queued = Promise.withResolvers();
    const release = Promise.withResolvers();
    const touchTask = manager.touchTask.bind(manager);
    t.mock.method(manager, "touchTask", async (taskId, options, ...rest) => {
      if (options?.progress?.fromOldAttempt) { queued.resolve(); await release.promise; }
      return touchTask(taskId, options, ...rest);
    });
    const staleHeartbeat = contexts[0].heartbeat({ fromOldAttempt: true });
    const rejected = assert.rejects(staleHeartbeat, { code: "FULL_STORY_PAUSED" });
    try {
      await within(() => queued.promise);
      await manager.controlTask({ ...args, action: "pause" });
      await waitUntil(() => manager.getTaskById(args.taskId), (task) => task.progress.controlState === "paused");
      await manager.controlTask({ ...args, action: "resume" });
      const resumed = await waitUntil(() => manager.getTaskById(args.taskId), (task) => task.progress.currentAttempt === 2);
      const watchdog = manager.watchdogs.get(args.taskId);
      release.resolve();
      await rejected;
      const after = await manager.getTaskById(args.taskId);
      assert.deepEqual(after.progress, resumed.progress);
      assert.equal(after.watchdogDueAt, resumed.watchdogDueAt);
      assert.equal(manager.watchdogs.get(args.taskId), watchdog);
      assert.equal(contexts.length, 2);
    } finally {
      release.resolve();
      await manager.controlTask({ ...args, action: "terminate" });
      await waitUntil(() => manager.pools.workflow.running, (count) => count === 0);
    }
  });
});
