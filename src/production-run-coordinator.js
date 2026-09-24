import { safeIdentifier } from "./production-lineage.js";

// One FIFO lock per production Run. The callback is deliberately not
// re-entrant: callers that already own the lock must only invoke explicit
// *Unlocked store methods with the manifest/task-index handles they loaded.
export class ProductionRunCoordinator {
  constructor() {
    this.runLocks = new Map();
  }

  async withRunLock(projectId, runId, operation) {
    const safeProjectId = safeIdentifier(projectId, "projectId");
    const safeRunId = safeIdentifier(runId, "runId");
    const key = `${safeProjectId}/${safeRunId}`;
    const previous = this.runLocks.get(key) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    this.runLocks.set(key, tail);
    await previous;
    try {
      return await operation({ projectId: safeProjectId, runId: safeRunId });
    } finally {
      release();
      if (this.runLocks.get(key) === tail) this.runLocks.delete(key);
    }
  }
}
