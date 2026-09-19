import { randomUUID } from "node:crypto";
import {
  ProductionStateError,
  contentDigest,
  lineageRef,
  normalizeArtifactId,
  normalizeDependencies,
  safeIdentifier
} from "./production-lineage.js";
import {
  DURABLE_TASK_ACTIVE_STATUSES,
  DURABLE_TASK_TERMINAL_STATUSES,
  publicTask
} from "./durable-task-store.js";
import { readModelUsageFromError } from "./token-usage.js";

const DEFAULT_LOCAL_STALL_MS = 300_000;
const DEFAULT_PROVIDER_GRACE_MS = 120_000;
const DEFAULT_MAX_QUEUED_BYTES = 140 * 1024 * 1024;

export class DurableTaskManager {
  constructor({
    productionStore,
    taskStore,
    coordinator,
    now = () => new Date(),
    idFactory = () => randomUUID(),
    localStallMs = DEFAULT_LOCAL_STALL_MS,
    providerGraceMs = DEFAULT_PROVIDER_GRACE_MS,
    maxQueuedBytes = DEFAULT_MAX_QUEUED_BYTES,
    pools = null
  } = {}) {
    if (!productionStore || !taskStore || !coordinator) {
      throw new TypeError("DurableTaskManager 需要 productionStore、taskStore 与 coordinator");
    }
    this.productionStore = productionStore;
    this.taskStore = taskStore;
    this.coordinator = coordinator;
    this.now = typeof now === "function" ? now : () => new Date();
    this.idFactory = typeof idFactory === "function" ? idFactory : () => randomUUID();
    this.localStallMs = boundedMs(localStallMs, DEFAULT_LOCAL_STALL_MS);
    this.providerGraceMs = boundedMs(providerGraceMs, DEFAULT_PROVIDER_GRACE_MS);
    this.maxQueuedBytes = Math.max(1, Number(maxQueuedBytes) || DEFAULT_MAX_QUEUED_BYTES);
    this.pools = normalizePools(pools);
    this.runtimes = new Map();
    this.outcomes = new Map();
    this.watchdogs = new Map();
    this.waiters = new Map();
    this.taskLocations = new Map();
    this.queuedBytes = 0;
    this.schedulerTail = Promise.resolve();
    this.productionStore.artifactWriteGuard = async ({ input, projectId, runId }) => {
      const index = await this.taskStore.readIndex(projectId, runId);
      this.taskStore.assertTargetWritableUnlocked(index, {
        artifactId: input.artifactId,
        ownerTaskId: input.ownerTaskId || ""
      });
    };
  }

  async createTask(definition = {}) {
    return this.withSchedulerLock(async () => {
      const projectId = safeIdentifier(definition.projectId, "projectId");
      const runId = safeIdentifier(definition.runId, "runId");
      const poolName = definition.pool === "media" ? "media" : "workflow";
      const requestBytes = Math.max(0, Number(definition.requestBytes) || estimateBytes(definition.input));
      const pool = this.pools[poolName];
      const created = await this.coordinator.withRunLock(projectId, runId, async () => {
        const manifest = await this.productionStore.readManifest(projectId, runId);
        const index = await this.taskStore.readIndex(projectId, runId);
        const prepared = await this.prepareDefinition(definition, manifest);
        const targetArtifactIds = prepared.targetArtifactIds;
        const compatibilityToken = normalizeCompatibilityRequestToken(
          definition.productionRequestToken,
          prepared
        );
        const operationKey = contentDigest({
          kind: definition.kind,
          targetArtifactIds,
          targetExpectedRevisions: prepared.targetExpectedRevisions,
          frozenDependencies: prepared.frozenDependencies,
          modelSnapshot: prepared.modelSnapshot,
          inputDigest: prepared.inputDigest
        });
        const existingId = index.operations?.[operationKey];
        const existing = existingId ? index.tasks?.[existingId] : null;
        if (existing && DURABLE_TASK_ACTIVE_STATUSES.includes(existing.status)) {
          if (compatibilityToken && existing.requestId !== compatibilityToken.requestId) {
            throw new ProductionStateError("同一操作已由另一请求接管，请刷新页面后重新连接当前任务", {
              code: "TASK_REQUEST_ID_MISMATCH",
              httpStatus: 409,
              details: [{ taskId: existing.taskId }]
            });
          }
          return { task: existing, reused: true, prepared: null };
        }
        for (const artifactId of targetArtifactIds) {
          const claimedBy = index.claims?.[artifactId];
          const owner = claimedBy ? index.tasks?.[claimedBy] : null;
          if (owner && DURABLE_TASK_ACTIVE_STATUSES.includes(owner.status)) {
            throw new ProductionStateError(`artifact ${artifactId} 已有任务正在执行`, {
              code: "TASK_TARGET_BUSY",
              httpStatus: 409,
              details: [{ artifactId, taskId: claimedBy }]
            });
          }
        }
        const willQueue = pool.running >= pool.limit;
        if (willQueue && (pool.queue.length >= pool.queueLimit || this.queuedBytes + requestBytes > this.maxQueuedBytes)) {
          throw new ProductionStateError("服务器任务队列已满，请稍后重试", {
            code: "TASK_CAPACITY_EXCEEDED",
            httpStatus: 429,
            details: [{ pool: poolName, queued: pool.queue.length }]
          });
        }
        const taskId = `task-${safeIdentifier(this.idFactory(), "task UUID")}`;
        const requestId = compatibilityToken?.requestId
          || `request-${safeIdentifier(this.idFactory(), "request UUID")}`;
        const result = this.taskStore.createTaskUnlocked(index, {
          taskId,
          requestId,
          kind: definition.kind,
          pool: poolName,
          operationKey,
          requestBytes,
          targetArtifactIds,
          targetExpectedRevisions: prepared.targetExpectedRevisions,
          frozenDependencies: prepared.frozenDependencies,
          modelSnapshot: prepared.modelSnapshot,
          progress: definition.kind === "fullStory"
            ? mergeProgress(prepared.progress, { controlState: "running", attempt: 1 })
            : prepared.progress
        });
        await this.taskStore.writeIndexUnlocked(index);
        return { ...result, prepared };
      });
      this.taskLocations.set(created.task.taskId, { projectId, runId });
      if (created.reused) return { task: publicTask(created.task), reused: true };
      const taskId = created.task.taskId;
      this.runtimes.set(taskId, {
        definition,
        input: created.prepared.input,
        inputBytes: requestBytes,
        poolName,
        ownerTaskId: taskId,
        ...(["directorPipeline", "fullStory"].includes(definition.kind) ? {
          controlKind: definition.kind,
          controlState: "running",
          controller: new AbortController(),
          finished: deferred()
        } : {}),
        ...(definition.kind === "fullStory" ? { settledUsage: null, attempt: 1, attemptRunning: false } : {}),
        active: true
      });
      pool.queue.push(taskId);
      this.queuedBytes += requestBytes;
      queueMicrotask(() => { void this.drain(poolName).catch((error) => this.reportBackgroundError(error)); });
      return { task: publicTask(created.task), reused: false };
    });
  }

  async prepareDefinition(definition, manifest) {
    const run = await this.productionStore.loadRunUnlocked(manifest, { includeContent: true });
    const prepared = typeof definition.prepare === "function"
      ? await definition.prepare({ manifest, run, productionStore: this.productionStore })
      : { input: definition.input };
    const targetArtifactIds = uniqueArtifactIds(prepared.targetArtifactIds || definition.targetArtifactIds);
    const dependencyIds = Array.isArray(prepared.dependencyIds)
      ? prepared.dependencyIds
      : Array.isArray(definition.dependencyIds) ? definition.dependencyIds : [];
    const frozenDependencies = prepared.frozenDependencies
      ? normalizeDependencies(prepared.frozenDependencies)
      : dependencyIds.map((artifactId) => requireCurrentLineage(run, artifactId));
    // 目标的期望版本 = latest 指向的那一版，**不论它是否已 stale**——与状态库提交门
    // （commitArtifactUnlocked 比的是 manifest.latest）、完整剧情展开前复核与浏览器同一口径。
    // stale 的目标仍有 revision，重新生成就是在它之上提交下一版。此前这里把 stale 算成 null，
    // 于是任何已失效目标重新生成都必然冲突（2026-09-18：采纳候选修订后展开，连续三次
    // FULL_STORY_REQUEST_REVISION_CONFLICT）。运行中目标被上游弄 stale 由冻结依赖复检拦截。
    const targetExpectedRevisions = Object.fromEntries(targetArtifactIds.map((artifactId) => [
      artifactId,
      targetLatestRevision(run.latestArtifacts?.[artifactId]?.lineage)
    ]));
    const input = prepared.input ?? definition.input ?? {};
    const preparedInputDigest = String(prepared.inputDigest || definition.inputDigest || "").trim().toLowerCase();
    return {
      input,
      inputDigest: /^[a-f0-9]{64}$/u.test(preparedInputDigest)
        ? preparedInputDigest
        : contentDigest(prepared.idempotencyInput ?? input),
      targetArtifactIds,
      targetExpectedRevisions,
      frozenDependencies,
      modelSnapshot: prepared.modelSnapshot ?? definition.modelSnapshot ?? {},
      progress: prepared.progress ?? {}
    };
  }

  async drain(poolName) {
    await this.withSchedulerLock(async () => {
      const pool = this.pools[poolName];
      while (pool.running < pool.limit && pool.queue.length) {
        const taskId = pool.queue.shift();
        const runtime = this.runtimes.get(taskId);
        if (!runtime?.active) continue;
        pool.running += 1;
        this.queuedBytes = Math.max(0, this.queuedBytes - runtime.inputBytes);
        void this.runRootTask(taskId, runtime).finally(() => {
          void this.withSchedulerLock(async () => {
            pool.running = Math.max(0, pool.running - 1);
            queueMicrotask(() => { void this.drain(poolName).catch((error) => this.reportBackgroundError(error)); });
          }).catch((error) => this.reportBackgroundError(error));
        }).catch((error) => this.reportBackgroundError(error));
      }
    });
  }

  async runRootTask(taskId, runtime) {
    try {
      const started = await this.startTask(taskId);
      if (!started) return;
      for (;;) {
        try {
          this.assertExecutionAllowed(taskId);
          if (runtime.controlKind === "fullStory") await this.beginFullStoryAttempt(taskId, runtime);
          const context = this.taskContext(taskId, runtime.ownerTaskId);
          const outcome = await runtime.definition.execute(runtime.input, context);
          this.assertExecutionAllowed(taskId);
          this.outcomes.set(taskId, outcome?.compatibilityResult);
          await this.completeTask(taskId, outcome || {});
          break;
        } catch (error) {
          if (runtime.active && ["pausing", "paused"].includes(runtime.controlState)) {
            await this.parkDirectorTask(taskId, runtime, error);
            continue;
          }
          throw error;
        }
      }
    } catch (error) {
      if (runtime.controlState === "terminating") {
        const task = await this.getTaskById(taskId);
        await this.finishControlledTask({ ...task, status: "cancelled", reason: taskControlError("terminate", runtime.controlKind) });
      } else {
        await this.failFromError(taskId, error);
      }
    } finally {
      runtime.active = false;
      this.runtimes.delete(taskId);
      this.clearWatchdog(taskId);
      this.notifyWaiters(taskId);
      runtime.finished?.resolve();
    }
  }

  async runChildTask(parentTaskId, definition = {}, assertContextAllowed = null) {
    const parentId = safeIdentifier(parentTaskId, "parentTaskId");
    this.assertExecutionAllowed(parentId);
    const parent = await this.getTaskById(parentId);
    if (!DURABLE_TASK_ACTIVE_STATUSES.includes(parent.status)) {
      throw taskOwnershipError(parentId);
    }
    const created = await this.coordinator.withRunLock(parent.projectId, parent.runId, async () => {
      const manifest = await this.productionStore.readManifest(parent.projectId, parent.runId);
      const index = await this.taskStore.readIndex(parent.projectId, parent.runId);
      const parentInternal = this.taskStore.getTaskUnlocked(index, parentId);
      if (!DURABLE_TASK_ACTIVE_STATUSES.includes(parentInternal.status)) throw taskOwnershipError(parentId);
      assertContextAllowed?.();
      this.assertExecutionAllowed(parentId);
      const prepared = await this.prepareDefinition(definition, manifest);
      const operationKey = contentDigest({
        parentTaskId: parentId,
        kind: definition.kind,
        targetArtifactIds: prepared.targetArtifactIds,
        targetExpectedRevisions: prepared.targetExpectedRevisions,
        frozenDependencies: prepared.frozenDependencies,
        modelSnapshot: prepared.modelSnapshot,
        inputDigest: prepared.inputDigest
      });
      const existingId = index.operations?.[operationKey];
      const existing = existingId ? index.tasks?.[existingId] : null;
      if (existing && existing.status === "completed") return { task: existing, reused: true, prepared: null };
      if (existing && DURABLE_TASK_ACTIVE_STATUSES.includes(existing.status)) {
        return { task: existing, reused: true, prepared };
      }
      const taskId = `task-${safeIdentifier(this.idFactory(), "task UUID")}`;
      const requestId = `request-${safeIdentifier(this.idFactory(), "request UUID")}`;
      const result = this.taskStore.createTaskUnlocked(index, {
        taskId,
        parentTaskId: parentId,
        ownerTaskId: parentInternal.ownerTaskId,
        requestId,
        kind: definition.kind,
        pool: parentInternal.pool,
        operationKey,
        targetArtifactIds: prepared.targetArtifactIds,
        targetExpectedRevisions: prepared.targetExpectedRevisions,
        frozenDependencies: prepared.frozenDependencies,
        modelSnapshot: prepared.modelSnapshot,
        progress: prepared.progress
      });
      await this.taskStore.writeIndexUnlocked(index);
      return { ...result, prepared };
    });
    if (created.task.status === "completed") return publicTask(created.task);
    const childId = created.task.taskId;
    this.taskLocations.set(childId, { projectId: parent.projectId, runId: parent.runId });
    const childRuntime = {
      definition,
      input: created.prepared.input,
      inputBytes: 0,
      poolName: parent.pool,
      ownerTaskId: created.task.ownerTaskId,
      signal: this.runtimes.get(created.task.ownerTaskId)?.controller?.signal,
      active: true
    };
    this.runtimes.set(childId, childRuntime);
    try {
      const started = await this.startTask(childId);
      if (!started) throw taskOwnershipError(childId);
      const context = this.taskContext(childId, childRuntime.ownerTaskId, parentId);
      const outcome = await definition.execute(childRuntime.input, context);
      this.outcomes.set(childId, outcome?.compatibilityResult);
      await this.completeTask(childId, outcome || {}, { releaseClaims: false });
      await this.refreshParentUsage(parentId);
      return await this.getTaskById(childId);
    } catch (error) {
      await this.failFromError(childId, error, { releaseClaims: false });
      await this.refreshParentUsage(parentId);
      throw error;
    } finally {
      childRuntime.active = false;
      this.runtimes.delete(childId);
      this.clearWatchdog(childId);
      this.notifyWaiters(childId);
    }
  }

  taskContext(taskId, ownerTaskId, parentTaskId = null) {
    const runtime = this.runtimes.get(taskId);
    const signal = runtime?.signal || runtime?.controller?.signal;
    const assertContextAllowed = () => {
      signal?.throwIfAborted();
      this.assertExecutionAllowed(taskId);
    };
    const touch = async (options) => {
      signal?.throwIfAborted();
      this.assertExecutionAllowed(taskId);
      const result = await this.touchTask(taskId, options, assertContextAllowed);
      if (parentTaskId) {
        try {
          await this.touchTask(parentTaskId, {
            ...options,
            phase: `child:${result.kind}:${options?.phase || result.phase}`
          }, assertContextAllowed);
        } catch (error) {
          if (error?.code !== "TASK_OWNERSHIP_LOST") throw error;
        }
      }
      return result;
    };
    return Object.freeze({
      taskId,
      ownerTaskId,
      signal,
      captureUsage: (usage) => {
        // A Full Story resumes within the same root runtime. A callback from its
        // old aborted accounting scope must never replace the new attempt.
        if (runtime?.active && (runtime.signal || runtime.controller?.signal) === signal
          && (runtime.controlKind !== "fullStory" || runtime.attemptRunning)) runtime.usageSnapshot = structuredClone(usage);
      },
      updatePhase: (phase, options) => touch({ phase, ...options }),
      heartbeat: (progress, options) => touch({ progress, ...options }),
      updateUsage: async (usage) => { assertContextAllowed(); return this.updateTaskUsage(taskId, usage, assertContextAllowed); },
      providerRequestStarted: () => {
        signal?.throwIfAborted();
        this.assertExecutionAllowed(taskId);
        if (signal) runtime.providerCalls = (runtime.providerCalls || 0) + 1;
      },
      beforeProviderCall: async (phase, timeoutMs) => {
        signal?.throwIfAborted();
        await this.assertFrozenContextCurrent(taskId);
        const result = await touch({
          phase,
          stallMs: Math.max(this.localStallMs, boundedMs(timeoutMs, this.localStallMs) + this.providerGraceMs)
        });
        signal?.throwIfAborted();
        this.assertExecutionAllowed(taskId);
        return result;
      },
      afterProviderCall: async (phase, progress) => {
        await this.assertFrozenContextCurrent(taskId);
        return touch({ phase, progress, stallMs: this.localStallMs });
      },
      assertFrozenContextCurrent: async () => { assertContextAllowed(); const result = await this.assertFrozenContextCurrent(taskId); assertContextAllowed(); return result; },
      recordStage: async (status, error = null) => { assertContextAllowed(); return this.recordStageForTask(taskId, status, error, assertContextAllowed); },
      commitArtifact: async (input) => { assertContextAllowed(); return this.commitArtifactForTask(taskId, ownerTaskId, input, assertContextAllowed); },
      runChild: async (definition) => { assertContextAllowed(); return this.runChildTask(taskId, definition, assertContextAllowed); },
      getTask: () => this.getTaskById(taskId)
    });
  }

  async startTask(taskId) {
    const task = await this.getTaskById(taskId);
    const now = this.timestamp();
    const due = new Date(Date.parse(now) + this.localStallMs).toISOString();
    const result = await this.coordinator.withRunLock(task.projectId, task.runId, async () => {
      const manifest = await this.productionStore.readManifest(task.projectId, task.runId);
      const index = await this.taskStore.readIndex(task.projectId, task.runId);
      const current = this.taskStore.getTaskUnlocked(index, taskId);
      if (current.status !== "queued") return false;
      this.taskStore.updateTaskUnlocked(index, taskId, {
        status: "running",
        phase: "running",
        startedAt: now,
        lastProgressAt: now,
        watchdogDueAt: due
      }, { activeOnly: true });
      this.taskStore.appendEventUnlocked(index, { type: "task.started", taskId, createdAt: now });
      if (current.targetArtifactIds.length === 1) {
        await this.productionStore.recordStageUnlocked(manifest, {
          projectId: task.projectId,
          runId: task.runId,
          stageId: current.targetArtifactIds[0],
          status: "running",
          requestId: current.requestId
        });
      }
      await this.taskStore.writeIndexUnlocked(index);
      return true;
    });
    if (result) this.armWatchdog(taskId, due);
    return result;
  }

  async beginFullStoryAttempt(taskId, runtime) {
    const task = await this.getTaskById(taskId);
    await this.coordinator.withRunLock(task.projectId, task.runId, async () => {
      const manifest = await this.productionStore.readManifest(task.projectId, task.runId);
      const index = await this.taskStore.readIndex(task.projectId, task.runId);
      const current = this.taskStore.getTaskUnlocked(index, taskId);
      if (!DURABLE_TASK_ACTIVE_STATUSES.includes(current.status)) throw taskOwnershipError(taskId);
      this.assertExecutionAllowed(taskId);
      // Frozen dependencies and target revision belong to the user operation;
      // continuing does not prepare against a newer current Artifact.
      assertFrozenInManifest(manifest, current, { targetArtifactId: current.targetArtifactIds[0] });
      const requestId = runtime.needsNewAttempt
        ? `request-${safeIdentifier(this.idFactory(), "request UUID")}`
        : current.requestId;
      if (runtime.needsNewAttempt) runtime.attempt += 1;
      runtime.needsNewAttempt = false;
      runtime.attemptRunning = true;
      this.taskStore.updateTaskUnlocked(index, taskId, {
        requestId,
        phase: "running",
        progress: mergeProgress(current.progress, { controlState: "running", attempt: runtime.attempt })
      }, { activeOnly: true });
      await this.productionStore.recordStageUnlocked(manifest, {
        projectId: task.projectId,
        runId: task.runId,
        stageId: current.targetArtifactIds[0],
        status: "running",
        requestId
      });
      this.taskStore.appendEventUnlocked(index, { type: "task.attempt.started", taskId, requestId, attempt: runtime.attempt, createdAt: this.timestamp() });
      await this.taskStore.writeIndexUnlocked(index);
    });
  }

  async touchTask(taskId, { phase, progress, stallMs = this.localStallMs } = {}, assertContextAllowed = null) {
    const task = await this.getTaskById(taskId);
    const now = this.timestamp();
    const due = new Date(Date.parse(now) + Math.max(1, Number(stallMs) || this.localStallMs)).toISOString();
    const applied = await this.updateTaskAtomic(task.projectId, task.runId, taskId, (index, current) => {
      if (!DURABLE_TASK_ACTIVE_STATUSES.includes(current.status)) return false;
      assertContextAllowed?.();
      this.assertExecutionAllowed(taskId);
      this.taskStore.updateTaskUnlocked(index, taskId, {
        ...(phase !== undefined ? { phase } : {}),
        ...(progress !== undefined ? { progress: mergeProgress(current.progress, progress) } : {}),
        lastProgressAt: now,
        watchdogDueAt: due
      }, { activeOnly: true });
      return true;
    });
    if (!applied) throw taskOwnershipError(taskId);
    assertContextAllowed?.();
    this.armWatchdog(taskId, due);
    return this.getTaskById(taskId);
  }

  async updateTaskUsage(taskId, usage, assertContextAllowed = null) {
    const runtime = this.runtimes.get(taskId);
    if (runtime?.active) runtime.usageSnapshot = structuredClone(usage);
    const task = await this.getTaskById(taskId);
    const applied = await this.updateTaskAtomic(task.projectId, task.runId, taskId, (index, current) => {
      if (!DURABLE_TASK_ACTIVE_STATUSES.includes(current.status)) return false;
      assertContextAllowed?.();
      this.taskStore.updateTaskUnlocked(index, taskId, { usage: this.taskUsage(current, usage) }, { activeOnly: true });
      return true;
    });
    if (!applied) throw taskOwnershipError(taskId);
    return this.getTaskById(taskId);
  }

  async refreshParentUsage(parentTaskId) {
    const parent = await this.getTaskById(parentTaskId);
    await this.updateTaskAtomic(parent.projectId, parent.runId, parentTaskId, (index, current) => {
      if (!DURABLE_TASK_ACTIVE_STATUSES.includes(current.status)) return false;
      const usage = aggregateChildUsage(index, current);
      if (!usage) return false;
      this.taskStore.updateTaskUnlocked(index, parentTaskId, { usage }, { activeOnly: true });
      return true;
    });
  }

  async assertFrozenContextCurrent(taskId) {
    this.assertExecutionAllowed(taskId);
    const task = await this.getTaskById(taskId);
    if (!DURABLE_TASK_ACTIVE_STATUSES.includes(task.status)) throw taskOwnershipError(taskId);
    const ids = [...task.targetArtifactIds, ...task.frozenDependencies.map((item) => item.artifactId)];
    const snapshot = await this.productionStore.readCurrentLineageSnapshot({
      projectId: task.projectId,
      runId: task.runId,
      artifactIds: ids
    });
    for (const [artifactId, expectedRevision] of Object.entries(task.targetExpectedRevisions || {})) {
      const actualRevision = targetLatestRevision(snapshot.artifacts?.[artifactId]);
      if ((expectedRevision || null) !== actualRevision) {
        throw frozenConflict(artifactId, expectedRevision, actualRevision);
      }
    }
    for (const dependency of task.frozenDependencies || []) {
      const actual = snapshot.artifacts?.[dependency.artifactId];
      if (
        !actual
        || actual.status !== "current"
        || actual.revision !== dependency.revision
        || actual.contentDigest !== dependency.contentDigest
      ) {
        throw frozenConflict(dependency.artifactId, dependency.revision, actual?.revision || null);
      }
    }
    return true;
  }

  async recordStageForTask(taskId, status, error = null, assertContextAllowed = null) {
    const task = await this.getTaskById(taskId);
    if (task.targetArtifactIds.length !== 1) return null;
    return this.coordinator.withRunLock(task.projectId, task.runId, async () => {
      const manifest = await this.productionStore.readManifest(task.projectId, task.runId);
      const index = await this.taskStore.readIndex(task.projectId, task.runId);
      const current = this.taskStore.getTaskUnlocked(index, taskId);
      assertContextAllowed?.();
      if (!DURABLE_TASK_ACTIVE_STATUSES.includes(current.status) && status === "running") throw taskOwnershipError(taskId);
      return this.productionStore.recordStageUnlocked(manifest, {
        projectId: task.projectId,
        runId: task.runId,
        stageId: task.targetArtifactIds[0],
        status,
        requestId: task.requestId,
        ...(status === "running" ? {} : { expectedRequestId: task.requestId }),
        error
      });
    });
  }

  async commitArtifactForTask(taskId, ownerTaskId, input = {}, assertContextAllowed = null) {
    const task = await this.getTaskById(taskId);
    const artifactId = normalizeArtifactId(input.artifactId || task.targetArtifactIds[0]);
    if (!task.targetArtifactIds.includes(artifactId)) {
      throw new ProductionStateError("Task 不能提交未声明的 Artifact", {
        code: "TASK_TARGET_MISMATCH",
        httpStatus: 409
      });
    }
    return this.coordinator.withRunLock(task.projectId, task.runId, async () => {
      const manifest = await this.productionStore.readManifest(task.projectId, task.runId);
      const index = await this.taskStore.readIndex(task.projectId, task.runId);
      const currentTask = this.taskStore.getTaskUnlocked(index, taskId);
      if (!DURABLE_TASK_ACTIVE_STATUSES.includes(currentTask.status)) throw taskOwnershipError(taskId);
      assertContextAllowed?.();
      this.assertExecutionAllowed(taskId);
      this.taskStore.assertTargetWritableUnlocked(index, { artifactId, ownerTaskId });
      assertFrozenInManifest(manifest, currentTask, { targetArtifactId: artifactId });
      const committed = await this.productionStore.commitArtifactUnlocked(manifest, {
        ...input,
        projectId: task.projectId,
        runId: task.runId,
        artifactId,
        requestId: task.requestId,
        expectedCurrentRevision: currentTask.targetExpectedRevisions?.[artifactId] || null,
        dependencies: input.dependencies || currentTask.frozenDependencies
      });
      const refs = mergeResultRefs(currentTask.resultArtifactRefs, [lineageRef(committed.lineage)]);
      this.taskStore.updateTaskUnlocked(index, taskId, { resultArtifactRefs: refs }, { activeOnly: true });
      await this.taskStore.writeIndexUnlocked(index);
      return committed;
    });
  }

  async completeTask(taskId, outcome = {}, { releaseClaims = true } = {}) {
    const task = await this.getTaskById(taskId);
    const now = this.timestamp();
    return this.updateTaskAtomic(task.projectId, task.runId, taskId, (index, current) => {
      if (!DURABLE_TASK_ACTIVE_STATUSES.includes(current.status)) return false;
      this.assertExecutionAllowed(taskId);
      const refs = mergeResultRefs(current.resultArtifactRefs, outcome.resultArtifactRefs || []);
      this.taskStore.updateTaskUnlocked(index, taskId, {
        status: "completed",
        phase: "completed",
        completedAt: now,
        lastProgressAt: now,
        watchdogDueAt: null,
        resultArtifactRefs: refs,
        usage: current.kind === "directorPipeline"
          ? aggregateChildUsage(index, current) || this.taskUsage(current, outcome.usage)
          : this.taskUsage(current, outcome.usage),
        notices: outcome.notices ?? current.notices,
        progress: outcome.progress === undefined
          ? current.progress
          : mergeProgress(current.progress, outcome.progress),
        error: null
      }, { activeOnly: true });
      this.taskStore.appendEventUnlocked(index, { type: "task.completed", taskId, createdAt: now });
      if (releaseClaims && current.ownerTaskId === current.taskId) this.taskStore.releaseClaimsUnlocked(index, current.ownerTaskId);
      return true;
    });
  }

  async failFromError(taskId, error, { releaseClaims = true } = {}) {
    let task;
    try { task = await this.getTaskById(taskId); } catch { return false; }
    if (!DURABLE_TASK_ACTIVE_STATUSES.includes(task.status)) return false;
    const conflicted = [
      "TASK_FROZEN_CONTEXT_CONFLICT",
      "ARTIFACT_REVISION_CONFLICT",
      "ARTIFACT_DEPENDENCY_STALE"
    ].includes(error?.code);
    const status = ["DIRECTOR_STAGE_PAUSED", "FULL_STORY_PAUSED"].includes(error?.code) ? "interrupted"
      : ["DIRECTOR_RUN_TERMINATED", "FULL_STORY_TERMINATED"].includes(error?.code) ? "cancelled"
        : conflicted ? "conflicted" : "failed";
    return this.finishWithStatus(taskId, status, error, { releaseClaims });
  }

  async finishWithStatus(taskId, status, error, { releaseClaims = true } = {}) {
    const task = await this.getTaskById(taskId);
    const now = this.timestamp();
    const applied = await this.coordinator.withRunLock(task.projectId, task.runId, async () => {
      const manifest = await this.productionStore.readManifest(task.projectId, task.runId);
      const index = await this.taskStore.readIndex(task.projectId, task.runId);
      const current = this.taskStore.getTaskUnlocked(index, taskId);
      if (!DURABLE_TASK_ACTIVE_STATUSES.includes(current.status)) return false;
      const rootRuntime = this.runtimes.get(current.ownerTaskId);
      if (error?.code === "TASK_STALLED" && rootRuntime?.controlState && rootRuntime.controlState !== "running") return false;
      this.taskStore.updateTaskUnlocked(index, taskId, {
        status,
        phase: status,
        completedAt: now,
        lastProgressAt: now,
        watchdogDueAt: null,
        error,
        // 父任务的 error usage 只对应刚失败的那个子调用；一旦已有子任务，
        // Task Store 中的逐子任务汇总才是这次父任务的完整计费口径。
        usage: aggregateChildUsage(index, current) || this.taskUsage(current, readModelUsageFromError(error))
      }, { activeOnly: true });
      this.taskStore.appendEventUnlocked(index, { type: `task.${status}`, taskId, createdAt: now });
      if (current.targetArtifactIds.length === 1) {
        await this.productionStore.recordStageUnlocked(manifest, {
          projectId: task.projectId,
          runId: task.runId,
          stageId: current.targetArtifactIds[0],
          status,
          requestId: current.requestId,
          expectedRequestId: current.requestId,
          error
        });
      }
      if (releaseClaims && current.ownerTaskId === current.taskId) {
        for (const childId of current.childTaskIds || []) {
          const child = index.tasks[childId];
          if (!child || !DURABLE_TASK_ACTIVE_STATUSES.includes(child.status)) continue;
          this.taskStore.updateTaskUnlocked(index, childId, {
            status,
            phase: status,
            completedAt: now,
            lastProgressAt: now,
            watchdogDueAt: null,
            error,
            usage: this.taskUsage(child, readModelUsageFromError(error))
          }, { activeOnly: true });
          this.taskStore.appendEventUnlocked(index, { type: `task.${status}`, taskId: childId, createdAt: now });
          if (child.targetArtifactIds.length === 1) {
            await this.productionStore.recordStageUnlocked(manifest, {
              projectId: task.projectId,
              runId: task.runId,
              stageId: child.targetArtifactIds[0],
              status,
              requestId: child.requestId,
              expectedRequestId: child.requestId,
              error
            });
          }
        }
        this.taskStore.releaseClaimsUnlocked(index, current.ownerTaskId);
      }
      if (current.childTaskIds?.length) {
        this.taskStore.updateTaskUnlocked(index, taskId, {
          usage: aggregateChildUsage(index, current) || current.usage
        });
      }
      await this.taskStore.writeIndexUnlocked(index);
      return true;
    });
    if (!applied) return false;
    this.clearWatchdog(taskId);
    if (applied && !task.parentTaskId) this.stopDirectorRuntime(taskId, error);
    this.notifyWaiters(taskId);
    for (const childId of task.childTaskIds || []) {
      this.clearWatchdog(childId);
      this.notifyWaiters(childId);
    }
    return applied;
  }

  async releaseTask({ projectId, runId, taskId } = {}) {
    return this.finishControlledTask({
      projectId,
      runId,
      taskId,
      status: "abandoned",
      reason: {
        code: "TASK_ABANDONED",
        category: "control-plane",
        message: "任务已强制释放；远端调用可能仍在执行并产生费用。"
      }
    });
  }

  assertExecutionAllowed(taskId) {
    const runtime = this.runtimes.get(taskId);
    if (!runtime) return;
    runtime.signal?.throwIfAborted();
    const root = this.runtimes.get(runtime.ownerTaskId);
    root?.controller?.signal.throwIfAborted();
    if (root?.controlState === "terminating") throw taskControlError("terminate", root.controlKind);
    if (["pausing", "paused"].includes(root?.controlState)) throw taskControlError("pause", root.controlKind);
    if (!runtime.active) throw taskOwnershipError(taskId);
  }

  taskUsage(task, fallback = null) {
    const runtime = this.runtimes.get(task.taskId);
    if (runtime?.controlKind === "fullStory") {
      const attemptUsage = usageWithDispatchCount(runtime.usageSnapshot || fallback, runtime.providerCalls || 0);
      return aggregateUsages([runtime.settledUsage, attemptUsage]) || task.usage;
    }
    const known = runtime?.usageSnapshot || fallback || task.usage;
    const dispatched = runtime?.providerCalls || 0;
    return usageWithDispatchCount(known, dispatched);
  }

  stopDirectorRuntime(taskId, reason) {
    const runtime = this.runtimes.get(taskId);
    if (!runtime?.controller) return;
    runtime.controller.abort(reason instanceof Error ? reason : Object.assign(new Error(reason?.message || "任务已结束"), reason));
    runtime.resumeGate?.resolve();
  }

  async parkDirectorTask(taskId, runtime, error = null) {
    const task = await this.getTaskById(taskId);
    await this.updateTaskAtomic(task.projectId, task.runId, taskId, async (index, current) => {
      if (!DURABLE_TASK_ACTIVE_STATUSES.includes(current.status)) {
        runtime.active = false;
        return false;
      }
      if (!runtime.active) return false;
      if (runtime.controlState !== "pausing") return false;
      const usage = aggregateChildUsage(index, current) || this.taskUsage(current, readModelUsageFromError(error));
      if (runtime.controlKind === "fullStory") {
        if (runtime.attemptRunning) {
          runtime.settledUsage = usage ? structuredClone(usage) : null;
          runtime.usageSnapshot = null;
          runtime.providerCalls = 0;
          runtime.attemptRunning = false;
          runtime.needsNewAttempt = true;
        }
        const manifest = await this.productionStore.readManifest(task.projectId, task.runId);
        await this.productionStore.recordStageUnlocked(manifest, {
          projectId: task.projectId,
          runId: task.runId,
          stageId: current.targetArtifactIds[0],
          status: "interrupted",
          requestId: current.requestId,
          expectedRequestId: current.requestId,
          error: taskControlError("pause", runtime.controlKind)
        });
      }
      runtime.controlState = "paused";
      this.taskStore.updateTaskUnlocked(index, taskId, {
        phase: "paused",
        progress: mergeProgress(current.progress, { controlState: "paused" }),
        usage,
        watchdogDueAt: null,
        lastProgressAt: this.timestamp()
      }, { activeOnly: true });
      return true;
    });
    this.clearWatchdog(taskId);
    if (runtime.controlState === "paused" && runtime.active) await runtime.resumeGate.promise;
  }

  async controlDirectorTask(task, action) {
    if (!["pause", "resume", "terminate"].includes(action)) {
      throw new ProductionStateError("任务控制 action 只允许 pause、resume 或 terminate", {
        code: "TASK_CONTROL_ACTION_INVALID", httpStatus: 400
      });
    }
    const runtime = this.runtimes.get(task.taskId);
    if (!runtime?.active || !runtime.controller) {
      throw new ProductionStateError("当前进程没有该任务的执行上下文，请刷新任务状态", {
        code: "TASK_CONTROL_CONTEXT_MISSING", httpStatus: 409
      });
    }
    let applied = false;
    let controllerToAbort;
    let gateToResolve;
    let resumeRunningTask = false;
    await this.updateTaskAtomic(task.projectId, task.runId, task.taskId, async (index, current) => {
      if (!DURABLE_TASK_ACTIVE_STATUSES.includes(current.status) || runtime.controlState === "terminating") return false;
      if (current.kind === "fullStory") {
        // Commit and control share this Run lock. Once this attempt's Artifact
        // has landed, let normal completion finish; pausing it here would redo
        // a successful Story against its original expected target revision.
        const manifest = await this.productionStore.readManifest(task.projectId, task.runId);
        if (current.resultArtifactRefs.some((ref) => current.targetArtifactIds.includes(ref.artifactId))
          || manifest.artifacts.some((artifact) => artifact.artifactId === current.targetArtifactIds[0] && artifact.requestId === current.requestId)) return false;
      }
      if (action === "resume" && runtime.controlState === "pausing") {
        throw new ProductionStateError("当前请求正在中断，请在暂停完成后继续", {
          code: "TASK_CONTROL_PAUSE_PENDING", httpStatus: 409
        });
      }
      if ((action === "pause" && runtime.controlState !== "running")
        || (action === "resume" && runtime.controlState === "running")) return false;
      const controlState = action === "pause" ? (current.status === "queued" ? "paused" : "pausing")
        : action === "resume" ? "running" : "terminating";
      // The next control request may replace these before this request leaves
      // the lock. Act on the exact attempt/gate selected by this transition.
      controllerToAbort = runtime.controller;
      gateToResolve = runtime.resumeGate;
      resumeRunningTask = current.status === "running";
      runtime.controlState = controlState;
      if (action === "pause") runtime.resumeGate = deferred();
      if (action === "resume") runtime.controller = new AbortController();
      this.taskStore.updateTaskUnlocked(index, task.taskId, {
        phase: controlState,
        progress: mergeProgress(current.progress, { controlState, controlUpdatedAt: this.timestamp() }),
        ...(action === "resume" ? {} : { watchdogDueAt: null }),
        lastProgressAt: this.timestamp()
      }, { activeOnly: true });
      this.taskStore.appendEventUnlocked(index, { type: `task.control.${action}`, taskId: task.taskId, createdAt: this.timestamp() });
      applied = true;
      return true;
    });
    if (applied && action === "resume") {
      if (resumeRunningTask) this.armWatchdog(task.taskId, new Date(Date.now() + this.localStallMs).toISOString());
      gateToResolve?.resolve();
    } else if (applied) {
      this.clearWatchdog(task.taskId);
      controllerToAbort.abort(taskControlError(action, runtime.controlKind));
      const latest = await this.getTaskById(task.taskId);
      for (const childId of latest.childTaskIds || []) this.clearWatchdog(childId);
      if (action === "terminate") {
        gateToResolve?.resolve();
        // Give body/SSE cancellation a bounded opportunity to capture reported usage.
        // No coordinator or scheduler lock is held while the request unwinds.
        if (latest.status === "running") await settleWithin(runtime.finished.promise, 1_500);
        await this.finishControlledTask({ ...task, status: "cancelled", reason: taskControlError(action, runtime.controlKind) });
      }
    }
    return this.getTaskById(task.taskId);
  }

  async controlTask({ projectId, runId, taskId, action } = {}) {
    const safeProjectId = safeIdentifier(projectId, "projectId");
    const safeRunId = safeIdentifier(runId, "runId");
    const safeTaskId = safeIdentifier(taskId, "taskId");
    const task = await this.taskStore.getTask({ projectId: safeProjectId, runId: safeRunId, taskId: safeTaskId });
    if (DURABLE_TASK_TERMINAL_STATUSES.includes(task.status)) return task;
    if (!["shotVideoBatch", "directorPipeline", "fullStory"].includes(task.kind) || task.parentTaskId) {
      throw new ProductionStateError("只有 AI 导演、完整剧情和镜头视频批量任务支持暂停、继续和终止", {
        code: "TASK_CONTROL_UNSUPPORTED",
        httpStatus: 409
      });
    }
    const normalizedAction = String(action || "").trim().toLowerCase();
    if (["directorPipeline", "fullStory"].includes(task.kind)) return this.controlDirectorTask(task, normalizedAction);
    if (normalizedAction === "terminate") {
      return this.finishControlledTask({
        projectId: safeProjectId,
        runId: safeRunId,
        taskId: safeTaskId,
        status: "cancelled",
        reason: {
          code: "SHOT_VIDEO_BATCH_TERMINATED",
          category: "control-plane",
          message: "镜头视频批量任务已终止；已提交给供应商的当前片段可能仍在执行并产生费用。"
        }
      });
    }
    if (!["pause", "resume"].includes(normalizedAction)) {
      throw new ProductionStateError("任务控制 action 只允许 pause、resume 或 terminate", {
        code: "TASK_CONTROL_ACTION_INVALID",
        httpStatus: 400
      });
    }
    const now = this.timestamp();
    const controlState = normalizedAction === "pause" ? "paused" : "running";
    await this.updateTaskAtomic(safeProjectId, safeRunId, safeTaskId, (index, current) => {
      if (!DURABLE_TASK_ACTIVE_STATUSES.includes(current.status)) return false;
      this.taskStore.updateTaskUnlocked(index, safeTaskId, {
        phase: controlState,
        progress: mergeProgress(current.progress, {
          controlState,
          controlUpdatedAt: now
        }),
        lastProgressAt: now
      }, { activeOnly: true });
      this.taskStore.appendEventUnlocked(index, {
        type: `task.control.${normalizedAction}`,
        taskId: safeTaskId,
        createdAt: now
      });
      return true;
    });
    return this.taskStore.getTask({ projectId: safeProjectId, runId: safeRunId, taskId: safeTaskId });
  }

  async finishControlledTask({ projectId, runId, taskId, status, reason } = {}) {
    const safeProjectId = safeIdentifier(projectId, "projectId");
    const safeRunId = safeIdentifier(runId, "runId");
    const safeTaskId = safeIdentifier(taskId, "taskId");
    const task = await this.taskStore.getTask({ projectId: safeProjectId, runId: safeRunId, taskId: safeTaskId });
    if (DURABLE_TASK_TERMINAL_STATUSES.includes(task.status)) return task;
    const abandonedIds = await this.coordinator.withRunLock(safeProjectId, safeRunId, async () => {
      const manifest = await this.productionStore.readManifest(safeProjectId, safeRunId);
      const index = await this.taskStore.readIndex(safeProjectId, safeRunId);
      const requested = this.taskStore.getTaskUnlocked(index, safeTaskId);
      const root = index.tasks[requested.ownerTaskId] || requested;
      // Capture children first so the parent includes their latest reported usage.
      const ids = [...(root.childTaskIds || []), root.taskId];
      const now = this.timestamp();
      for (const id of ids) {
        const current = index.tasks[id];
        if (!current || !DURABLE_TASK_ACTIVE_STATUSES.includes(current.status)) continue;
        this.taskStore.updateTaskUnlocked(index, id, {
          status,
          phase: status,
          completedAt: now,
          lastProgressAt: now,
          watchdogDueAt: null,
          error: reason,
          usage: id === root.taskId ? aggregateChildUsage(index, root) || this.taskUsage(current) : this.taskUsage(current)
        }, { activeOnly: true });
        this.taskStore.appendEventUnlocked(index, { type: `task.${status}`, taskId: id, createdAt: now });
        if (current.targetArtifactIds.length === 1) {
          await this.productionStore.recordStageUnlocked(manifest, {
            projectId: safeProjectId,
            runId: safeRunId,
            stageId: current.targetArtifactIds[0],
            status,
            requestId: current.requestId,
            expectedRequestId: current.requestId,
            error: reason
          });
        }
      }
      this.taskStore.releaseClaimsUnlocked(index, root.ownerTaskId);
      await this.taskStore.writeIndexUnlocked(index);
      return ids;
    });
    for (const id of abandonedIds) this.stopDirectorRuntime(id, reason);
    await this.withSchedulerLock(async () => {
      for (const id of abandonedIds) {
        const runtime = this.runtimes.get(id);
        const pool = runtime ? this.pools[runtime.poolName] : null;
        if (runtime?.active && pool?.queue.includes(id)) {
          pool.queue = pool.queue.filter((queuedId) => queuedId !== id);
          this.queuedBytes = Math.max(0, this.queuedBytes - runtime.inputBytes);
          this.runtimes.delete(id);
          runtime.finished?.resolve();
        }
        if (runtime) runtime.active = false;
        this.clearWatchdog(id);
        this.notifyWaiters(id);
      }
    });
    return this.taskStore.getTask({ projectId: safeProjectId, runId: safeRunId, taskId: safeTaskId });
  }

  async reconcileInterruptedTasks() {
    const runs = await this.taskStore.scanRunIndexes();
    const summary = [];
    for (const { projectId, runId } of runs) {
      const changed = await this.coordinator.withRunLock(projectId, runId, async () => {
        const manifest = await this.productionStore.readManifest(projectId, runId);
        const index = await this.taskStore.readIndex(projectId, runId);
        let count = 0;
        for (const task of Object.values(index.tasks)) this.taskLocations.set(task.taskId, { projectId, runId });
        const activeTasks = Object.values(index.tasks).filter((task) => DURABLE_TASK_ACTIVE_STATUSES.includes(task.status));
        for (const task of activeTasks.filter((item) => item.parentTaskId)) {
          const recovered = recoveredArtifactRef(manifest, task);
          if (recovered) {
            this.taskStore.updateTaskUnlocked(index, task.taskId, {
              status: "completed",
              phase: "completed",
              completedAt: this.timestamp(),
              watchdogDueAt: null,
              resultArtifactRefs: [recovered]
            }, { activeOnly: true });
          } else {
            await this.interruptTaskUnlocked(manifest, index, task);
          }
          count += 1;
        }
        for (const task of activeTasks.filter((item) => !item.parentTaskId)) {
          const standaloneRecovered = task.targetArtifactIds.length === 1 ? recoveredArtifactRef(manifest, task) : null;
          const pipelineRecovered = task.targetArtifactIds.length > 1
            ? recoveredTargetRefs(manifest, task)
            : null;
          if (standaloneRecovered || pipelineRecovered) {
            this.taskStore.updateTaskUnlocked(index, task.taskId, {
              status: "completed",
              phase: "completed",
              completedAt: this.timestamp(),
              watchdogDueAt: null,
              resultArtifactRefs: standaloneRecovered
                ? [standaloneRecovered]
                : pipelineRecovered
            }, { activeOnly: true });
          } else {
            await this.interruptTaskUnlocked(manifest, index, task, { stage: false });
          }
          this.taskStore.releaseClaimsUnlocked(index, task.ownerTaskId);
          count += 1;
        }
        if (count) await this.taskStore.writeIndexUnlocked(index);
        return count;
      });
      if (changed) summary.push({ projectId, runId, changed });
    }
    return summary;
  }

  async interruptTaskUnlocked(manifest, index, task, { stage = true } = {}) {
    const now = this.timestamp();
    const error = {
      code: "TASK_INTERRUPTED",
      category: "control-plane",
      message: "服务进程已重启；远端调用可能已经计费，系统未自动重试。"
    };
    this.taskStore.updateTaskUnlocked(index, task.taskId, {
      status: "interrupted",
      phase: "interrupted",
      completedAt: now,
      watchdogDueAt: null,
      error,
      usage: aggregateChildUsage(index, task) || task.usage
    }, { activeOnly: true });
    this.taskStore.appendEventUnlocked(index, { type: "task.interrupted", taskId: task.taskId, createdAt: now });
    if (stage && task.targetArtifactIds.length === 1) {
      await this.productionStore.recordStageUnlocked(manifest, {
        projectId: task.projectId,
        runId: task.runId,
        stageId: task.targetArtifactIds[0],
        status: "interrupted",
        requestId: task.requestId,
        expectedRequestId: task.requestId,
        error
      });
    }
  }

  async waitForTask({ projectId, runId, taskId } = {}) {
    const task = await this.taskStore.getTask({ projectId, runId, taskId });
    if (DURABLE_TASK_TERMINAL_STATUSES.includes(task.status)) {
      return { task, compatibilityResult: this.outcomes.get(taskId) };
    }
    return new Promise((resolve, reject) => {
      const key = safeIdentifier(taskId, "taskId");
      const callbacks = this.waiters.get(key) || [];
      let settled = false;
      const completeWaiter = async () => {
        if (settled) return;
        settled = true;
        try {
          resolve({
            task: await this.taskStore.getTask({ projectId, runId, taskId }),
            compatibilityResult: this.outcomes.get(taskId)
          });
        } catch (error) { reject(error); }
      };
      callbacks.push(completeWaiter);
      this.waiters.set(key, callbacks);
      void this.taskStore.getTask({ projectId, runId, taskId }).then((latest) => {
        if (DURABLE_TASK_TERMINAL_STATUSES.includes(latest.status)) this.notifyWaiters(key);
      }).catch((error) => {
        if (settled) return;
        settled = true;
        const remaining = (this.waiters.get(key) || []).filter((callback) => callback !== completeWaiter);
        if (remaining.length) this.waiters.set(key, remaining);
        else this.waiters.delete(key);
        reject(error);
      });
    });
  }

  async getTaskById(taskId) {
    const safeTaskId = safeIdentifier(taskId, "taskId");
    const known = this.taskLocations.get(safeTaskId);
    if (known) return this.taskStore.getTask({ ...known, taskId: safeTaskId });
    for (const { projectId, runId } of await this.taskStore.scanRunIndexes()) {
      try {
        const task = await this.taskStore.getTask({ projectId, runId, taskId: safeTaskId });
        this.taskLocations.set(safeTaskId, { projectId, runId });
        return task;
      } catch (error) {
        if (error?.code !== "TASK_NOT_FOUND") throw error;
      }
    }
    throw new ProductionStateError("Durable Task 不存在", { code: "TASK_NOT_FOUND", httpStatus: 404 });
  }

  async updateTaskAtomic(projectId, runId, taskId, operation) {
    return this.coordinator.withRunLock(projectId, runId, async () => {
      const index = await this.taskStore.readIndex(projectId, runId);
      const task = this.taskStore.getTaskUnlocked(index, taskId);
      const result = await operation(index, task);
      if (result) await this.taskStore.writeIndexUnlocked(index);
      return result;
    });
  }

  armWatchdog(taskId, dueAt) {
    this.clearWatchdog(taskId);
    const runtime = this.runtimes.get(taskId);
    const root = this.runtimes.get(runtime?.ownerTaskId);
    if (root?.controlState && root.controlState !== "running") return;
    const delay = Math.max(1, Date.parse(dueAt) - Date.now());
    const timer = setTimeout(() => {
      if (this.watchdogs.get(taskId) !== timer) return;
      void this.finishWithStatus(taskId, "failed", {
        code: "TASK_STALLED",
        category: "timeout",
        message: "任务长时间没有进展；远端调用可能已经提交并产生费用。"
      }).catch(() => {});
    }, delay);
    timer.unref?.();
    this.watchdogs.set(taskId, timer);
  }

  clearWatchdog(taskId) {
    const timer = this.watchdogs.get(taskId);
    if (timer) clearTimeout(timer);
    this.watchdogs.delete(taskId);
  }

  async notifyWaiters(taskId) {
    const callbacks = this.waiters.get(taskId) || [];
    this.waiters.delete(taskId);
    await Promise.all(callbacks.map((callback) => callback().catch((error) => this.reportBackgroundError(error))));
  }

  reportBackgroundError(error) {
    console.error(`Durable Task 后台收尾失败：${String(error?.message || error).slice(0, 500)}`);
  }

  async withSchedulerLock(operation) {
    const previous = this.schedulerTail;
    let release;
    this.schedulerTail = new Promise((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }

  timestamp() {
    const value = this.now();
    return (value instanceof Date ? value : new Date(value)).toISOString();
  }
}

function normalizePools(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    workflow: poolState(source.workflow, 2, 8),
    media: poolState(source.media, 4, 8)
  };
}

function poolState(value, defaultLimit, defaultQueueLimit) {
  const requestedLimit = Number(value?.limit);
  const requestedQueueLimit = Number(value?.queueLimit);
  return {
    limit: Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.round(requestedLimit) : defaultLimit,
    queueLimit: Number.isFinite(requestedQueueLimit) && requestedQueueLimit >= 0
      ? Math.round(requestedQueueLimit)
      : defaultQueueLimit,
    running: 0,
    queue: []
  };
}

function uniqueArtifactIds(value) {
  if (!Array.isArray(value) || !value.length) {
    throw new ProductionStateError("Task 至少需要一个 target Artifact", { code: "TASK_TARGET_REQUIRED" });
  }
  return [...new Set(value.map((artifactId) => normalizeArtifactId(artifactId)))];
}

function normalizeCompatibilityRequestToken(value, prepared) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProductionStateError("兼容请求 token 无效", {
      code: "TASK_REQUEST_TOKEN_INVALID",
      httpStatus: 400
    });
  }
  const artifactId = normalizeArtifactId(value.artifactId);
  const requestId = safeIdentifier(value.requestId, "production requestId");
  if (prepared.targetArtifactIds.length !== 1 || prepared.targetArtifactIds[0] !== artifactId) {
    throw new ProductionStateError("兼容请求 token 与 Task target 不一致", {
      code: "TASK_REQUEST_TARGET_MISMATCH",
      httpStatus: 409,
      details: [{ artifactId, targetArtifactIds: prepared.targetArtifactIds }]
    });
  }
  const expectedRevision = value.expectedCurrentRevision
    ? safeIdentifier(value.expectedCurrentRevision, "expectedCurrentRevision")
    : null;
  const actualRevision = prepared.targetExpectedRevisions?.[artifactId] || null;
  if (expectedRevision !== actualRevision) {
    throw new ProductionStateError(
      `artifact ${artifactId} 已从 ${expectedRevision || "空版本"} 更新为 ${actualRevision || "空版本"}，拒绝旧请求启动任务`,
      {
        code: "ARTIFACT_REVISION_CONFLICT",
        httpStatus: 409,
        details: [{ artifactId, expectedRevision, actualRevision }]
      }
    );
  }
  return { artifactId, requestId, expectedCurrentRevision: expectedRevision };
}

function requireCurrentLineage(run, artifactId) {
  const safeArtifactId = normalizeArtifactId(artifactId);
  const lineage = run.latestArtifacts?.[safeArtifactId]?.lineage;
  if (!lineage || lineage.status !== "current") {
    throw new ProductionStateError(`缺少 current dependency：${safeArtifactId}`, {
      code: "TASK_DEPENDENCY_MISSING",
      httpStatus: 409
    });
  }
  return lineageRef(lineage);
}

/**
 * 目标 Artifact 的「当前版本」：latest 指向的那一版，不论 current 还是 stale。
 * **创建冻结、调用前复检、锁内提交前复检三处共用这一份**，并与状态库提交门
 * （commitArtifactUnlocked 的 `currentArtifact(manifest).revision`）逐字同一口径——
 * 任何一处单独改成「只认 current」，stale 目标的重新生成就会在那一处必然冲突。
 */
function targetLatestRevision(lineage) {
  return lineage?.revision || null;
}

function assertFrozenInManifest(manifest, task, { targetArtifactId } = {}) {
  const latestArtifact = (artifactId) => {
    const revision = manifest.latest?.[artifactId];
    return revision
      ? (manifest.artifacts || []).find((item) => item.artifactId === artifactId && item.revision === revision) || null
      : null;
  };
  const target = latestArtifact(targetArtifactId);
  const expected = task.targetExpectedRevisions?.[targetArtifactId] || null;
  if (targetLatestRevision(target) !== expected) {
    // 本请求自己已经提交过、结果仍是 current：同一 Task 的重复 finalize，不算冲突。
    if (!(target?.requestId === task.requestId && target.status === "current")) {
      throw frozenConflict(targetArtifactId, expected, target?.revision || null);
    }
  }
  for (const dependency of normalizeDependencies(task.frozenDependencies || [])) {
    const current = latestArtifact(dependency.artifactId);
    if (
      !current
      || current.status !== "current"
      || current.revision !== dependency.revision
      || current.contentDigest !== dependency.contentDigest
    ) {
      throw frozenConflict(dependency.artifactId, dependency.revision, current?.revision || null);
    }
  }
}

function frozenConflict(artifactId, expectedRevision, actualRevision) {
  return new ProductionStateError(`冻结上下文已变化：${artifactId}`, {
    code: "TASK_FROZEN_CONTEXT_CONFLICT",
    httpStatus: 409,
    details: [{ artifactId, expectedRevision: expectedRevision || null, actualRevision: actualRevision || null }]
  });
}

function taskOwnershipError(taskId) {
  return new ProductionStateError(`任务 ${taskId} 已失去提交权`, {
    code: "TASK_OWNERSHIP_LOST",
    httpStatus: 409
  });
}

function recoveredArtifactRef(manifest, task) {
  if (task.targetArtifactIds.length !== 1) return null;
  const artifactId = task.targetArtifactIds[0];
  const revision = manifest.latest?.[artifactId];
  const artifact = revision
    ? (manifest.artifacts || []).find((item) => item.artifactId === artifactId && item.revision === revision)
    : null;
  if (!artifact || artifact.status !== "current" || artifact.requestId !== task.requestId) return null;
  return {
    artifactId,
    revision: artifact.revision,
    contentDigest: artifact.contentDigest,
    ...(artifact.mediaNamespace ? { mediaNamespace: artifact.mediaNamespace } : {})
  };
}

function recoveredTargetRefs(manifest, task) {
  const refs = [];
  for (const artifactId of task.targetArtifactIds) {
    const revision = manifest.latest?.[artifactId];
    const artifact = revision
      ? (manifest.artifacts || []).find((item) => item.artifactId === artifactId && item.revision === revision)
      : null;
    if (!artifact || artifact.status !== "current") return null;
    refs.push({
      artifactId,
      revision: artifact.revision,
      contentDigest: artifact.contentDigest,
      ...(artifact.mediaNamespace ? { mediaNamespace: artifact.mediaNamespace } : {})
    });
  }
  return refs;
}

function mergeResultRefs(left, right) {
  const byKey = new Map();
  for (const item of [...(left || []), ...(right || [])]) {
    if (!item?.artifactId || !item?.revision || !item?.contentDigest) continue;
    byKey.set(`${item.artifactId}@${item.revision}`, item);
  }
  return [...byKey.values()];
}

function estimateBytes(value) {
  try { return Buffer.byteLength(JSON.stringify(value ?? {}), "utf8"); } catch { return 0; }
}

function boundedMs(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric) : fallback;
}

function mergeProgress(current, patch) {
  if (
    current && typeof current === "object" && !Array.isArray(current)
    && patch && typeof patch === "object" && !Array.isArray(patch)
  ) return { ...current, ...patch };
  return patch;
}

function aggregateChildUsage(index, task) {
  return aggregateUsages((task.childTaskIds || []).map((id) => index.tasks?.[id]?.usage));
}

function aggregateUsages(values) {
  const usages = values.filter(Boolean);
  if (!usages.length) return null;
  const byModel = new Map();
  let calls = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let costCny = 0;
  let costKnown = true;
  const hasCompleteness = usages.some((usage) => usage.reportedCalls !== undefined);
  let reportedCalls = 0;
  let unreportedCalls = 0;
  for (const usage of usages) {
    calls += Number(usage.calls) || 0;
    reportedCalls += Number(usage.reportedCalls ?? usage.calls) || 0;
    unreportedCalls += Number(usage.unreportedCalls) || 0;
    promptTokens += Number(usage.promptTokens) || 0;
    completionTokens += Number(usage.completionTokens) || 0;
    totalTokens += Number(usage.totalTokens) || 0;
    if (usage.costCny === null || usage.costCny === undefined) costKnown = false;
    else costCny += Number(usage.costCny) || 0;
    for (const item of usage.byModel || []) {
      const key = `${item.provider || ""}\u0000${item.model || ""}`;
      const current = byModel.get(key) || {
        provider: item.provider || "",
        model: item.model || "",
        calls: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        costCny: 0
      };
      current.calls += Number(item.calls) || 0;
      current.promptTokens += Number(item.promptTokens) || 0;
      current.completionTokens += Number(item.completionTokens) || 0;
      current.totalTokens += Number(item.totalTokens) || 0;
      if (item.costCny === null || item.costCny === undefined) current.costCny = null;
      else if (current.costCny !== null) current.costCny += Number(item.costCny) || 0;
      byModel.set(key, current);
    }
  }
  return {
    calls,
    ...(hasCompleteness ? { reportedCalls, unreportedCalls, usageComplete: unreportedCalls === 0 } : {}),
    promptTokens,
    completionTokens,
    totalTokens,
    costCny: costKnown ? Math.round(costCny * 100) / 100 : null,
    costKnown,
    byModel: [...byModel.values()].map((item) => ({
      ...item,
      costCny: item.costCny === null ? null : Math.round(item.costCny * 100) / 100
    }))
  };
}

function usageWithDispatchCount(known, dispatched) {
  if (!dispatched) return known;
  const reportedCalls = Number(known?.reportedCalls ?? known?.calls) || 0;
  const calls = Math.max(dispatched, reportedCalls);
  const unreportedCalls = calls - reportedCalls;
  return {
    ...(known || { promptTokens: 0, completionTokens: 0, totalTokens: 0, byModel: [] }),
    calls,
    reportedCalls,
    unreportedCalls,
    usageComplete: unreportedCalls === 0,
    costCny: unreportedCalls ? null : known?.costCny ?? null,
    costKnown: !unreportedCalls && Boolean(known?.costKnown)
  };
}

function taskControlError(action, kind = "directorPipeline") {
  if (kind === "fullStory") {
    return Object.assign(new Error(action === "pause"
      ? "完整剧情已暂停；当前请求已中断，继续将重新生成本次完整剧情，可能再次计费。"
      : "完整剧情已终止；当前连接已中断，供应商可能已产生费用，未返回的用量仍未知。"), {
      code: action === "pause" ? "FULL_STORY_PAUSED" : "FULL_STORY_TERMINATED",
      category: "control-plane"
    });
  }
  return Object.assign(new Error(action === "pause"
    ? "AI 导演已暂停；当前请求已中断，继续将重新执行未完成阶段，可能再次计费。"
    : "AI 导演已终止；当前连接已中断，供应商可能已产生费用，未返回的用量仍未知。"), {
    code: action === "pause" ? "DIRECTOR_STAGE_PAUSED" : "DIRECTOR_RUN_TERMINATED",
    category: "control-plane"
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function settleWithin(promise, timeoutMs) {
  let timer;
  try {
    await Promise.race([promise, new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); })]);
  } finally { clearTimeout(timer); }
}
