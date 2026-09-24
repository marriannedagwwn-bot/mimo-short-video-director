import dns from "node:dns";
import fs from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";

// Node's default test discovery also loads .mjs helpers in this directory.
// Only an explicitly configured subprocess may mutate networking or install hooks.
if (process.env.TEST_SYSTEM_PROXY_SNAPSHOT && process.env.TEST_SYSTEM_PROXY_EXIT_REPORT) {
  // The target remains a non-loopback hostname for routing decisions, but every
  // transport in this subprocess can only reach the controlled local fixture.
  const fixtureHostname = "system-proxy-model.invalid";
  const originalLookup = dns.lookup.bind(dns);
  dns.lookup = (hostname, options, callback) => {
    if (hostname !== fixtureHostname) return originalLookup(hostname, options, callback);
    const done = typeof options === "function" ? options : callback;
    queueMicrotask(() => {
      if (typeof options === "object" && options?.all) done(null, [{ address: "127.0.0.1", family: 4 }]);
      else done(null, "127.0.0.1", 4);
    });
  };
  syncBuiltinESMExports();

  const { initializeSystemProxy } = await import("../../src/system-proxy.js");
  const controller = await initializeSystemProxy({
    platform: "darwin",
    readSnapshot: () => fs.readFile(process.env.TEST_SYSTEM_PROXY_SNAPSHOT, "utf8"),
    pollIntervalMs: 20,
    env: process.env
  });

  process.on("message", async (message) => {
    if (message?.type !== "refresh-system-proxy") return;
    try {
      // A timer refresh may already be reading the preceding snapshot. Joining
      // it first, then starting one fresh read, acknowledges the requested file.
      await controller.refresh();
      await controller.refresh();
      process.send?.({ type: "system-proxy-refreshed", requestId: message.requestId, status: controller.status() });
    } catch (error) {
      process.send?.({ type: "system-proxy-refreshed", requestId: message.requestId, error: error.message });
    }
  });
  // This observer must not keep CLI --help or a completed worker alive.
  process.channel?.unref();
  process.on("exit", () => {
    const proxyEnvironment = Object.fromEntries(Object.entries(process.env)
      .filter(([key]) => /^(?:https?|all|no)_proxy$/iu.test(key)));
    writeFileSync(process.env.TEST_SYSTEM_PROXY_EXIT_REPORT, JSON.stringify({ proxyEnvironment, status: controller.status() }));
  });
  process.send?.({ type: "system-proxy-ready", status: controller.status() });
}
