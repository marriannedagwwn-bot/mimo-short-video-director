import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { ProductionStateError } from "./production-lineage.js";
import { DURABLE_TASK_ACTIVE_STATUSES } from "./durable-task-store.js";

const MARKER_VERSION = "mimo-browser-workspace-cleanup/1.0";
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u;
const WORKSPACE_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

// Only browser-owned Runs enter this cleaner. The durable marker contains IDs,
// never source data, and remains until every local Runner has left its finally.
// The server's existing workspace sweep retries it after late output or restart.
export class BrowserWorkspaceCleanup {
  constructor({ productionStore, taskManager, coordinator, publicDir, cleanupRoot, outputLogRoots = [] } = {}) {
    if (!productionStore || !taskManager || !coordinator || !publicDir || !cleanupRoot) {
      throw new TypeError("BrowserWorkspaceCleanup 需要 productionStore、taskManager、coordinator、publicDir 与 cleanupRoot");
    }
    this.productionStore = productionStore;
    this.taskManager = taskManager;
    this.coordinator = coordinator;
    this.publicDir = path.resolve(publicDir);
    this.cleanupRoot = path.resolve(cleanupRoot);
    this.outputLogRoots = [...new Set(outputLogRoots.filter((value) => typeof value === "string" && value.trim()).map((value) => path.resolve(value)))];
  }

  async cleanup(input = {}) {
    const ids = cleanupIds(input);
    return this.withCleanupLocks(ids, async (directorRoots) => {
      const manifest = await this.readManifestIfPresent(ids);
      const existing = await this.readMarkerIfPresent(ids);
      if (manifest) this.assertOwner(manifest, ids);
      else if (existing) this.assertMarkerOwner(existing, ids);
      else return { deleted: true, pending: false, missing: true };
      await this.writeMarker(ids);
      return this.cleanupUnlocked(ids, manifest, directorRoots);
    });
  }

  async sweepPending() {
    let entries;
    try { entries = await fs.readdir(this.cleanupRoot, { withFileTypes: true }); } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    const results = [];
    const errors = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/u.test(entry.name)) continue;
      try {
        const file = path.join(this.cleanupRoot, entry.name);
        let marker;
        try { marker = JSON.parse(await fs.readFile(file, "utf8")); } catch (error) {
          if (error.code === "ENOENT") continue;
          throw error;
        }
        const ids = cleanupIds(marker);
        if (marker.type !== MARKER_VERSION || path.basename(this.markerPath(ids)) !== entry.name) {
          throw cleanupError("页面清理记录无效", "BROWSER_WORKSPACE_CLEANUP_MARKER_INVALID");
        }
        results.push(await this.withCleanupLocks(ids, async (directorRoots) => {
          if (!await this.readMarkerIfPresent(ids)) return { deleted: true, pending: false };
          const manifest = await this.readManifestIfPresent(ids);
          if (manifest) this.assertOwner(manifest, ids);
          return this.cleanupUnlocked(ids, manifest, directorRoots);
        }));
      } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "部分页面生产数据清理失败，将在下次清理时重试");
    return results;
  }

  // Startup only, before accepting requests: a crash can occur after createRun
  // persists its owner but before the workspace attaches its Run reference.
  async reconcileOrphanedRuns({ hasWorkspaceRunReference } = {}) {
    if (typeof hasWorkspaceRunReference !== "function") {
      throw new TypeError("恢复页面孤儿 Run 需要 hasWorkspaceRunReference");
    }
    const results = [];
    const errors = [];
    for (const project of await directoryEntries(this.productionStore.rootDir)) {
      if (!project.isDirectory() || !SAFE_ID.test(project.name)) continue;
      try {
        if (!await safeExistingDirectory(this.productionStore.rootDir, [project.name])) continue;
        for (const run of await directoryEntries(path.join(this.productionStore.rootDir, project.name))) {
          if (!run.isDirectory() || !SAFE_ID.test(run.name)) continue;
          try {
            const coordinates = { projectId: project.name, runId: run.name };
            if (!await safeExistingDirectory(this.productionStore.rootDir, [project.name, run.name])) continue;
            let stat;
            try { stat = await fs.lstat(this.productionStore.manifestPath(project.name, run.name)); } catch (error) {
              if (error.code === "ENOENT") continue;
              throw error;
            }
            if (!stat.isFile() || stat.isSymbolicLink()) continue;
            const manifest = await this.productionStore.readManifest(project.name, run.name);
            const workspaceId = manifest.metadata?.browserWorkspaceId;
            if (typeof workspaceId !== "string" || !WORKSPACE_UUID.test(workspaceId)) continue;
            const ids = { ...coordinates, workspaceId };
            const referenced = await hasWorkspaceRunReference(ids);
            if (referenced === true) continue;
            if (referenced !== false) throw cleanupError("无法确认页面 Run 引用，保留原数据", "BROWSER_WORKSPACE_REFERENCE_UNKNOWN");
            results.push({ ...ids, ...await this.cleanup(ids) });
          } catch (error) { errors.push(error); }
        }
      } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "部分页面 Run 的归属无法确认，未删除这些数据");
    return results;
  }

  withLocks(ids, operation) {
    // createTask owns scheduler then Run; reversing that order can deadlock.
    return this.taskManager.withSchedulerLock(() => this.coordinator.withRunLock(ids.projectId, ids.runId, operation));
  }

  async withCleanupLocks(ids, operation) {
    const directorRoots = new Set();
    try {
      return await this.withLocks(ids, () => operation(directorRoots));
    } finally {
      // Revocation and deletion happen above. Abort listeners and paused
      // resume gates may execute provider/runner code, so wake them only after
      // the scheduler and Run locks have both been released. Even a failed
      // file deletion must not leave an already-revoked director parked.
      for (const taskId of directorRoots) {
        this.taskManager.stopDirectorRuntime(taskId, {
          code: "BROWSER_WORKSPACE_CLOSED", category: "control-plane",
          message: "页面工作区已清空，AI 导演请求已停止。"
        });
      }
    }
  }

  async cleanupUnlocked(ids, manifest, directorRoots) {
    const manager = this.taskManager;
    const index = manifest ? await manager.taskStore.readIndex(ids.projectId, ids.runId) : null;
    const taskIds = new Set(Object.keys(index?.tasks || {}));
    for (const [taskId, location] of manager.taskLocations) {
      if (sameRun(location, ids)) taskIds.add(taskId);
    }
    for (const [taskId, runtime] of manager.runtimes) {
      if (sameRun(runtime.definition, ids)) taskIds.add(taskId);
    }
    if (index) {
      const now = manager.timestamp();
      for (const task of Object.values(index.tasks)) {
        if (!DURABLE_TASK_ACTIVE_STATUSES.includes(task.status)) continue;
        manager.taskStore.updateTaskUnlocked(index, task.taskId, {
          status: "abandoned", phase: "abandoned", completedAt: now,
          lastProgressAt: now, watchdogDueAt: null,
          error: { code: "BROWSER_WORKSPACE_CLOSED", category: "control-plane", message: "页面工作区已清空；已提交的远端调用无法撤回。" }
        }, { activeOnly: true });
      }
      index.claims = {};
      await manager.taskStore.writeIndexUnlocked(index);
    }
    for (const taskId of taskIds) {
      const runtime = manager.runtimes.get(taskId);
      if (runtime) runtime.active = false;
      if (runtime?.controller && runtime.definition.kind === "directorPipeline" && runtime.ownerTaskId === taskId) {
        directorRoots.add(taskId);
      }
      let queued = false;
      for (const pool of Object.values(manager.pools)) {
        if (!pool.queue.includes(taskId)) continue;
        pool.queue = pool.queue.filter((id) => id !== taskId);
        queued = true;
      }
      if (queued) {
        manager.queuedBytes = Math.max(0, manager.queuedBytes - (runtime?.inputBytes || 0));
        manager.runtimes.delete(taskId);
      }
      manager.outcomes.delete(taskId);
      manager.clearWatchdog(taskId);
      await manager.notifyWaiters(taskId);
    }

    await this.removeFiles(ids);
    const pending = [...taskIds].some((taskId) => manager.runtimes.has(taskId));
    if (!pending) {
      for (const taskId of taskIds) manager.taskLocations.delete(taskId);
      await fs.rm(this.markerPath(ids), { force: true });
    }
    return { deleted: true, pending };
  }

  async removeFiles(ids) {
    await removeOwnedTree(this.productionStore.rootDir, [ids.projectId, ids.runId]);
    await removeOwnedTree(this.publicDir, ["generated-images", ids.projectId, ids.runId]);
    await removeOwnedTree(this.publicDir, ["generated-videos", ids.projectId, ids.runId]);
    // FullModelOutputLogWriter groups bound output by scope, then this stable
    // Run token. Unbound output has no trustworthy Run identity and is untouched.
    const runToken = `run-${hash(`${ids.projectId}\0${ids.runId}`).slice(0, 16)}`;
    for (const root of this.outputLogRoots) {
      if (!await safeExistingDirectory(root, ["bound"])) continue;
      const scopes = await fs.readdir(path.join(root, "bound"), { withFileTypes: true });
      for (const scope of scopes) {
        if (!scope.isDirectory() || !SAFE_ID.test(scope.name)) continue;
        await removeOwnedTree(root, ["bound", scope.name, runToken]);
      }
    }
  }

  async readManifestIfPresent(ids) {
    // Validate ancestor paths before the store follows them when opening JSON.
    if (!await safeExistingDirectory(this.productionStore.rootDir, [ids.projectId, ids.runId])) return null;
    try { return await this.productionStore.readManifest(ids.projectId, ids.runId); } catch (error) {
      if (error.code === "PRODUCTION_RUN_NOT_FOUND") return null;
      throw error;
    }
  }

  assertOwner(manifest, ids) {
    if (manifest.metadata?.browserWorkspaceId !== ids.workspaceId) {
      throw cleanupError("不能删除不属于当前页面的生产 Run", "BROWSER_WORKSPACE_RUN_OWNERSHIP_MISMATCH", 403);
    }
  }

  assertMarkerOwner(marker, ids) {
    if (marker.type !== MARKER_VERSION || !sameRun(marker, ids) || marker.workspaceId !== ids.workspaceId) {
      throw cleanupError("页面清理记录不属于当前页面", "BROWSER_WORKSPACE_RUN_OWNERSHIP_MISMATCH", 403);
    }
  }

  markerPath(ids) {
    return path.join(this.cleanupRoot, `${hash(`${ids.projectId}\0${ids.runId}`)}.json`);
  }

  async readMarkerIfPresent(ids) {
    const file = this.markerPath(ids);
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw cleanupError("页面清理记录无效", "BROWSER_WORKSPACE_CLEANUP_MARKER_INVALID");
      return JSON.parse(await fs.readFile(file, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async writeMarker(ids) {
    await fs.mkdir(this.cleanupRoot, { recursive: true, mode: 0o700 });
    const file = this.markerPath(ids);
    const temporary = `${file}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify({ type: MARKER_VERSION, ...ids })}\n`, { mode: 0o600 });
    await fs.rename(temporary, file);
  }
}

function cleanupIds(input) {
  const result = {};
  for (const key of ["projectId", "runId", "workspaceId"]) {
    if (typeof input[key] !== "string" || !SAFE_ID.test(input[key])) {
      throw cleanupError(`${key} 格式无效`, "BROWSER_WORKSPACE_CLEANUP_ID_INVALID", 400);
    }
    result[key] = input[key];
  }
  return result;
}

async function safeExistingDirectory(root, segments) {
  let current = path.resolve(root);
  for (const segment of segments) {
    if (!SAFE_ID.test(segment)) throw cleanupError("页面清理路径无效", "BROWSER_WORKSPACE_CLEANUP_PATH_INVALID", 400);
    current = path.join(current, segment);
    let stat;
    try { stat = await fs.lstat(current); } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw cleanupError("页面清理路径不得经过符号链接或普通文件", "BROWSER_WORKSPACE_CLEANUP_PATH_INVALID", 400);
    }
  }
  return true;
}

async function removeOwnedTree(root, segments) {
  if (!await safeExistingDirectory(root, segments)) return;
  await fs.rm(path.join(root, ...segments), { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
}

function sameRun(left, right) {
  return left?.projectId === right.projectId && left?.runId === right.runId;
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function cleanupError(message, code, httpStatus = 500) {
  return new ProductionStateError(message, { code, httpStatus });
}

async function directoryEntries(directory) {
  try { return await fs.readdir(directory, { withFileTypes: true }); } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}
