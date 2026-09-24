import dns from "node:dns";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";

// An unconfigured helper discovered by node --test must exit without changing
// DNS, proxy routing, or process listeners.
if (process.env.TEST_SYSTEM_PROXY_SNAPSHOT && process.env.TEST_SYSTEM_PROXY_TLS_PORT) {
  const allowedHosts = new Set(["system-proxy-model.invalid", "wrong.system-proxy-model.invalid"]);
  const originalLookup = dns.lookup.bind(dns);
  dns.lookup = (hostname, options, callback) => {
    if (!allowedHosts.has(hostname)) return originalLookup(hostname, options, callback);
    const done = typeof options === "function" ? options : callback;
    queueMicrotask(() => {
      if (typeof options === "object" && options?.all) done(null, [{ address: "127.0.0.1", family: 4 }]);
      else done(null, "127.0.0.1", 4);
    });
  };
  syncBuiltinESMExports();

  // Pure transport fixture: it initializes the actual routing module, without
  // relying on a production CLI hook or disabling certificate verification.
  const { initializeSystemProxy } = await import("../../src/system-proxy.js");
  const controller = await initializeSystemProxy({
    platform: "darwin", pollIntervalMs: 0,
    readSnapshot: () => fs.readFile(process.env.TEST_SYSTEM_PROXY_SNAPSHOT, "utf8")
  });
  process.on("message", async (message) => {
    try {
      if (message.action === "close") {
        await controller.close();
        process.send({ id: message.id, closed: true });
        process.disconnect();
        return;
      }
      const url = new URL(message.url);
      if (url.protocol !== "https:" || !allowedHosts.has(url.hostname)
        || url.port !== process.env.TEST_SYSTEM_PROXY_TLS_PORT) throw new Error("Uncontrolled fixture URL rejected");
      await controller.refresh();
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      process.send({ id: message.id, httpStatus: response.status, body: await response.text(), proxy: controller.status() });
    } catch (error) {
      process.send({ id: message.id, error: error.message, code: error.cause?.code || error.code });
    }
  });
  process.on("disconnect", () => { void controller.close(); });
  process.send({ ready: true, tlsVerificationDisabled: process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0" });
}
