import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = fileURLToPath(new URL("../", import.meta.url));
const preload = path.join(root, "test/fixtures/system-proxy-preload.mjs");
const hostname = "system-proxy-model.invalid";
const media = Buffer.from("controlled system proxy worker output\n".repeat(30));
const execFileAsync = promisify(execFile);

function snapshot(proxyPort = null) {
  return `<dictionary> {\n  HTTPEnable : ${proxyPort ? 1 : 0}\n  HTTPProxy : 127.0.0.1\n  HTTPPort : ${proxyPort || 1}\n  HTTPSEnable : ${proxyPort ? 1 : 0}\n  HTTPSProxy : 127.0.0.1\n  HTTPSPort : ${proxyPort || 1}\n}\n`;
}

async function listen(server, t) {
  const sockets = new Set();
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    const stopped = new Promise((resolve) => server.close(resolve));
    for (const socket of sockets) socket.destroy();
    await stopped;
  });
  return server.address().port;
}

async function within(promise, message, timeoutMs = 8000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mimo-system-proxy-entrypoints-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const snapshotPath = path.join(directory, "scutil-proxy.txt");
  await fs.writeFile(snapshotPath, snapshot());
  let launches = 0;
  const writeSnapshot = async (proxyPort) => {
    const temporary = `${snapshotPath}.tmp`;
    await fs.writeFile(temporary, snapshot(proxyPort));
    await fs.rename(temporary, snapshotPath);
  };
  const launch = (entry, args = [], extraEnv = {}) => {
    const reportPath = path.join(directory, `exit-${++launches}.json`);
    const child = spawn(process.execPath, ["--use-env-proxy", "--import", preload, path.join(root, entry), ...args], {
      cwd: directory,
      env: {
        PATH: process.env.PATH,
        NODE_ENV: "test",
        HTTP_PROXY: "http://127.0.0.1:1",
        http_proxy: "http://127.0.0.1:2",
        HTTPS_PROXY: "http://127.0.0.1:3",
        https_proxy: "http://127.0.0.1:4",
        ALL_PROXY: "http://127.0.0.1:5",
        all_proxy: "http://127.0.0.1:6",
        NO_PROXY: "old-bypass.invalid", no_proxy: "old-bypass.invalid",
        TEST_SYSTEM_PROXY_SNAPSHOT: snapshotPath,
        TEST_SYSTEM_PROXY_EXIT_REPORT: reportPath,
        ...extraEnv
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"]
    });
    let logs = "";
    child.stdout.on("data", (chunk) => { logs += chunk; });
    child.stderr.on("data", (chunk) => { logs += chunk; });
    const messages = [];
    const waiters = new Set();
    child.on("message", (message) => {
      messages.push(message);
      for (const resolve of waiters) resolve();
    });
    const exited = new Promise((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
      child.once("error", (error) => resolve({ error }));
    });
    const waitMessage = async (predicate) => {
      let wake;
      const listen = () => new Promise((resolve) => { wake = resolve; waiters.add(resolve); });
      try {
        while (!messages.some(predicate)) {
          await within(Promise.race([listen(), exited.then((result) => { throw new Error(`Entry exited before proxy acknowledgement: ${JSON.stringify(result)}\n${logs}`); })]), `Proxy acknowledgement timed out\n${logs}`);
          waiters.delete(wake);
        }
        return messages.find(predicate);
      } finally { waiters.delete(wake); }
    };
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await within(exited, `Entry did not stop\n${logs}`, 2000).catch(() => { child.kill("SIGKILL"); });
    });
    let refreshCount = 0;
    return {
      child, logs: () => logs, exited,
      ready: () => waitMessage((message) => message.type === "system-proxy-ready"),
      refresh: async (proxyPort) => {
        await writeSnapshot(proxyPort);
        const requestId = ++refreshCount;
        child.send({ type: "refresh-system-proxy", requestId });
        const result = await waitMessage((message) => message.type === "system-proxy-refreshed" && message.requestId === requestId);
        assert.equal(result.error, undefined);
        return result.status;
      },
      assertCleanExit: async () => {
        const result = await within(exited, `Entry failed to finish\n${logs}`);
        assert.equal(result.code, 0, logs);
        const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
        assert.deepEqual(report.proxyEnvironment, {}, "inherited proxy variables must not survive initialization");
        assert.equal(report.status.mode, "closed", "the actual entry must close its shared proxy controller");
      }
    };
  };
  return { directory, snapshotPath, writeSnapshot, launch };
}

async function proxy(t, label, targetPort, paths, errors) {
  const tunnels = [];
  const server = http.createServer((_request, response) => {
    errors.push(`${label}: unexpected non-CONNECT proxy request`);
    response.writeHead(502).end();
  });
  server.on("connect", (request, client, head) => {
    const expected = `${hostname}:${targetPort}`;
    if (request.url !== expected) {
      errors.push(`${label}: unexpected CONNECT ${request.url}`);
      client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      return;
    }
    tunnels.push(request.url);
    const upstream = net.connect(targetPort, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    // This fixture carries plain HTTP inside CONNECT, so record each request
    // line while forwarding byte-for-byte without adding application headers.
    let pending = "";
    client.on("data", (chunk) => {
      pending += chunk.toString("latin1");
      let end;
      while ((end = pending.indexOf("\r\n\r\n")) >= 0) {
        const headers = pending.slice(0, end);
        const line = headers.split("\r\n")[0];
        if (/^(GET|POST) /u.test(line)) paths.push({ proxy: label, line });
        pending = pending.slice(end + 4);
      }
    });
    client.on("error", () => upstream.destroy());
    upstream.on("error", (error) => { errors.push(`${label}: ${error.message}`); client.destroy(); });
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  });
  return { port: await listen(server, t), tunnels };
}

function json(response, value) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

test("real generic worker follows direct → proxy A → proxy B → direct for submit, polls and download exactly once", async (t) => {
  const f = await fixture(t);
  const errors = [];
  const requests = [];
  const proxied = [];
  let worker;
  let proxyA;
  let proxyB;
  let providerPort;
  const provider = http.createServer((request, response) => {
    void (async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      requests.push(`${request.method} ${request.url}`);
      if (request.url === "/generate") {
        assert.equal(request.method, "POST");
        assert.equal(requests.length, 1, "a paid submission must never be retried when proxy settings change");
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        assert.ok(body.prompt || body.rawRequest?.prompt);
        await worker.refresh(proxyA.port);
        json(response, { taskId: "fixture-task", status: "queued", pollUrl: `http://${hostname}:${providerPort}/poll` });
      } else if (request.url === "/poll" && requests.length === 2) {
        assert.deepEqual(proxied.map((item) => item.proxy), ["A"]);
        await worker.refresh(proxyB.port);
        json(response, { taskId: "fixture-task", status: "running" });
      } else if (request.url === "/poll" && requests.length === 3) {
        assert.deepEqual(proxied.map((item) => item.proxy), ["A", "B"]);
        await worker.refresh(null);
        json(response, { taskId: "fixture-task", status: "done", videoUrl: `http://${hostname}:${providerPort}/download` });
      } else if (request.url === "/download") {
        assert.equal(request.method, "GET");
        response.writeHead(200, { "content-type": "video/mp4" });
        response.end(media);
      } else throw new Error(`unexpected provider request ${request.method} ${request.url}`);
    })().catch((error) => { errors.push(error.message); response.destroy(error); });
  });
  providerPort = await listen(provider, t);
  proxyA = await proxy(t, "A", providerPort, proxied, errors);
  proxyB = await proxy(t, "B", providerPort, proxied, errors);
  const config = path.join(f.directory, "provider.json");
  const request = path.join(f.directory, "request.json");
  const output = path.join(f.directory, "video.mp4");
  const receipt = path.join(f.directory, "receipt.json");
  await fs.writeFile(config, JSON.stringify({ videoEndpoint: `http://${hostname}:${providerPort}/generate`,
    videoModel: "local-video", includeRawRequest: true, timeoutMs: 5000, pollIntervalMs: 30, pollTimeoutMs: 5000 }));
  await fs.writeFile(request, JSON.stringify({ taskId: "local-task", capability: "first_last_frame_video_generation",
    provider: "VideoHTTP", prompt: "controlled network fixture", inputArtifacts: [] }));
  worker = f.launch("workers/generic-http-worker.mjs", ["--config", config, "--request", request, "--output", output, "--receipt", receipt]);
  await worker.ready();
  await worker.assertCleanExit();
  assert.deepEqual(errors, []);
  assert.deepEqual(requests, ["POST /generate", "GET /poll", "GET /poll", "GET /download"]);
  assert.deepEqual(proxied, [{ proxy: "A", line: "GET /poll HTTP/1.1" }, { proxy: "B", line: "GET /poll HTTP/1.1" }]);
  assert.equal(proxyA.tunnels.length, 1);
  assert.equal(proxyB.tunnels.length, 1);
  assert.deepEqual(await fs.readFile(output), media);
  const result = JSON.parse(await fs.readFile(receipt, "utf8"));
  assert.equal(result.providerTaskId, "fixture-task");
  assert.equal(result.resultKind, "url");
  assert.equal(result.outputPath, output);
});

test("native macOS worker initializes system routing itself without a preinitialized dispatcher", {
  skip: process.platform !== "darwin" ? "Production scutil initialization is macOS-specific; controlled cross-platform entry tests run above." : false
}, async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const provider = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* Consume exactly one submitted request. */ }
    calls += 1;
    json(response, { data: { videoBase64: media.toString("base64") } });
  });
  const port = await listen(provider, t);
  const config = path.join(f.directory, "native-provider.json");
  const request = path.join(f.directory, "native-request.json");
  const output = path.join(f.directory, "native-video.mp4");
  const receipt = path.join(f.directory, "native-receipt.json");
  const report = path.join(f.directory, "native-exit.json");
  await fs.writeFile(config, JSON.stringify({ videoEndpoint: `http://127.0.0.1:${port}/generate`,
    videoModel: "local-video", timeoutMs: 3000 }));
  await fs.writeFile(request, JSON.stringify({ taskId: "native-worker", capability: "first_last_frame_video_generation",
    provider: "VideoHTTP", prompt: "local native entry fixture", inputArtifacts: [] }));
  await execFileAsync(process.execPath, ["--use-env-proxy", "--import", path.join(root, "test/fixtures/system-proxy-exit-report.mjs"),
    path.join(root, "workers/generic-http-worker.mjs"), "--config", config, "--request", request,
    "--output", output, "--receipt", receipt], {
    cwd: f.directory,
    timeout: 8000,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "test",
      HTTP_PROXY: "http://127.0.0.1:1", http_proxy: "http://127.0.0.1:2",
      HTTPS_PROXY: "http://127.0.0.1:3", https_proxy: "http://127.0.0.1:4",
      ALL_PROXY: "http://127.0.0.1:5", all_proxy: "http://127.0.0.1:6",
      // NO_PROXY and no_proxy intentionally absent: a stale Node dispatcher
      // would otherwise bypass the bad inherited proxy and hide a missing hook.
      TEST_SYSTEM_PROXY_EXIT_REPORT: report
    }
  });
  assert.equal(calls, 1);
  assert.deepEqual(await fs.readFile(output), media);
  assert.equal(JSON.parse(await fs.readFile(receipt, "utf8")).resultKind, "base64");
  assert.deepEqual(JSON.parse(await fs.readFile(report, "utf8")), {}, "the real worker must remove every inherited proxy variable");
});

test("real run-video CLI help initializes proxy state and exits without a polling handle leak", async (t) => {
  const f = await fixture(t);
  const cli = f.launch("bin/run-video.js", ["--help"]);
  await cli.ready();
  await cli.assertCleanExit();
  assert.match(cli.logs(), /用法：[\s\S]*run:video/);
});

test("real server health exposes the initialized system proxy status and stays reachable on loopback", async (t) => {
  const f = await fixture(t);
  const reserved = net.createServer();
  await new Promise((resolve) => reserved.listen(0, "127.0.0.1", resolve));
  const port = reserved.address().port;
  await new Promise((resolve) => reserved.close(resolve));
  const server = f.launch("server.js", [], {
    PORT: String(port),
    WORKFLOW_PRODUCTION_STATE_DIR: path.join(f.directory, "production"),
    PARTIAL_REPAIR_DEBUG_DIR: path.join(f.directory, "debug")
  });
  await server.ready();
  const health = async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(3000) });
    assert.equal(response.status, 200);
    return response.json();
  };
  let result;
  const deadline = Date.now() + 8000;
  while (!result) {
    try { result = await health(); } catch (error) {
      assert.ok(Date.now() < deadline, `server health never became available: ${error.message}\n${server.logs()}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  assert.ok(result.networkProxy, `health must expose proxy status: ${JSON.stringify(result)}`);
  assert.equal(result.networkProxy.mode, "direct");
  assert.equal(result.networkProxy.http, "direct");
  const ignored = http.createServer((_request, response) => response.writeHead(502).end());
  const ignoredPort = await listen(ignored, t);
  await server.refresh(ignoredPort);
  result = await health();
  assert.equal(result.networkProxy.mode, "proxy");
  assert.equal(result.networkProxy.http, "proxy");
  assert.equal(result.networkProxy.https, "proxy");
  await server.refresh(null);
  result = await health();
  assert.equal(result.networkProxy.mode, "direct");
  assert.equal(result.networkProxy.http, "direct");
  assert.equal(result.networkProxy.https, "direct");
  server.child.kill("SIGTERM");
  await within(server.exited, `server did not stop\n${server.logs()}`);
});
