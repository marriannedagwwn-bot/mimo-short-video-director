import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProductionStateStore } from "../src/production-state-store.js";
import { lineageRef } from "../src/production-lineage.js";

// 参考视频的 v3 测试包金标准（2026-10-10，加剧情 Run 的 3.1 包之前在改动前的代码上算出）。
// 固定签名密钥、固定时间与编号、固定内容：摘要和签名必须逐字节不变——已经导出的包要能照常导入，
// 剧情 Run 的包只能另起一个版本，不能动 3.0 的字节。

const GOLDEN_DIGEST = "247c725e14c9085042aeae08fe65e711e96c112692de56ca651216998f5e4ed7";
const GOLDEN_SIGNATURE = "33be3c7112d23b35e72a301fd5b2df8063ed8120cfbb43c3394a4dc32967de22";

async function goldenStore() {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "mimo-package-golden-"));
  await fs.writeFile(path.join(rootDir, ".package-signing-key"), Buffer.alloc(48, 0x5a), { mode: 0o600 });
  let nextId = 0;
  const store = new ProductionStateStore({
    rootDir,
    idFactory: () => `golden-${++nextId}`,
    now: () => new Date("2026-10-10T00:00:00.000Z")
  });
  return { rootDir, store };
}

async function commit(store, run, input) {
  return store.commitArtifact({
    projectId: run.projectId,
    runId: run.runId,
    requestId: `request-${input.artifactId.replaceAll(":", "-")}`,
    expectedCurrentRevision: null,
    dependencies: [],
    ...input
  });
}

test("v3 参考视频测试包：固定密钥与内容下，摘要、签名与导入后的结构逐字节不变（金标准）", async () => {
  const { rootDir, store } = await goldenStore();
  try {
    const run = await store.createRun({ projectId: "project-golden", metadata: { creatorProfile: { fixedCharacter: "阿岚", vertical: "治愈", constraints: "" } } });
    const selectedVariant = { id: "V1", title: "雨天的纸箱", characterSetup: { protagonist: "阿岚" } };
    const fullStory = { selectedVariantId: "V1", title: "雨天的纸箱", sceneScript: [{ sceneId: "S1", timeRange: "00:00-00:10" }] };
    const animationPlan = { selectedVariantId: "V1", promptSchemaVersion: "3.0", shotPlan: [{ shotId: "A01" }] };
    const variant = await commit(store, run, { artifactId: "variant:V1", artifactType: "selectedVariant", content: selectedVariant });
    const story = await commit(store, run, { artifactId: "fullStory:V1", artifactType: "fullStory", content: fullStory, dependencies: [lineageRef(variant.lineage)] });
    await commit(store, run, { artifactId: "animationPlan:V1", artifactType: "animationPlan", content: animationPlan, dependencies: [lineageRef(story.lineage)], createMediaNamespace: true });
    // 浏览器发来的形状（public/app.js selectedStoryPackage 的参考视频分支）。
    const sealed = await store.sealPackage({
      projectId: run.projectId,
      runId: run.runId,
      payload: {
        exportedAt: "2026-10-10T00:00:00.000Z",
        mode: "live",
        modelInfo: { storyProvider: "MiMo", storyModel: "mimo-v2.6-pro" },
        sourceVideo: { name: "fixture.mp4", duration: 30 },
        creatorProfile: { fixedCharacter: "阿岚", vertical: "治愈", constraints: "" },
        referenceAnalysis: { format: "fixture" },
        sourceScriptReconstruction: { scenes: [] },
        themeVariants: { variants: [selectedVariant] },
        creativeBrief: { storyEngine: {} },
        visualGuardrails: { fixedCharacterBoundary: { characterName: "阿岚" } },
        selectedVariant,
        fullStory,
        animationPlan,
        shotFrameResults: {},
        shotVideoResults: { "V1:A01": { status: "ready" } }
      }
    });
    assert.equal(sealed.packageVersion, "3.0");
    assert.equal(sealed.packageDigest, GOLDEN_DIGEST);
    assert.equal(sealed.packageSignature, GOLDEN_SIGNATURE);

    const imported = await store.importPackage(sealed);
    const shape = Object.fromEntries(Object.entries(imported.production.artifacts).map(([artifactId, lineage]) => [
      artifactId,
      { type: lineage.artifactType, dependencies: lineage.dependencies.map((ref) => ref.artifactId).sort() }
    ]));
    assert.deepEqual(shape, {
      referenceAnalysis: { type: "referenceAnalysis", dependencies: [] },
      sourceScriptReconstruction: { type: "sourceScriptReconstruction", dependencies: ["referenceAnalysis"] },
      creativeBrief: { type: "creativeBrief", dependencies: ["referenceAnalysis", "sourceScriptReconstruction"] },
      visualGuardrails: { type: "visualGuardrails", dependencies: ["creativeBrief", "referenceAnalysis", "sourceScriptReconstruction"] },
      themeVariants: { type: "themeVariants", dependencies: ["creativeBrief", "visualGuardrails"] },
      "variant:V1": { type: "selectedVariant", dependencies: ["themeVariants"] },
      "fullStory:V1": { type: "fullStory", dependencies: ["creativeBrief", "referenceAnalysis", "sourceScriptReconstruction", "themeVariants", "variant:V1", "visualGuardrails"] },
      "animationPlan:V1": { type: "animationPlan", dependencies: ["creativeBrief", "fullStory:V1", "referenceAnalysis", "sourceScriptReconstruction", "variant:V1", "visualGuardrails"] }
    });
    assert.deepEqual(Object.keys(imported.production.metadata).sort(), ["creatorProfile", "importedFromPackageDigest", "sourceVideo"]);
    assert.equal(imported.production.metadata.entryMode, undefined, "参考视频的包导入后仍是参考视频 Run");
    assert.deepEqual(imported.payload.shotVideoResults, {});
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});
