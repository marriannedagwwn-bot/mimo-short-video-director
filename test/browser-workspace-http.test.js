import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { BrowserWorkspaceStore } from "../src/browser-workspace-store.js";
import { createBrowserWorkspaceHandler } from "../src/browser-workspace-http.js";

const prefix = "/api/browser-workspace";
const sourceBytes = Buffer.from([0, 1, 2, 255, 4, 128, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
const sourceName = "参考 视频 你好.mp4";

async function fixture(t, { lifetimeHeartbeatMs = 30_000 } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mimo-browser-workspace-http-"));
  let time = 100_000;
  let pageId = randomUUID();
  const cleaned = [];
  const config = {
    rootDir: path.join(directory, "workspaces"),
    clock: () => time,
    cleanupRun: async (run) => {
      cleaned.push(run);
      await fs.rm(path.join(directory, "runs", run.runId), { recursive: true, force: true });
    }
  };
  let store = new BrowserWorkspaceStore(config);
  const stores = new Set([store]);
  const responseClosed = [];
  const handlers = [];
  let handle = createBrowserWorkspaceHandler({ store, maxSourceBytes: 32, lifetimeHeartbeatMs });
  const server = http.createServer((request, response) => {
    responseClosed.push(new Promise((resolve) => response.once("close", resolve)));
    const handled = (async () => {
      try {
        if (!await handle(request, response, new URL(request.url, "http://localhost"))) {
          response.writeHead(404);
          response.end();
        }
      } catch (error) {
        if (response.headersSent) response.destroy(error);
        else {
          response.writeHead(error.httpStatus || 500, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ ok: false, code: error.code || "UNEXPECTED_ERROR", error: error.message }));
        }
      }
    })();
    handlers.push(handled);
    void handled.catch(() => {}); // The teardown below reports handler failures.
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(async () => {
    const serverClosed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await serverClosed;
    // A closed listening server can still have queued response-close callbacks.
    // Wait for those callbacks and any registration that was still in flight;
    // no SSE timer can enqueue another touch after every response has closed.
    await Promise.all(responseClosed);
    await Promise.all(handlers);
    for (;;) {
      const pending = [...stores].flatMap((item) => [...item.locks.values()]);
      if (!pending.length) break;
      await Promise.allSettled(pending);
    }
    await fs.rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const f = {
    directory, cleaned, base,
    get store() { return store; },
    get pageId() { return pageId; },
    newPage() { pageId = randomUUID(); return pageId; },
    advance(ms) { time += ms; },
    restartStore() { store = new BrowserWorkspaceStore(config); stores.add(store); handle = createBrowserWorkspaceHandler({ store, maxSourceBytes: 32, lifetimeHeartbeatMs }); },
    request(method, route, options = {}) { return request(base, method, route, options); },
    json(method, route, body = {}) { return request(base, method, route, { body: Buffer.from(JSON.stringify({ pageId, ...body })), headers: { "Content-Type": "application/json" } }); },
    async create() {
      const result = await f.json("POST", `${prefix}/start`);
      assert.equal(result.status, 200);
      assert.equal(result.headers["cache-control"], "no-store");
      return result.json.result.workspace;
    },
    upload(session, options = {}) {
      return f.request("PUT", sourceRoute(session, { pageId, ...options }), { body: options.buffer || sourceBytes, headers: { "Content-Type": options.type || "video/mp4" }, ...options.request });
    },
    openLifetime(session, options = {}) { return openLifetime(base, session.id, options.pageId || pageId); }
  };
  return f;
}

function openLifetime(base, id, pageId) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${base}${prefix}/${id}/lifetime?pageId=${pageId}`, (res) => {
      let data = "";
      res.on("error", () => {});
      res.on("data", (chunk) => {
        data += chunk.toString();
        if (res.statusCode !== 200) reject(new Error(`lifetime returned ${res.statusCode}: ${data}`));
        else if (data.includes("event: ready")) resolve({
          req, res,
          get data() { return data; },
          close() { res.destroy(); req.destroy(); }
        });
      });
    });
    req.on("error", reject);
  });
}

async function until(predicate, message = "condition was not reached") {
  const end = Date.now() + 1500;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

function sourceRoute(session, { type = "video/mp4", name = sourceName, pageId } = {}) {
  const query = new URLSearchParams({ generation: String(session.generation), pageId, name, type, lastModified: "123456789" });
  return `${prefix}/${session.id}/source?${query}`;
}

function request(base, method, route, { body = null, headers = {}, chunked = false, beforeEnd = null } = {}) {
  return new Promise((resolve, reject) => {
    const actualHeaders = { ...headers };
    if (body && !chunked) actualHeaders["Content-Length"] = body.length;
    const req = http.request(new URL(route, base), { method, headers: actualHeaders }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.once("error", reject);
      res.once("end", () => {
        const buffer = Buffer.concat(chunks);
        let json = null;
        if (String(res.headers["content-type"]).includes("application/json") && buffer.length) json = JSON.parse(buffer.toString("utf8"));
        resolve({ status: res.statusCode, headers: res.headers, buffer, json });
      });
    });
    req.once("error", reject);
    if (beforeEnd) {
      req.write(body.subarray(0, 1));
      Promise.resolve().then(beforeEnd).then(() => req.end(body.subarray(1))).catch((error) => { req.destroy(); reject(error); });
      return;
    }
    if (chunked && body) req.write(body);
    req.end(chunked ? undefined : body);
  });
}

test("HTTP binary upload preserves Chinese filename and source bytes across store restart; GET, HEAD, ranges never cache", async (t) => {
  const f = await fixture(t);
  const initial = await f.create();
  const uploaded = await f.upload(initial);
  assert.equal(uploaded.status, 200);
  assert.equal(uploaded.headers["cache-control"], "no-store");
  const session = uploaded.json.result.workspace;
  assert.equal(session.source.name, sourceName);
  assert.equal(session.source.size, sourceBytes.length);
  assert.equal(session.source.lastModified, 123456789);
  f.restartStore();
  const restored = await f.json("POST", `${prefix}/start`, { workspaceId: session.id });
  assert.deepEqual(restored.json.result.workspace.source, session.source);
  const get = await f.request("GET", session.source.url);
  assert.equal(get.status, 200);
  assert.equal(get.headers["cache-control"], "no-store");
  assert.equal(get.headers["content-type"], "video/mp4");
  assert.equal(get.headers["accept-ranges"], "bytes");
  assert.deepEqual(get.buffer, sourceBytes);
  const head = await f.request("HEAD", session.source.url);
  assert.equal(head.status, 200);
  assert.equal(head.buffer.length, 0);
  assert.equal(head.headers["content-length"], String(sourceBytes.length));
  assert.equal(head.headers["cache-control"], "no-store");
  for (const [range, start, end] of [["bytes=2-5", 2, 5], ["bytes=-3", 13, 15], ["bytes=5-", 5, 15], ["bytes=12-999", 12, 15]]) {
    const partial = await f.request("GET", session.source.url, { headers: { Range: range } });
    assert.equal(partial.status, 206, range);
    assert.equal(partial.headers["content-range"], `bytes ${start}-${end}/16`);
    assert.equal(partial.headers["cache-control"], "no-store");
    assert.deepEqual(partial.buffer, sourceBytes.subarray(start, end + 1));
  }
  for (const range of ["bytes=50-60", "bytes=5-3", "bytes=-0", "bytes=1-2,4-5", "bytes=-"]) {
    const invalid = await f.request("GET", session.source.url, { headers: { Range: range } });
    assert.equal(invalid.status, 416, range);
    assert.equal(invalid.headers["content-range"], "bytes */16");
    assert.equal(invalid.headers["cache-control"], "no-store");
  }
});

test("HTTP reset deletes the prior source and owned Run, then rejects stale uploads and closing beacons", async (t) => {
  const f = await fixture(t);
  const initial = await f.create();
  const session = (await f.upload(initial)).json.result.workspace;
  const run = { projectId: "project-http", runId: "run-http" };
  await fs.mkdir(path.join(f.directory, "runs", run.runId), { recursive: true });
  await fs.writeFile(path.join(f.directory, "runs", run.runId, "artifact.json"), "generated result");
  await f.store.attachRun(session.id, { ...run, expectedGeneration: session.generation });
  const oldPath = (await f.store.getSource(session.id)).path;
  const reset = await f.json("POST", `${prefix}/${session.id}/reset`, { generation: session.generation });
  assert.equal(reset.status, 200);
  assert.equal(reset.json.result.workspace.source, null);
  assert.equal(reset.json.result.workspace.run, null);
  await assert.rejects(fs.stat(oldPath), { code: "ENOENT" });
  await assert.rejects(fs.stat(path.join(f.directory, "runs", run.runId)), { code: "ENOENT" });
  assert.deepEqual(f.cleaned, [{ ...run, workspaceId: session.id }]);
  assert.equal((await f.request("GET", session.source.url)).status, 404);
  for (const response of [await f.upload(session), await f.json("POST", `${prefix}/${session.id}/closing`, { generation: session.generation })]) {
    assert.equal(response.status, 409);
    assert.equal(response.json.code, "BROWSER_WORKSPACE_GENERATION_CONFLICT");
  }
  const replacement = await f.upload(reset.json.result.workspace, { buffer: Buffer.from("new source") });
  assert.equal(replacement.status, 200);
  assert.equal((await f.store.resume(session.id)).closingAt, null);
});

test("HTTP upload rejects wrong MIME, empty files, declared and streamed oversize bodies without saving a source", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const wrong = await f.upload(session, { type: "text/plain" });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.json.code, "BROWSER_SOURCE_TYPE_INVALID");
  const empty = await f.upload(session, { buffer: Buffer.alloc(0) });
  assert.equal(empty.status, 400);
  assert.equal(empty.json.code, "BROWSER_SOURCE_EMPTY");
  const large = await f.upload(session, { buffer: Buffer.alloc(33) });
  assert.equal(large.status, 413);
  assert.equal(large.json.code, "BROWSER_WORKSPACE_BODY_TOO_LARGE");
  const streamed = await f.upload(session, { buffer: Buffer.alloc(33), request: { chunked: true } });
  assert.equal(streamed.status, 413);
  assert.equal(streamed.json.code, "BROWSER_WORKSPACE_BODY_TOO_LARGE");
  assert.equal((await f.store.resume(session.id)).source, null);
  assert.equal((await f.store.resume(session.id)).generation, 0);
});

test("an upload already streaming when reset completes cannot restore the previous video", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  let preflightReached;
  const preflight = new Promise((resolve) => { preflightReached = resolve; });
  const originalInspect = f.store.inspect.bind(f.store);
  f.store.inspect = async (...args) => {
    const result = await originalInspect(...args);
    preflightReached();
    return result;
  };
  const result = await f.upload(session, { request: { beforeEnd: async () => {
    await preflight;
    const reset = await f.json("POST", `${prefix}/${session.id}/reset`, { generation: session.generation });
    assert.equal(reset.status, 200);
  } } });
  assert.equal(result.status, 409);
  assert.equal(result.json.code, "BROWSER_WORKSPACE_GENERATION_CONFLICT");
  const current = await f.store.resume(session.id);
  assert.equal(current.generation, 1);
  assert.equal(current.source, null);
});

test("HTTP refresh resumes within closing grace; expiry returns 410 then 404 after sweep and cannot be revived", async (t) => {
  const f = await fixture(t);
  let session = (await f.upload(await f.create())).json.result.workspace;
  const close = await f.json("POST", `${prefix}/${session.id}/closing`, { generation: session.generation });
  assert.equal(close.status, 200);
  assert.equal(close.json.result.workspace.closingAt, 160_000);
  f.advance(59_999);
  f.newPage();
  const refresh = await f.json("POST", `${prefix}/start`, { workspaceId: session.id });
  assert.equal(refresh.status, 200);
  session = refresh.json.result.workspace;
  assert.equal(session.closingAt, null);
  assert.deepEqual((await f.request("GET", session.source.url)).buffer, sourceBytes);
  await f.json("POST", `${prefix}/${session.id}/closing`, { generation: session.generation });
  f.advance(60_000);
  assert.equal((await f.request("GET", session.source.url)).status, 410);
  assert.equal((await f.json("POST", `${prefix}/start`, { workspaceId: session.id })).status, 410);
  assert.deepEqual(await f.store.sweepExpired(), [session.id]);
  assert.equal((await f.request("GET", session.source.url)).status, 404);
  assert.equal((await f.json("POST", `${prefix}/${session.id}/touch`, { generation: session.generation })).status, 404);
});

test("HTTP invalid paths, malformed JSON and missing generations fail explicitly", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  for (const id of ["not-a-uuid", "%2Ftmp%2Foutside", "..%2Foutside"]) {
    const result = await f.request("GET", `${prefix}/${id}/source`);
    assert.equal(result.status, 400);
    assert.equal(result.json.code, "BROWSER_WORKSPACE_ID_INVALID");
  }
  assert.equal((await f.request("GET", `${prefix}/${randomUUID()}/source`)).status, 404);
  const malformed = await f.request("POST", `${prefix}/start`, { body: Buffer.from("{broken"), headers: { "Content-Type": "application/json" } });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.json.code, "BROWSER_WORKSPACE_JSON_INVALID");
  const missing = await f.json("POST", `${prefix}/${session.id}/touch`);
  assert.equal(missing.status, 400);
  assert.equal(missing.json.code, "BROWSER_WORKSPACE_GENERATION_REQUIRED");
  const missingPage = await f.request("POST", `${prefix}/start`, { body: Buffer.from("{}"), headers: { "Content-Type": "application/json" } });
  assert.equal(missingPage.status, 400);
  assert.equal(missingPage.json.code, "BROWSER_WORKSPACE_PAGE_ID_INVALID");
  assert.equal((await f.request("DELETE", `${prefix}/${session.id}/source`)).status, 405);
});

test("HTTP page ownership rejects stale closing and upload after refresh, and late heartbeats cannot extend closing", async (t) => {
  const f = await fixture(t);
  const session = (await f.upload(await f.create())).json.result.workspace;
  const oldPageId = f.pageId;
  await f.json("POST", `${prefix}/${session.id}/closing`, { generation: session.generation });
  f.advance(59_000);
  f.newPage();
  const resumed = await f.json("POST", `${prefix}/start`, { workspaceId: session.id });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.json.result.workspace.closingAt, null);
  for (const action of ["closing", "touch", "reset"]) {
    const stale = await f.json("POST", `${prefix}/${session.id}/${action}`, { generation: session.generation, pageId: oldPageId });
    assert.equal(stale.status, 409, action);
    assert.equal(stale.json.code, "BROWSER_WORKSPACE_PAGE_CONFLICT");
  }
  assert.equal((await f.upload(session, { pageId: oldPageId })).json.code, "BROWSER_WORKSPACE_PAGE_CONFLICT");
  const closing = await f.json("POST", `${prefix}/${session.id}/closing`, { generation: session.generation });
  f.advance(59_999);
  const heartbeat = await f.json("POST", `${prefix}/${session.id}/touch`, { generation: session.generation });
  assert.equal(heartbeat.status, 200);
  assert.equal(heartbeat.json.result.workspace.closingAt, closing.json.result.workspace.closingAt);
  f.advance(1);
  assert.deepEqual(await f.store.sweepExpired(), [session.id]);
});

test("HTTP source PUT preflight and completion both preserve an already closing page's deadline", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const closing = await f.json("POST", `${prefix}/${session.id}/closing`, { generation: session.generation });
  f.advance(59_000);
  const saved = await f.upload(session);
  assert.equal(saved.status, 200);
  assert.equal(saved.json.result.workspace.closingAt, closing.json.result.workspace.closingAt);
  f.advance(1_000);
  assert.deepEqual(await f.store.sweepExpired(), [session.id]);
});

test("HTTP reset-run removes the Run immediately while preserving the original video and invalidating old requests", async (t) => {
  const f = await fixture(t);
  const session = (await f.upload(await f.create())).json.result.workspace;
  const run = { projectId: "project-http", runId: "run-reset-only" };
  await fs.mkdir(path.join(f.directory, "runs", run.runId), { recursive: true });
  await fs.writeFile(path.join(f.directory, "runs", run.runId, "artifact.json"), "generated result");
  await f.store.attachRun(session.id, { ...run, expectedGeneration: session.generation, pageId: f.pageId });
  const closing = await f.json("POST", `${prefix}/${session.id}/closing`, { generation: session.generation });
  const response = await f.json("POST", `${prefix}/${session.id}/reset-run`, { generation: session.generation });
  assert.equal(response.status, 200);
  const cleared = response.json.result.workspace;
  assert.equal(cleared.run, null);
  assert.equal(cleared.generation, session.generation + 1);
  assert.deepEqual(cleared.source, session.source);
  assert.equal(cleared.closingAt, closing.json.result.workspace.closingAt);
  assert.deepEqual((await f.request("GET", session.source.url)).buffer, sourceBytes);
  await assert.rejects(fs.stat(path.join(f.directory, "runs", run.runId)), { code: "ENOENT" });
  assert.equal((await f.json("POST", `${prefix}/${session.id}/reset-run`, { generation: session.generation })).status, 409);
});

test("a real lifetime stream preserves an inactive page and socket close starts the 60-second deletion grace", async (t) => {
  const f = await fixture(t, { lifetimeHeartbeatMs: 10 });
  const session = (await f.upload(await f.create())).json.result.workspace;
  const stream = await f.openLifetime(session);
  assert.match(stream.res.headers["content-type"], /^text\/event-stream/u);
  assert.equal(stream.res.headers["cache-control"], "no-store");
  f.advance(3_600_000);
  assert.deepEqual(await f.store.sweepExpired(), []);
  assert.deepEqual((await f.request("GET", session.source.url)).buffer, sourceBytes);
  await until(() => stream.data.includes(": alive"), "server did not send a lifetime heartbeat");
  stream.close();
  await until(async () => (await f.store.inspect(session.id)).closingAt !== null, "socket close did not mark the workspace closing");
  assert.equal((await f.store.inspect(session.id)).closingAt, 3_760_000);
  f.advance(59_999);
  assert.deepEqual(await f.store.sweepExpired(), []);
  f.advance(1);
  assert.deepEqual(await f.store.sweepExpired(), [session.id]);
  assert.equal((await f.request("GET", session.source.url)).status, 404);
});

test("same-page stream replacement closes the old socket without closing the new connection, and reconnect clears grace", async (t) => {
  const f = await fixture(t, { lifetimeHeartbeatMs: 10 });
  const session = await f.create();
  const first = await f.openLifetime(session);
  const second = await f.openLifetime(session);
  await until(() => first.res.complete, "superseded stream did not end");
  assert.equal((await f.store.inspect(session.id)).closingAt, null);
  first.close();
  second.close();
  await until(async () => (await f.store.inspect(session.id)).closingAt !== null);
  f.advance(59_000);
  const reconnected = await f.openLifetime(session);
  assert.equal((await f.store.inspect(session.id)).closingAt, null);
  await f.json("POST", `${prefix}/${session.id}/reset-run`, { generation: session.generation });
  await until(() => reconnected.data.includes(": alive"));
  assert.equal(reconnected.res.complete, false, "changing generation must not break the lifetime stream");
  reconnected.close();
});

test("new-document resume invalidates the old stream and an explicit close still ends an open stream at expiry", async (t) => {
  const f = await fixture(t, { lifetimeHeartbeatMs: 10 });
  const session = await f.create();
  const oldPageId = f.pageId;
  const old = await f.openLifetime(session);
  f.newPage();
  await f.json("POST", `${prefix}/start`, { workspaceId: session.id });
  const current = await f.openLifetime(session);
  await until(() => old.res.complete, "old document stream did not end");
  assert.equal((await f.store.inspect(session.id)).closingAt, null);
  const rejected = await f.request("GET", `${prefix}/${session.id}/lifetime?pageId=${oldPageId}`);
  assert.equal(rejected.status, 409);
  assert.equal(rejected.json.code, "BROWSER_WORKSPACE_PAGE_CONFLICT");
  await f.json("POST", `${prefix}/${session.id}/closing`, { generation: session.generation });
  f.advance(60_000);
  await until(() => current.res.complete, "expired workspace stream did not end");
  assert.deepEqual(await f.store.sweepExpired(), [session.id]);
  assert.equal(f.store.lifetimeConnections.size, 0);
});

test("closing a socket while registration is pending cannot leave a phantom connected workspace", async (t) => {
  const f = await fixture(t, { lifetimeHeartbeatMs: 10 });
  const session = await f.create();
  const originalConnect = f.store.connectLifetime.bind(f.store);
  let reached;
  let release;
  const entered = new Promise((resolve) => { reached = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  f.store.connectLifetime = async (...args) => {
    reached();
    await gate;
    return originalConnect(...args);
  };
  const req = http.get(`${f.base}${prefix}/${session.id}/lifetime?pageId=${f.pageId}`);
  req.on("error", () => {});
  await entered;
  req.destroy();
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await until(async () => (await f.store.inspect(session.id)).closingAt !== null, "an aborted registration left a connected session");
  assert.equal(f.store.lifetimeConnections.size, 0);
  f.advance(60_000);
  assert.deepEqual(await f.store.sweepExpired(), [session.id]);
});
