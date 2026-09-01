import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  ProductionStateError,
  normalizeArtifactId,
  normalizeDependencies,
  safeIdentifier
} from "./production-lineage.js";

export const DURABLE_TASK_SCHEMA_VERSION = "1.0";
export const DURABLE_TASK_INDEX_TYPE = "mimo-durable-task-index";
export const DURABLE_TASK_ACTIVE_STATUSES = Object.freeze(["queued", "running"]);
export const DURABLE_TASK_TERMINAL_STATUSES = Object.freeze([
  "completed",
  "failed",
  "conflicted",
  "interrupted",
  "abandoned",
  "cancelled"
]);
const ALL_STATUSES = new Set([...DURABLE_TASK_ACTIVE_STATUSES, ...DURABLE_TASK_TERMINAL_STATUSES]);

export class DurableTaskStore {
  constructor({ rootDir, now = () => new Date() } = {}) {
    const configuredRoot = String(rootDir || "").trim();
    if (!configuredRoot) throw new TypeError("DurableTaskStore.rootDir 不能为空");
    this.rootDir = path.resolve(configuredRoot);
    this.now = typeof now === "function" ? now : () => new Date();
  }

  tasksDirectory(projectId, runId) {
    const directory = path.resolve(
      this.rootDir,
      safeIdentifier(projectId, "projectId"),
      safeIdentifier(runId, "runId"),
      "tasks"
    );
    if (directory !== this.rootDir && !directory.startsWith(`${this.rootDir}${path.sep}`)) {
      throw new ProductionStateError("Durable Task 路径越界", {
        code: "TASK_PATH_OUTSIDE_ROOT",
        httpStatus: 400
      });
    }
    return directory;
  }

  indexPath(projectId, runId) {
    return path.join(this.tasksDirectory(projectId, runId), "index.json");
  }

  async readIndex(projectId, runId) {
    const safeProjectId = safeIdentifier(projectId, "projectId");
    const safeRunId = safeIdentifier(runId, "runId");
    try {
      const index = JSON.parse(await fs.readFile(this.indexPath(safeProjectId, safeRunId), "utf8"));
      return validateIndex(index, safeProjectId, safeRunId);
    } catch (error) {
      if (error?.code === "ENOENT") return emptyIndex(safeProjectId, safeRunId, this.timestamp());
      throw error;
    }
  }

  async writeIndexUnlocked(index) {
    validateIndex(index, index.projectId, index.runId);
    index.updatedAt = this.timestamp();
    await atomicWriteJson(this.indexPath(index.projectId, index.runId), index);
    return index;
  }

  listTasksUnlocked(index, { activeOnly = false } = {}) {
    const tasks = Object.values(index.tasks || {})
      .filter((task) => !activeOnly || DURABLE_TASK_ACTIVE_STATUSES.includes(task.status))
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
    return tasks.map(publicTask);
  }

  getTaskUnlocked(index, taskId) {
    const safeTaskId = safeIdentifier(taskId, "taskId");
    const task = index.tasks?.[safeTaskId];
    if (!task) {
      throw new ProductionStateError("Durable Task 不存在", {
        code: "TASK_NOT_FOUND",
        httpStatus: 404
      });
    }
    return task;
  }

  createTaskUnlocked(index, input = {}) {
    const taskId = safeIdentifier(input.taskId, "taskId");
    const requestId = safeIdentifier(input.requestId, "requestId");
    const kind = safeTaskKind(input.kind);
    const status = normalizeTaskStatus(input.status || "queued");
    const targetArtifactIds = uniqueArtifactIds(input.targetArtifactIds || []);
    const ownerTaskId = safeIdentifier(input.ownerTaskId || taskId, "ownerTaskId");
    const operationKey = requireSha256(input.operationKey, "operationKey");
    const existingId = index.operations?.[operationKey];
    if (existingId) {
      const existing = index.tasks?.[existingId];
      if (existing && DURABLE_TASK_ACTIVE_STATUSES.includes(existing.status)) {
        return { task: existing, reused: true };
      }
      delete index.operations[operationKey];
    }
    for (const artifactId of targetArtifactIds) {
      const currentOwner = index.claims?.[artifactId];
      if (currentOwner && currentOwner !== ownerTaskId) {
        const owner = index.tasks?.[currentOwner];
        if (owner && DURABLE_TASK_ACTIVE_STATUSES.includes(owner.status)) {
          throw new ProductionStateError(`artifact ${artifactId} 已有任务正在执行`, {
            code: "TASK_TARGET_BUSY",
            httpStatus: 409,
            details: [{ artifactId, taskId: currentOwner }]
          });
        }
        delete index.claims[artifactId];
      }
    }
    const createdAt = this.timestamp();
    const task = {
      schemaVersion: DURABLE_TASK_SCHEMA_VERSION,
      taskId,
      ...(input.parentTaskId ? { parentTaskId: safeIdentifier(input.parentTaskId, "parentTaskId") } : {}),
      ownerTaskId,
      projectId: index.projectId,
      runId: index.runId,
      kind,
      requestId,
      operationKey,
      status,
      phase: safePhase(input.phase || status),
      pool: input.pool === "media" ? "media" : "workflow",
      targetArtifactIds,
      targetExpectedRevisions: normalizeExpectedRevisions(input.targetExpectedRevisions, targetArtifactIds),
      frozenDependencies: normalizeDependencies(input.frozenDependencies || []),
      modelSnapshot: sanitizeTaskValue(input.modelSnapshot || {}, 0),
      progress: sanitizeTaskValue(input.progress || {}, 0),
      usage: sanitizeTaskValue(input.usage || null, 0),
      resultArtifactRefs: normalizeResultRefs(input.resultArtifactRefs || []),
      notices: sanitizeStringArray(input.notices),
      error: null,
      requestBytes: Math.max(0, Number(input.requestBytes) || 0),
      createdAt,
      startedAt: null,
      completedAt: null,
      updatedAt: createdAt,
      lastProgressAt: createdAt,
      watchdogDueAt: input.watchdogDueAt ? normalizeTimestamp(input.watchdogDueAt) : null,
      childTaskIds: []
    };
    index.tasks[taskId] = task;
    index.operations[operationKey] = taskId;
    for (const artifactId of targetArtifactIds) index.claims[artifactId] = ownerTaskId;
    if (task.parentTaskId) {
      const parent = index.tasks[task.parentTaskId];
      if (parent && !parent.childTaskIds.includes(taskId)) parent.childTaskIds.push(taskId);
    }
    this.appendEventUnlocked(index, {
      type: "task.created",
      taskId,
      kind,
      status,
      createdAt
    });
    return { task, reused: false };
  }

  updateTaskUnlocked(index, taskId, patch = {}, { activeOnly = false } = {}) {
    const task = this.getTaskUnlocked(index, taskId);
    if (activeOnly && !DURABLE_TASK_ACTIVE_STATUSES.includes(task.status)) {
      return { task, applied: false };
    }
    if (patch.status !== undefined) task.status = normalizeTaskStatus(patch.status);
    if (patch.phase !== undefined) task.phase = safePhase(patch.phase);
    if (patch.progress !== undefined) task.progress = sanitizeTaskValue(patch.progress, 0);
    if (patch.usage !== undefined) task.usage = sanitizeTaskValue(patch.usage, 0);
    if (patch.modelSnapshot !== undefined) task.modelSnapshot = sanitizeTaskValue(patch.modelSnapshot, 0);
    if (patch.resultArtifactRefs !== undefined) task.resultArtifactRefs = normalizeResultRefs(patch.resultArtifactRefs);
    if (patch.notices !== undefined) task.notices = sanitizeStringArray(patch.notices);
    if (patch.error !== undefined) task.error = patch.error ? sanitizeTaskError(patch.error) : null;
    if (patch.lastProgressAt !== undefined) task.lastProgressAt = normalizeTimestamp(patch.lastProgressAt);
    if (patch.watchdogDueAt !== undefined) task.watchdogDueAt = patch.watchdogDueAt ? normalizeTimestamp(patch.watchdogDueAt) : null;
    if (patch.startedAt !== undefined) task.startedAt = patch.startedAt ? normalizeTimestamp(patch.startedAt) : null;
    if (patch.completedAt !== undefined) task.completedAt = patch.completedAt ? normalizeTimestamp(patch.completedAt) : null;
    task.updatedAt = this.timestamp();
    return { task, applied: true };
  }

  releaseClaimsUnlocked(index, ownerTaskId) {
    const safeOwnerTaskId = safeIdentifier(ownerTaskId, "ownerTaskId");
    for (const [artifactId, owner] of Object.entries(index.claims || {})) {
      if (owner === safeOwnerTaskId) delete index.claims[artifactId];
    }
  }

  assertTargetWritableUnlocked(index, { artifactId, ownerTaskId = "" } = {}) {
    const safeArtifactId = normalizeArtifactId(artifactId);
    const claimedBy = index.claims?.[safeArtifactId];
    // Unclaimed targets preserve all existing browser/internal/import commits.
    if (!claimedBy) return true;
    const claimedTask = index.tasks?.[claimedBy];
    if (!claimedTask || !DURABLE_TASK_ACTIVE_STATUSES.includes(claimedTask.status)) {
      delete index.claims[safeArtifactId];
      return true;
    }
    const suppliedOwner = ownerTaskId ? safeIdentifier(ownerTaskId, "ownerTaskId") : "";
    if (suppliedOwner && suppliedOwner === claimedBy) return true;
    throw new ProductionStateError(`artifact ${safeArtifactId} 已被任务 ${claimedBy} 占用`, {
      code: "TASK_TARGET_BUSY",
      httpStatus: 409,
      details: [{ artifactId: safeArtifactId, taskId: claimedBy }]
    });
  }

  appendEventUnlocked(index, event = {}) {
    index.events ||= [];
    index.events.push(sanitizeTaskValue(event, 0));
    index.events = index.events.slice(-2_000);
  }

  async listTasks({ projectId, runId, activeOnly = false } = {}) {
    const index = await this.readIndex(projectId, runId);
    return this.listTasksUnlocked(index, { activeOnly });
  }

  async getTask({ projectId, runId, taskId } = {}) {
    const index = await this.readIndex(projectId, runId);
    return publicTask(this.getTaskUnlocked(index, taskId));
  }

  async scanRunIndexes() {
    let projects = [];
    try {
      projects = await fs.readdir(this.rootDir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    const found = [];
    for (const projectEntry of projects) {
      if (!projectEntry.isDirectory()) continue;
      let projectId;
      try { projectId = safeIdentifier(projectEntry.name, "projectId"); } catch { continue; }
      const projectDir = path.join(this.rootDir, projectId);
      for (const runEntry of await fs.readdir(projectDir, { withFileTypes: true })) {
        if (!runEntry.isDirectory()) continue;
        let runId;
        try { runId = safeIdentifier(runEntry.name, "runId"); } catch { continue; }
        try {
          await fs.access(this.indexPath(projectId, runId));
          found.push({ projectId, runId });
        } catch {}
      }
    }
    return found;
  }

  timestamp() {
    const value = this.now();
    return (value instanceof Date ? value : new Date(value)).toISOString();
  }
}

export function publicTask(task) {
  const {
    operationKey: _operationKey,
    requestBytes: _requestBytes,
    ownerTaskId: _ownerTaskId,
    ...safe
  } = task;
  return structuredClone(safe);
}

function emptyIndex(projectId, runId, timestamp) {
  return {
    indexType: DURABLE_TASK_INDEX_TYPE,
    schemaVersion: DURABLE_TASK_SCHEMA_VERSION,
    projectId,
    runId,
    createdAt: timestamp,
    updatedAt: timestamp,
    tasks: {},
    operations: {},
    claims: {},
    events: []
  };
}

function validateIndex(index, projectId, runId) {
  if (
    !index
    || index.indexType !== DURABLE_TASK_INDEX_TYPE
    || index.schemaVersion !== DURABLE_TASK_SCHEMA_VERSION
    || index.projectId !== projectId
    || index.runId !== runId
    || !index.tasks
    || !index.operations
    || !index.claims
  ) {
    throw new ProductionStateError("Durable Task index 无效", {
      code: "TASK_INDEX_INVALID",
      httpStatus: 500
    });
  }
  return index;
}

function normalizeTaskStatus(value) {
  const status = String(value || "").trim();
  if (!ALL_STATUSES.has(status)) {
    throw new ProductionStateError("Durable Task status 无效", {
      code: "TASK_STATUS_INVALID"
    });
  }
  return status;
}

function safeTaskKind(value) {
  const kind = String(value || "").trim();
  if (!kind || kind.length > 80 || !/^[A-Za-z][A-Za-z0-9._-]*$/u.test(kind)) {
    throw new ProductionStateError("Durable Task kind 无效", { code: "TASK_KIND_INVALID" });
  }
  return kind;
}

function safePhase(value) {
  return String(value || "queued").trim().replace(/[^A-Za-z0-9_.:-]+/gu, "_").slice(0, 120) || "queued";
}

function uniqueArtifactIds(value) {
  if (!Array.isArray(value) || !value.length) {
    throw new ProductionStateError("Task 至少需要一个 target Artifact", { code: "TASK_TARGET_REQUIRED" });
  }
  return [...new Set(value.map((artifactId) => normalizeArtifactId(artifactId)))];
}

function normalizeExpectedRevisions(value, artifactIds) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.fromEntries(artifactIds.map((artifactId) => {
    const revision = source[artifactId];
    return [artifactId, revision ? safeIdentifier(revision, "expectedCurrentRevision") : null];
  }));
}

function normalizeResultRefs(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 200).map((item) => ({
    artifactId: normalizeArtifactId(item.artifactId),
    revision: safeIdentifier(item.revision, "result.revision"),
    contentDigest: requireSha256(item.contentDigest, "result.contentDigest"),
    ...(item.mediaNamespace ? { mediaNamespace: safeIdentifier(item.mediaNamespace, "result.mediaNamespace") } : {})
  }));
}

function sanitizeTaskError(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    code: String(source.code || "TASK_FAILED").replace(/[^A-Za-z0-9_.:/-]+/gu, "_").slice(0, 160),
    category: String(source.category || "unknown").replace(/[^A-Za-z0-9_.:/-]+/gu, "_").slice(0, 160),
    message: redactSensitiveText(source.message || "任务执行失败", 2_000),
    details: Array.isArray(source.details)
      ? source.details.slice(0, 100).map((item) => sanitizeTaskValue(item, 1))
      : []
  };
}

function sanitizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).map((item) => redactSensitiveText(item, 2_000));
}

function sanitizeTaskValue(value, depth) {
  if (depth > 5) return null;
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "string") return redactSensitiveText(value, 4_000);
  if (["number", "boolean"].includes(typeof value)) return Number.isFinite(value) || typeof value === "boolean" ? value : null;
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => sanitizeTaskValue(item, depth + 1));
  if (typeof value !== "object") return String(value).slice(0, 200);
  const result = {};
  for (const [key, entry] of Object.entries(value).slice(0, 200)) {
    if (
      /prompt|dataurl|base64|cookie|authorization|api.?key|secret/iu.test(key)
      && !/promptDigest$/iu.test(key)
    ) continue;
    result[String(key).slice(0, 120)] = sanitizeTaskValue(entry, depth + 1);
  }
  return result;
}

function redactSensitiveText(value, limit) {
  return String(value || "")
    .replace(/data:[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gu, "[data-url-redacted]")
    .replace(/[A-Za-z0-9+/]{80,}={0,2}/gu, "[base64-redacted]")
    .slice(0, limit);
}

function normalizeTimestamp(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new ProductionStateError("Task timestamp 无效", { code: "TASK_TIMESTAMP_INVALID" });
  }
  return date.toISOString();
}

function requireSha256(value, label) {
  const digest = String(value || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(digest)) {
    throw new ProductionStateError(`${label} 必须是 SHA-256`, { code: "TASK_DIGEST_INVALID" });
  }
  return digest;
}

async function atomicWriteJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, file);
}
