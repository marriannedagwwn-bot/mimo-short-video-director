import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProductionStateStore } from "../src/production-state-store.js";
import { lineageRef } from "../src/production-lineage.js";
import { createProductionPackageDownloadHandler } from "../src/production-package-download.js";
import { downloadProductionPackage } from "../public/production-package-download.js";

test("HTTP download preserves signed package, unicode filename and validation failures", async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "mimo-download-test-"));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const store = new ProductionStateStore({ rootDir });
  const run = await store.createRun({ projectId: "download-test" });
  const selectedVariant = { id: "V1", title: "晒谷场的午后" };
  const fullStory = { title: "晒谷场的午后", selectedVariantId: "V1", sceneScript: [] };
  const variant = await store.commitArtifact({ ...run, artifactId: "variant:V1", artifactType: "selectedVariant", requestId: "v1", content: selectedVariant });
  await store.commitArtifact({ ...run, artifactId: "fullStory:V1", artifactType: "fullStory", requestId: "s1", content: fullStory, dependencies: [lineageRef(variant.lineage)] });
  const sealed = await store.sealPackage({ ...run, payload: { selectedVariant, fullStory } });
  const handler = createProductionPackageDownloadHandler({ productionStore: store, maxPackageBytes: 8000 });
  const server = http.createServer(async (request, response) => {
    try {
      if (await handler(request, response, new URL(request.url, "http://localhost"))) return;
      response.writeHead(404); response.end();
    } catch (error) {
      response.writeHead(error.httpStatus || 500, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false, error: { code: error.code, message: error.message } }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/production/package/download`;
  for (const testPackage of [false, true]) {
    const response = await fetch(url, { method: "POST", body: new URLSearchParams({ package: JSON.stringify(sealed), testPackage: String(testPackage) }) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(response.headers.get("content-disposition"), /^attachment;/);
    assert.match(decodeURIComponent(response.headers.get("content-disposition")), testPackage ? /晒谷场的午后-测试包.json/ : /晒谷场的午后.json/);
    assert.deepEqual(await response.json(), sealed);
  }
  const changed = { ...sealed, fullStory: { ...fullStory, title: "tampered" } };
  const rejected = await fetch(url, { method: "POST", body: new URLSearchParams({ package: JSON.stringify(changed) }) });
  assert.equal(rejected.headers.get("content-disposition"), null);
  assert.equal((await rejected.json()).error.code, "PRODUCTION_PACKAGE_DIGEST_MISMATCH");
  for (const [source, code] of [["{invalid", "PACKAGE_DOWNLOAD_INVALID_JSON"], ["x".repeat(8100), "PACKAGE_DOWNLOAD_TOO_LARGE"]]) {
    const response = await fetch(url, { method: "POST", body: new URLSearchParams({ package: source }) });
    assert.equal((await response.json()).error.code, code);
  }
  const wrongType = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(wrongType.status, 415);
});

test("browser download submits the intact signed payload as a form and surfaces HTTP errors", () => {
  const mounted = [];
  const timers = [];
  const errors = [];
  const document = { body: { append: (...nodes) => mounted.push(...nodes) }, createElement(tag) {
    return { tag, children: [], append(node) { this.children.push(node); }, submit() { this.submitted = true; }, remove() { this.removed = true; } };
  } };
  const payload = { title: "汉字 & + =", packageSignature: "original-signature" };
  downloadProductionPackage(payload, { testPackage: true, document, schedule: (fn, ms) => timers.push({ fn, ms }), onError: (message) => errors.push(message) });
  const [frame, form] = mounted;
  assert.equal(form.action, "/api/production/package/download");
  assert.equal(form.method, "POST");
  assert.equal(form.target, frame.name);
  assert.equal(form.submitted, true);
  assert.deepEqual(JSON.parse(form.children.find((node) => node.name === "package").value), payload);
  assert.equal(form.children.find((node) => node.name === "testPackage").value, "true");
  assert.equal(frame.removed, undefined);
  frame.contentDocument = { body: { textContent: JSON.stringify({ ok: false, error: { message: "签名无效" } }) } };
  frame.onload();
  assert.deepEqual(errors, ["签名无效"]);
  assert.equal(timers[0].ms, 60_000);
  timers[0].fn();
  assert.equal(frame.removed, true);
  assert.equal(form.removed, true);
});
