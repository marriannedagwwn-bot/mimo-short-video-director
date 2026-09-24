import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const hostname = "system-proxy-model.invalid";

async function within(promise, message, timeoutMs = 6000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

async function listen(server, t) {
  const sockets = new Set();
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    const closed = new Promise((resolve) => server.close(resolve));
    for (const socket of sockets) socket.destroy();
    await closed;
  });
  return server.address().port;
}

async function certificates(directory) {
  const ca = path.join(directory, "ca.pem");
  const caKey = path.join(directory, "ca.key");
  const key = path.join(directory, "server.key");
  const csr = path.join(directory, "server.csr");
  const cert = path.join(directory, "server.pem");
  const extensions = path.join(directory, "server.ext");
  await fs.writeFile(extensions, `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:${hostname}\n`);
  await execFileAsync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", caKey,
    "-out", ca, "-days", "1", "-subj", "/CN=Mimo Controlled Proxy TLS Root",
    "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"], { timeout: 5000 });
  await execFileAsync("openssl", ["req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", key,
    "-out", csr, "-subj", `/CN=${hostname}`], { timeout: 5000 });
  await execFileAsync("openssl", ["x509", "-req", "-in", csr, "-CA", ca, "-CAkey", caKey,
    "-CAcreateserial", "-out", cert, "-days", "1", "-sha256", "-extfile", extensions], { timeout: 5000 });
  return { ca, key: await fs.readFile(key), cert: await fs.readFile(cert) };
}

function startClient(t, directory, ca, snapshotPath, tlsPort) {
  const child = spawn(process.execPath, ["--use-env-proxy", fileURLToPath(new URL("./fixtures/system-proxy-https-client.mjs", import.meta.url))], {
    cwd: directory,
    env: {
      PATH: process.env.PATH, NODE_ENV: "test", NODE_EXTRA_CA_CERTS: ca,
      HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:2",
      TEST_SYSTEM_PROXY_SNAPSHOT: snapshotPath, TEST_SYSTEM_PROXY_TLS_PORT: String(tlsPort)
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  const pending = new Map();
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  child.on("message", (message) => {
    if (message.ready) resolveReady(message);
    else pending.get(message.id)?.(message);
  });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await within(exited, "TLS fixture subprocess did not stop", 2000).catch(() => { child.kill("SIGKILL"); });
  });
  let counter = 0;
  const request = async (message) => {
    const id = ++counter;
    const reply = new Promise((resolve) => pending.set(id, resolve));
    child.send({ ...message, id });
    try {
      return await within(Promise.race([reply, exited.then((result) => { throw new Error(`TLS client exited early: ${JSON.stringify(result)}\n${logs}`); })]), `TLS client did not answer\n${logs}`);
    } finally { pending.delete(id); }
  };
  return { ready, request, exited, logs: () => logs };
}

test("controlled TLS requests switch HTTPS proxy → direct independently of HTTP with certificate checks enabled", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mimo-system-proxy-https-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const tls = await certificates(directory);
  const requests = [];
  const target = https.createServer({ key: tls.key, cert: tls.cert }, (request, response) => {
    requests.push({ url: request.url, sourcePort: request.socket.remotePort, encrypted: request.socket.encrypted });
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(`verified TLS response ${requests.length}`);
  });
  // The final negative check deliberately presents the wrong DNS identity.
  target.on("tlsClientError", () => {});
  const tlsPort = await listen(target, t);
  const tunnels = [];
  const proxyErrors = [];
  const proxy = http.createServer((_request, response) => response.writeHead(502).end());
  proxy.on("connect", (request, client, head) => {
    if (request.url !== `${hostname}:${tlsPort}`) {
      proxyErrors.push(`unexpected CONNECT ${request.url}`);
      client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      return;
    }
    const upstream = net.connect(tlsPort, "127.0.0.1", () => {
      tunnels.push({ destination: request.url, sourcePort: upstream.localPort });
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    client.on("error", () => upstream.destroy());
    upstream.on("error", (error) => { proxyErrors.push(error.message); client.destroy(); });
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  });
  const proxyPort = await listen(proxy, t);
  const snapshotPath = path.join(directory, "scutil-proxy.txt");
  const writeSnapshot = async (httpEnabled, httpsEnabled) => fs.writeFile(snapshotPath,
    `<dictionary> {\n  HTTPEnable : ${Number(httpEnabled)}\n  HTTPProxy : 127.0.0.1\n  HTTPPort : ${proxyPort}\n  HTTPSEnable : ${Number(httpsEnabled)}\n  HTTPSProxy : 127.0.0.1\n  HTTPSPort : ${proxyPort}\n}\n`);
  await writeSnapshot(true, true);
  const client = startClient(t, directory, tls.ca, snapshotPath, tlsPort);
  assert.equal((await within(client.ready, "TLS subprocess initialization timed out")).tlsVerificationDisabled, false);
  const fetchSecure = (url = `https://${hostname}:${tlsPort}/secure`) => client.request({ action: "fetch", url });

  const proxied = await fetchSecure();
  assert.equal(proxied.error, undefined, JSON.stringify(proxied));
  assert.equal(proxied.httpStatus, 200);
  assert.equal(proxied.body, "verified TLS response 1");
  assert.equal(proxied.proxy.http, "proxy");
  assert.equal(proxied.proxy.https, "proxy");
  assert.equal(tunnels.length, 1);
  assert.equal(requests[0].sourcePort, tunnels[0].sourcePort);

  await writeSnapshot(true, false);
  const httpsDirect = await fetchSecure();
  assert.equal(httpsDirect.error, undefined, JSON.stringify(httpsDirect));
  assert.equal(httpsDirect.body, "verified TLS response 2");
  assert.equal(httpsDirect.proxy.mode, "proxy");
  assert.equal(httpsDirect.proxy.http, "proxy");
  assert.equal(httpsDirect.proxy.https, "direct");
  assert.equal(tunnels.length, 1);
  assert.notEqual(requests[1].sourcePort, tunnels[0].sourcePort, "HTTPS must stop using the old tunnel while HTTP stays proxied");

  await writeSnapshot(false, false);
  const allDirect = await fetchSecure();
  assert.equal(allDirect.error, undefined, JSON.stringify(allDirect));
  assert.equal(allDirect.body, "verified TLS response 3");
  assert.equal(allDirect.proxy.mode, "direct");
  assert.equal(allDirect.proxy.http, "direct");
  assert.equal(allDirect.proxy.https, "direct");
  assert.equal(tunnels.length, 1);
  assert.notEqual(requests[2].sourcePort, tunnels[0].sourcePort);
  assert.deepEqual(requests.map((request) => request.url), ["/secure", "/secure", "/secure"]);
  assert.ok(requests.every((request) => request.encrypted));

  const wrongIdentity = await fetchSecure(`https://wrong.${hostname}:${tlsPort}/secure`);
  assert.equal(wrongIdentity.code, "ERR_TLS_CERT_ALTNAME_INVALID", "the trusted CA must not disable hostname verification");
  assert.equal(requests.length, 3, "invalid TLS identity must fail before an HTTP request reaches the target");
  assert.deepEqual(proxyErrors, []);
  assert.equal((await client.request({ action: "close" })).closed, true);
  assert.equal((await within(client.exited, "TLS subprocess did not exit after close")).code, 0, client.logs());
});
