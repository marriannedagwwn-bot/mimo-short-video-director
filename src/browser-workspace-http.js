import fs from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { ProductionStateError } from "./production-lineage.js";

const PREFIX = "/api/browser-workspace";
export const BROWSER_SOURCE_VIDEO_MAX_BYTES = 512 * 1024 * 1024;

// Source bytes live outside both public/ and the JSON Task Store. This route
// serves only the file selected by the workspace store, never a supplied path.
export function createBrowserWorkspaceHandler({ store, maxSourceBytes = BROWSER_SOURCE_VIDEO_MAX_BYTES, lifetimeHeartbeatMs = 30_000, onWarning = (message) => console.warn(message) } = {}) {
  if (!Number.isFinite(lifetimeHeartbeatMs) || lifetimeHeartbeatMs <= 0) throw new TypeError("页面连接心跳间隔无效");
  return async function handleBrowserWorkspace(request, response, url) {
    if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return false;
    if (request.method === "POST" && url.pathname === `${PREFIX}/start`) {
      const body = await readBodyJson(request);
      const pageId = requiredPageId(body.pageId);
      const workspace = body.workspaceId ? await store.resume(body.workspaceId, { pageId }) : await store.create({ pageId });
      reply(response, { workspace });
      return true;
    }
    const match = /^\/api\/browser-workspace\/([^/]+)\/(source|touch|closing|reset|reset-run|lifetime)$/u.exec(url.pathname);
    if (!match) throw workspaceHttpError("页面工作数据接口不存在", "BROWSER_WORKSPACE_ROUTE_NOT_FOUND", 404);
    const [, id, action] = match;
    if (action === "lifetime" && request.method === "GET") {
      await serveLifetime(response, {
        store, id, pageId: requiredPageId(url.searchParams.get("pageId")), lifetimeHeartbeatMs, onWarning
      });
      return true;
    }
    if (action === "source" && ["GET", "HEAD"].includes(request.method)) {
      await serveSource(request, response, await store.getSource(id));
      return true;
    }
    if (action === "source" && request.method === "PUT") {
      const expectedGeneration = requiredGeneration(url.searchParams.get("generation"));
      const pageId = requiredPageId(url.searchParams.get("pageId"));
      const type = url.searchParams.get("type") || request.headers["content-type"] || "";
      if (!/^video\/[a-z0-9.+-]+$/iu.test(type)) {
        throw workspaceHttpError("请选择视频文件", "BROWSER_SOURCE_TYPE_INVALID", 400);
      }
      // Reject stale writes before buffering a potentially large request, then
      // check the frozen generation again when the store commits the bytes.
      await store.inspect(id, { expectedGeneration, pageId });
      const buffer = await readBody(request, maxSourceBytes);
      if (!buffer.length) throw workspaceHttpError("视频文件为空", "BROWSER_SOURCE_EMPTY", 400);
      const workspace = await store.setSource(id, {
        buffer,
        name: url.searchParams.get("name") || "reference-video",
        type,
        lastModified: Number(url.searchParams.get("lastModified")) || 0,
        expectedGeneration,
        pageId
      });
      reply(response, { workspace });
      return true;
    }
    if (request.method === "POST" && ["touch", "closing", "reset", "reset-run"].includes(action)) {
      const body = await readBodyJson(request);
      const options = { expectedGeneration: requiredGeneration(body.generation), pageId: requiredPageId(body.pageId) };
      const workspace = action === "reset"
        ? await store.resetSource(id, options)
        : await store[action === "closing" ? "markClosing" : action === "reset-run" ? "resetRun" : "touch"](id, options);
      reply(response, { workspace });
      return true;
    }
    throw workspaceHttpError("页面工作数据接口不支持此请求方法", "BROWSER_WORKSPACE_METHOD_NOT_ALLOWED", 405);
  };
}

async function serveLifetime(response, { store, id, pageId, lifetimeHeartbeatMs, onWarning }) {
  let connectionId = null;
  let timer = null;
  let closed = false;
  let checking = false;
  const disconnect = async () => {
    if (!connectionId) return;
    const token = connectionId;
    connectionId = null;
    try { await store.disconnectLifetime(id, { pageId, connectionId: token }); }
    catch { onWarning("页面连接断开状态暂未保存，将由心跳过期清理重试。"); }
  };
  // Install this before the asynchronous registration: a tab can close while
  // the session index is being written and must not leave a phantom live token.
  response.once("close", () => {
    closed = true;
    clearInterval(timer);
    void disconnect();
  });
  ({ connectionId } = await store.connectLifetime(id, { pageId }));
  if (closed || response.destroyed) {
    await disconnect();
    return;
  }
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"
  });
  response.write("retry: 2000\nevent: ready\ndata: {}\n\n");
  timer = setInterval(async () => {
    if (closed || checking) return;
    checking = true;
    try {
      await store.touchLifetime(id, { pageId, connectionId });
      if (!closed) response.write(": alive\n\n");
    } catch {
      clearInterval(timer);
      response.end();
    } finally { checking = false; }
  }, lifetimeHeartbeatMs);
  timer.unref();
}

async function serveSource(request, response, source) {
  const file = await fs.open(source.path, "r");
  try {
    const { size } = await file.stat();
    const range = parseRange(request.headers.range, size);
    if (range === false) {
      response.writeHead(416, { "Content-Range": `bytes */${size}`, "Cache-Control": "no-store" });
      response.end();
      return;
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? size - 1;
    response.writeHead(range ? 206 : 200, {
      "Content-Type": source.metadata.type,
      "Content-Length": end - start + 1,
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {})
    });
    if (request.method === "HEAD") response.end();
    else await pipeline(file.createReadStream({ start, end, autoClose: false }), response);
  } catch (error) {
    if (response.headersSent) response.destroy(error);
    else throw error;
  } finally {
    await file.close();
  }
}

function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header);
  if (!match || (!match[1] && !match[2])) return false;
  const suffix = !match[1];
  const start = suffix ? Math.max(0, size - Number(match[2])) : Number(match[1]);
  const end = suffix || !match[2] ? size - 1 : Math.min(size - 1, Number(match[2]));
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return false;
  return { start, end };
}

export function requiredWorkspaceGeneration(value) {
  if (value === null || value === undefined || value === "") {
    throw workspaceHttpError("缺少页面工作数据版本，请刷新页面", "BROWSER_WORKSPACE_GENERATION_REQUIRED", 400);
  }
  const generation = Number(value);
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw workspaceHttpError("页面工作数据版本无效", "BROWSER_WORKSPACE_GENERATION_INVALID", 400);
  }
  return generation;
}

const requiredGeneration = requiredWorkspaceGeneration;

export function requiredWorkspacePageId(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value)) {
    throw workspaceHttpError("页面实例标识无效，请刷新页面", "BROWSER_WORKSPACE_PAGE_ID_INVALID", 400);
  }
  return value;
}

const requiredPageId = requiredWorkspacePageId;

async function readBodyJson(request) {
  const buffer = await readBody(request, 16 * 1024);
  try {
    const body = JSON.parse(buffer.toString("utf8") || "{}");
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw workspaceHttpError("请求 JSON 格式无效", "BROWSER_WORKSPACE_JSON_INVALID", 400);
  }
}

async function readBody(request, limit) {
  if (Number(request.headers["content-length"]) > limit) {
    throw workspaceHttpError(`文件或请求过大，最多 ${Math.round(limit / 1024 / 1024)} MB`, "BROWSER_WORKSPACE_BODY_TOO_LARGE", 413);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw workspaceHttpError("文件或请求超过大小上限", "BROWSER_WORKSPACE_BODY_TOO_LARGE", 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function reply(response, result) {
  response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify({ ok: true, result }));
}

function workspaceHttpError(message, code, httpStatus) {
  return new ProductionStateError(message, { code, httpStatus });
}
