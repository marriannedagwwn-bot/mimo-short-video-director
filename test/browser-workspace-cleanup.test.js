import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BrowserWorkspaceCleanup } from "../src/browser-workspace-cleanup.js";
import { ProductionRunCoordinator } from "../src/production-run-coordinator.js";
import { ProductionStateStore } from "../src/production-state-store.js";
import { DurableTaskStore } from "../src/durable-task-store.js";
import { DurableTaskManager } from "../src/durable-task-manager.js";
import { FullModelOutputLogWriter } from "../src/full-model-output-log.js";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mimo-workspace-cleanup-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const coordinator = new ProductionRunCoordinator();
  const productionStore = new ProductionStateStore({ rootDir: path.join(root, "runs"), coordinator });
  const taskStore = new DurableTaskStore({ rootDir: productionStore.rootDir });
  const taskManager = new DurableTaskManager({ productionStore, taskStore, coordinator, pools: { workflow: { limit: 1, queueLimit: 8 } } });
  const options = { productionStore, taskManager, coordinator, publicDir: path.join(root, "public"), cleanupRoot: path.join(root, "cleanup"), outputLogRoots: [path.join(root, "logs")] };
  const cleanup = new BrowserWorkspaceCleanup(options);
  const run = await productionStore.createRun({ projectId: "project-owned", metadata: { browserWorkspaceId: "workspace-owned" } });
  const ids = { projectId: run.projectId, runId: run.runId, workspaceId: "workspace-owned" };
  const writer = new FullModelOutputLogWriter({ outputRoot: options.outputLogRoots[0], onWarning: (message) => { throw new Error(message); } });
  const mediaPath = (kind, target = run) => path.join(options.publicDir, kind, target.projectId, target.runId, "r000001-plan", "asset.bin");
  return { root, ...options, cleanup, run, ids, writer, mediaPath };
}

async function put(file, content = "owned content") {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

async function absent(file) {
  await assert.rejects(fs.stat(file), (error) => error.code === "ENOENT");
}

function logInput(ids) {
  return { context: { verified: true, projectId: ids.projectId, runId: ids.runId, artifactId: "fullStory:V1", variantId: "V1", productionRequestId: "request-1" }, content: "full output fixture" };
}

async function until(predicate) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "local runner must finish");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("owned cleanup removes the Run, generated images/videos and bound logs while preserving unrelated data", async (t) => {
  const f = await fixture(t);
  const oldRun = await f.productionStore.createRun({ projectId: f.ids.projectId });
  const ownImage = f.mediaPath("generated-images");
  const ownVideo = f.mediaPath("generated-videos");
  const oldVideo = f.mediaPath("generated-videos", oldRun);
  await Promise.all([put(ownImage), put(ownVideo), put(oldVideo)]);
  const ownLog = await f.writer.recordAttempt(logInput(f.ids));
  const oldLog = await f.writer.recordAttempt(logInput(oldRun));
  const unboundLog = await f.writer.recordAttempt({ content: "unbound historic output" });
  assert.ok(ownLog?.outputPath);
  assert.deepEqual(await f.cleanup.cleanup(f.ids), { deleted: true, pending: false });
  await Promise.all([absent(f.productionStore.runDirectory(f.ids.projectId, f.ids.runId)), absent(ownImage), absent(ownVideo), absent(ownLog.outputPath)]);
  assert.equal(await fs.readFile(oldVideo, "utf8"), "owned content");
  assert.ok(await f.productionStore.loadRun(oldRun));
  assert.equal(await fs.readFile(oldLog.outputPath, "utf8"), "full output fixture");
  assert.equal(await fs.readFile(unboundLog.outputPath, "utf8"), "unbound historic output");
  assert.deepEqual(await fs.readdir(f.cleanupRoot), []);
  assert.deepEqual(await f.cleanup.cleanup(f.ids), { deleted: true, pending: false, missing: true });
});

test("cleanup rejects another workspace, historic unowned Runs, dot identifiers and symlink ancestors", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.cleanup.cleanup({ ...f.ids, workspaceId: "workspace-other" }), (error) => error.code === "BROWSER_WORKSPACE_RUN_OWNERSHIP_MISMATCH");
  const historical = await f.productionStore.createRun({ projectId: "project-historical" });
  await assert.rejects(f.cleanup.cleanup({ ...f.ids, projectId: historical.projectId, runId: historical.runId }), (error) => error.code === "BROWSER_WORKSPACE_RUN_OWNERSHIP_MISMATCH");
  for (const projectId of [".", "..", "../project-owned", "/tmp", ""]) {
    await assert.rejects(f.cleanup.cleanup({ ...f.ids, projectId }), (error) => error.code === "BROWSER_WORKSPACE_CLEANUP_ID_INVALID");
  }
  const outside = path.join(f.root, "outside");
  await put(path.join(outside, "run-protected", "protected.txt"));
  await fs.symlink(outside, path.join(f.productionStore.rootDir, "project-link"));
  await assert.rejects(f.cleanup.cleanup({ ...f.ids, projectId: "project-link", runId: "run-protected" }), (error) => error.code === "BROWSER_WORKSPACE_CLEANUP_PATH_INVALID");
  assert.equal(await fs.readFile(path.join(outside, "run-protected", "protected.txt"), "utf8"), "owned content");
  assert.ok(await f.productionStore.loadRun(f.run));
});

test("active cleanup cancels queued work, prevents late commits, and sweeps late output after the local runner exits", async (t) => {
  const f = await fixture(t);
  let started = false;
  let finishProvider;
  let lateCommitError;
  let lateLog;
  const provider = new Promise((resolve) => { finishProvider = resolve; });
  const running = await f.taskManager.createTask({
    projectId: f.ids.projectId, runId: f.ids.runId, kind: "analysis", targetArtifactIds: ["referenceAnalysis"], input: {},
    execute: async (_input, context) => {
      started = true;
      await provider;
      // A real logger may finish after cancellation; it must be removed by the
      // final sweep even though the artifact guard rejects this late result.
      lateLog = await f.writer.recordAttempt(logInput(f.ids));
      await put(f.mediaPath("generated-videos"), "late output");
      try {
        await context.commitArtifact({ artifactId: "referenceAnalysis", artifactType: "referenceAnalysis", content: { late: true } });
      } catch (error) { lateCommitError = error; throw error; }
      return {};
    }
  });
  await until(() => started);
  let queuedExecuted = false;
  const queued = await f.taskManager.createTask({
    projectId: f.ids.projectId, runId: f.ids.runId, kind: "brief", targetArtifactIds: ["creativeBrief"], input: { queued: true },
    execute: async () => { queuedExecuted = true; return {}; }
  });
  assert.ok(f.taskManager.queuedBytes > 0);
  assert.deepEqual(await f.cleanup.cleanup(f.ids), { deleted: true, pending: true });
  await absent(f.productionStore.runDirectory(f.ids.projectId, f.ids.runId));
  assert.equal(f.taskManager.queuedBytes, 0);
  assert.equal(f.taskManager.runtimes.has(queued.task.taskId), false);
  assert.equal(f.taskManager.watchdogs.size, 0);
  const [marker] = await fs.readdir(f.cleanupRoot);
  const storedMarker = JSON.parse(await fs.readFile(path.join(f.cleanupRoot, marker), "utf8"));
  assert.deepEqual(Object.keys(storedMarker).sort(), ["projectId", "runId", "type", "workspaceId"]);
  await assert.rejects(f.cleanup.cleanup({ ...f.ids, workspaceId: "workspace-other" }), (error) => error.code === "BROWSER_WORKSPACE_RUN_OWNERSHIP_MISMATCH");
  finishProvider();
  await until(() => !f.taskManager.runtimes.has(running.task.taskId));
  assert.ok(lateCommitError);
  assert.equal(queuedExecuted, false);
  await f.cleanup.sweepPending();
  await Promise.all([absent(lateLog.outputPath), absent(f.mediaPath("generated-videos")), absent(f.productionStore.runDirectory(f.ids.projectId, f.ids.runId))]);
  assert.deepEqual(await fs.readdir(f.cleanupRoot), []);
  assert.equal(f.taskManager.taskLocations.has(running.task.taskId), false);
});

for (const entry of ["cleanup", "sweepPending"]) for (const initialState of ["running", "paused"]) {
  test(`${entry} stops a ${initialState} director outside cleanup locks and returns its workflow slot`, async (t) => {
    const f = await fixture(t);
    let context;
    let attempts = 0;
    const created = await f.taskManager.createTask({
      projectId: f.ids.projectId, runId: f.ids.runId, kind: "directorPipeline",
      targetArtifactIds: ["referenceAnalysis"], input: {},
      execute: async (_input, current) => {
        context = current;
        attempts += 1;
        await new Promise((_, reject) => current.signal.addEventListener("abort", () => reject(current.signal.reason), { once: true }));
        assert.fail("aborted director must never continue its old attempt");
      }
    });
    const taskId = created.task.taskId;
    const realStop = f.taskManager.stopDirectorRuntime.bind(f.taskManager);
    t.after(async () => {
      realStop(taskId, new Error("test cleanup"));
      await until(() => !f.taskManager.runtimes.has(taskId));
    });
    await until(() => Boolean(context));
    if (initialState === "paused") {
      await f.taskManager.controlTask({ ...f.ids, taskId, action: "pause" });
      await until(() => f.taskManager.runtimes.get(taskId)?.controlState === "paused");
    }
    assert.equal(f.taskManager.pools.workflow.running, 1);
    const nextRun = await f.productionStore.createRun({ projectId: "project-next" });
    let nextStarted = false;
    const next = await f.taskManager.createTask({
      ...nextRun, kind: "analysis", targetArtifactIds: ["referenceAnalysis"], input: {},
      execute: async () => { nextStarted = true; return {}; }
    });
    assert.equal(next.task.status, "queued");

    let inCleanupLock = false;
    const realLocks = f.cleanup.withLocks.bind(f.cleanup);
    f.cleanup.withLocks = (ids, operation) => realLocks(ids, async () => {
      inCleanupLock = true;
      try { return await operation(); } finally { inCleanupLock = false; }
    });
    const stopped = [];
    f.taskManager.stopDirectorRuntime = (id, reason) => {
      assert.equal(inCleanupLock, false, "abort and resumeGate callbacks must run after both cleanup locks are released");
      assert.equal(f.taskManager.runtimes.get(id)?.active, false, "ownership must be revoked before waking the parked runner");
      stopped.push({ id, reason });
      realStop(id, reason);
    };
    if (entry === "sweepPending") await f.cleanup.writeMarker(f.ids);
    const result = entry === "cleanup" ? await f.cleanup.cleanup(f.ids) : (await f.cleanup.sweepPending())[0];
    assert.deepEqual(result, { deleted: true, pending: true });
    assert.equal(stopped.length, 1);
    assert.equal(stopped[0].id, taskId);
    assert.equal(stopped[0].reason.code, "BROWSER_WORKSPACE_CLOSED");
    assert.equal(context.signal.aborted, true);
    if (initialState === "running") assert.equal(context.signal.reason.code, "BROWSER_WORKSPACE_CLOSED");
    await until(() => !f.taskManager.runtimes.has(taskId) && nextStarted && f.taskManager.pools.workflow.running === 0);
    assert.equal(attempts, 1);
    assert.equal(f.taskManager.runtimes.size, 0);
    await assert.rejects(context.commitArtifact({
      artifactId: "referenceAnalysis", artifactType: "referenceAnalysis", content: { late: true }
    }));
    await absent(f.productionStore.runDirectory(f.ids.projectId, f.ids.runId));
    assert.equal((await fs.readdir(f.cleanupRoot)).length, 1);
    await f.cleanup.sweepPending();
    assert.deepEqual(await fs.readdir(f.cleanupRoot), []);
    assert.equal(f.taskManager.taskLocations.has(taskId), false);
    assert.equal((await f.taskManager.taskStore.getTask({ ...nextRun, taskId: next.task.taskId })).status, "completed");
  });
}

test("a restarted cleaner replays an ID-only marker and removes output written after the original deletion", async (t) => {
  const f = await fixture(t);
  // Represent an in-flight Runner whose old process will no longer exist after
  // restart. No provider call is needed for this filesystem recovery contract.
  f.taskManager.runtimes.set("task-old-process", { active: true, definition: f.ids });
  f.taskManager.taskLocations.set("task-old-process", f.ids);
  assert.equal((await f.cleanup.cleanup(f.ids)).pending, true);
  await put(f.mediaPath("generated-images"), "late image");
  f.taskManager.runtimes.clear();
  f.taskManager.taskLocations.clear();
  const restarted = new BrowserWorkspaceCleanup(f);
  await restarted.sweepPending();
  await absent(f.mediaPath("generated-images"));
  assert.deepEqual(await fs.readdir(f.cleanupRoot), []);
});

test("cleanup does not trust a missing Run as authority to remove same-named public files", async (t) => {
  const f = await fixture(t);
  const missing = { ...f.ids, runId: "run-missing" };
  const file = f.mediaPath("generated-images", missing);
  await put(file, "unowned orphan");
  assert.deepEqual(await f.cleanup.cleanup(missing), { deleted: true, pending: false, missing: true });
  assert.equal(await fs.readFile(file, "utf8"), "unowned orphan");
});

test("a task queued concurrently behind cleanup cannot recreate the deleted Run", async (t) => {
  const f = await fixture(t);
  const removing = f.cleanup.cleanup(f.ids);
  const creating = f.taskManager.createTask({
    projectId: f.ids.projectId, runId: f.ids.runId, kind: "analysis", targetArtifactIds: ["referenceAnalysis"], input: {},
    execute: async () => { assert.fail("removed Run must never execute a new task"); }
  });
  const results = await Promise.allSettled([removing, creating]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  assert.equal(results[1].reason.code, "PRODUCTION_RUN_NOT_FOUND");
  await absent(f.productionStore.runDirectory(f.ids.projectId, f.ids.runId));
  assert.equal(f.taskManager.runtimes.size, 0);
});

async function within(promise) {
  let timeout;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error("task waiter did not settle")), 500);
    })]);
  } finally { clearTimeout(timeout); }
}

test("cleanup settles attached waiters before deleting the index and later concurrent notifications remain harmless", async (t) => {
  const f = await fixture(t);
  let release;
  let started = false;
  const provider = new Promise((resolve) => { release = resolve; });
  const created = await f.taskManager.createTask({
    projectId: f.ids.projectId, runId: f.ids.runId, kind: "analysis", targetArtifactIds: ["referenceAnalysis"], input: {},
    execute: async () => { started = true; await provider; return {}; }
  });
  try {
    await until(() => started);
    const waiting = f.taskManager.waitForTask({ ...f.ids, taskId: created.task.taskId });
    await until(() => f.taskManager.waiters.has(created.task.taskId));
    await within(f.cleanup.cleanup(f.ids));
    const result = await within(waiting);
    assert.equal(result.task.status, "abandoned");
    await absent(f.productionStore.runDirectory(f.ids.projectId, f.ids.runId));
    await within(Promise.all(Array.from({ length: 8 }, () => f.taskManager.notifyWaiters(created.task.taskId))));
    assert.equal(f.taskManager.waiters.has(created.task.taskId), false);
  } finally {
    release();
    await until(() => !f.taskManager.runtimes.has(created.task.taskId));
    await f.cleanup.sweepPending();
  }
});

test("a waiter registering from an old active snapshot after cleanup rejects instead of hanging", async (t) => {
  const f = await fixture(t);
  let releaseProvider;
  let started = false;
  const provider = new Promise((resolve) => { releaseProvider = resolve; });
  const created = await f.taskManager.createTask({
    projectId: f.ids.projectId, runId: f.ids.runId, kind: "analysis", targetArtifactIds: ["referenceAnalysis"], input: {},
    execute: async () => { started = true; await provider; return {}; }
  });
  await until(() => started);
  const originalGetTask = f.taskManager.taskStore.getTask.bind(f.taskManager.taskStore);
  let releaseSnapshot;
  const snapshotGate = new Promise((resolve) => { releaseSnapshot = resolve; });
  let snapshotTaken = false;
  let holdFirst = true;
  f.taskManager.taskStore.getTask = async (input) => {
    const snapshot = await originalGetTask(input);
    if (holdFirst) {
      holdFirst = false;
      snapshotTaken = true;
      await snapshotGate;
    }
    return snapshot;
  };
  try {
    const waiting = f.taskManager.waitForTask({ ...f.ids, taskId: created.task.taskId }).then((value) => ({ value }), (error) => ({ error }));
    await until(() => snapshotTaken);
    await f.cleanup.cleanup(f.ids);
    releaseSnapshot();
    const outcome = await within(waiting);
    assert.equal(outcome.error?.code, "TASK_NOT_FOUND");
    assert.equal(f.taskManager.waiters.has(created.task.taskId), false);
  } finally {
    releaseSnapshot();
    f.taskManager.taskStore.getTask = originalGetTask;
    releaseProvider();
    await until(() => !f.taskManager.runtimes.has(created.task.taskId));
    await f.cleanup.sweepPending();
  }
});

test("startup reconciliation removes only UUID-owned orphan Runs and keeps current, pending and historical data", async (t) => {
  const f = await fixture(t);
  const workspaceId = "11111111-1111-4111-8111-111111111111";
  const createOwned = () => f.productionStore.createRun({ projectId: "project-recovery", metadata: { browserWorkspaceId: workspaceId } });
  const current = await createOwned();
  const pending = await createOwned();
  const orphan = await createOwned();
  const historical = await f.productionStore.createRun({ projectId: "project-recovery" });
  const invalidOwner = await f.productionStore.createRun({ projectId: "project-recovery", metadata: { browserWorkspaceId: "not-a-workspace-uuid" } });
  const orphanVideo = f.mediaPath("generated-videos", orphan);
  const currentVideo = f.mediaPath("generated-videos", current);
  await Promise.all([put(orphanVideo), put(currentVideo)]);
  const referenced = new Set([current.runId, pending.runId]);
  const inspected = [];
  const removed = await f.cleanup.reconcileOrphanedRuns({
    hasWorkspaceRunReference: async (ids) => {
      inspected.push(ids);
      return referenced.has(ids.runId);
    }
  });
  assert.deepEqual(removed.map((item) => item.runId), [orphan.runId]);
  assert.deepEqual(inspected.map((item) => item.runId).sort(), [current.runId, pending.runId, orphan.runId].sort());
  assert.ok(inspected.every((item) => item.workspaceId === workspaceId));
  await absent(f.productionStore.runDirectory(orphan.projectId, orphan.runId));
  await absent(orphanVideo);
  for (const run of [current, pending, historical, invalidOwner, f.run]) assert.ok(await f.productionStore.loadRun(run));
  assert.equal(await fs.readFile(currentVideo, "utf8"), "owned content");
});

test("startup orphan reconciliation never deletes on unknown workspace reads and never follows project, Run or manifest symlinks", async (t) => {
  const f = await fixture(t);
  const workspaceId = "22222222-2222-4222-8222-222222222222";
  const owned = await f.productionStore.createRun({ projectId: "project-unknown", metadata: { browserWorkspaceId: workspaceId } });
  await assert.rejects(f.cleanup.reconcileOrphanedRuns({
    hasWorkspaceRunReference: async () => { throw Object.assign(new Error("unreadable session"), { code: "EACCES" }); }
  }), AggregateError);
  assert.ok(await f.productionStore.loadRun(owned));
  await assert.rejects(f.cleanup.reconcileOrphanedRuns({ hasWorkspaceRunReference: async () => undefined }), AggregateError);
  assert.ok(await f.productionStore.loadRun(owned));

  const outside = path.join(f.root, "outside-scanned-root");
  const outsideRun = path.join(outside, "run-outside");
  await put(path.join(outsideRun, "manifest.json"), JSON.stringify({ metadata: { browserWorkspaceId: workspaceId } }));
  await fs.symlink(outside, path.join(f.productionStore.rootDir, "project-symlink"));
  await fs.symlink(outsideRun, path.join(f.productionStore.rootDir, owned.projectId, "run-symlink"));
  const linkedManifest = path.join(f.productionStore.rootDir, owned.projectId, "run-linked-manifest");
  await fs.mkdir(linkedManifest);
  await fs.symlink(path.join(outsideRun, "manifest.json"), path.join(linkedManifest, "manifest.json"));
  const inspected = [];
  await f.cleanup.reconcileOrphanedRuns({ hasWorkspaceRunReference: async (ids) => { inspected.push(ids); return true; } });
  assert.deepEqual(inspected.map((item) => item.runId), [owned.runId]);
  assert.ok(await fs.stat(path.join(outsideRun, "manifest.json")));
});
