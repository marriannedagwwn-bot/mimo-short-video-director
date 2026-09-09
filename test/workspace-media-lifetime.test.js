import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { generateShotVideo } from "../src/shot-video-generator.js";

const execFileAsync = promisify(execFile);
const MEDIA = Buffer.alloc(600, 7);

async function fixture(t, handleProvider) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mimo-workspace-media-"));
  const runDir = path.join(root, "private-run");
  const outputRoot = path.join(root, "generated", "project", "run", "plan");
  const workRoot = path.join(runDir, "media-work");
  const lifetimeFile = path.join(runDir, "manifest.json");
  const output = path.join(outputRoot, "video.mp4");
  const request = path.join(workRoot, "request.json");
  const receipt = path.join(workRoot, "receipt.json");
  const config = path.join(root, "provider.json");
  const f = { root, runDir, outputRoot, workRoot, lifetimeFile, output, request, receipt, config };
  const server = http.createServer((req, res) => {
    void handleProvider(req, res, f).catch((error) => {
      res.writeHead(500);
      res.end(String(error));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  f.url = `http://127.0.0.1:${server.address().port}`;
  await Promise.all([fs.mkdir(workRoot, { recursive: true }), fs.mkdir(outputRoot, { recursive: true })]);
  await fs.writeFile(lifetimeFile, "{}");
  await fs.writeFile(config, JSON.stringify({ videoEndpoint: `${f.url}/generate`, videoModel: "local-video", includeRawRequest: true, timeoutMs: 5000 }));
  await fs.writeFile(request, JSON.stringify({ taskId: "test", capability: "first_last_frame_video_generation", prompt: "local fixture", inputArtifacts: [] }));
  f.runWorker = () => execFileAsync(process.execPath, [
    path.resolve("workers/generic-http-worker.mjs"), "--config", config,
    "--request", request, "--output", output, "--receipt", receipt,
    "--lifetime-file", lifetimeFile
  ], { timeout: 10_000 });
  return f;
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function base64Response(response) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ data: { videoBase64: MEDIA.toString("base64") } }));
}

async function absent(file) {
  await assert.rejects(fs.stat(file), (error) => error.code === "ENOENT");
}

test("real worker writes an open workspace and never sends its local lifetime control to the provider", async (t) => {
  let body;
  const f = await fixture(t, async (request, response) => {
    body = await readBody(request);
    base64Response(response);
  });
  await f.runWorker();
  assert.deepEqual(await fs.readFile(f.output), MEDIA);
  assert.ok(JSON.parse(await fs.readFile(f.receipt, "utf8")).provider);
  assert.ok(body.rawRequest);
  assert.equal(Object.hasOwn(body.rawRequest, "lifetimeFile"), false);
  assert.equal(Object.hasOwn(body.rawRequest, "workspaceLifetimeFile"), false);
  assert.equal(JSON.stringify(body).includes(f.lifetimeFile), false);
});

test("standalone worker cannot recreate a closed Run or media tree after its provider returns", async (t) => {
  let calls = 0;
  const f = await fixture(t, async (request, response, f) => {
    await readBody(request);
    calls += 1;
    await fs.rm(f.runDir, { recursive: true });
    await fs.rm(path.dirname(f.outputRoot), { recursive: true });
    base64Response(response);
  });
  await assert.rejects(f.runWorker(), (error) => /页面工作区已关闭/u.test(error.stderr));
  assert.equal(calls, 1);
  await Promise.all([absent(f.runDir), absent(path.dirname(f.outputRoot))]);
});

test("standalone worker rechecks lifetime after a download finishes and cannot write its receipt", async (t) => {
  let downloads = 0;
  const f = await fixture(t, async (request, response, f) => {
    if (request.url === "/generate") {
      await readBody(request);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: { videoUrl: `${f.url}/download` } }));
      return;
    }
    downloads += 1;
    await fs.rm(f.runDir, { recursive: true });
    await fs.rm(path.dirname(f.outputRoot), { recursive: true });
    response.writeHead(200, { "content-type": "video/mp4" });
    response.end(MEDIA);
  });
  await assert.rejects(f.runWorker(), (error) => /页面工作区已关闭/u.test(error.stderr));
  assert.equal(downloads, 1);
  await Promise.all([absent(f.runDir), absent(path.dirname(f.outputRoot))]);
});

test("standalone worker does not recreate a deleted output directory even when the lifetime file remains", async (t) => {
  const f = await fixture(t, async (request, response, f) => {
    await readBody(request);
    await fs.rm(f.outputRoot, { recursive: true });
    base64Response(response);
  });
  await assert.rejects(f.runWorker(), (error) => /页面工作区已关闭/u.test(error.stderr));
  await absent(f.outputRoot);
  await absent(f.receipt);
  assert.ok(await fs.stat(f.lifetimeFile));
});

test("workspace generator keeps requests and references in its private Run and executes the real worker", async (t) => {
  let calls = 0;
  let body;
  let temporaryNames;
  const f = await fixture(t, async (request, response, f) => {
    body = await readBody(request);
    calls += 1;
    temporaryNames = (await fs.readdir(f.workRoot)).filter((name) => name.startsWith("shot-video-"));
    assert.equal(temporaryNames.length, 1);
    const files = await fs.readdir(path.join(f.workRoot, temporaryNames[0]));
    assert.ok(files.some((name) => name.endsWith(".request.json")));
    base64Response(response);
  });
  const result = await generateShotVideo({
    configPath: f.config, outputRoot: f.outputRoot,
    workRoot: f.workRoot, lifetimeFile: f.lifetimeFile,
    videoProvider: "VideoHTTP", videoModel: "local-video",
    generationMode: "first_last_frame",
    startFrameDataUrl: "data:image/png;base64,aW1hZ2U=",
    endFrameDataUrl: "data:image/png;base64,aW1hZ2U=",
    shot: { shotId: "A01", durationSeconds: 5, videoPrompt: "local fixture" },
    videoOutputProbe: async () => 5
  });
  assert.equal(calls, 1);
  assert.deepEqual(await fs.readFile(result.outputPath), MEDIA);
  assert.equal(Object.hasOwn(body.rawRequest, "lifetimeFile"), false);
  await absent(path.join(f.workRoot, temporaryNames[0]));
});

test("a closed workspace generator makes zero provider calls and does not recreate its private Run", async (t) => {
  let calls = 0;
  const f = await fixture(t, async (_request, response) => { calls += 1; base64Response(response); });
  await fs.rm(f.runDir, { recursive: true });
  await assert.rejects(generateShotVideo({
    configPath: f.config, outputRoot: f.outputRoot,
    workRoot: f.workRoot, lifetimeFile: f.lifetimeFile,
    videoProvider: "VideoHTTP", videoModel: "local-video", generationMode: "first_last_frame",
    startFrameDataUrl: "data:image/png;base64,aW1hZ2U=", endFrameDataUrl: "data:image/png;base64,aW1hZ2U=",
    shot: { shotId: "A01", durationSeconds: 5, videoPrompt: "local fixture" }
  }), (error) => error.code === "BROWSER_WORKSPACE_MEDIA_CLOSED");
  assert.equal(calls, 0);
  await absent(f.runDir);
});

test("current all_reference generator stores reference bytes under the owned Run and removes them after real worker completion", async (t) => {
  let temporaryDirectory;
  let body;
  const f = await fixture(t, async (request, response, f) => {
    body = await readBody(request);
    const names = (await fs.readdir(f.workRoot)).filter((name) => name.startsWith("shot-video-"));
    assert.equal(names.length, 1);
    temporaryDirectory = path.join(f.workRoot, names[0]);
    assert.equal(await fs.readFile(path.join(temporaryDirectory, "reference-01.png"), "utf8"), "reference bytes");
    base64Response(response);
  });
  await fs.writeFile(f.config, JSON.stringify({
    videoEndpoint: `${f.url}/generate`, providerPreset: "modelark_content_generation",
    videoModel: "doubao-seedance-2-0-260128", apiKey: "fixture-key", timeoutMs: 5000
  }));
  const result = await generateShotVideo({
    configPath: f.config, outputRoot: f.outputRoot, workRoot: f.workRoot, lifetimeFile: f.lifetimeFile,
    videoProvider: "Seedance", videoModel: "doubao-seedance-2-0-260128", generationMode: "all_reference",
    referenceAssets: [{ mediaType: "image", name: "reference.png", dataUrl: `data:image/png;base64,${Buffer.from("reference bytes").toString("base64")}` }],
    shot: { shotId: "A01", durationSeconds: 5, videoPrompt: "local fixture" }, videoOutputProbe: async () => 5
  });
  assert.ok(body.content.some((item) => item.type === "image_url"));
  assert.equal(JSON.stringify(body).includes(f.lifetimeFile), false);
  assert.deepEqual(await fs.readFile(result.outputPath), MEDIA);
  await absent(temporaryDirectory);
});
