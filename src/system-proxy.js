import { execFile } from "node:child_process";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import { promisify } from "node:util";
import { Agent, Dispatcher, EnvHttpProxyAgent, ProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";

const execFileAsync = promisify(execFile);
const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"];
const LOOPBACK = new BlockList();
LOOPBACK.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK.addAddress("::1", "ipv6");
let initialization;
let activeController;

const SAFE_ERRORS = {
  SYSTEM_PROXY_CONFIG_INVALID: "macOS 系统代理配置无效，已阻止外部请求，请检查系统代理设置。",
  SYSTEM_PROXY_READ_FAILED: "无法读取 macOS 系统代理设置，已阻止外部请求，请检查系统网络设置。",
  SYSTEM_PROXY_AUTOMATIC_UNSUPPORTED: "当前启用了 PAC 或自动代理发现，暂不支持此模式，已阻止外部请求。请改用系统 HTTP/HTTPS 代理。",
  SYSTEM_PROXY_NOT_READY: "系统代理设置尚未就绪，已阻止外部请求。",
  SYSTEM_PROXY_SOCKS_UNSUPPORTED: "当前目标需要 SOCKS 系统代理，暂不支持此模式，已阻止外部请求。请启用系统 HTTP/HTTPS 代理。",
  SYSTEM_PROXY_NATIVE_UNSUPPORTED: "当前原生 HTTP 请求需要系统代理，暂不支持此路径，已阻止外部请求。请使用 fetch。"
};

function proxyError(code) {
  return Object.assign(new Error(SAFE_ERRORS[code]), { code });
}

export function readSystemProxyError(error) {
  let current = error;
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth += 1) {
    if (Object.hasOwn(SAFE_ERRORS, current.code)) return { code: current.code, message: SAFE_ERRORS[current.code] };
    current = current.cause;
  }
  return null;
}

function invalidConfig() {
  return proxyError("SYSTEM_PROXY_CONFIG_INVALID");
}

// scutil prints nested dictionaries for scoped settings. Parse the structure so
// a nested HTTPEnable cannot accidentally override the effective root setting.
export function parseScutilProxySnapshot(text) {
  const lines = String(text).trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let index = 0;
  function readContainer(kind) {
    const output = kind === "array" ? [] : Object.create(null);
    while (index < lines.length) {
      const line = lines[index++];
      if (line === "}") return output;
      const match = /^(.+?)\s+:\s+(.*)$/.exec(line);
      if (!match) throw invalidConfig();
      const [, key, raw] = match;
      const container = /^<(dictionary|array)>\s+\{$/.exec(raw);
      const value = container ? readContainer(container[1]) : raw;
      if (Array.isArray(output)) {
        if (!/^\d+$/.test(key) || Number(key) !== output.length) throw invalidConfig();
        output.push(value);
      } else {
        if (Object.hasOwn(output, key)) throw invalidConfig();
        output[key] = value;
      }
    }
    throw invalidConfig();
  }
  if (lines[index++] !== "<dictionary> {") throw invalidConfig();
  const snapshot = readContainer("dictionary");
  if (index !== lines.length) throw invalidConfig();
  return snapshot;
}

async function readMacOSProxySnapshot() {
  try {
    const { stdout } = await execFileAsync("/usr/sbin/scutil", ["--proxy"], { timeout: 1_500, maxBuffer: 256 * 1024, encoding: "utf8" });
    return parseScutilProxySnapshot(stdout);
  } catch (error) {
    if (error?.code === "SYSTEM_PROXY_CONFIG_INVALID") throw error;
    // Command stderr and output may contain proxy URLs or credentials.
    throw proxyError("SYSTEM_PROXY_READ_FAILED");
  }
}

function enabled(snapshot, key) {
  const value = snapshot[key];
  if (value === undefined || value === 0 || value === "0" || value === false) return false;
  if (value === 1 || value === "1" || value === true) return true;
  throw invalidConfig();
}

function hostname(value) {
  return String(value).toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function isLoopback(host) {
  const family = isIP(host);
  return host === "localhost" || host.endsWith(".localhost") || Boolean(family && LOOPBACK.check(host, family === 6 ? "ipv6" : "ipv4"));
}

function proxyEndpoint(snapshot, prefix, protocol) {
  if (!enabled(snapshot, `${prefix}Enable`)) return null;
  const host = String(snapshot[`${prefix}Proxy`] ?? "").trim();
  const rawPort = snapshot[`${prefix}Port`];
  const port = Number(rawPort);
  if (!host || /[\s/@?#\\]/.test(host) || !/^\d+$/.test(String(rawPort)) || !Number.isInteger(port) || port < 1 || port > 65535) throw invalidConfig();
  const bareHost = hostname(host);
  if (bareHost.includes(":") && isIP(bareHost) !== 6) throw invalidConfig();
  try {
    const url = new URL(`${protocol}://${isIP(bareHost) === 6 ? `[${bareHost}]` : bareHost}:${port}`);
    if (!url.hostname || url.username || url.password) throw invalidConfig();
    return { kind: protocol === "socks5" ? "socks" : "proxy", url: url.href };
  } catch {
    throw invalidConfig();
  }
}

function exceptionMatcher(value) {
  if (typeof value !== "string" || !value.trim()) throw invalidConfig();
  const rule = hostname(value.trim());
  if (rule.includes("/")) {
    const parts = rule.split("/");
    if (parts.length !== 2 || !/^\d+$/.test(parts[1])) throw invalidConfig();
    let network = parts[0];
    // macOS itself commonly emits the abbreviated IPv4 subnet 169.254/16.
    if (/^\d+(?:\.\d+){0,2}$/.test(network)) network = network.split(".").concat(Array(4 - network.split(".").length).fill("0")).join(".");
    const family = isIP(network);
    const prefix = Number(parts[1]);
    if (!family || prefix > (family === 6 ? 128 : 32)) throw invalidConfig();
    const blockList = new BlockList();
    try { blockList.addSubnet(network, prefix, family === 6 ? "ipv6" : "ipv4"); } catch { throw invalidConfig(); }
    return (host) => Boolean(isIP(host) && blockList.check(host, isIP(host) === 6 ? "ipv6" : "ipv4"));
  }
  if (/[\s/@?#]/.test(rule)) throw invalidConfig();
  if (isIP(rule)) {
    const blockList = new BlockList();
    blockList.addAddress(rule, isIP(rule) === 6 ? "ipv6" : "ipv4");
    return (host) => Boolean(isIP(host) && blockList.check(host, isIP(host) === 6 ? "ipv6" : "ipv4"));
  }
  const pattern = new RegExp(`^${rule.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i");
  return (host) => pattern.test(host);
}

function compilePolicy(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw invalidConfig();
  if (enabled(snapshot, "ProxyAutoConfigEnable") || enabled(snapshot, "ProxyAutoDiscoveryEnable")) {
    throw proxyError("SYSTEM_PROXY_AUTOMATIC_UNSUPPORTED");
  }
  const httpProxy = proxyEndpoint(snapshot, "HTTP", "http");
  const httpsProxy = proxyEndpoint(snapshot, "HTTPS", "http");
  const socksProxy = !httpProxy || !httpsProxy ? proxyEndpoint(snapshot, "SOCKS", "socks5") : null;
  if (snapshot.ExceptionsList !== undefined && !Array.isArray(snapshot.ExceptionsList)) throw invalidConfig();
  const exceptions = (snapshot.ExceptionsList || []).map(exceptionMatcher);
  const excludeSimple = enabled(snapshot, "ExcludeSimpleHostnames");
  const routes = { "http:": httpProxy || socksProxy, "https:": httpsProxy || socksProxy };
  return {
    routes,
    bypass: (host) => (excludeSimple && !host.includes(".") && !isIP(host)) || exceptions.some((match) => match(host)),
    mode: httpProxy || httpsProxy || socksProxy ? "proxy" : "direct",
    error: null
  };
}

class RoutingDispatcher extends Dispatcher {
  constructor(select) { super(); this.select = select; }
  dispatch(options, handler) {
    try { return this.select(new URL(options.origin)).dispatch(options, handler); }
    catch (error) { queueMicrotask(() => handler.onError(error)); return false; }
  }
}

function nativeRouter(BaseAgent, select, protocol) {
  const router = new BaseAgent({ keepAlive: true, timeout: 5_000 });
  router.addRequest = (request, options) => {
    try {
      const host = hostname(options.hostname || options.host || "localhost");
      const port = options.port || (protocol === "https:" ? 443 : 80);
      select(new URL(`${protocol}//${isIP(host) === 6 ? `[${host}]` : host}:${port}`)).addRequest(request, options);
    } catch (error) {
      // ClientRequest is still waiting for its Agent to assign a socket. Report
      // the failure through Agent's supported connection callback so error and
      // close events settle even when no socket has ever been created.
      const rejected = new BaseAgent();
      rejected.createConnection = (_options, callback) => { queueMicrotask(() => callback(error)); };
      request.once("close", () => rejected.destroy());
      rejected.addRequest(request, options);
    }
  };
  return router;
}

function closeNativeAgent(agent) {
  return new Promise((resolve) => {
    function finish() {
      if (Object.values(agent.sockets).some((sockets) => sockets.length) || Object.values(agent.requests).some((requests) => requests.length)) return false;
      agent.destroy();
      resolve();
      return true;
    }
    if (finish()) return;
    const timer = setInterval(() => { if (finish()) clearInterval(timer); }, 25);
    timer.unref();
  });
}

export async function initializeSystemProxy(options = {}) {
  if (!initialization) {
    initialization = createSystemProxy(options).then((controller) => { activeController = controller; return controller; }).catch((error) => { initialization = undefined; throw error; });
  }
  return initialization;
}

async function createSystemProxy({ platform = process.platform, readSnapshot = readMacOSProxySnapshot, pollIntervalMs = 2_000, env = process.env, logger = console } = {}) {
  const original = { dispatcher: getGlobalDispatcher(), http: http.globalAgent, https: https.globalAgent };
  const directAgent = new Agent();
  const directNative = { "http:": new http.Agent({ keepAlive: true, timeout: 5_000 }), "https:": new https.Agent({ keepAlive: true, timeout: 5_000 }) };
  const proxies = new Map();
  const closing = new Set();
  let policy = { routes: {}, bypass: () => false, mode: "blocked", error: proxyError("SYSTEM_PROXY_NOT_READY") };
  let timer;
  let refreshPromise;
  let closePromise;
  let closed = false;
  let checkedAt = null;
  let lastLoggedError;
  let environmentAgent;

  function retire(promise) {
    const tracked = Promise.resolve(promise).catch(() => {}).finally(() => closing.delete(tracked));
    closing.add(tracked);
  }
  function routeFor(url) {
    const host = hostname(url.hostname);
    if (isLoopback(host)) return null;
    if (policy.error) throw policy.error;
    if (policy.bypass(host)) return null;
    return policy.routes[url.protocol] || null;
  }
  function select(url) {
    if (environmentAgent) return environmentAgent;
    const route = routeFor(url);
    if (!route) return directAgent;
    if (route.kind === "socks") throw proxyError("SYSTEM_PROXY_SOCKS_UNSUPPORTED");
    if (!proxies.has(route.url)) proxies.set(route.url, new ProxyAgent({ uri: route.url, proxyTunnel: true }));
    return proxies.get(route.url);
  }
  function selectNative(url) {
    if (platform !== "darwin") return directNative[url.protocol];
    const route = routeFor(url);
    if (!route) return directNative[url.protocol];
    if (route.kind === "socks") throw proxyError("SYSTEM_PROXY_SOCKS_UNSUPPORTED");
    throw proxyError("SYSTEM_PROXY_NATIVE_UNSUPPORTED");
  }
  const dispatcher = new RoutingDispatcher(select);
  const httpRouter = nativeRouter(http.Agent, selectNative, "http:");
  const httpsRouter = nativeRouter(https.Agent, selectNative, "https:");

  async function refresh() {
    if (closed) return controller.status();
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      let next;
      try {
        const snapshot = await readSnapshot();
        next = compilePolicy(typeof snapshot === "string" ? parseScutilProxySnapshot(snapshot) : snapshot);
      } catch (error) {
        const safeError = proxyError(["SYSTEM_PROXY_CONFIG_INVALID", "SYSTEM_PROXY_AUTOMATIC_UNSUPPORTED"].includes(error?.code) ? error.code : "SYSTEM_PROXY_READ_FAILED");
        next = { routes: {}, bypass: () => false, mode: "blocked", error: safeError };
      }
      if (closed) return controller.status();
      policy = next;
      checkedAt = new Date().toISOString();
      if (policy.error?.code !== lastLoggedError) {
        lastLoggedError = policy.error?.code;
        if (policy.error) logger?.error?.(`[system-proxy] ${policy.error.code}: ${policy.error.message}`);
      }
      const urls = new Set(Object.values(policy.routes).filter(Boolean).map((route) => route.url));
      for (const [key, agent] of proxies) if (!urls.has(key)) { proxies.delete(key); retire(agent.close()); }
      return controller.status();
    })().finally(() => { refreshPromise = undefined; });
    return refreshPromise;
  }

  const controller = {
    refresh,
    status: () => ({
      platform,
      mode: closed ? "closed" : policy.mode,
      http: policy.error ? "blocked" : policy.routes["http:"]?.kind || "direct",
      https: policy.error ? "blocked" : policy.routes["https:"]?.kind || "direct",
      checkedAt,
      error: readSystemProxyError(policy.error) || (Object.values(policy.routes).some((route) => route?.kind === "socks") ? readSystemProxyError(proxyError("SYSTEM_PROXY_SOCKS_UNSUPPORTED")) : null)
    }),
    async close() {
      if (closed) return closePromise;
      closed = true;
      clearInterval(timer);
      if (getGlobalDispatcher() === dispatcher) setGlobalDispatcher(original.dispatcher);
      if (http.globalAgent === httpRouter) http.globalAgent = original.http;
      if (https.globalAgent === httpsRouter) https.globalAgent = original.https;
      if (activeController === controller) { activeController = undefined; initialization = undefined; }
      for (const agent of proxies.values()) retire(agent.close());
      retire(directAgent.close());
      if (environmentAgent) retire(environmentAgent.close());
      for (const agent of Object.values(directNative)) retire(closeNativeAgent(agent));
      httpRouter.destroy();
      httpsRouter.destroy();
      closePromise = Promise.all([...closing]);
      await closePromise;
    }
  };

  if (platform === "darwin") {
    for (const key of PROXY_ENV_KEYS) delete env[key];
    await refresh();
    if (pollIntervalMs > 0) { timer = setInterval(() => { void refresh(); }, pollIntervalMs); timer.unref(); }
  } else {
    environmentAgent = new EnvHttpProxyAgent({ httpProxy: env.http_proxy || env.HTTP_PROXY || "", httpsProxy: env.https_proxy || env.HTTPS_PROXY || "", noProxy: env.no_proxy || env.NO_PROXY || "" });
    for (const [protocol, BaseAgent] of [["http:", http.Agent], ["https:", https.Agent]]) {
      directNative[protocol].destroy();
      directNative[protocol] = new BaseAgent({ keepAlive: true, timeout: 5_000, proxyEnv: env });
    }
    policy = { routes: {}, bypass: () => false, mode: "environment", error: null };
    checkedAt = new Date().toISOString();
    controller.refresh = async () => controller.status();
  }
  setGlobalDispatcher(dispatcher);
  http.globalAgent = httpRouter;
  https.globalAgent = httpsRouter;
  return controller;
}
