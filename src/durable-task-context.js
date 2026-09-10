import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage();

export function currentDurableTaskContext() {
  return storage.getStore() || null;
}

export function runWithDurableTaskContext(context, operation) {
  if (!context) return operation();
  return storage.run(context, operation);
}

export function throwIfDurableTaskAborted() {
  storage.getStore()?.signal?.throwIfAborted();
}

// fetch keeps this signal through response-body consumption, including SSE reads.
export function durableProviderAbortSignal(timeoutMs) {
  throwIfDurableTaskAborted();
  const context = storage.getStore();
  const taskSignal = context?.signal;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = taskSignal ? AbortSignal.any([taskSignal, timeoutSignal]) : timeoutSignal;
  context?.providerRequestStarted?.();
  return signal;
}

export async function beforeDurableProviderCall(phase, timeoutMs) {
  const context = storage.getStore();
  throwIfDurableTaskAborted();
  try {
    if (typeof context?.beforeProviderCall === "function") {
      await context.beforeProviderCall(phase, timeoutMs);
    }
  } finally {
    // Explicit user control must retain its reason even if ownership was released.
    throwIfDurableTaskAborted();
  }
}

export async function afterDurableProviderCall(phase, progress = undefined) {
  const context = storage.getStore();
  throwIfDurableTaskAborted();
  try {
    if (typeof context?.afterProviderCall === "function") {
      await context.afterProviderCall(phase, progress);
    }
  } finally {
    throwIfDurableTaskAborted();
  }
}

export async function durableTaskHeartbeat(progress, options = {}) {
  const context = storage.getStore();
  if (typeof context?.heartbeat === "function") {
    await context.heartbeat(progress, options);
  }
}
