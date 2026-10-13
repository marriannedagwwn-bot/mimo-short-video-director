import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProductionStateStore } from "../src/production-state-store.js";
import { lineageRef } from "../src/production-lineage.js";
import { ensureStoryboardPlan } from "../src/storyboard-contract.js";

// 参考视频的 v3 测试包金标准（2026-10-10，加剧情 Run 的 3.1 包之前在改动前的代码上算出）。
// 固定签名密钥、固定时间与编号、固定内容：摘要和签名必须逐字节不变——已经导出的包要能照常导入，
// 剧情 Run 的包只能另起一个版本，不能动 3.0 的字节。
//
// 2026-10-11 换过一次夹具：原夹具里的 Plan 是旧 3.0 分镜（{promptSchemaVersion:"3.0", shotPlan:[{shotId:"A01"}]}），
// 而 sealPackage / validatePackage 从这天起拒绝封装与导入旧分镜，所以把夹具 Plan 换成下面这份最小合法 4.0 分镜，
// 摘要与签名随之重算。签名算法与包结构没有改：同一份 4.0 夹具在删除前的代码（HEAD ba4c500）上算出的
// 摘要和签名与这里逐字节相同，旧 3.0 夹具在删除前的代码上也仍然得到原来的 247c725e… / 33be3c71…。
// 包版本仍是 3.0（参考视频的包），与 Plan 版本无关。

const GOLDEN_DIGEST = "0097b37886a727fc54c9094390b4675d31b23cf40b7128301010d8b0051af796";
const GOLDEN_SIGNATURE = "3f5f791d1a1bad0ebd0de19b6dbd5c8f7f84d12d680d0ca43160cc7f79cf0db9";

// 最小合法 4.0 分镜：一个角色、一场、一个 10 秒片段，能过 ensureStoryboardPlan 全量校验。
const GOLDEN_ANIMATION_PLAN = {
  promptSchemaVersion: "4.0",
  selectedVariantId: "V1",
  title: "雨天的纸箱",
  productionStrategy: {
    format: "storyboard_video",
    targetAspectRatio: "16:9",
    targetRuntimeSeconds: 10,
    backgroundMusicMode: "none",
    visualStyle: "治愈",
    characterExpressionRules: "",
    sourceSceneIds: ["S1"],
    characterNames: ["阿岚"]
  },
  viewingIntent: "阿岚在雨里把纸箱护进屋檐下。",
  visualDesign: {
    characters: [{ name: "阿岚", appearance: "", designedDetails: [] }],
    locations: [{ name: "屋檐下", sourceSceneIds: ["S1"], layout: "窄屋檐下靠墙", lighting: "阴天自然光" }],
    props: []
  },
  adaptations: [],
  blockedIssues: [],
  shotPlan: [{
    shotId: "A01",
    sourceSceneIds: ["S1"],
    durationSeconds: 10,
    storyPurpose: "建立阿岚护住纸箱",
    emotionalTarget: "专注",
    transitionIn: { type: "start", description: "开场" },
    beats: [{
      startSeconds: 0,
      endSeconds: 10,
      sourceSceneIds: ["S1"],
      location: "屋檐下",
      characters: ["阿岚"],
      framing: "中景",
      camera: "固定机位",
      visibleAction: "阿岚把湿了一角的纸箱抱进屋檐下。",
      dialogue: [],
      soundDesign: "雨声"
    }],
    continuityOut: "纸箱放在阿岚脚边。",
    acceptanceCriteria: ["纸箱始终在画面里"]
  }],
  characterReferencePrompts: [{
    characterName: "阿岚",
    storyRole: "主角",
    identity: "社区修理师",
    appearancePrompt: "阿岚，社区修理师",
    consistencyTags: [],
    forbiddenChanges: []
  }],
  characterRegistry: {
    protagonist: {
      name: "阿岚",
      identity: "社区修理师",
      traits: ["细心"],
      speechRules: "话少",
      signatureBehaviors: ["先护住手里的东西"]
    },
    supportingCharacters: []
  },
  editorial: { initialReview: null, repairs: [], finalReview: null, guidance: [] }
};

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
    const animationPlan = structuredClone(GOLDEN_ANIMATION_PLAN);
    assert.equal(ensureStoryboardPlan(structuredClone(animationPlan)).promptSchemaVersion, "4.0");
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
