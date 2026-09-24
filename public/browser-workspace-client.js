import { createApiRequestError } from "./compiler-observability.js";
import { STORY_DURATION_SOURCE, STORY_DURATION_PRESETS } from "./story-duration.js";

export const BROWSER_WORKSPACE_STORAGE_KEY = "directorBrowserWorkspace";
export const CREATION_PREFERENCES_STORAGE_KEY = "directorCreationPreferences";

// These are generation preferences, never creatorProfile or Artifact facts.
export function creationPreferences(value = {}) {
  return {
    variantCount: [3, 4, 5, 6].includes(Number(value.variantCount)) ? String(value.variantCount) : "3",
    animationAspectRatioDefault: value.animationAspectRatioDefault === "9:16" ? "9:16" : "16:9",
    storyDurationTarget: STORY_DURATION_PRESETS.includes(Number(value.storyDurationTarget))
      ? String(value.storyDurationTarget) : STORY_DURATION_SOURCE
  };
}

export function createBrowserWorkspaceClient({ storage, fetch: request, sendBeacon = () => false,
  createPageId = () => crypto.randomUUID(),
  createEventSource = typeof EventSource === "function" ? (url) => new EventSource(url) : null }) {
  let workspace = null;
  let startup = null;
  let queue = Promise.resolve();
  let epoch = 0;
  let closing = false;
  let lifetime = null;
  let lifetimeKey = "";
  // A document identity must not be copied through sessionStorage on refresh.
  let pageId = createPageId();
  const expired = (error) => ["BROWSER_WORKSPACE_NOT_FOUND", "BROWSER_WORKSPACE_EXPIRED"].includes(error.code);
  const path = (action) => `/api/browser-workspace/${encodeURIComponent(workspace.id)}/${action}`;
  function closeLifetime() {
    lifetime?.close();
    lifetime = null;
    lifetimeKey = "";
  }
  function connectLifetime() {
    if (!createEventSource || !workspace || closing) return;
    const key = `${workspace.id}:${pageId}`;
    if (lifetime && lifetimeKey === key) return;
    closeLifetime();
    // Generation changes replace video content, not the live document. Keeping
    // this socket open protects a background tab when its JS timers are throttled.
    lifetime = createEventSource(`${path("lifetime")}?${new URLSearchParams({ pageId })}`);
    lifetimeKey = key;
    // EventSource reconnects itself after a transient server/network outage.
    // Its messages and errors never adopt source/Run data into the page.
  }
  async function json(url, body, options = {}) {
    const response = await request(url, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), ...options
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) throw createApiRequestError(payload, response.status, "页面工作区暂时不可用，请重试。");
    return payload.result;
  }
  function adopt(value) {
    workspace = value;
    storage.setItem(BROWSER_WORKSPACE_STORAGE_KEY, workspace.id);
    if (closing) close();
    else connectLifetime();
    return workspace;
  }
  async function start() {
    if (workspace) return workspace;
    if (!startup) {
      startup = json("/api/browser-workspace/start", { workspaceId: storage.getItem(BROWSER_WORKSPACE_STORAGE_KEY) || undefined, pageId })
        .catch((error) => {
          if (!expired(error)) throw error;
          return json("/api/browser-workspace/start", { pageId });
        })
        .then((result) => adopt(result.workspace))
        .catch((error) => { startup = null; throw error; });
    }
    return startup;
  }
  function enqueue(operation) {
    const pending = queue.catch(() => {}).then(operation);
    queue = pending;
    return pending;
  }
  function close() {
    closing = true;
    closeLifetime();
    if (!workspace) return;
    const body = JSON.stringify({ generation: workspace.generation, pageId });
    if (!sendBeacon(path("closing"), new Blob([body], { type: "application/json" }))) {
      void request(path("closing"), {
        method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true
      }).catch(() => {});
    }
  }
  return {
    start,
    adopt,
    get workspace() { return workspace; },
    get pageId() { return pageId; },
    get epoch() { return epoch; },
    beginChange() { epoch += 1; return epoch; },
    isCurrent(token) { return token === epoch; },
    reference() {
      if (!workspace) throw new Error("页面工作区尚未就绪，请稍后重试。");
      return { workspaceId: workspace.id, workspaceGeneration: workspace.generation, workspacePageId: pageId };
    },
    rememberRun(run) {
      if (workspace) workspace = { ...workspace, run: run?.runId ? { projectId: run.projectId, runId: run.runId } : null };
    },
    importPackage(payload, token) {
      return enqueue(async () => {
        await start();
        if (token !== epoch) return null;
        const imported = await json("/api/production/package/import", {
          package: payload,
          workspaceId: workspace.id,
          workspaceGeneration: workspace.generation,
          workspacePageId: pageId
        });
        if (!imported.workspace) throw new Error("服务端没有返回导入包所属的页面工作区。");
        // Import changes the generation too. Even if the user has switched away,
        // the next queued replacement must use this newly committed generation.
        adopt(imported.workspace);
        return token === epoch ? imported : null;
      });
    },
    resetRun(token) {
      return enqueue(async () => {
        await start();
        if (token !== epoch) return null;
        const reset = await json(path("reset-run"), { generation: workspace.generation, pageId });
        adopt(reset.workspace);
        return token === epoch ? workspace : null;
      });
    },
    replaceSource(file, token) {
      return enqueue(async () => {
        await start();
        if (token !== epoch) return null;
        // Reset first: even a failed upload must never resurrect the preceding video's results.
        const reset = await json(path("reset"), { generation: workspace.generation, pageId });
        adopt(reset.workspace);
        if (token !== epoch) return null;
        const query = new URLSearchParams({
          generation: String(workspace.generation), pageId, name: file.name, type: file.type,
          lastModified: String(file.lastModified)
        });
        const uploaded = await json(`${path("source")}?${query}`, null, {
          method: "PUT", headers: { "content-type": "application/octet-stream" }, body: file
        });
        adopt(uploaded.workspace);
        return token === epoch ? workspace : null;
      });
    },
    close,
    async resume() {
      return enqueue(async () => {
        await start();
        const before = workspace;
        pageId = createPageId();
        closing = false;
        let result;
        try {
          result = await json("/api/browser-workspace/start", {
            workspaceId: workspace?.id || storage.getItem(BROWSER_WORKSPACE_STORAGE_KEY) || undefined,
            pageId
          });
        } catch (error) {
          if (!expired(error)) throw error;
          result = await json("/api/browser-workspace/start", { pageId });
        }
        const changed = before?.id !== result.workspace.id || before?.generation !== result.workspace.generation;
        if (changed) epoch += 1;
        adopt(result.workspace);
        return changed;
      });
    },
    async touch() {
      await start();
      // Touch never adopts a stale snapshot over a concurrently uploaded new generation.
      const touchedId = workspace.id;
      try {
        await json(path("touch"), { generation: workspace.generation, pageId });
        if (closing) close();
        return false;
      } catch (error) {
        if (!expired(error) || touchedId !== workspace.id) throw error;
        epoch += 1;
        pageId = createPageId();
        adopt((await json("/api/browser-workspace/start", { pageId })).workspace);
        return true;
      }
    }
  };
}
