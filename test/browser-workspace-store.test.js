import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { BrowserWorkspaceStore } from "../src/browser-workspace-store.js";

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mimo-browser-workspace-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let time = 10_000;
  const cleaned = [];
  const config = {
    rootDir: path.join(directory, "workspaces"),
    clock: () => time,
    cleanupRun: async (run) => { cleaned.push(run); },
    ...options
  };
  return { directory, config, store: new BrowserWorkspaceStore(config), cleaned, advance(ms) { time += ms; } };
}

function upload(generation, text = "saved video") {
  return { buffer: Buffer.from(text), name: "我的原视频.mp4", type: "video/mp4", lastModified: 1234, expectedGeneration: generation };
}

const run = { projectId: "project-fixture", runId: "run-fixture" };

test("binary source and explicit Run survive a new store instance without copying business content", async (t) => {
  const f = await fixture(t);
  const initial = await f.store.create();
  assert.equal(initial.generation, 0);
  const saved = await f.store.setSource(initial.id, upload(initial.generation));
  const attached = await f.store.attachRun(initial.id, { ...run, expectedGeneration: saved.generation });
  assert.equal(saved.source.digest, createHash("sha256").update("saved video").digest("hex"));
  assert.equal(saved.source.url, `/api/browser-workspace/${initial.id}/source`);
  const reopened = new BrowserWorkspaceStore(f.config);
  assert.deepEqual(await reopened.resume(initial.id), attached);
  const source = await reopened.getSource(initial.id);
  assert.equal(await fs.readFile(source.path, "utf8"), "saved video");
  assert.equal(source.metadata.name, "我的原视频.mp4");
  assert.equal((await fs.stat(source.path)).mode & 0o777, 0o600);
  const record = await fs.readFile(path.join(f.config.rootDir, initial.id, "session.json"), "utf8");
  assert.ok(!record.includes("saved video"));
  assert.ok(!record.includes("data:"));
  assert.equal(f.cleaned.length, 0);
});

test("refresh cancels the 60-second close grace; final close expires exactly at the boundary", async (t) => {
  const f = await fixture(t);
  const session = await f.store.create();
  await f.store.markClosing(session.id);
  f.advance(59_999);
  assert.deepEqual(await f.store.sweepExpired(), []);
  assert.equal((await f.store.resume(session.id)).closingAt, null);
  f.advance(60_001);
  assert.deepEqual(await f.store.sweepExpired(), []);
  await f.store.markClosing(session.id);
  f.advance(60_000);
  await assert.rejects(f.store.resume(session.id), { code: "BROWSER_WORKSPACE_EXPIRED", httpStatus: 410 });
  assert.deepEqual(await f.store.sweepExpired(), [session.id]);
  await assert.rejects(f.store.touch(session.id), { code: "BROWSER_WORKSPACE_NOT_FOUND" });
  assert.deepEqual(await fs.readdir(f.config.rootDir), []);
});

test("sessions without a close signal expire after 120 seconds, and heartbeat extends the lifetime", async (t) => {
  const f = await fixture(t);
  const session = await f.store.create();
  f.advance(120_000 - 1);
  await f.store.touch(session.id);
  f.advance(120_000 - 1);
  assert.deepEqual(await f.store.sweepExpired(), []);
  f.advance(1);
  assert.deepEqual(await new BrowserWorkspaceStore(f.config).sweepExpired(), [session.id]);
});

test("source upload and reset preserve a closing page's original deadline; inspect never renews it", async (t) => {
  const f = await fixture(t);
  for (const operation of ["upload", "reset"]) {
    const session = await f.store.create();
    const saved = await f.store.setSource(session.id, upload(0));
    const closing = await f.store.markClosing(session.id, { expectedGeneration: saved.generation });
    f.advance(59_000);
    const inspected = await f.store.inspect(session.id, { expectedGeneration: saved.generation });
    assert.equal(inspected.touchedAt, closing.touchedAt);
    assert.equal(inspected.closingAt, closing.closingAt);
    const completed = operation === "upload"
      ? await f.store.setSource(session.id, upload(saved.generation, "late uploaded bytes"))
      : await f.store.resetSource(session.id, { expectedGeneration: saved.generation });
    assert.equal(completed.closingAt, closing.closingAt, operation);
    f.advance(1_000);
    await assert.rejects(f.store.inspect(session.id), { code: "BROWSER_WORKSPACE_EXPIRED" });
    assert.deepEqual(await f.store.sweepExpired(), [session.id]);
  }
});

test("changing the video deletes its old app copy and owned Run while preserving the user's original", async (t) => {
  const f = await fixture(t);
  const original = path.join(f.directory, "user-original.mp4");
  await fs.writeFile(original, "original user's file");
  const session = await f.store.create();
  const first = await f.store.setSource(session.id, upload(0));
  const oldSource = await f.store.getSource(session.id);
  const interruptedUpload = path.join(f.config.rootDir, session.id, `source-${randomUUID()}.bin.tmp`);
  await fs.writeFile(interruptedUpload, "interrupted upload");
  await f.store.attachRun(session.id, { ...run, expectedGeneration: first.generation });
  const changed = await f.store.setSource(session.id, upload(first.generation, "replacement"));
  assert.equal(changed.generation, first.generation + 1);
  assert.equal(changed.run, null);
  assert.deepEqual(f.cleaned, [{ ...run, workspaceId: session.id }]);
  await assert.rejects(fs.stat(oldSource.path), { code: "ENOENT" });
  await assert.rejects(fs.stat(interruptedUpload), { code: "ENOENT" });
  assert.equal(await fs.readFile(original, "utf8"), "original user's file");
  assert.equal(await fs.readFile((await f.store.getSource(session.id)).path, "utf8"), "replacement");
});

test("late uploads, Run attachments and close beacons cannot modify a reset source generation", async (t) => {
  const f = await fixture(t);
  const session = await f.store.create();
  const saved = await f.store.setSource(session.id, upload(0));
  const resetPromise = f.store.resetSource(session.id, { expectedGeneration: saved.generation });
  const lateUpload = f.store.setSource(session.id, upload(saved.generation, "late"));
  const reset = await resetPromise;
  await assert.rejects(lateUpload, { code: "BROWSER_WORKSPACE_GENERATION_CONFLICT" });
  await assert.rejects(f.store.attachRun(session.id, { ...run, expectedGeneration: saved.generation }), { code: "BROWSER_WORKSPACE_GENERATION_CONFLICT" });
  await assert.rejects(f.store.markClosing(session.id, { expectedGeneration: saved.generation }), { code: "BROWSER_WORKSPACE_GENERATION_CONFLICT" });
  assert.equal(reset.source, null);
  assert.equal((await f.store.resume(session.id)).closingAt, null);
  await assert.rejects(f.store.setSource(session.id, { ...upload(reset.generation), expectedGeneration: undefined }), { code: "BROWSER_WORKSPACE_GENERATION_INVALID" });
});

test("one Run can only be owned by one tab, including concurrent attaches", async (t) => {
  const f = await fixture(t);
  const a = await f.store.create();
  const b = await f.store.create();
  const results = await Promise.allSettled([
    f.store.attachRun(a.id, { ...run, expectedGeneration: 0 }),
    f.store.attachRun(b.id, { ...run, expectedGeneration: 0 })
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.find((result) => result.status === "rejected").reason.code, "BROWSER_WORKSPACE_RUN_OWNED");
  const owned = results[0].status === "fulfilled" ? a : b;
  const free = owned === a ? b : a;
  assert.equal((await f.store.resume(free.id)).run, null);
  await f.store.resetSource(owned.id, { expectedGeneration: 0 });
  assert.deepEqual((await f.store.attachRun(free.id, { ...run, expectedGeneration: 0 })).run, run);
});

test("explicit same-video Run replacement cleans old results and preserves source bytes and generation", async (t) => {
  const cleaned = [];
  const f = await fixture(t, { cleanupRun: async (target) => {
    cleaned.push(target);
    await fs.rm(path.join(f.directory, target.runId), { recursive: true, force: true });
  } });
  const session = await f.store.create();
  const saved = await f.store.setSource(session.id, upload(0));
  const source = await f.store.getSource(session.id);
  await fs.mkdir(path.join(f.directory, run.runId));
  await fs.writeFile(path.join(f.directory, run.runId, "artifact.json"), "old result");
  await f.store.attachRun(session.id, { ...run, expectedGeneration: saved.generation });
  const nextRun = { ...run, runId: "run-next" };
  await assert.rejects(f.store.attachRun(session.id, { ...nextRun, expectedGeneration: saved.generation }), { code: "BROWSER_WORKSPACE_RUN_BUSY" });
  const replaced = await f.store.attachRun(session.id, { ...nextRun, expectedGeneration: saved.generation, replaceExisting: true });
  assert.deepEqual(replaced.run, nextRun);
  assert.deepEqual(replaced.source, saved.source);
  assert.equal(replaced.generation, saved.generation);
  assert.equal(await fs.readFile(source.path, "utf8"), "saved video");
  await assert.rejects(fs.stat(path.join(f.directory, run.runId)), { code: "ENOENT" });
  assert.deepEqual(cleaned, [{ ...run, workspaceId: session.id }]);
});

test("Run replacement checks cross-tab ownership before cleanup and journals cleanup failures", async (t) => {
  let fail = true;
  let attempts = 0;
  const f = await fixture(t, { cleanupRun: async () => { attempts++; if (fail) throw new Error("old Run busy"); } });
  const a = await f.store.create();
  const b = await f.store.create();
  const saved = await f.store.setSource(a.id, upload(0));
  await f.store.attachRun(a.id, { ...run, expectedGeneration: saved.generation });
  const nextRun = { ...run, runId: "run-next" };
  await f.store.attachRun(b.id, { ...nextRun, expectedGeneration: 0 });
  await assert.rejects(f.store.attachRun(a.id, { ...nextRun, expectedGeneration: saved.generation, replaceExisting: true }), { code: "BROWSER_WORKSPACE_RUN_OWNED" });
  assert.equal(attempts, 0);
  assert.deepEqual((await f.store.resume(a.id)).run, run);
  const replacement = { ...run, runId: "run-replacement" };
  await assert.rejects(f.store.attachRun(a.id, { ...replacement, expectedGeneration: saved.generation, replaceExisting: true }), /old Run busy/u);
  const interrupted = await new BrowserWorkspaceStore(f.config).resume(a.id);
  assert.equal(interrupted.run, null);
  assert.equal(interrupted.generation, saved.generation);
  assert.deepEqual(interrupted.source, saved.source);
  fail = false;
  await f.store.sweepExpired();
  assert.deepEqual((await f.store.attachRun(a.id, { ...replacement, expectedGeneration: saved.generation, replaceExisting: true })).run, replacement);
  assert.equal(attempts, 2);
});

test("resetRun immediately clears old results while retaining source bytes and the page closing deadline", async (t) => {
  const f = await fixture(t);
  const pageId = randomUUID();
  const session = await f.store.create({ pageId });
  const saved = await f.store.setSource(session.id, { ...upload(0), pageId });
  await f.store.attachRun(session.id, { ...run, expectedGeneration: saved.generation, pageId });
  const sourcePath = (await f.store.getSource(session.id)).path;
  const closing = await f.store.markClosing(session.id, { pageId });
  const reset = await f.store.resetRun(session.id, { expectedGeneration: saved.generation, pageId });
  assert.equal(reset.run, null);
  assert.equal(reset.generation, saved.generation + 1);
  assert.equal(reset.closingAt, closing.closingAt);
  assert.deepEqual(reset.source, saved.source);
  assert.equal(await fs.readFile(sourcePath, "utf8"), "saved video");
  assert.deepEqual(f.cleaned, [{ ...run, workspaceId: session.id }]);
  assert.equal((await new BrowserWorkspaceStore(f.config).inspect(session.id)).run, null);
  await assert.rejects(f.store.attachRun(session.id, { ...run, expectedGeneration: saved.generation, pageId }), { code: "BROWSER_WORKSPACE_GENERATION_CONFLICT" });
});

test("resetRun cleanup failures retain the source and persist the old Run for retry after restart", async (t) => {
  let attempts = 0;
  const f = await fixture(t, { cleanupRun: async () => { if (++attempts === 1) throw new Error("Run removal failed"); } });
  const session = await f.store.create();
  const saved = await f.store.setSource(session.id, upload(0));
  await f.store.attachRun(session.id, { ...run, expectedGeneration: saved.generation });
  await assert.rejects(f.store.resetRun(session.id, { expectedGeneration: saved.generation }), /Run removal failed/u);
  const reopened = new BrowserWorkspaceStore(f.config);
  const reset = await reopened.inspect(session.id);
  assert.equal(reset.run, null);
  assert.deepEqual(reset.source, saved.source);
  assert.equal(reset.generation, saved.generation + 1);
  assert.equal(await fs.readFile((await reopened.getSource(session.id)).path, "utf8"), "saved video");
  assert.deepEqual(await reopened.sweepExpired(), []);
  assert.equal(attempts, 2);
});

test("cleanup failure is persisted, reported, and retried across a restart without reviving a closed session", async (t) => {
  let attempts = 0;
  const f = await fixture(t, { cleanupRun: async () => { if (++attempts === 1) throw new Error("cleanup temporarily unavailable"); } });
  const session = await f.store.create();
  const saved = await f.store.setSource(session.id, upload(0));
  await f.store.attachRun(session.id, { ...run, expectedGeneration: saved.generation });
  await assert.rejects(f.store.close(session.id), /cleanup temporarily unavailable/u);
  const reopened = new BrowserWorkspaceStore(f.config);
  await assert.rejects(reopened.touch(session.id), { code: "BROWSER_WORKSPACE_EXPIRED" });
  const record = JSON.parse(await fs.readFile(path.join(f.config.rootDir, session.id, "session.json"), "utf8"));
  assert.equal(record.deleting, true);
  assert.deepEqual(record.pendingCleanup[0].run, run);
  assert.deepEqual(await reopened.sweepExpired(), [session.id]);
  assert.equal(attempts, 2);
  await assert.rejects(fs.stat(path.join(f.config.rootDir, session.id)), { code: "ENOENT" });
});

test("failed reset cleanup remains retryable and protects the old Run from being reattached elsewhere", async (t) => {
  let fail = true;
  const f = await fixture(t, { cleanupRun: async () => { if (fail) throw new Error("locked Run"); } });
  const a = await f.store.create();
  const b = await f.store.create();
  await f.store.attachRun(a.id, { ...run, expectedGeneration: 0 });
  await assert.rejects(f.store.resetSource(a.id, { expectedGeneration: 0 }), /locked Run/u);
  const reset = await f.store.resume(a.id);
  assert.equal(reset.run, null);
  assert.equal(reset.generation, 1);
  await assert.rejects(f.store.attachRun(a.id, { ...run, expectedGeneration: reset.generation }), { code: "BROWSER_WORKSPACE_CLEANUP_PENDING" });
  await assert.rejects(f.store.attachRun(b.id, { ...run, expectedGeneration: 0 }), { code: "BROWSER_WORKSPACE_RUN_OWNED" });
  await assert.rejects(f.store.sweepExpired(), AggregateError);
  fail = false;
  assert.deepEqual(await f.store.sweepExpired(), []);
  assert.deepEqual((await f.store.attachRun(b.id, { ...run, expectedGeneration: 0 })).run, run);
});

test("a late heartbeat cannot cancel closing and a touch after deletion cannot recreate files", async (t) => {
  const f = await fixture(t);
  const session = await f.store.create();
  const closing = await f.store.markClosing(session.id);
  f.advance(59_999);
  const [touched, swept] = await Promise.all([f.store.touch(session.id), f.store.sweepExpired()]);
  assert.equal(touched.closingAt, closing.closingAt);
  assert.deepEqual(swept, []);
  f.advance(1);
  assert.deepEqual(await f.store.sweepExpired(), [session.id]);
  await assert.rejects(f.store.touch(session.id), { code: "BROWSER_WORKSPACE_NOT_FOUND" });
  assert.deepEqual(await f.store.close(session.id), { id: session.id, deleted: true });
});

test("a refreshed document claims its own page ID and rejects old-document closing, heartbeats and writes", async (t) => {
  const f = await fixture(t);
  const oldPage = randomUUID();
  const newPage = randomUUID();
  const session = await f.store.create({ pageId: oldPage });
  const saved = await f.store.setSource(session.id, { ...upload(0), pageId: oldPage });
  const closing = await f.store.markClosing(session.id, { pageId: oldPage, expectedGeneration: saved.generation });
  f.advance(59_000);
  assert.equal((await f.store.touch(session.id, { pageId: oldPage })).closingAt, closing.closingAt);
  assert.equal((await f.store.resume(session.id, { pageId: oldPage })).closingAt, closing.closingAt);
  const refreshed = await new BrowserWorkspaceStore(f.config).resume(session.id, { pageId: newPage });
  assert.equal(refreshed.closingAt, null);
  assert.equal(refreshed.generation, saved.generation);
  assert.deepEqual(refreshed.source, saved.source);
  for (const operation of [
    () => f.store.markClosing(session.id, { pageId: oldPage }),
    () => f.store.touch(session.id, { pageId: oldPage }),
    () => f.store.inspect(session.id, { pageId: oldPage }),
    () => f.store.setSource(session.id, { ...upload(saved.generation), pageId: oldPage }),
    () => f.store.resetSource(session.id, { expectedGeneration: saved.generation, pageId: oldPage }),
    () => f.store.resetRun(session.id, { expectedGeneration: saved.generation, pageId: oldPage }),
    () => f.store.attachRun(session.id, { ...run, expectedGeneration: saved.generation, pageId: oldPage })
  ]) await assert.rejects(operation(), { code: "BROWSER_WORKSPACE_PAGE_CONFLICT" });
  f.advance(60_000);
  assert.deepEqual(await f.store.sweepExpired(), []);
  const newClosing = await f.store.markClosing(session.id, { pageId: newPage });
  f.advance(59_999);
  assert.equal((await f.store.touch(session.id, { pageId: newPage })).closingAt, newClosing.closingAt);
  f.advance(1);
  assert.deepEqual(await f.store.sweepExpired(), [session.id]);
});

test("invalid IDs and source symlinks cannot read or delete paths outside the session", async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.directory, "outside.txt");
  await fs.writeFile(outside, "preserve");
  for (const id of ["../outside.txt", "/tmp/unsafe", "not-a-uuid"]) {
    await assert.rejects(f.store.close(id), { code: "BROWSER_WORKSPACE_ID_INVALID" });
  }
  const session = await f.store.create();
  await f.store.setSource(session.id, upload(0));
  const source = await f.store.getSource(session.id);
  await fs.rm(source.path);
  await fs.symlink(outside, source.path);
  await assert.rejects(f.store.getSource(session.id), { code: "BROWSER_WORKSPACE_SOURCE_INVALID" });
  await f.store.close(session.id);
  assert.equal(await fs.readFile(outside, "utf8"), "preserve");
  const historical = path.join(f.config.rootDir, "historical-run");
  await fs.mkdir(historical);
  await f.store.sweepExpired();
  assert.ok((await fs.stat(historical)).isDirectory());
  await assert.rejects(f.store.resume(randomUUID()), { code: "BROWSER_WORKSPACE_NOT_FOUND" });
});

test("a session directory replaced by a symlink cannot redirect source reads or cleanup into its target", async (t) => {
  const f = await fixture(t);
  const session = await f.store.create();
  const externalDirectory = path.join(f.directory, "user-directory");
  await fs.mkdir(externalDirectory);
  await fs.writeFile(path.join(externalDirectory, "keep.txt"), "user content");
  const sessionDirectory = path.join(f.config.rootDir, session.id);
  await fs.rm(sessionDirectory, { recursive: true });
  await fs.symlink(externalDirectory, sessionDirectory, "dir");
  await assert.rejects(f.store.getSource(session.id), /工作区目录无效/u);
  await assert.rejects(f.store.close(session.id), /工作区目录无效/u);
  assert.deepEqual(await f.store.sweepExpired(), []);
  assert.equal(await fs.readFile(path.join(externalDirectory, "keep.txt"), "utf8"), "user content");
  assert.deepEqual(f.cleaned, []);
});

test("a current lifetime connection survives long browser inactivity, while an explicit closing deadline still expires", async (t) => {
  const f = await fixture(t);
  const pageId = randomUUID();
  const session = await f.store.create({ pageId });
  const connection = await f.store.connectLifetime(session.id, { pageId });
  f.advance(3_600_000);
  assert.deepEqual(await f.store.sweepExpired(), []);
  const current = await f.store.inspect(session.id, { pageId });
  assert.equal(current.closingAt, null);
  await f.store.resetRun(session.id, { expectedGeneration: 0, pageId });
  await f.store.touchLifetime(session.id, { pageId, ...connection });
  await f.store.markClosing(session.id, { pageId });
  f.advance(60_000);
  assert.deepEqual(await f.store.sweepExpired(), [session.id]);
  assert.equal(f.store.lifetimeConnections.size, 0);
});

test("lifetime disconnection begins grace, same-page reconnect cancels it, and stale tokens cannot close or touch the new stream", async (t) => {
  const f = await fixture(t);
  const pageId = randomUUID();
  const session = await f.store.create({ pageId });
  const first = await f.store.connectLifetime(session.id, { pageId });
  await f.store.disconnectLifetime(session.id, { pageId, ...first });
  assert.equal((await f.store.inspect(session.id)).closingAt, 70_000);
  f.advance(59_000);
  const second = await f.store.connectLifetime(session.id, { pageId });
  assert.equal((await f.store.inspect(session.id)).closingAt, null);
  assert.deepEqual(await f.store.disconnectLifetime(session.id, { pageId, ...first }), { disconnected: false });
  await assert.rejects(f.store.touchLifetime(session.id, { pageId, ...first }), { code: "BROWSER_WORKSPACE_CONNECTION_CONFLICT" });
  const third = await f.store.connectLifetime(session.id, { pageId });
  assert.deepEqual(await f.store.disconnectLifetime(session.id, { pageId, ...second }), { disconnected: false });
  assert.equal((await f.store.inspect(session.id)).closingAt, null);
  await f.store.disconnectLifetime(session.id, { pageId, ...third });
  f.advance(60_000);
  assert.deepEqual(await f.store.sweepExpired(), [session.id]);
});

test("document resume invalidates the old lifetime token and connection state is never persisted across restart", async (t) => {
  const f = await fixture(t);
  const oldPageId = randomUUID();
  const newPageId = randomUUID();
  const session = await f.store.create({ pageId: oldPageId });
  const first = await f.store.connectLifetime(session.id, { pageId: oldPageId });
  await f.store.resume(session.id, { pageId: newPageId });
  const second = await f.store.connectLifetime(session.id, { pageId: newPageId });
  assert.deepEqual(await f.store.disconnectLifetime(session.id, { pageId: oldPageId, ...first }), { disconnected: false });
  await assert.rejects(f.store.connectLifetime(session.id, { pageId: oldPageId }), { code: "BROWSER_WORKSPACE_PAGE_CONFLICT" });
  await assert.rejects(f.store.touchLifetime(session.id, { pageId: oldPageId, ...first }), { code: "BROWSER_WORKSPACE_PAGE_CONFLICT" });
  const record = await fs.readFile(path.join(f.config.rootDir, session.id, "session.json"), "utf8");
  assert.ok(!record.includes(first.connectionId));
  assert.ok(!record.includes(second.connectionId));
  f.advance(120_000);
  assert.deepEqual(await f.store.sweepExpired(), []);
  const restarted = new BrowserWorkspaceStore(f.config);
  assert.deepEqual(await restarted.sweepExpired(), [session.id]);
});
