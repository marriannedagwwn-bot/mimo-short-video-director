import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProductionStateStore } from "../src/production-state-store.js";
import { lineageRef } from "../src/production-lineage.js";

// 镜头视频「之前生成的版本」（2026-10-24）用到的两个通用方法：列出一组 Artifact 的全部修订，
// 以及把旧修订原样重新签发成当前版本（依赖必须仍是当前有效版本、期望版本要对得上）。

async function withRun(operation) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "mimo-shot-video-history-"));
  let nextId = 0;
  const store = new ProductionStateStore({ rootDir, idFactory: () => `id-${++nextId}` });
  try {
    const run = await store.createRun({ projectId: "project-history" });
    let request = 0;
    const commit = (input) => store.commitArtifact({
      projectId: run.projectId, runId: run.runId, requestId: `request-${++request}`, dependencies: [], ...input
    });
    await operation({ store, run, commit });
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
}

const video = (name, extra = {}) => ({ status: "ready", selectedIndex: 0, result: { videos: [{ outputUrl: `/v/${name}.mp4` }], ...extra } });

async function seed(commit) {
  const plan = await commit({ artifactId: "animationPlan:V2", artifactType: "animationPlan", content: { plan: 1 } });
  const planRef = lineageRef(plan.lineage);
  const a01r1 = await commit({ artifactId: "shotVideo:V2:A01", artifactType: "shotVideo", content: video("a01-minimax"), dependencies: [planRef], expectedCurrentRevision: null });
  const a01r2 = await commit({ artifactId: "shotVideo:V2:A01", artifactType: "shotVideo", content: video("a01-seedance"), dependencies: [planRef], expectedCurrentRevision: a01r1.lineage.revision });
  // A02 第一版接的是 A01 第一条的抽帧；第二版接的是 A01 第二条。
  const a02r1 = await commit({ artifactId: "shotVideo:V2:A02", artifactType: "shotVideo", content: video("a02-old"), dependencies: [planRef, lineageRef(a01r2.lineage)], expectedCurrentRevision: null });
  const a02r2 = await commit({ artifactId: "shotVideo:V2:A02", artifactType: "shotVideo", content: video("a02-new"), dependencies: [planRef, lineageRef(a01r2.lineage)], expectedCurrentRevision: a02r1.lineage.revision });
  return { planRef, a01r1, a01r2, a02r1, a02r2 };
}

test("列出全部修订：旧版说明能不能换回，当前版给出会被作废的下游", async () => {
  await withRun(async ({ store, run, commit }) => {
    const { a01r1, a01r2, a02r1 } = await seed(commit);
    const revisions = await store.listArtifactRevisions({ projectId: run.projectId, runId: run.runId, artifactIdPrefix: "shotVideo:V2:" });
    const byRevision = Object.fromEntries(revisions.map((entry) => [entry.lineage.revision, entry]));
    assert.equal(revisions.length, 4);
    assert.equal(byRevision[a01r1.lineage.revision].latest, false);
    assert.equal(byRevision[a01r1.lineage.revision].restoreBlocker, null, "依赖的分镜还是当前版本，可以换回");
    assert.deepEqual(byRevision[a01r1.lineage.revision].content, video("a01-minimax"), "内容从 Run 读出");
    assert.equal(byRevision[a01r2.lineage.revision].latest, true);
    assert.deepEqual(byRevision[a01r2.lineage.revision].dependents, ["shotVideo:V2:A02"], "A02 用了 A01 当前这条的抽帧");
    assert.equal(byRevision[a01r2.lineage.revision].restoreBlocker.code, "ARTIFACT_RESTORE_ALREADY_LATEST");
    assert.equal(byRevision[a02r1.lineage.revision].restoreBlocker, null);
    await assert.rejects(store.listArtifactRevisions({ projectId: run.projectId, runId: run.runId, artifactIdPrefix: "" }), { code: "ARTIFACT_PREFIX_REQUIRED" });
  });
});

test("换回：原样重新签发（内容与依赖都取自那一版），依赖它当前版本的下游递归作废", async () => {
  await withRun(async ({ store, run, commit }) => {
    const { a01r1, a01r2 } = await seed(commit);
    const restored = await store.restoreArtifactRevision({
      projectId: run.projectId, runId: run.runId, artifactId: "shotVideo:V2:A01", revision: a01r1.lineage.revision,
      requestId: "restore-1", expectedCurrentRevision: a01r2.lineage.revision
    });
    assert.equal(restored.restoredFrom, a01r1.lineage.revision);
    assert.deepEqual(restored.content, video("a01-minimax"));
    assert.equal(restored.lineage.status, "current");
    assert.notEqual(restored.lineage.revision, a01r1.lineage.revision, "签发成新修订，不改旧修订");
    assert.equal(restored.lineage.contentDigest, a01r1.lineage.contentDigest);
    assert.deepEqual(restored.lineage.dependencies, a01r1.lineage.dependencies);
    assert.deepEqual(restored.staleArtifactIds, ["shotVideo:V2:A02"]);
    const loaded = await store.loadRun({ projectId: run.projectId, runId: run.runId });
    assert.equal(loaded.latestArtifacts["shotVideo:V2:A01"].lineage.revision, restored.lineage.revision);
    assert.equal(loaded.latestArtifacts["shotVideo:V2:A02"].lineage.status, "stale");
  });
});

test("换回被拒：上游已换版本、期望版本对不上、本来就是当前版本、内容检查不过，都不写入", async () => {
  await withRun(async ({ store, run, commit }) => {
    const { a01r1, a01r2, a02r1, a02r2 } = await seed(commit);
    const ids = { projectId: run.projectId, runId: run.runId };
    const restoreA01 = await store.restoreArtifactRevision({ ...ids, artifactId: "shotVideo:V2:A01", revision: a01r1.lineage.revision, requestId: "r-1", expectedCurrentRevision: a01r2.lineage.revision });
    // A01 换过之后，A02 的旧版本接的是已经不是当前的 A01 第二条：接不上。
    await assert.rejects(store.restoreArtifactRevision({ ...ids, artifactId: "shotVideo:V2:A02", revision: a02r1.lineage.revision, requestId: "r-2", expectedCurrentRevision: a02r2.lineage.revision }),
      (error) => error.code === "ARTIFACT_RESTORE_DEPENDENCY_CHANGED" && error.httpStatus === 409
        && error.details[0].artifactId === "shotVideo:V2:A01" && error.details[0].actualRevision === restoreA01.lineage.revision);
    // 期望的当前版本已被别人换掉。
    await assert.rejects(store.restoreArtifactRevision({ ...ids, artifactId: "shotVideo:V2:A01", revision: a01r2.lineage.revision, requestId: "r-3", expectedCurrentRevision: a01r2.lineage.revision }),
      { code: "ARTIFACT_REVISION_CONFLICT" });
    await assert.rejects(store.restoreArtifactRevision({ ...ids, artifactId: "shotVideo:V2:A01", revision: restoreA01.lineage.revision, requestId: "r-4", expectedCurrentRevision: restoreA01.lineage.revision }),
      { code: "ARTIFACT_RESTORE_ALREADY_LATEST" });
    await assert.rejects(store.restoreArtifactRevision({ ...ids, artifactId: "shotVideo:V2:A01", revision: "shotVideo-V2-A01-r9", requestId: "r-5", expectedCurrentRevision: restoreA01.lineage.revision }),
      { code: "ARTIFACT_REVISION_NOT_FOUND" });
    await assert.rejects(store.restoreArtifactRevision({ ...ids, artifactId: "shotVideo:V2:A01", revision: a01r2.lineage.revision, requestId: "r-6", expectedCurrentRevision: restoreA01.lineage.revision,
      validateContent: async () => { throw Object.assign(new Error("文件不在"), { code: "SHOT_VIDEO_RESTORE_FILE_MISSING" }); } }), { code: "SHOT_VIDEO_RESTORE_FILE_MISSING" });
    const loaded = await store.loadRun(ids);
    assert.equal(loaded.latestArtifacts["shotVideo:V2:A01"].lineage.revision, restoreA01.lineage.revision, "被拒的请求一个都没写入");
  });
});

test("换回同样受任务占用检查：有任务正在写这个目标时不写", async () => {
  await withRun(async ({ store, run, commit }) => {
    const { a01r1, a01r2 } = await seed(commit);
    store.artifactWriteGuard = async ({ input }) => {
      if (input.artifactId === "shotVideo:V2:A01") throw Object.assign(new Error("busy"), { code: "TASK_TARGET_BUSY" });
    };
    await assert.rejects(store.restoreArtifactRevision({ projectId: run.projectId, runId: run.runId, artifactId: "shotVideo:V2:A01", revision: a01r1.lineage.revision, requestId: "r-1", expectedCurrentRevision: a01r2.lineage.revision }),
      { code: "TASK_TARGET_BUSY" });
  });
});
