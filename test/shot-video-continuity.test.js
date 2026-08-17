import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  dropStaleMediaResults,
  estimateOneFpsFrameCount,
  mediaFilenameSegment,
  previousShotInPlan,
  selectedShotVideoCandidate,
  shotFrameResultKey,
  shotVideoArtifactIdFor,
  shotVideoResultKey
} from "../public/shot-video-continuity.js";
import {
  resolveAuthoritativeShotVideoInput,
  resolveAuthoritativeShotVideoReferenceAssets,
  resolvePreviousShotFrameReference,
  SHOT_VIDEO_CONTINUITY_PREVIOUS_SHOT_FRAMES
} from "../src/shot-video-continuity.js";
import { extractVideoFramesEverySecond, generateShotVideo } from "../src/shot-video-generator.js";

const PLAN_DIGEST = "a".repeat(64);
const VIDEO_DIGEST = "b".repeat(64);

test("视频生成只从当前 Plan 解析 exact shot，运行时只允许显式覆盖 videoPrompt", () => {
  const planEntry = {
    content: {
      promptSchemaVersion: "3.0",
      characterReferencePrompts: [{ characterName: "小白子" }],
      shotPlan: [{
        shotId: "A02",
        sourceSceneId: "S1",
        sceneId: "LOC01",
        durationSeconds: 5,
        videoPrompt: "Plan 原始提示词",
        characterAction: "Plan 权威动作"
      }]
    }
  };
  const resolved = resolveAuthoritativeShotVideoInput({
    planArtifactId: "animationPlan:V1",
    planEntry,
    currentShotId: "A02",
    promptOverride: "用户在生成弹窗确认的临时提示词",
    requestedSchemaVersion: "3.0",
    selectedVariantId: "V1"
  });
  assert.equal(resolved.shot.videoPrompt, "用户在生成弹窗确认的临时提示词");
  assert.equal(resolved.shot.characterAction, "Plan 权威动作");
  assert.equal(resolved.shot.durationSeconds, 5);
  assert.equal(resolved.promptSource, "runtime_override");
  assert.deepEqual(resolved.characterReferences, [{ characterName: "小白子" }]);
  assert.throws(() => resolveAuthoritativeShotVideoInput({
    planArtifactId: "animationPlan:V1",
    planEntry,
    currentShotId: "A99"
  }), /不在已签发 Animation Plan/u);
  assert.throws(() => resolveAuthoritativeShotVideoInput({
    planArtifactId: "animationPlan:V1",
    planEntry,
    currentShotId: "A02",
    requestedSchemaVersion: "2.0"
  }), /Prompt Schema/u);
  assert.throws(() => resolveAuthoritativeShotVideoInput({
    planArtifactId: "animationPlan:V1",
    planEntry,
    currentShotId: "A02",
    selectedVariantId: "V2"
  }), /主题变体/u);
});

test("character_reference 只能绑定当前签发 Plan 的 exact 角色图，服务端保留来源不能伪造", () => {
  const signedDataUrl = "data:image/png;base64,c2lnbmVk";
  const plan = {
    characterReferencePrompts: [{
      characterName: "小白子",
      referenceImageDataUrl: signedDataUrl
    }]
  };
  const resolved = resolveAuthoritativeShotVideoReferenceAssets([{
    mediaType: "image",
    name: "客户端自报名称",
    dataUrl: signedDataUrl,
    source: "character_reference"
  }, {
    mediaType: "image",
    name: "普通氛围参考",
    dataUrl: "data:image/png;base64,d2Vhaw==",
    source: "upload"
  }], plan);
  assert.equal(resolved[0].sourceCharacterName, "小白子");
  assert.equal(resolved[0].name, "小白子参考图");
  assert.equal(resolved[1].source, "upload");

  assert.throws(
    () => resolveAuthoritativeShotVideoReferenceAssets([{
      mediaType: "image",
      dataUrl: "data:image/png;base64,Zm9yZ2Vk",
      source: "character_reference"
    }], plan),
    /不属于当前签发 Animation Plan/u
  );
  assert.throws(
    () => resolveAuthoritativeShotVideoReferenceAssets([{
      mediaType: "image",
      dataUrl: signedDataUrl,
      source: "previous_shot_frame"
    }], plan),
    /服务端保留来源/u
  );
});

test("上一业务镜头按当前 Plan 顺序解析，结果状态按 variant 隔离", () => {
  const plan = {
    shotPlan: [
      { shotId: "A09", durationSeconds: 4 },
      { shotId: "A02", durationSeconds: 6 }
    ]
  };
  assert.equal(previousShotInPlan(plan, "A02").shotId, "A09");
  assert.equal(previousShotInPlan(plan, "A09"), null);
  assert.equal(previousShotInPlan({ shotPlan: [{ shotId: "A01" }, { shotId: "A01" }] }, "A01"), null);
  assert.equal(shotVideoArtifactIdFor("V1", "A01"), "shotVideo:V1:A01");
  assert.notEqual(shotVideoResultKey("V1", "A01"), shotVideoResultKey("V2", "A01"));
  assert.notEqual(shotFrameResultKey("V1", "A01", "start"), shotFrameResultKey("V2", "A01", "start"));
  assert.equal(mediaFilenameSegment("animationPlan-V.1-r1"), "animationPlan-V_1-r1");
  assert.equal(estimateOneFpsFrameCount(6.08), 6);
  assert.equal(selectedShotVideoCandidate({
    status: "ready",
    selectedIndex: 1,
    result: {
      videos: [{ outputUrl: "/one.mp4" }, { outputUrl: "/two.mp4" }]
    }
  }).outputUrl, "/two.mp4");

  const mediaState = {
    shotVideoResults: {
      "V1:A01": { status: "ready" },
      "V1:A02": { status: "ready" },
      "V2:A01": { status: "ready" }
    },
    shotFrameResults: {
      "V1:A01:start": { status: "ready" },
      "V2:A01:start": { status: "ready" }
    }
  };
  dropStaleMediaResults(mediaState, "shotVideo:V1:A02");
  assert.deepEqual(Object.keys(mediaState.shotVideoResults).sort(), ["V1:A01", "V2:A01"]);
  dropStaleMediaResults(mediaState, "animationPlan:V1");
  assert.deepEqual(Object.keys(mediaState.shotVideoResults), ["V2:A01"]);
  assert.deepEqual(Object.keys(mediaState.shotFrameResults), ["V2:A01:start"]);
});

test("服务端只从当前 Plan 的上一镜 current Artifact 解析受信视频", async (t) => {
  const fixture = await continuityFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));

  const resolved = await resolvePreviousShotFrameReference(fixture.request);
  assert.equal(resolved.sourceShotId, "A01");
  assert.equal(resolved.sourceOutputUrl, fixture.outputUrl);
  assert.equal(resolved.sourcePath, await fs.realpath(fixture.outputPath));
  assert.equal(resolved.continuityType, "intentional_next_shot");
  assert.deepEqual(resolved.sourceArtifact, {
    artifactId: "shotVideo:V1:A01",
    revision: "shotVideo-V1-A01-r2",
    contentDigest: VIDEO_DIGEST
  });

  await assert.rejects(
    () => resolvePreviousShotFrameReference({ ...fixture.request, currentShotId: "A01" }),
    /第一镜/u
  );
  await assert.rejects(
    () => resolvePreviousShotFrameReference({ ...fixture.request, generationMode: "first_last_frame" }),
    /只能用于显式 all_reference/u
  );

  const staleArtifacts = structuredClone(fixture.request.latestArtifacts);
  staleArtifacts["shotVideo:V1:A01"].lineage.status = "stale";
  await assert.rejects(
    () => resolvePreviousShotFrameReference({ ...fixture.request, latestArtifacts: staleArtifacts }),
    /没有当前可用/u
  );

  const wrongPlanArtifacts = structuredClone(fixture.request.latestArtifacts);
  wrongPlanArtifacts["shotVideo:V1:A01"].lineage.dependencies[0].revision = "animationPlan-V1-r0";
  await assert.rejects(
    () => resolvePreviousShotFrameReference({ ...fixture.request, latestArtifacts: wrongPlanArtifacts }),
    /不属于当前 Animation Plan/u
  );

  const outsideArtifacts = structuredClone(fixture.request.latestArtifacts);
  outsideArtifacts["shotVideo:V1:A01"].content.result.videos[0].outputUrl = "/generated-videos/other/run/old/A01.mp4";
  await assert.rejects(
    () => resolvePreviousShotFrameReference({ ...fixture.request, latestArtifacts: outsideArtifacts }),
    /不属于当前 Plan 的受信媒体目录/u
  );

  const traversalArtifacts = structuredClone(fixture.request.latestArtifacts);
  traversalArtifacts["shotVideo:V1:A01"].content.result.videos[0].outputUrl = `${fixture.request.videoPublicBasePath}/${fixture.request.filenamePrefix}-A01-%2F..%2Fescape.mp4`;
  await assert.rejects(
    () => resolvePreviousShotFrameReference({ ...fixture.request, latestArtifacts: traversalArtifacts }),
    /不属于当前 Plan 的受信媒体目录/u
  );

  const dottedVariantFixture = await continuityFixture({ variantId: "V.1" });
  t.after(() => fs.rm(dottedVariantFixture.root, { recursive: true, force: true }));
  const dottedVariantResolved = await resolvePreviousShotFrameReference(dottedVariantFixture.request);
  assert.equal(dottedVariantResolved.sourceShotId, "A01");
  assert.equal(dottedVariantResolved.sourcePath, await fs.realpath(dottedVariantFixture.outputPath));
});

test("FFmpeg 以 1 fps 抽取上一镜并限制最多 9 张", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "previous-shot-frames-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "source.mp4");
  await fs.writeFile(sourcePath, Buffer.alloc(32, 1));
  let command = "";
  let args = [];
  const result = await extractVideoFramesEverySecond({
    sourcePath,
    outputDirectory: root,
    sourceShotId: "A01",
    durationProbe: async () => 6.08,
    execFileRunner: async (receivedCommand, receivedArgs) => {
      command = receivedCommand;
      args = receivedArgs;
      const pattern = receivedArgs.at(-1);
      await Promise.all(Array.from({ length: 6 }, (_, index) => (
        fs.writeFile(pattern.replace("%02d", String(index + 1).padStart(2, "0")), Buffer.alloc(16, index + 1))
      )));
    }
  });
  assert.equal(command, "ffmpeg");
  assert.equal(args.includes("-an"), true);
  assert.equal(args.includes("0:v:0"), true);
  assert.match(args[args.indexOf("-vf") + 1], /^fps=1,/u);
  assert.equal(result.durationSeconds, 6.08);
  assert.deepEqual(result.frames.map((frame) => frame.timestampSeconds), [0, 1, 2, 3, 4, 5]);

  const overflowRoot = await fs.mkdtemp(path.join(os.tmpdir(), "previous-shot-overflow-"));
  t.after(() => fs.rm(overflowRoot, { recursive: true, force: true }));
  await assert.rejects(() => extractVideoFramesEverySecond({
    sourcePath,
    outputDirectory: overflowRoot,
    sourceShotId: "A01",
    durationProbe: async () => 10,
    execFileRunner: async (_receivedCommand, receivedArgs) => {
      const pattern = receivedArgs.at(-1);
      await Promise.all(Array.from({ length: 10 }, (_, index) => (
        fs.writeFile(pattern.replace("%02d", String(index + 1).padStart(2, "0")), Buffer.alloc(16, index + 1))
      )));
    }
  }), /超过全能参考图片上限 9 张/u);
});

test("上一镜每秒抽帧作为 reference_image，并把精确源 lineage 写入回执", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shot-video-previous-frames-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, "provider.json");
  const sourcePath = path.join(root, "source-A01.mp4");
  await Promise.all([
    fs.writeFile(configPath, JSON.stringify({
      videoEndpoint: "https://provider.invalid/video",
      providerPreset: "modelark_content_generation",
      videoModel: "doubao-seedance-2-0-260128",
      apiKey: "test-key"
    })),
    fs.writeFile(sourcePath, Buffer.alloc(32, 2))
  ]);
  let providerRequest = null;
  let outputProbeCalls = 0;
  const result = await generateShotVideo({
    configPath,
    outputRoot: path.join(root, "generated-videos"),
    publicBasePath: "/generated-videos/test",
    videoProvider: "Seedance",
    videoModel: "doubao-seedance-2-0-260128",
    generationMode: "all_reference",
    continuityReferenceMode: SHOT_VIDEO_CONTINUITY_PREVIOUS_SHOT_FRAMES,
    trustedPreviousShotReference: trustedPreviousShotReference(sourcePath),
    previousShotFrameExtractor: async ({ outputDirectory }) => {
      const frames = [];
      for (let index = 0; index < 6; index += 1) {
        const framePath = path.join(outputDirectory, `injected-${index + 1}.jpg`);
        await fs.writeFile(framePath, Buffer.alloc(24, index + 1));
        frames.push({ path: framePath, timestampSeconds: index });
      }
      return { durationSeconds: 6.08, frames };
    },
    referenceAssets: [{
      mediaType: "image",
      name: "canonical-character.png",
      dataUrl: `data:image/png;base64,${Buffer.from("canonical").toString("base64")}`,
      source: "character_reference"
    }],
    workerRunner: async ({ request, output, receipt }) => {
      providerRequest = JSON.parse(await fs.readFile(request, "utf8"));
      await fs.writeFile(output, Buffer.alloc(600, 3));
      await fs.writeFile(receipt, JSON.stringify({ ok: true }));
    },
    videoOutputProbe: async () => { outputProbeCalls += 1; },
    shot: {
      shotId: "A02",
      sourceSceneId: "S1",
      durationSeconds: 5,
      videoPrompt: "当前镜头只执行 A02 的剧情动作。"
    }
  });

  assert.deepEqual(result.referenceSummary, { image: 7, video: 0, audio: 0 });
  assert.equal(result.continuityReferenceReceipt.sourceShotId, "A01");
  assert.equal(result.continuityReferenceReceipt.frameCount, 6);
  assert.equal(result.continuityReferenceReceipt.sourceDurationSeconds, 6.08);
  assert.match(result.continuityReferenceReceipt.sourceVideoSha256, /^[a-f0-9]{64}$/u);
  assert.equal(result.continuityReferenceReceipt.frames.length, 6);
  assert.equal(result.continuityReferenceReceipt.frames.every((frame) => /^[a-f0-9]{64}$/u.test(frame.sha256)), true);
  assert.deepEqual(result.continuityReferenceReceipt.sourceArtifact, trustedPreviousShotReference(sourcePath).sourceArtifact);
  assert.equal(Object.hasOwn(result.continuityReferenceReceipt, "sourcePath"), false);
  assert.equal(providerRequest.inputArtifacts.length, 7);
  assert.deepEqual(providerRequest.inputArtifacts.slice(1).map((item) => item.role), Array(6).fill("reference_image"));
  assert.deepEqual(providerRequest.inputArtifacts.slice(1).map((item) => item.source), Array(6).fill("previous_shot_frame"));
  assert.equal(outputProbeCalls, 1);
});

test("上一镜抽帧计入合并后的 9 图上限，不能静默挤掉既有参考图", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shot-video-previous-overflow-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, "provider.json");
  const sourcePath = path.join(root, "source-A01.mp4");
  await Promise.all([
    fs.writeFile(configPath, JSON.stringify({
      videoEndpoint: "https://provider.invalid/video",
      providerPreset: "modelark_content_generation",
      videoModel: "doubao-seedance-2-0-260128",
      apiKey: "test-key"
    })),
    fs.writeFile(sourcePath, Buffer.alloc(32, 2))
  ]);
  const referenceAssets = Array.from({ length: 9 }, (_, index) => ({
    mediaType: "image",
    name: `reference-${index + 1}.png`,
    dataUrl: `data:image/png;base64,${Buffer.from(`image-${index + 1}`).toString("base64")}`
  }));
  await assert.rejects(() => generateShotVideo({
    configPath,
    outputRoot: path.join(root, "generated-videos"),
    videoProvider: "Seedance",
    videoModel: "doubao-seedance-2-0-260128",
    generationMode: "all_reference",
    continuityReferenceMode: SHOT_VIDEO_CONTINUITY_PREVIOUS_SHOT_FRAMES,
    trustedPreviousShotReference: trustedPreviousShotReference(sourcePath),
    previousShotFrameExtractor: async ({ outputDirectory }) => {
      const framePath = path.join(outputDirectory, "injected-1.jpg");
      await fs.writeFile(framePath, Buffer.alloc(24, 1));
      return { durationSeconds: 1, frames: [{ path: framePath, timestampSeconds: 0 }] };
    },
    referenceAssets,
    workerRunner: async () => {
      throw new Error("图片超限时不应调用 worker");
    },
    shot: { shotId: "A02", durationSeconds: 5, videoPrompt: "测试" }
  }), /全能参考图片最多 9 张，当前 10 张/u);
});

test("同一镜头的并发视频请求使用不可碰撞的输出文件名", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shot-video-unique-output-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, "provider.json");
  await fs.writeFile(configPath, JSON.stringify({
    videoEndpoint: "https://provider.invalid/video",
    providerPreset: "modelark_content_generation",
    videoModel: "doubao-seedance-2-0-260128",
    apiKey: "test-key"
  }));
  const options = {
    configPath,
    outputRoot: path.join(root, "generated-videos"),
    publicBasePath: "/generated-videos/test",
    filenamePrefix: "animationPlan-V1-r1-abcdef123456",
    videoProvider: "Seedance",
    videoModel: "doubao-seedance-2-0-260128",
    generationMode: "all_reference",
    referenceAssets: [{
      mediaType: "image",
      name: "reference.png",
      dataUrl: `data:image/png;base64,${Buffer.from("reference").toString("base64")}`
    }],
    workerRunner: async ({ output, receipt }) => {
      await fs.writeFile(output, Buffer.alloc(600, 4));
      await fs.writeFile(receipt, JSON.stringify({ ok: true }));
    },
    videoOutputProbe: async () => {},
    shot: { shotId: "A02", durationSeconds: 5, videoPrompt: "测试" }
  };
  const [first, second] = await Promise.all([
    generateShotVideo(options),
    generateShotVideo(options)
  ]);
  assert.notEqual(first.outputPath, second.outputPath);
  assert.notEqual(first.outputUrl, second.outputUrl);
});

async function continuityFixture({ variantId = "V1" } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "continuity-resolver-"));
  const videoOutputRoot = path.join(root, "generated-videos", "project", "run", "plan");
  const videoPublicBasePath = "/generated-videos/project/run/plan";
  const planArtifactId = `animationPlan:${variantId}`;
  const planRevision = `animationPlan-${variantId}-r1`;
  const sourceArtifactId = `shotVideo:${variantId}:A01`;
  const filenamePrefix = `${planRevision}-${PLAN_DIGEST.slice(0, 12)}`;
  const filename = `${mediaFilenameSegment(filenamePrefix)}-A01-20260812T120000000.mp4`;
  const outputPath = path.join(videoOutputRoot, filename);
  const outputUrl = `${videoPublicBasePath}/${filename}`;
  await fs.mkdir(videoOutputRoot, { recursive: true });
  await fs.writeFile(outputPath, Buffer.alloc(32, 1));
  const planLineage = {
    artifactId: planArtifactId,
    artifactType: "animationPlan",
    revision: planRevision,
    contentDigest: PLAN_DIGEST,
    status: "current"
  };
  const planEntry = {
    lineage: planLineage,
    content: {
      shotPlan: [
        { shotId: "A01", sourceSceneId: "S1", sceneId: "LOC01", durationSeconds: 6 },
        { shotId: "A02", sourceSceneId: "S1", sceneId: "LOC01", durationSeconds: 5 }
      ]
    }
  };
  const latestArtifacts = {
    [sourceArtifactId]: {
      lineage: {
        artifactId: sourceArtifactId,
        artifactType: "shotVideo",
        revision: `shotVideo-${variantId}-A01-r2`,
        contentDigest: VIDEO_DIGEST,
        status: "current",
        dependencies: [{
          artifactId: planLineage.artifactId,
          revision: planLineage.revision,
          contentDigest: planLineage.contentDigest
        }]
      },
      content: {
        status: "ready",
        selectedIndex: 0,
        result: { videos: [{ outputUrl }] }
      }
    }
  };
  return {
    root,
    outputPath,
    outputUrl,
    request: {
      continuityReferenceMode: SHOT_VIDEO_CONTINUITY_PREVIOUS_SHOT_FRAMES,
      generationMode: "all_reference",
      currentShotId: "A02",
      planArtifactId,
      planEntry,
      latestArtifacts,
      videoOutputRoot,
      videoPublicBasePath,
      filenamePrefix
    }
  };
}

function trustedPreviousShotReference(sourcePath) {
  return {
    mode: SHOT_VIDEO_CONTINUITY_PREVIOUS_SHOT_FRAMES,
    continuityType: "intentional_next_shot",
    sourceShotId: "A01",
    sourceSceneId: "S1",
    sceneId: "LOC01",
    selectedIndex: 0,
    sourceOutputUrl: "/generated-videos/current/A01.mp4",
    sourcePath,
    sourceArtifact: {
      artifactId: "shotVideo:V1:A01",
      revision: "shotVideo-V1-A01-r2",
      contentDigest: VIDEO_DIGEST
    }
  };
}
