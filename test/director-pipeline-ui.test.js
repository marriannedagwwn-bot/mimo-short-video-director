import test from "node:test";
import assert from "node:assert/strict";
import {
  createDirectorArtifactSynchronizer,
  formatDirectorCompletionStatus,
  nextDirectorArtifactSync
} from "../public/director-pipeline-ui.js";

function directorTask(completedStages, overrides = {}) {
  return {
    taskId: "task-director",
    targetArtifactIds: ["a", "b", "c", "d", "e"],
    progress: { completedStages, totalStages: 5 },
    ...overrides
  };
}

test("completedStages only schedules a Run reload when the count increases", () => {
  const checkpoint = { taskId: "task-director", completedStages: 2 };
  assert.equal(nextDirectorArtifactSync(checkpoint, directorTask(2)), null);
  assert.deepEqual(nextDirectorArtifactSync(checkpoint, directorTask(3)), {
    taskId: "task-director",
    previousCompletedStages: 2,
    completedStages: 3
  });
});

test("each observed completedStages increase reloads once and renders the new range immediately", async () => {
  let reloads = 0;
  const rendered = [];
  let releaseReload;
  const firstReload = new Promise((resolve) => { releaseReload = resolve; });
  const synchronizer = createDirectorArtifactSynchronizer({
    reloadRun: async () => {
      reloads += 1;
      if (reloads === 1) await firstReload;
      return { revision: reloads };
    },
    renderCompletedStages: (target, run) => rendered.push({ ...target, revision: run.revision })
  });

  const sameIncreaseA = synchronizer.sync(directorTask(1));
  const sameIncreaseB = synchronizer.sync(directorTask(1));
  releaseReload();
  assert.equal(await sameIncreaseA, true);
  assert.equal(await sameIncreaseB, false);
  assert.equal(reloads, 1);
  assert.deepEqual(rendered[0], {
    taskId: "task-director",
    previousCompletedStages: 0,
    completedStages: 1,
    revision: 1
  });

  assert.equal(await synchronizer.sync(directorTask(3)), true);
  assert.equal(reloads, 2);
  assert.deepEqual(rendered[1], {
    taskId: "task-director",
    previousCompletedStages: 1,
    completedStages: 3,
    revision: 2
  });
  assert.equal(await synchronizer.sync(directorTask(3)), false);
  assert.equal(reloads, 2);
});

test("a failed Run reload is retried by the next poll without advancing the checkpoint", async () => {
  let attempts = 0;
  const synchronizer = createDirectorArtifactSynchronizer({
    reloadRun: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary fetch failure");
      return {};
    },
    renderCompletedStages: () => {}
  });
  assert.equal(await synchronizer.sync(directorTask(1)), false);
  assert.equal(synchronizer.snapshot().completedStages, 0);
  assert.equal(await synchronizer.sync(directorTask(1)), true);
  assert.equal(attempts, 2);
});

test("reset invalidates an in-flight reload so an abandoned Run cannot render late results", async () => {
  let releaseReload;
  const reloadGate = new Promise((resolve) => { releaseReload = resolve; });
  let renders = 0;
  const synchronizer = createDirectorArtifactSynchronizer({
    reloadRun: async () => {
      await reloadGate;
      return { stale: true };
    },
    renderCompletedStages: () => { renders += 1; }
  });
  const syncing = synchronizer.sync(directorTask(1));
  synchronizer.reset();
  releaseReload();
  assert.equal(await syncing, false);
  assert.equal(renders, 0);
  assert.deepEqual(synchronizer.snapshot(), { taskId: "", completedStages: 0 });
});

test("director completion status distinguishes reused stages from paid model calls", () => {
  const text = formatDirectorCompletionStatus(directorTask(5, {
    childTaskIds: ["visual-guardrails", "variants"],
    usage: { calls: 2 }
  }), " · 本次消耗 58,854 tokens · 约 ¥0.66");
  assert.equal(
    text,
    "AI 导演阶段完成 · 复用 3 个已有阶段 · 本次实际调用 2 次模型 · 本次消耗 58,854 tokens · 约 ¥0.66"
  );
});
