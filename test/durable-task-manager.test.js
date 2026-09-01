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
        promptDigest: "a".repeat(64),
        imageDataUrl: `data:image/png;base64,${"A".repeat(120)}`
      }
    });
    assert.equal(created.task.progress.prompt, undefined);
    assert.equal(created.task.progress.imageDataUrl, undefined);
    assert.equal(created.task.progress.promptDigest, "a".repeat(64));
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
