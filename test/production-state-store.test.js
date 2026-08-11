import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProductionStateStore } from "../src/production-state-store.js";
import { lineageRef } from "../src/production-lineage.js";

async function withStore(run) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "mimo-production-state-test-"));
  let nextId = 0;
  const store = new ProductionStateStore({
    rootDir,
    idFactory: () => `id-${++nextId}`
  });
  try {
    await run({ store, rootDir });
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
}

async function commit(store, run, input) {
  return store.commitArtifact({
    projectId: run.projectId,
    runId: run.runId,
    requestId: input.requestId || `request-${input.artifactId.replaceAll(":", "-")}`,
    expectedCurrentRevision: input.expectedCurrentRevision ?? null,
    dependencies: input.dependencies || [],
    ...input
  });
}

test("persistent run checkpoints artifacts and restores them after a new store instance", async () => {
  await withStore(async ({ store, rootDir }) => {
    const run = await store.createRun({
      projectId: "project-test",
      metadata: { creatorProfile: { fixedCharacter: "奶奶" } }
    });
    await store.recordStage({
      projectId: run.projectId,
      runId: run.runId,
      stageId: "referenceAnalysis",
      status: "running",
      requestId: "request-analysis"
    });
    const analysis = await commit(store, run, {
      artifactId: "referenceAnalysis",
      artifactType: "referenceAnalysis",
      content: { summary: "分析" },
      requestId: "request-analysis"
    });
    const reopened = new ProductionStateStore({ rootDir });
    const loaded = await reopened.loadRun(run);
    assert.deepEqual(loaded.latestArtifacts.referenceAnalysis.content, { summary: "分析" });
    assert.equal(loaded.latestArtifacts.referenceAnalysis.lineage.revision, analysis.lineage.revision);
    assert.equal(loaded.stages.referenceAnalysis.status, "completed");
    assert.ok(loaded.checkpoint.sequence >= 2);
  });
});
test("same-id upstream change stales Story, Plan and media, while key reordering is idempotent", async () => {
  await withStore(async ({ store }) => {
    const run = await store.createRun({ projectId: "project-stale" });
    const variant = await commit(store, run, {
      artifactId: "variant:V1",
      artifactType: "selectedVariant",
      content: { id: "V1", title: "旧主题", characterSetup: { protagonist: "奶奶" } }
    });
    const reordered = await commit(store, run, {
      artifactId: "variant:V1",
      artifactType: "selectedVariant",
      expectedCurrentRevision: variant.lineage.revision,
      content: { characterSetup: { protagonist: "奶奶" }, title: "旧主题", id: "V1" }
    });
    assert.equal(reordered.reused, true);

    const story = await commit(store, run, {
      artifactId: "fullStory:V1",
      artifactType: "fullStory",
      content: { selectedVariantId: "V1", sceneScript: [{ sceneId: "SC01" }] },
      dependencies: [lineageRef(variant.lineage)]
    });
    const plan = await commit(store, run, {
      artifactId: "animationPlan:V1",
      artifactType: "animationPlan",
      content: { selectedVariantId: "V1", promptSchemaVersion: "3.0", shotPlan: [] },
      dependencies: [lineageRef(story.lineage)],
      createMediaNamespace: true
    });
    await commit(store, run, {
      artifactId: "shotVideo:V1:S01",
      artifactType: "shotVideo",
      content: { status: "ready", result: { outputUrl: "/old.mp4" } },
      dependencies: [lineageRef(plan.lineage)]
    });

    const changed = await commit(store, run, {
      artifactId: "variant:V1",
      artifactType: "selectedVariant",
      expectedCurrentRevision: variant.lineage.revision,
      content: { id: "V1", title: "新主题", characterSetup: { protagonist: "奶奶" } }
    });
    assert.deepEqual(changed.staleArtifactIds, [
      "animationPlan:V1",
      "fullStory:V1",
      "shotVideo:V1:S01"
    ]);
    const loaded = await store.loadRun(run, { includeContent: false });
    assert.equal(loaded.latestArtifacts["fullStory:V1"].lineage.status, "stale");
    assert.equal(loaded.latestArtifacts["animationPlan:V1"].lineage.status, "stale");
    assert.equal(loaded.latestArtifacts["shotVideo:V1:S01"].lineage.status, "stale");

    await assert.rejects(
      commit(store, run, {
        artifactId: "variant:V1",
        artifactType: "selectedVariant",
        expectedCurrentRevision: variant.lineage.revision,
        content: { id: "V1", title: "更旧的异步结果" }
      }),
      (error) => error.code === "ARTIFACT_REVISION_CONFLICT"
    );
  });
});

test("signed v3 package validates lineage, rejects tampering and imports into an isolated run", async () => {
  await withStore(async ({ store }) => {
    const run = await store.createRun({ projectId: "project-package" });
    const variantContent = { id: "V1", title: "主题", characterSetup: { protagonist: "奶奶" } };
    const storyContent = { selectedVariantId: "V1", sceneScript: [{ sceneId: "SC01" }] };
    const planContent = { selectedVariantId: "V1", promptSchemaVersion: "3.0", shotPlan: [] };
    const variant = await commit(store, run, {
      artifactId: "variant:V1",
      artifactType: "selectedVariant",
      content: variantContent
    });
    const story = await commit(store, run, {
      artifactId: "fullStory:V1",
      artifactType: "fullStory",
      content: storyContent,
      dependencies: [lineageRef(variant.lineage)]
    });
    await commit(store, run, {
      artifactId: "animationPlan:V1",
      artifactType: "animationPlan",
      content: planContent,
      dependencies: [lineageRef(story.lineage)],
      createMediaNamespace: true
    });
    const sealed = await store.sealPackage({
      projectId: run.projectId,
      runId: run.runId,
      payload: {
        packageType: "story-production-test-package",
        packageVersion: "3.0",
        selectedVariant: variantContent,
        fullStory: storyContent,
        animationPlan: planContent,
        shotVideoResults: { S01: { status: "ready" } }
      }
    });
    await assert.doesNotReject(store.validatePackage(sealed));
    await assert.rejects(
      store.validatePackage({ ...sealed, fullStory: { ...storyContent, sceneScript: [] } }),
      (error) => error.code === "PRODUCTION_PACKAGE_DIGEST_MISMATCH"
    );

    const imported = await store.importPackage(sealed);
    assert.notEqual(imported.production.runId, run.runId);
    assert.deepEqual(imported.payload.shotVideoResults, {});
    assert.equal(imported.discardedMedia, true);
    assert.equal(imported.production.artifacts["animationPlan:V1"].status, "current");
    assert.match(imported.production.artifacts["animationPlan:V1"].mediaNamespace, new RegExp(`^${imported.production.projectId}/${imported.production.runId}/`, "u"));
  });
});
