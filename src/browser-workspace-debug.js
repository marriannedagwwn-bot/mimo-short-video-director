// Debug is still optional and non-authoritative. For a browser-owned task its
// files share the Run's lifetime, including stages whose trace is "unbound".
const ASYNC_WRITER_METHODS = new Set(["begin", "recordResponse", "recordResult", "recordAttempt", "finalizeAttempt"]);

export function scopeBrowserWorkspaceDebugWriter(writer, resolveOutputRoot) {
  return new Proxy(writer, {
    get(target, property, receiver) {
      if (!ASYNC_WRITER_METHODS.has(property)) return Reflect.get(target, property, receiver);
      return async (...args) => {
        if (!target.enabled) return null;
        const outputRoot = await resolveOutputRoot(target.outputRoot);
        if (!outputRoot) return null;
        const scoped = outputRoot === target.outputRoot
          ? target : new target.constructor({ ...target, outputRoot });
        return scoped[property](...args);
      };
    }
  });
}

export function scopeBrowserWorkspacePromptCapture(capture, resolveOutputRoot) {
  const originalRun = capture.run.bind(capture);
  capture.run = async (metadata, callback) => {
    if (!capture.enabled) return originalRun(metadata, callback);
    const outputRoot = await resolveOutputRoot(capture.outputRoot);
    if (!outputRoot) return callback();
    if (outputRoot === capture.outputRoot) return originalRun(metadata, callback);
    const scoped = new capture.constructor({ ...capture, outputRoot });
    // wrapFetch is installed once; all per-request captures use its ALS.
    scoped.storage = capture.storage;
    return scoped.run(metadata, callback);
  };
  return capture;
}
