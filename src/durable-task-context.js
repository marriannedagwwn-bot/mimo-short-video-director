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
// 非流式调用传总时长 timeoutMs；流式调用传 null 并用 idleSignal（空闲超时）代替，
// 不设总时长上限（见 stream-idle-timeout.js）。
export function durableProviderAbortSignal(timeoutMs, idleSignal = null) {
  throwIfDurableTaskAborted();
  const context = storage.getStore();
  const signals = [
    context?.signal,
    timeoutMs == null ? null : AbortSignal.timeout(timeoutMs),
    idleSignal
  ].filter(Boolean);
  const signal = signals.length <= 1 ? signals[0] : AbortSignal.any(signals);
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
