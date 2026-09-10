import test from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { connect } from "node:net";
import { initializeSystemProxy, parseScutilProxySnapshot, readSystemProxyError } from "../src/system-proxy.js";
import { getGlobalDispatcher } from "undici";

const DIRECT = "<dictionary> {\n HTTPEnable : 0\n HTTPSEnable : 0\n SOCKSEnable : 0\n}";
const logger = { error() {} };
const proxySnapshot = (port, extra = {}) => ({ HTTPEnable: 1, HTTPProxy: "127.0.0.1", HTTPPort: port, HTTPSEnable: 1, HTTPSProxy: "127.0.0.1", HTTPSPort: port, ...extra });

function mapDNS(t) {
  const original = dns.lookup;
  dns.lookup = function lookup(host, options, callback) {
    if (typeof options === "function") { callback = options; options = {}; }
    if (host.endsWith(".test") || host === "intranet") {
      queueMicrotask(() => options?.all ? callback(null, [{ address: "127.0.0.1", family: 4 }]) : callback(null, "127.0.0.1", 4));
      return;
    }
    return original.call(dns, host, options, callback);
  };
  t.after(() => { dns.lookup = original; });
}

async function localServer(t, handler) {
  const server = http.createServer(handler);
  const sockets = new Set();
  server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { for (const socket of sockets) socket.destroy(); server.close(resolve); }));
  return { server, port: server.address().port, url: `http://provider.test:${server.address().port}` };
}

async function localProxy(t) {
  const hits = [];
  const proxy = await localServer(t, (request, response) => { response.writeHead(500); response.end("CONNECT required"); });
  proxy.server.on("connect", (request, socket, head) => {
    hits.push(request.url);
    const target = new URL(`http://${request.url}`);
    const upstream = connect({ host: "127.0.0.1", port: Number(target.port) }, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
  });
  return { ...proxy, hits };
}

async function controllerFor(t, readSnapshot, options = {}) {
  const controller = await initializeSystemProxy({ platform: "darwin", readSnapshot, pollIntervalMs: 0, env: {}, logger, ...options });
  t.after(() => controller.close());
  return controller;
}

function nativeGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (data) => { body += data; });
      response.on("end", () => resolve(body));
      response.on("error", reject);
    }).on("error", reject);
  });
}

test("scutil parsing keeps root proxy state separate from nested scoped state and preserves IPv6", () => {
  const snapshot = parseScutilProxySnapshot(`<dictionary> {
  HTTPEnable : 0
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
    2 : ::1
  }
  __SCOPED__ : <dictionary> {
    en0 : <dictionary> {
      HTTPEnable : 1
      HTTPProxy : ::1
    }
  }
}`);
  assert.equal(snapshot.HTTPEnable, "0");
  assert.deepEqual(snapshot.ExceptionsList, ["*.local", "169.254/16", "::1"]);
  assert.equal(snapshot.__SCOPED__.en0.HTTPProxy, "::1");
  for (const value of ["", "no proxies", "<dictionary> {\nHTTPEnable : 1", "<dictionary> {\nHTTPEnable : 1\nHTTPEnable : 0\n}", "<dictionary> {\n}\ntrailing"]) {
    assert.throws(() => parseScutilProxySnapshot(value), { code: "SYSTEM_PROXY_CONFIG_INVALID" });
  }
});

test("proxy error reader only returns static safe messages through a bounded cause chain", () => {
  const error = { code: "SYSTEM_PROXY_READ_FAILED", message: "secret in message" };
  assert.deepEqual(readSystemProxyError({ cause: error }), { code: "SYSTEM_PROXY_READ_FAILED", message: "无法读取 macOS 系统代理设置，已阻止外部请求，请检查系统网络设置。" });
  assert.equal(readSystemProxyError({ code: "UNKNOWN", message: "secret" }), null);
  let deep = error;
  for (let i = 0; i < 8; i += 1) deep = { cause: deep };
  assert.equal(readSystemProxyError(deep), null);
  const cyclic = {}; cyclic.cause = cyclic;
  assert.equal(readSystemProxyError(cyclic), null);
});

test("initialization clears inherited stale proxy variables, awaits snapshot and reuses one controller", { timeout: 5_000 }, async (t) => {
  const env = Object.fromEntries(["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"].map((key) => [key, "http://stale.invalid:7892"]));
  env.PRESERVED = "yes";
  const gate = Promise.withResolvers();
  let reads = 0;
  const dispatcherBefore = getGlobalDispatcher();
  const pending = initializeSystemProxy({ platform: "darwin", readSnapshot: () => { reads += 1; return gate.promise; }, pollIntervalMs: 0, env, logger });
  const duplicate = initializeSystemProxy({ readSnapshot: () => { throw new Error("duplicate initializer must not run"); } });
  let finished = false;
  void pending.then(() => { finished = true; });
  await Promise.resolve();
  assert.equal(finished, false);
  assert.deepEqual(env, { PRESERVED: "yes" });
  gate.resolve(DIRECT);
  const controller = await pending;
  t.after(() => controller.close());
  assert.equal(await duplicate, controller);
  assert.equal(reads, 1);
  assert.notEqual(getGlobalDispatcher(), dispatcherBefore);
  await controller.close();
  assert.equal(getGlobalDispatcher(), dispatcherBefore);
});

test("real fetch CONNECT follows direct → proxy A → proxy B → off without restarting", { timeout: 5_000 }, async (t) => {
  mapDNS(t);
  const origin = await localServer(t, (_request, response) => response.end("ok"));
  const first = await localProxy(t);
  const second = await localProxy(t);
  let snapshot = DIRECT;
  const controller = await controllerFor(t, () => snapshot);
  const dispatcher = getGlobalDispatcher();
  assert.equal(await (await fetch(origin.url)).text(), "ok");
  assert.equal(first.hits.length, 0);
  snapshot = proxySnapshot(first.port);
  await controller.refresh();
  assert.equal(await (await fetch(origin.url)).text(), "ok");
  assert.equal(first.hits.length, 1);
  snapshot = proxySnapshot(second.port);
  await controller.refresh();
  assert.equal(await (await fetch(origin.url)).text(), "ok");
  assert.equal(second.hits.length, 1);
  snapshot = DIRECT;
  await controller.refresh();
  assert.equal(await (await fetch(origin.url)).text(), "ok");
  assert.equal(first.hits.length, 1);
  assert.equal(second.hits.length, 1);
  assert.equal(getGlobalDispatcher(), dispatcher);
  assert.equal(controller.status().mode, "direct");
});

test("retiring proxy preserves an active body, and next request uses the new policy", { timeout: 5_000 }, async (t) => {
  mapDNS(t);
  let response;
  const origin = await localServer(t, (request, res) => {
    if (request.url === "/slow") { response = res; res.write("first-"); }
    else res.end("new");
  });
  const proxy = await localProxy(t);
  let snapshot = proxySnapshot(proxy.port);
  const controller = await controllerFor(t, () => snapshot);
  const pending = await fetch(`${origin.url}/slow`);
  const body = pending.text();
  snapshot = DIRECT;
  await controller.refresh();
  assert.equal(response.destroyed, false);
  assert.equal(await (await fetch(`${origin.url}/new`)).text(), "new");
  response.end("last");
  assert.equal(await body, "first-last");
  assert.equal(proxy.hits.length, 1);
});

test("abort still closes the active proxied response after the proxy changes", { timeout: 5_000 }, async (t) => {
  mapDNS(t);
  const disconnected = Promise.withResolvers();
  const origin = await localServer(t, (_request, response) => { response.write("partial"); response.once("close", () => disconnected.resolve()); });
  const proxy = await localProxy(t);
  let snapshot = proxySnapshot(proxy.port);
  const controller = await controllerFor(t, () => snapshot);
  const abort = new AbortController();
  const response = await fetch(origin.url, { signal: abort.signal });
  const body = response.text();
  const rejected = assert.rejects(body, { name: "AbortError" });
  snapshot = DIRECT;
  await controller.refresh();
  abort.abort();
  await rejected;
  await disconnected.promise;
});

test("localhost and loopback bypass proxy and blocked policy before all other rules", { timeout: 5_000 }, async (t) => {
  const origin = await localServer(t, (_request, response) => response.end("local"));
  const proxy = await localProxy(t);
  let snapshot = proxySnapshot(proxy.port);
  const controller = await controllerFor(t, () => snapshot);
  assert.equal(await (await fetch(`http://127.0.0.1:${origin.port}`)).text(), "local");
  assert.equal(await (await fetch(`http://localhost:${origin.port}`)).text(), "local");
  snapshot = { ProxyAutoConfigEnable: 1, ProxyAutoConfigURLString: "https://user:secret@pac.invalid/private" };
  await controller.refresh();
  assert.equal(await (await fetch(`http://127.0.0.1:${origin.port}`)).text(), "local");
  assert.equal(proxy.hits.length, 0);
});

test("system hostname, wildcard, IP/CIDR and simple-host exceptions select direct routes", { timeout: 5_000 }, async (t) => {
  mapDNS(t);
  const origin = await localServer(t, (_request, response) => response.end("ok"));
  const proxy = await localProxy(t);
  await controllerFor(t, () => proxySnapshot(proxy.port, { ExceptionsList: ["*.bypass.test", "exact.test", "169.254/16", "10.0.0.0/8", "2001:db8::/32", "192.168.2.4", "2001:0DB9:0:0:0:0:0:1"], ExcludeSimpleHostnames: 1 }));
  for (const host of ["nested.bypass.test", "exact.test", "intranet"]) assert.equal(await (await fetch(`http://${host}:${origin.port}`)).text(), "ok");
  assert.equal(proxy.hits.length, 0);
  assert.equal(await (await fetch(`http://external.test:${origin.port}`)).text(), "ok");
  assert.equal(proxy.hits.length, 1);
  // Observe actual route selection for numeric destinations without requiring
  // those addresses to be bound to a local interface.
  const directDispatch = getGlobalDispatcher().select(new URL("http://169.254.2.3"));
  for (const host of ["10.2.3.4", "192.168.2.4", "[2001:db8::1]", "[2001:db9::1]", "127.4.3.2", "[::1]", "[::ffff:127.0.0.1]"]) {
    assert.equal(getGlobalDispatcher().select(new URL(`http://${host}`)), directDispatch);
  }
  assert.notEqual(getGlobalDispatcher().select(new URL("http://192.168.2.5")), directDispatch);
});

test("HTTP and HTTPS switches remain independent; uncovered SOCKS routes fail closed", async (t) => {
  const controller = await controllerFor(t, () => ({ HTTPEnable: 1, HTTPProxy: "127.0.0.1", HTTPPort: 18888, HTTPSEnable: 0 }));
  const router = getGlobalDispatcher();
  assert.notEqual(router.select(new URL("http://provider.test")), router.select(new URL("https://provider.test")));
  assert.equal(controller.status().https, "direct");
  await controller.close();
  const socks = await controllerFor(t, () => ({ HTTPEnable: 1, HTTPProxy: "127.0.0.1", HTTPPort: 18888, SOCKSEnable: 1, SOCKSProxy: "127.0.0.1", SOCKSPort: 18889 }));
  assert.equal(socks.status().http, "proxy");
  assert.equal(socks.status().https, "socks");
  assert.equal(socks.status().error.code, "SYSTEM_PROXY_SOCKS_UNSUPPORTED");
  await assert.rejects(fetch("https://provider.test"), (error) => error.cause?.code === "SYSTEM_PROXY_SOCKS_UNSUPPORTED");
  assert.equal(getGlobalDispatcher().select(new URL("http://provider.test")).constructor.name, "ProxyAgent");
  await socks.close();
  const covered = await controllerFor(t, () => proxySnapshot(18888, { SOCKSEnable: 1 }));
  assert.equal(covered.status().http, "proxy");
  assert.equal(covered.status().https, "proxy");
  assert.equal(covered.status().error, null);
});

test("read errors, malformed configuration, PAC and WPAD block external requests without logging secrets", { timeout: 5_000 }, async (t) => {
  const logs = [];
  let snapshot = DIRECT;
  const controller = await controllerFor(t, () => { if (snapshot instanceof Error) throw snapshot; return snapshot; }, { logger: { error: (line) => logs.push(line) } });
  for (const [value, code] of [
    [new Error("user:secret@proxy.invalid token=hidden"), "SYSTEM_PROXY_READ_FAILED"],
    [{ HTTPEnable: 1, HTTPProxy: "user:secret@proxy.invalid", HTTPPort: 1 }, "SYSTEM_PROXY_CONFIG_INVALID"],
    [{ HTTPEnable: 1, HTTPProxy: "localhost", HTTPPort: "oops" }, "SYSTEM_PROXY_CONFIG_INVALID"],
    [{ HTTPEnable: 1, HTTPProxy: "localhost\\path", HTTPPort: 7892 }, "SYSTEM_PROXY_CONFIG_INVALID"],
    [{ HTTPEnable: "maybe" }, "SYSTEM_PROXY_CONFIG_INVALID"],
    [{ ExceptionsList: ["10.0.0.0/99"] }, "SYSTEM_PROXY_CONFIG_INVALID"],
    [{ ProxyAutoConfigEnable: 1, ProxyAutoConfigURLString: "https://user:secret@pac.invalid" }, "SYSTEM_PROXY_AUTOMATIC_UNSUPPORTED"],
    [{ ProxyAutoDiscoveryEnable: 1 }, "SYSTEM_PROXY_AUTOMATIC_UNSUPPORTED"]
  ]) {
    snapshot = value;
    await controller.refresh();
    assert.equal(controller.status().mode, "blocked");
    assert.equal(controller.status().error.code, code);
    await assert.rejects(fetch("http://never-contact-this.invalid"), (error) => error.cause?.code === code);
  }
  assert.doesNotMatch(JSON.stringify(logs), /secret|hidden|proxy\.invalid|pac\.invalid/);
  snapshot = DIRECT;
  await controller.refresh();
  assert.equal(controller.status().mode, "direct");
});

test("refresh and polling never overlap snapshot reads and recover after a failed read", { timeout: 5_000 }, async (t) => {
  let reads = 0;
  let gate;
  const controller = await controllerFor(t, async () => { reads += 1; if (gate) await gate.promise; return DIRECT; }, { pollIntervalMs: 10 });
  gate = Promise.withResolvers();
  const first = controller.refresh();
  const second = controller.refresh();
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(reads, 2);
  gate.resolve();
  gate = null;
  await Promise.all([first, second]);
  await controller.close();
  const afterClose = reads;
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(reads, afterClose);
});

test("a snapshot returning after close cannot reinstall global dispatchers", async (t) => {
  const original = getGlobalDispatcher();
  let gate;
  const controller = await controllerFor(t, () => gate ? gate.promise : DIRECT);
  gate = Promise.withResolvers();
  const pending = controller.refresh();
  await controller.close();
  gate.resolve(proxySnapshot(18888));
  await pending;
  assert.equal(getGlobalDispatcher(), original);
  assert.equal(controller.status().mode, "closed");
});

test("native HTTP has a clean direct baseline and rejects unsupported proxy routes", { timeout: 5_000 }, async (t) => {
  mapDNS(t);
  const origin = await localServer(t, (_request, response) => response.end("native"));
  const proxy = await localProxy(t);
  let snapshot = DIRECT;
  const controller = await controllerFor(t, () => snapshot);
  assert.equal(await nativeGet(origin.url), "native");
  snapshot = proxySnapshot(proxy.port);
  await controller.refresh();
  await assert.rejects(nativeGet(origin.url), { code: "SYSTEM_PROXY_NATIVE_UNSUPPORTED" });
  await assert.rejects(new Promise((resolve, reject) => https.get("https://provider.test/", resolve).on("error", reject)), { code: "SYSTEM_PROXY_NATIVE_UNSUPPORTED" });
  assert.equal(await nativeGet(`http://127.0.0.1:${origin.port}`), "native");
  assert.equal(proxy.hits.length, 0);
  snapshot = DIRECT;
  await controller.refresh();
  assert.equal(await nativeGet(origin.url), "native");
  assert.equal(proxy.hits.length, 0);
});

test("non-macOS keeps explicit environment proxy path and never reads macOS settings", { timeout: 5_000 }, async (t) => {
  mapDNS(t);
  const origin = await localServer(t, (_request, response) => response.end("environment"));
  const proxy = await localProxy(t);
  // Default EnvHttpProxyAgent uses forwarding for an HTTP endpoint.
  proxy.server.removeAllListeners("request");
  proxy.server.on("request", (_request, response) => { proxy.hits.push("forward"); response.end("environment"); });
  const env = { HTTP_PROXY: `http://127.0.0.1:${proxy.port}`, NO_PROXY: "localhost" };
  const copy = { ...env };
  const controller = await initializeSystemProxy({ platform: "linux", env, readSnapshot: () => { throw new Error("must not read macOS"); }, logger });
  t.after(() => controller.close());
  assert.equal(await (await fetch(origin.url)).text(), "environment");
  assert.equal(proxy.hits.length, 1);
  assert.deepEqual(env, copy);
  assert.equal(controller.status().mode, "environment");
  assert.equal((await controller.refresh()).mode, "environment");
});
