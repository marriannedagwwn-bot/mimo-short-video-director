import test from "node:test";
import assert from "node:assert/strict";
import {
  BROWSER_WORKSPACE_STORAGE_KEY, createBrowserWorkspaceClient, creationPreferences
} from "../public/browser-workspace-client.js";

const file = (name) => new File(["video bytes"], name, { type: "video/mp4", lastModified: 123 });
const reply = (workspace) => ({ ok: true, status: 200, json: async () => ({ ok: true, result: { workspace } }) });
function harness({ intercept = async () => null, storage = new Map() } = {}) {
  let current = { id: "workspace-test", generation: 0, source: null, run: null };
  const requests = [];
  const beacons = [];
  const eventSources = [];
  let pageSequence = 0;
  const client = createBrowserWorkspaceClient({
    createPageId: () => `page-${++pageSequence}`,
    createEventSource: (url) => {
      const source = { url, closeCount: 0, close() { this.closeCount += 1; } };
      eventSources.push(source);
      return source;
    },
    storage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    sendBeacon: (url, body) => { beacons.push({ url, body }); return true; },
    fetch: async (url, options) => {
      requests.push({ url, options });
      const intercepted = await intercept(url, options);
      if (intercepted) return intercepted;
      if (url.endsWith("/reset")) current = { ...current, generation: current.generation + 1, source: null, run: null };
      if (url.endsWith("/reset-run")) current = { ...current, generation: current.generation + 1, run: null };
      if (url === "/api/production/package/import") {
        current = { ...current, generation: current.generation + 1, source: null,
          run: { projectId: "import-project", runId: "import-run" } };
        return { ok: true, status: 200, json: async () => ({ ok: true, result: {
          workspace: structuredClone(current), payload: JSON.parse(options.body).package, production: current.run
        } }) };
      }
      if (options.method === "PUT") {
        current = { ...current, generation: current.generation + 1,
          source: { name: options.body.name, url: "/api/browser-workspace/workspace-test/source" } };
      }
      return reply(structuredClone(current));
    }
  });
  return { client, requests, beacons, storage, eventSources };
}

test("tab session stores only workspace identity and refresh starts using that identity", async () => {
  const first = harness();
  await first.client.start();
  assert.equal(first.storage.get(BROWSER_WORKSPACE_STORAGE_KEY), "workspace-test");
  first.client.rememberRun({ projectId: "project", runId: "run" });
  assert.equal(first.storage.size, 1);
  const refreshed = harness({ storage: first.storage });
  await refreshed.client.start();
  assert.deepEqual(JSON.parse(refreshed.requests[0].options.body), { workspaceId: "workspace-test", pageId: "page-1" });
  const otherTab = harness();
  await otherTab.client.start();
  assert.deepEqual(JSON.parse(otherTab.requests[0].options.body), { pageId: "page-1" });
});

test("replacement clears old source and run before upload, and failed upload keeps them cleared", async () => {
  const { client, requests } = harness({ intercept: async (_url, options) => options.method === "PUT"
    ? { ok: false, status: 500, json: async () => ({ ok: false, error: "upload failed" }) } : null });
  await client.start();
  client.rememberRun({ projectId: "project", runId: "old-run" });
  await assert.rejects(client.replaceSource(file("new.mp4"), client.beginChange()));
  assert.equal(client.workspace.run, null);
  assert.equal(client.workspace.source, null);
  assert.equal(client.workspace.generation, 1);
  assert.ok(requests[1].url.endsWith("/reset"));
  assert.equal(requests[2].options.method, "PUT");
  assert.match(requests[2].url, /generation=1/);
});

test("rapid video replacements serialize mutations and never return the superseded source", async () => {
  let release;
  let started;
  const gate = new Promise((resolve) => { release = resolve; });
  const inUpload = new Promise((resolve) => { started = resolve; });
  const { client, requests } = harness({ intercept: async (_url, options) => {
    if (options.method === "PUT" && options.body.name === "first.mp4") { started(); await gate; }
    return null;
  } });
  await client.start();
  const oldEpoch = client.beginChange();
  const first = client.replaceSource(file("first.mp4"), oldEpoch);
  await inUpload;
  const newEpoch = client.beginChange();
  const second = client.replaceSource(file("second.mp4"), newEpoch);
  release();
  assert.equal(await first, null);
  assert.equal((await second).source.name, "second.mp4");
  assert.equal(client.isCurrent(oldEpoch), false);
  assert.equal(client.isCurrent(newEpoch), true);
  const resets = requests.filter((item) => item.url.endsWith("/reset"));
  assert.deepEqual(resets.map((item) => JSON.parse(item.options.body).generation), [0, 2]);
  assert.equal(client.workspace.generation, 4);
});

test("a switch waiting behind another switch skips its obsolete reset and upload", async () => {
  const { client, requests } = harness();
  await client.start();
  const first = client.replaceSource(file("first.mp4"), client.beginChange());
  const second = client.replaceSource(file("second.mp4"), client.beginChange());
  assert.equal(await first, null);
  assert.equal((await second).source.name, "second.mp4");
  assert.equal(requests.filter((item) => item.options.method === "PUT").length, 1);
});

test("pagehide reports generation, and an upload completing after close sends an updated closing receipt", async () => {
  let release;
  let started;
  const gate = new Promise((resolve) => { release = resolve; });
  const inUpload = new Promise((resolve) => { started = resolve; });
  const { client, beacons, requests } = harness({ intercept: async (_url, options) => {
    if (options.method === "PUT") { started(); await gate; }
    return null;
  } });
  await client.start();
  const uploading = client.replaceSource(file("new.mp4"), client.beginChange());
  await inUpload;
  client.close();
  release();
  await uploading;
  assert.deepEqual(await Promise.all(beacons.map(async (item) => JSON.parse(await item.body.text()).generation)), [1, 2]);
  await client.touch();
  assert.ok(requests.at(-1).url.endsWith("/touch"));
  assert.deepEqual(JSON.parse(requests.at(-1).options.body), { generation: 2, pageId: "page-1" });
});

test("a late touch response cannot replace newer uploaded source state", async () => {
  let release;
  let started;
  const gate = new Promise((resolve) => { release = resolve; });
  const touching = new Promise((resolve) => { started = resolve; });
  const { client } = harness({ intercept: async (url) => {
    if (url.endsWith("/touch")) {
      started(); await gate;
      return reply({ id: "workspace-test", generation: 0, source: null, run: null });
    }
    return null;
  } });
  await client.start();
  const touch = client.touch();
  await touching;
  await client.replaceSource(file("current.mp4"), client.beginChange());
  release();
  await touch;
  assert.equal(client.workspace.source.name, "current.mp4");
  assert.equal(client.workspace.generation, 2);
});

test("persistent generation preferences whitelist only count, aspect ratio and duration", () => {
  assert.deepEqual(creationPreferences({ variantCount: 6, animationAspectRatioDefault: "9:16", storyDurationTarget: 75,
    source: "secret-video", modelOverrides: {}, fixedCharacter: "not profile", characterExpressionRules: "separate key" }), {
    variantCount: "6", animationAspectRatioDefault: "9:16", storyDurationTarget: "75"
  });
  assert.deepEqual(creationPreferences({ variantCount: 10, animationAspectRatioDefault: "4:3", storyDurationTarget: -1 }), {
    variantCount: "3", animationAspectRatioDefault: "16:9", storyDurationTarget: "source"
  });
});

test("restoring an expired tab creates an empty workspace while transient errors preserve its identity", async () => {
  for (const code of ["BROWSER_WORKSPACE_EXPIRED", "BROWSER_WORKSPACE_NOT_FOUND"]) {
    const storage = new Map([[BROWSER_WORKSPACE_STORAGE_KEY, "expired-id"]]);
    const { client, requests } = harness({ storage, intercept: async (url, options) => {
      if (url.endsWith("/start") && JSON.parse(options.body).workspaceId) {
        return { ok: false, status: 410, json: async () => ({ ok: false, code }) };
      }
      return null;
    } });
    assert.equal((await client.start()).source, null);
    assert.equal(requests.length, 2);
    assert.equal(storage.get(BROWSER_WORKSPACE_STORAGE_KEY), "workspace-test");
  }
  const storage = new Map([[BROWSER_WORKSPACE_STORAGE_KEY, "retained-id"]]);
  const { client, requests } = harness({ storage, intercept: async () => {
    throw new Error("network unavailable");
  } });
  await assert.rejects(client.start(), /network unavailable/);
  assert.equal(requests.length, 1);
  assert.equal(storage.get(BROWSER_WORKSPACE_STORAGE_KEY), "retained-id");
});

test("a tab waking after cleanup invalidates its pending UI epoch and reports an empty replacement", async () => {
  const { client } = harness({ intercept: async (url) => url.endsWith("/touch")
    ? { ok: false, status: 410, json: async () => ({ ok: false, code: "BROWSER_WORKSPACE_EXPIRED" }) } : null });
  await client.start();
  const epoch = client.epoch;
  client.rememberRun({ projectId: "project", runId: "expired-run" });
  assert.equal(await client.touch(), true);
  assert.equal(client.isCurrent(epoch), false);
  assert.equal(client.workspace.run, null);
});

test("closing during an in-flight heartbeat restores the closing receipt after its response", async () => {
  let release;
  let started;
  const gate = new Promise((resolve) => { release = resolve; });
  const pending = new Promise((resolve) => { started = resolve; });
  const { client, beacons } = harness({ intercept: async (url) => {
    if (url.endsWith("/touch")) { started(); await gate; }
    return null;
  } });
  await client.start();
  const touch = client.touch();
  await pending;
  client.close();
  release();
  await touch;
  assert.equal(beacons.length, 2);
});

test("successful package import adopts the server generation and clears the previous source", async () => {
  const { client } = harness();
  await client.start();
  await client.replaceSource(file("old.mp4"), client.beginChange());
  const oldEpoch = client.epoch;
  client.beginChange();
  client.adopt({ id: "workspace-test", generation: 3, source: null, run: { projectId: "import-project", runId: "import-run" } });
  assert.equal(client.workspace.source, null);
  assert.equal(client.workspace.run.runId, "import-run");
  assert.equal(client.isCurrent(oldEpoch), false);
  assert.deepEqual(client.reference(), { workspaceId: "workspace-test", workspaceGeneration: 3, workspacePageId: "page-1" });
});

test("BFCache resume claims a fresh document identity; closing and touches retain their document ownership", async () => {
  const { client, requests, beacons, storage } = harness();
  await client.start();
  client.close();
  assert.deepEqual(JSON.parse(await beacons[0].body.text()), { generation: 0, pageId: "page-1" });
  assert.equal(await client.resume(), false);
  assert.deepEqual(JSON.parse(requests.at(-1).options.body), { workspaceId: "workspace-test", pageId: "page-2" });
  await client.touch();
  assert.deepEqual(JSON.parse(requests.at(-1).options.body), { generation: 0, pageId: "page-2" });
  assert.equal(beacons.length, 1);
  assert.equal(storage.size, 1);
});

test("reset-run clears the persisted run while retaining the uploaded original video", async () => {
  const { client, requests } = harness();
  await client.start();
  await client.replaceSource(file("keep.mp4"), client.beginChange());
  client.rememberRun({ projectId: "project", runId: "discard" });
  const source = client.workspace.source;
  const workspace = await client.resetRun(client.beginChange());
  assert.equal(workspace.run, null);
  assert.deepEqual(workspace.source, source);
  assert.equal(workspace.generation, 3);
  assert.ok(requests.at(-1).url.endsWith("/reset-run"));
  assert.deepEqual(JSON.parse(requests.at(-1).options.body), { generation: 2, pageId: "page-1" });
});

test("a superseded reset-run updates the mutation generation but cannot overwrite the replacement video", async () => {
  let release;
  let started;
  const gate = new Promise((resolve) => { release = resolve; });
  const pending = new Promise((resolve) => { started = resolve; });
  const { client, requests } = harness({ intercept: async (url) => {
    if (url.endsWith("/reset-run")) { started(); await gate; }
    return null;
  } });
  await client.start();
  await client.replaceSource(file("old.mp4"), client.beginChange());
  const reset = client.resetRun(client.beginChange());
  await pending;
  const replacing = client.replaceSource(file("new.mp4"), client.beginChange());
  release();
  assert.equal(await reset, null);
  assert.equal((await replacing).source.name, "new.mp4");
  const resets = requests.filter((item) => item.url.endsWith("/reset"));
  assert.equal(JSON.parse(resets.at(-1).options.body).generation, 3);
  assert.equal(client.workspace.generation, 5);
});

test("one document lifetime stream survives source and run generation changes", async () => {
  const { client, eventSources } = harness();
  await client.start();
  await client.start();
  assert.equal(eventSources.length, 1);
  assert.equal(eventSources[0].url, "/api/browser-workspace/workspace-test/lifetime?pageId=page-1");
  await client.replaceSource(file("one.mp4"), client.beginChange());
  await client.resetRun(client.beginChange());
  await client.replaceSource(file("two.mp4"), client.beginChange());
  await client.touch();
  assert.equal(eventSources.length, 1);
  assert.equal(eventSources[0].closeCount, 0);
});

test("closing ends the lifetime stream, and BFCache resume opens one for its new page identity", async () => {
  const { client, eventSources, beacons } = harness();
  await client.start();
  client.close();
  assert.equal(eventSources[0].closeCount, 1);
  assert.equal(beacons.length, 1);
  client.close();
  assert.equal(eventSources[0].closeCount, 1);
  await client.resume();
  assert.equal(eventSources.length, 2);
  assert.equal(eventSources[1].url, "/api/browser-workspace/workspace-test/lifetime?pageId=page-2");
  assert.equal(eventSources[1].closeCount, 0);
});

test("adopting a different workspace closes its old lifetime stream without waiting for generation changes", async () => {
  const { client, eventSources } = harness();
  await client.start();
  client.adopt({ id: "replacement-workspace", generation: 0, source: null, run: null });
  assert.equal(eventSources[0].closeCount, 1);
  assert.equal(eventSources.length, 2);
  assert.equal(eventSources[1].url, "/api/browser-workspace/replacement-workspace/lifetime?pageId=page-1");
});

test("an upload or initial start completing after pagehide cannot reopen the lifetime stream", async () => {
  let release;
  let started;
  const gate = new Promise((resolve) => { release = resolve; });
  const pending = new Promise((resolve) => { started = resolve; });
  const { client, eventSources } = harness({ intercept: async (url) => {
    if (url.endsWith("/start")) { started(); await gate; }
    return null;
  } });
  const starting = client.start();
  await pending;
  client.close();
  release();
  await starting;
  assert.equal(eventSources.length, 0);
  await client.replaceSource(file("late.mp4"), client.beginChange());
  assert.equal(eventSources.length, 0);
});

test("an in-flight package import cannot overwrite a replacement video, whose reset uses the imported generation", async () => {
  let release;
  let started;
  const gate = new Promise((resolve) => { release = resolve; });
  const pending = new Promise((resolve) => { started = resolve; });
  const { client, requests, eventSources } = harness({ intercept: async (url) => {
    if (url === "/api/production/package/import") { started(); await gate; }
    return null;
  } });
  await client.start();
  await client.replaceSource(file("before-import.mp4"), client.beginChange());
  const importing = client.importPackage({ title: "imported story" }, client.beginChange());
  await pending;
  const replacing = client.replaceSource(file("after-import.mp4"), client.beginChange());
  release();
  assert.equal(await importing, null);
  assert.equal((await replacing).source.name, "after-import.mp4");
  const reset = requests.filter((item) => item.url.endsWith("/reset")).at(-1);
  assert.equal(JSON.parse(reset.options.body).generation, 3);
  assert.equal(client.workspace.run, null);
  assert.equal(client.workspace.generation, 5);
  assert.equal(eventSources.length, 1);
});

test("invalid package import preserves the previous source and run and does not mutate the generation", async () => {
  const { client } = harness({ intercept: async (url) => url === "/api/production/package/import"
    ? { ok: false, status: 400, json: async () => ({ ok: false, code: "PACKAGE_SIGNATURE_INVALID" }) } : null });
  await client.start();
  await client.replaceSource(file("keep.mp4"), client.beginChange());
  client.rememberRun({ projectId: "project", runId: "keep-run" });
  const before = structuredClone(client.workspace);
  await assert.rejects(client.importPackage({}, client.beginChange()), { code: "PACKAGE_SIGNATURE_INVALID" });
  assert.deepEqual(client.workspace, before);
});
