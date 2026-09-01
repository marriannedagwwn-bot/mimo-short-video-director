import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage();

export function runWithDurableTaskContext(context, operation) {
  if (!context) return operation();
  return storage.run(context, operation);
}

export async function beforeDurableProviderCall(phase, timeoutMs) {
  const context = storage.getStore();
  if (typeof context?.beforeProviderCall === "function") {
    await context.beforeProviderCall(phase, timeoutMs);
  }
}

export async function afterDurableProviderCall(phase, progress = undefined) {
  const context = storage.getStore();
  if (typeof context?.afterProviderCall === "function") {
    await context.afterProviderCall(phase, progress);
  }
}

export async function durableTaskHeartbeat(progress, options = {}) {
  const context = storage.getStore();
  if (typeof context?.heartbeat === "function") {
    await context.heartbeat(progress, options);
  }
}
