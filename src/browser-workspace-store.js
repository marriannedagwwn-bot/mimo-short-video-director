import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

const SESSION_TYPE = "mimo-browser-workspace/1.0";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u;
const SOURCE_FILE = /^source-[a-f0-9-]{36}\.bin$/u;
const OWNED_SOURCE_FILE = /^source-[a-f0-9-]{36}\.bin(?:\.tmp)?$/u;

export class BrowserWorkspaceError extends Error {
  constructor(message, code, httpStatus = 409) {
    super(message);
    this.name = "BrowserWorkspaceError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

// One writer process owns this directory. Content lives in ProductionStateStore;
// this index owns only the tab lifetime, source copy, and explicit Run reference.
export class BrowserWorkspaceStore {
  constructor({ rootDir, cleanupRun, clock = Date.now, closingGraceMs = 60_000, heartbeatTtlMs = 120_000 } = {}) {
    if (!rootDir || typeof cleanupRun !== "function") throw new TypeError("BrowserWorkspaceStore 需要 rootDir 与 cleanupRun");
    if (typeof clock !== "function" || !(closingGraceMs >= 0) || !(heartbeatTtlMs > 0)) throw new TypeError("BrowserWorkspaceStore 时钟设置无效");
    this.rootDir = path.resolve(rootDir);
    this.cleanupRun = cleanupRun;
    this.clock = clock;
    this.closingGraceMs = closingGraceMs;
    this.heartbeatTtlMs = heartbeatTtlMs;
    this.locks = new Map();
    this.lifetimeConnections = new Map();
  }

  async create({ pageId } = {}) {
    if (pageId !== undefined) requirePageId(pageId);
    const id = randomUUID();
    return this.withLock(id, async () => {
      const now = this.now();
      const session = { type: SESSION_TYPE, id, pageId: pageId ?? null, generation: 0, createdAt: now, touchedAt: now, closingAt: null, deleting: false, source: null, run: null, pendingCleanup: [] };
      await fs.mkdir(this.directory(id), { recursive: true, mode: 0o700 });
      await this.write(session);
      return publicSession(session);
    });
  }

  async resume(id, { pageId, expectedGeneration } = {}) {
    if (pageId !== undefined) requirePageId(pageId);
    return this.withLock(id, async () => {
      const session = await this.requireLive(id, expectedGeneration);
      const newDocument = pageId === undefined || session.pageId !== pageId;
      if (pageId !== undefined) session.pageId = pageId;
      session.touchedAt = this.now();
      if (newDocument) session.closingAt = null;
      await this.write(session);
      if (newDocument) this.lifetimeConnections.delete(id);
      return publicSession(session);
    });
  }

  async inspect(id, { expectedGeneration, pageId } = {}) {
    return this.withLock(id, async () => publicSession(await this.requireLive(id, expectedGeneration, pageId)));
  }

  async touch(id, { expectedGeneration, pageId } = {}) {
    return this.withLock(id, async () => {
      const session = await this.requireLive(id, expectedGeneration, pageId);
      session.touchedAt = this.now();
      await this.write(session);
      return publicSession(session);
    });
  }

  async markClosing(id, { expectedGeneration, pageId } = {}) {
    return this.withLock(id, async () => {
      const session = await this.requireLive(id, expectedGeneration, pageId);
      session.closingAt ??= this.now() + this.closingGraceMs;
      await this.write(session);
      return publicSession(session);
    });
  }

  async connectLifetime(id, { pageId } = {}) {
    requirePageId(pageId);
    return this.withLock(id, async () => {
      const session = await this.requireLive(id, undefined, pageId);
      const connectionId = randomUUID();
      session.touchedAt = this.now();
      session.closingAt = null;
      await this.write(session);
      this.lifetimeConnections.set(id, { pageId, connectionId });
      return { connectionId };
    });
  }

  async touchLifetime(id, { pageId, connectionId } = {}) {
    requirePageId(pageId);
    return this.withLock(id, async () => {
      const session = await this.requireLive(id, undefined, pageId);
      this.requireLifetimeConnection(id, pageId, connectionId);
      session.touchedAt = this.now();
      await this.write(session);
      return publicSession(session);
    });
  }

  async disconnectLifetime(id, { pageId, connectionId } = {}) {
    requirePageId(pageId);
    return this.withLock(id, async () => {
      const current = this.lifetimeConnections.get(id);
      if (!current || current.pageId !== pageId || current.connectionId !== connectionId) return { disconnected: false };
      this.lifetimeConnections.delete(id);
      let session;
      try { session = await this.read(id); } catch (error) {
        if (error.code === "BROWSER_WORKSPACE_NOT_FOUND") return { disconnected: false };
        throw error;
      }
      if (session.deleting || session.pageId !== pageId) return { disconnected: false };
      session.closingAt ??= this.now() + this.closingGraceMs;
      await this.write(session);
      return { disconnected: true };
    });
  }

  requireLifetimeConnection(id, pageId, connectionId) {
    const current = this.lifetimeConnections.get(id);
    if (!current || current.pageId !== pageId || current.connectionId !== connectionId) {
      throw new BrowserWorkspaceError("页面连接已由新的连接接管", "BROWSER_WORKSPACE_CONNECTION_CONFLICT");
    }
  }

  async setSource(id, { buffer, name, type, lastModified = 0, expectedGeneration, pageId } = {}) {
    if (!Buffer.isBuffer(buffer)) throw new TypeError("源视频必须为 Buffer");
    if (typeof name !== "string" || !name.trim() || name.length > 1000 || typeof type !== "string" || type.length > 200 || !Number.isFinite(lastModified) || lastModified < 0) {
      throw new BrowserWorkspaceError("源视频文件信息无效", "BROWSER_WORKSPACE_SOURCE_INVALID", 400);
    }
    requireGeneration(expectedGeneration);
    return this.withLock(id, async () => {
      const session = await this.requireLive(id, expectedGeneration, pageId);
      await this.resetUnlocked(session);
      const file = `source-${randomUUID()}.bin`;
      const source = { file, name, type, size: buffer.length, lastModified, digest: createHash("sha256").update(buffer).digest("hex") };
      const target = path.join(this.directory(id), file);
      const temporary = `${target}.tmp`;
      try {
        await fs.writeFile(temporary, buffer, { mode: 0o600, flag: "wx" });
        await fs.rename(temporary, target);
        session.source = source;
        await this.write(session);
      } catch (error) {
        // Preserve the original error; orphan files remain inside this owned
        // session directory and are removed when its lifetime ends.
        await fs.rm(temporary, { force: true }).catch(() => {});
        throw error;
      }
      return publicSession(session);
    });
  }

  async getSource(id) {
    return this.withLock(id, async () => {
      const session = await this.requireLive(id);
      if (!session.source) throw new BrowserWorkspaceError("当前页面尚未保存原视频", "BROWSER_WORKSPACE_SOURCE_NOT_FOUND", 404);
      const file = path.join(this.directory(id), session.source.file);
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== session.source.size) {
        throw new BrowserWorkspaceError("保存的原视频文件无效", "BROWSER_WORKSPACE_SOURCE_INVALID", 500);
      }
      return { path: file, metadata: publicSource(session) };
    });
  }

  async attachRun(id, { projectId, runId, expectedGeneration, replaceExisting = false, pageId } = {}) {
    const run = validateRun({ projectId, runId });
    requireGeneration(expectedGeneration);
    // Cross-session ownership is checked while attach operations serialize.
    return this.withLock("run-ownership", () => this.withLock(id, async () => {
      const session = await this.requireLive(id, expectedGeneration, pageId);
      if (session.pendingCleanup.length) throw new BrowserWorkspaceError("页面旧内容尚未清理完成，请稍后重试", "BROWSER_WORKSPACE_CLEANUP_PENDING");
      if (session.run && !sameRun(session.run, run) && replaceExisting !== true) throw new BrowserWorkspaceError("页面已有生产 Run，请先更换视频或清空页面", "BROWSER_WORKSPACE_RUN_BUSY");
      for (const otherId of await this.ids()) {
        if (otherId === id) continue;
        let other;
        try { other = await this.read(otherId); } catch (error) {
          if (error.code === "BROWSER_WORKSPACE_NOT_FOUND") continue;
          throw error;
        }
        if (sameRun(other.run, run) || other.pendingCleanup.some((item) => sameRun(item.run, run))) {
          throw new BrowserWorkspaceError("生产 Run 已属于另一个页面", "BROWSER_WORKSPACE_RUN_OWNED");
        }
      }
      if (session.run && !sameRun(session.run, run)) {
        session.pendingCleanup.push({ sourceFile: null, run: session.run });
        session.run = null;
        await this.write(session);
        await this.drainCleanup(session);
      }
      session.run = run;
      session.touchedAt = this.now();
      await this.write(session);
      return publicSession(session);
    }));
  }

  async resetSource(id, { expectedGeneration, pageId } = {}) {
    return this.withLock(id, async () => {
      const session = await this.requireLive(id, expectedGeneration, pageId);
      await this.resetUnlocked(session);
      return publicSession(session);
    });
  }

  async resetRun(id, { expectedGeneration, pageId } = {}) {
    return this.withLock(id, async () => {
      const session = await this.requireLive(id, expectedGeneration, pageId);
      if (session.run) session.pendingCleanup.push({ sourceFile: null, run: session.run });
      session.run = null;
      session.generation += 1;
      session.touchedAt = this.now();
      await this.write(session);
      await this.drainCleanup(session);
      return publicSession(session);
    });
  }

  async close(id) {
    return this.withLock(id, async () => {
      let session;
      try { session = await this.read(id); } catch (error) {
        if (error.code === "BROWSER_WORKSPACE_NOT_FOUND") return { id, deleted: true };
        throw error;
      }
      await this.closeUnlocked(session);
      return { id, deleted: true };
    });
  }

  async sweepExpired() {
    const deleted = [];
    const errors = [];
    for (const id of await this.ids()) {
      try {
        await this.withLock(id, async () => {
          let session;
          try { session = await this.read(id); } catch (error) {
            if (error.code === "BROWSER_WORKSPACE_NOT_FOUND") return;
            throw error;
          }
          if (session.deleting || this.expired(session)) {
            await this.closeUnlocked(session);
            deleted.push(id);
          } else if (session.pendingCleanup.length) {
            await this.drainCleanup(session);
          }
        });
      } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "部分页面工作区清理失败，将在下次清理时重试");
    return deleted;
  }

  async resetUnlocked(session) {
    if (session.source || session.run) session.pendingCleanup.push({ sourceFile: session.source?.file || null, run: session.run });
    session.source = null;
    session.run = null;
    session.generation += 1;
    session.touchedAt = this.now();
    await this.write(session);
    await this.drainCleanup(session);
    // A process can stop between binary rename and session-index publication.
    // Source replacement also removes these unreferenced upload remnants.
    for (const file of await fs.readdir(this.directory(session.id))) {
      if (OWNED_SOURCE_FILE.test(file)) await fs.rm(path.join(this.directory(session.id), file), { force: true });
    }
  }

  async closeUnlocked(session) {
    this.lifetimeConnections.delete(session.id);
    if (!session.deleting) {
      session.deleting = true;
      await this.resetUnlocked(session);
    }
    await this.drainCleanup(session);
    await fs.rm(this.directory(session.id), { recursive: true, force: true });
  }

  async drainCleanup(session) {
    while (session.pendingCleanup.length) {
      const pending = session.pendingCleanup[0];
      if (pending.run) await this.cleanupRun({ ...pending.run, workspaceId: session.id });
      if (pending.sourceFile) await fs.rm(path.join(this.directory(session.id), pending.sourceFile), { force: true });
      session.pendingCleanup.shift();
      await this.write(session);
    }
  }

  async requireLive(id, expectedGeneration, pageId) {
    const session = await this.read(id);
    if (session.deleting || this.expired(session)) throw new BrowserWorkspaceError("页面工作区已关闭或过期，请重新选择视频", "BROWSER_WORKSPACE_EXPIRED", 410);
    if (pageId !== undefined) {
      requirePageId(pageId);
      if (session.pageId !== pageId) throw new BrowserWorkspaceError("此页面已由刷新后的新页面接管，请使用最新页面", "BROWSER_WORKSPACE_PAGE_CONFLICT");
    }
    if (expectedGeneration !== undefined) {
      requireGeneration(expectedGeneration);
      if (expectedGeneration !== session.generation) throw new BrowserWorkspaceError("页面视频已更换，此请求已失效", "BROWSER_WORKSPACE_GENERATION_CONFLICT");
    }
    return session;
  }

  expired(session) {
    if (session.closingAt !== null) return this.now() >= session.closingAt;
    const connection = this.lifetimeConnections.get(session.id);
    if (connection && connection.pageId === session.pageId) return false;
    return this.now() >= session.touchedAt + this.heartbeatTtlMs;
  }

  now() {
    const value = Number(this.clock());
    if (!Number.isFinite(value)) throw new TypeError("BrowserWorkspaceStore 时钟无效");
    return value;
  }

  directory(id) {
    if (typeof id !== "string" || !UUID.test(id)) throw new BrowserWorkspaceError("页面工作区标识无效", "BROWSER_WORKSPACE_ID_INVALID", 400);
    return path.join(this.rootDir, id);
  }

  async ids() {
    try { return (await fs.readdir(this.rootDir, { withFileTypes: true })).filter((item) => item.isDirectory() && UUID.test(item.name)).map((item) => item.name); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
  }

  async read(id) {
    const directory = this.directory(id);
    let session;
    try {
      if (!(await fs.lstat(directory)).isDirectory()) throw new Error("工作区目录无效");
      session = JSON.parse(await fs.readFile(path.join(directory, "session.json"), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") throw new BrowserWorkspaceError("页面工作区不存在", "BROWSER_WORKSPACE_NOT_FOUND", 404);
      throw error;
    }
    if (session.type !== SESSION_TYPE || session.id !== id || !Number.isSafeInteger(session.generation) || session.generation < 0 || !Number.isFinite(session.touchedAt) || (session.closingAt !== null && !Number.isFinite(session.closingAt)) || !Array.isArray(session.pendingCleanup)) {
      throw new BrowserWorkspaceError("页面工作区记录无效", "BROWSER_WORKSPACE_INVALID", 500);
    }
    if (session.pageId != null && (typeof session.pageId !== "string" || !UUID.test(session.pageId))) throw new BrowserWorkspaceError("页面文档标识无效", "BROWSER_WORKSPACE_INVALID", 500);
    if (session.run) validateRun(session.run);
    if (session.source && !SOURCE_FILE.test(session.source.file)) throw new BrowserWorkspaceError("页面原视频路径无效", "BROWSER_WORKSPACE_INVALID", 500);
    for (const item of session.pendingCleanup) {
      if (item.run) validateRun(item.run);
      if (item.sourceFile && !SOURCE_FILE.test(item.sourceFile)) throw new BrowserWorkspaceError("页面清理路径无效", "BROWSER_WORKSPACE_INVALID", 500);
    }
    return session;
  }

  async write(session) {
    const target = path.join(this.directory(session.id), "session.json");
    const temporary = `${target}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(session)}\n`, { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, target);
  }

  async withLock(key, action) {
    if (key !== "run-ownership") this.directory(key);
    const previous = this.locks.get(key) || Promise.resolve();
    const pending = previous.catch(() => {}).then(action);
    this.locks.set(key, pending);
    try { return await pending; } finally { if (this.locks.get(key) === pending) this.locks.delete(key); }
  }
}

function publicSource(session) {
  if (!session.source) return null;
  const { file: _file, ...metadata } = session.source;
  return { ...metadata, url: `/api/browser-workspace/${session.id}/source` };
}

function publicSession(session) {
  const { id, generation, createdAt, touchedAt, closingAt, run } = session;
  return { id, generation, createdAt, touchedAt, closingAt, source: publicSource(session), run: run ? { ...run } : null };
}

function requireGeneration(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new BrowserWorkspaceError("缺少有效的页面视频版本", "BROWSER_WORKSPACE_GENERATION_INVALID", 400);
}

function requirePageId(value) {
  if (typeof value !== "string" || !UUID.test(value)) throw new BrowserWorkspaceError("页面文档标识无效", "BROWSER_WORKSPACE_PAGE_ID_INVALID", 400);
}

function validateRun(run) {
  if (typeof run.projectId !== "string" || typeof run.runId !== "string" || !RUN_ID.test(run.projectId) || !RUN_ID.test(run.runId) || [run.projectId, run.runId].some((id) => id === "." || id === "..")) {
    throw new BrowserWorkspaceError("生产 Run 标识无效", "BROWSER_WORKSPACE_RUN_INVALID", 400);
  }
  return { projectId: run.projectId, runId: run.runId };
}

function sameRun(left, right) {
  return Boolean(left && right && left.projectId === right.projectId && left.runId === right.runId);
}
