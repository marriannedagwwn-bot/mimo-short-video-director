import test from "node:test";
import assert from "node:assert/strict";
import {
  buildFrameReferenceManifest,
  canReusePreviousEndFrameAsStart,
  resolveFrameReferenceMode,
  shotRelatedCharacterReferences,
  validateFrameReferenceMode
} from "../public/shot-reference-images.js";
import { computeDependencyHash } from "../public/frame-dependency.js";

const image = (byte) => `data:image/png;base64,${Buffer.from([byte]).toString("base64")}`;

function shotFixture() {
  const environment = {
    sceneId: "LOC01",
    foreground: "木桌边缘",
    midground: "角色站在桌旁",
    background: "同一扇朝西窗户",
    atmosphere: "安静温暖"
  };
  const camera = {
    shotSize: "中近景",
    height: "视线高度",
    angle: "平视",
    viewDirection: "朝向窗户",
    lensFeel: "自然透视",
    depthOfField: "主体清晰",
    composition: "角色位于左侧"
  };
  const lighting = {
    source: "窗外夕阳",
    direction: "右后方逆光",
    colorAndContrast: "暖金色低反差"
  };
  return {
    shotId: "A01",
    sceneId: "LOC01",
    startFrame: {
      environment: structuredClone(environment),
      camera: structuredClone(camera),
      lighting: structuredClone(lighting)
    },
    endFrame: {
      environment: structuredClone(environment),
      camera: structuredClone(camera),
      lighting: structuredClone(lighting)
    },
    motion: {
      mode: "continuous_action",
      cameraMove: { mode: "locked" }
    }
  };
}

test("inherit manifest keeps the start frame first, deduplicates exact images and derives bindings", async () => {
  const startImage = image(1);
  const characterImage = image(2);
  const manifest = await buildFrameReferenceManifest({
    frameKind: "end",
    frameReferenceMode: "inherit",
    endpointReference: {
      role: "start_frame",
      dataUrl: startImage,
      sourceShotId: "A01"
    },
    characterReferences: [
      { characterName: "小白子", referenceImageDataUrl: characterImage },
      { characterName: "重复首帧", referenceImageDataUrl: startImage },
      { characterName: "重复角色", referenceImageDataUrl: characterImage }
    ]
  });

  assert.equal(manifest.providerImages.length, 2);
  assert.equal(manifest.providerImages[0].role, "start_frame");
  assert.equal(manifest.providerImages[0].sourceShotId, "A01");
  assert.equal(manifest.endpointReference.usedByProvider, true);
  assert.equal(manifest.additionalReferences.length, 1);
  assert.equal(manifest.additionalReferences[0].characterName, "小白子");
  assert.equal(manifest.promptBindings[0].token, manifest.providerImages[0].token);
  assert.equal(manifest.promptBindings[1].token, manifest.providerImages[1].token);
  assert.notEqual(manifest.providerImages[0].contentHash, manifest.providerImages[1].contentHash);
});

test("manifest deduplicates identical raw image bytes even when data URL metadata differs", async () => {
  const rawBytes = Buffer.from([42]).toString("base64");
  const manifest = await buildFrameReferenceManifest({
    frameKind: "start",
    characterReferences: [{
      characterName: "第一角色",
      referenceImageDataUrl: `data:image/png;base64,${rawBytes}`
    }, {
      characterName: "重复内容",
      referenceImageDataUrl: `data:image/webp;base64,${rawBytes}`
    }, {
      characterName: "唯一角色",
      referenceImageDataUrl: image(43)
    }]
  });

  assert.equal(manifest.providerImages.length, 2);
  assert.deepEqual(
    manifest.providerImages.map((item) => item.characterName),
    ["第一角色", "唯一角色"]
  );
});

test("transition reserves one provider slot for the endpoint and truncates characters in stable order", async () => {
  const characters = Array.from({ length: 7 }, (_, index) => ({
    characterName: `角色${index + 1}`,
    referenceImageDataUrl: image(index + 10)
  }));
  const manifest = await buildFrameReferenceManifest({
    frameKind: "end",
    frameReferenceMode: "transition",
    endpointReference: {
      dataUrl: image(3),
      sourceShotId: "A01"
    },
    characterReferences: characters,
    maxProviderImages: 6
  });

  assert.equal(manifest.providerImages.length, 6);
  assert.equal(manifest.providerImages[0].role, "start_frame");
  assert.deepEqual(
    manifest.additionalReferences.map((item) => item.characterName),
    characters.slice(0, 5).map((item) => item.characterName)
  );
  assert.deepEqual(
    manifest.providerImages.map((item) => item.index),
    [1, 2, 3, 4, 5, 6]
  );
});

test("independent ignores an endpoint and can use six character references", async () => {
  const characters = Array.from({ length: 7 }, (_, index) => ({
    characterName: `角色${index + 1}`,
    referenceImageDataUrl: image(index + 20)
  }));
  const manifest = await buildFrameReferenceManifest({
    frameKind: "end",
    frameReferenceMode: "independent",
    endpointReference: {
      dataUrl: image(4),
      sourceShotId: "A01"
    },
    characterReferences: characters
  });

  assert.equal(manifest.endpointReference, null);
  assert.equal(manifest.providerImages.length, 6);
  assert.ok(manifest.providerImages.every((item) => item.role === "character_reference"));
  assert.deepEqual(
    manifest.additionalReferences.map((item) => item.characterName),
    characters.slice(0, 6).map((item) => item.characterName)
  );
});

test("start-frame manifests contain only character references and enforce the provider cap", async () => {
  const manifest = await buildFrameReferenceManifest({
    frameKind: "start",
    characterReferences: Array.from({ length: 7 }, (_, index) => ({
      characterName: `角色${index + 1}`,
      referenceImageDataUrl: image(index + 30)
    })),
    maxProviderImages: 99
  });

  assert.equal(manifest.endpointReference, null);
  assert.equal(manifest.providerImages.length, 6);
  assert.ok(manifest.providerImages.every((item) => item.role === "character_reference"));
});

test("inherit and transition require an endpoint while independent does not", async () => {
  await assert.rejects(
    buildFrameReferenceManifest({
      frameKind: "end",
      frameReferenceMode: "inherit",
      characterReferences: []
    }),
    /必须提供有效的首帧视觉参考/
  );
  await assert.rejects(
    buildFrameReferenceManifest({
      frameKind: "end",
      frameReferenceMode: "transition",
      characterReferences: []
    }),
    /必须提供有效的首帧视觉参考/
  );
  await assert.doesNotReject(buildFrameReferenceManifest({
    frameKind: "end",
    frameReferenceMode: "independent",
    characterReferences: []
  }));
});

test("strong reference modes never truncate their required endpoint", async () => {
  const manifest = await buildFrameReferenceManifest({
    frameKind: "end",
    frameReferenceMode: "inherit",
    endpointReference: {
      dataUrl: image(5),
      sourceShotId: "A01"
    },
    characterReferences: [{
      characterName: "小白子",
      referenceImageDataUrl: image(6)
    }],
    maxProviderImages: 0
  });

  assert.equal(manifest.providerImages.length, 1);
  assert.equal(manifest.providerImages[0].role, "start_frame");
  assert.equal(manifest.endpointReference.usedByProvider, true);
});

test("mode resolver selects inherit only for unchanged visual structure", () => {
  const stable = shotFixture();
  assert.equal(resolveFrameReferenceMode(stable), "inherit");

  const movingCamera = structuredClone(stable);
  movingCamera.motion.cameraMove.mode = "continuous";
  assert.equal(resolveFrameReferenceMode(movingCamera), "transition");

  const continuousLoop = structuredClone(stable);
  continuousLoop.motion.mode = "loop";
  continuousLoop.motion.cameraMove.mode = "continuous";
  assert.equal(resolveFrameReferenceMode(continuousLoop), "inherit");
  assert.equal(validateFrameReferenceMode(continuousLoop, "inherit"), "inherit");

  const changedComposition = structuredClone(stable);
  changedComposition.endFrame.camera.composition = "角色位于中央";
  assert.equal(resolveFrameReferenceMode(changedComposition), "transition");

  const changedAtmosphere = structuredClone(stable);
  changedAtmosphere.endFrame.environment.atmosphere = "雨雾加重";
  assert.equal(resolveFrameReferenceMode(changedAtmosphere), "transition");

  const changedTime = structuredClone(stable);
  changedTime.startFrame.timeAndWeather = "黄昏";
  changedTime.endFrame.timeAndWeather = "夜晚";
  assert.equal(resolveFrameReferenceMode(changedTime), "transition");

  const transformedObject = structuredClone(stable);
  transformedObject.motion.mode = "object_transform";
  assert.equal(resolveFrameReferenceMode(transformedObject), "transition");
});

test("mode validation rejects strong inheritance changes and all cross-scene transitions", () => {
  const changedCamera = shotFixture();
  changedCamera.endFrame.camera.angle = "俯视";
  changedCamera.motion.cameraMove.mode = "continuous";
  assert.throws(
    () => validateFrameReferenceMode(changedCamera, "inherit"),
    /不能使用 inherit 模式/
  );
  assert.equal(validateFrameReferenceMode(changedCamera, "transition"), "transition");

  const crossScene = shotFixture();
  crossScene.endFrame.environment.sceneId = "LOC02";
  assert.throws(
    () => resolveFrameReferenceMode(crossScene),
    /transition 只允许同一 sceneId/
  );
  assert.throws(
    () => validateFrameReferenceMode(crossScene, "transition"),
    /transition 只允许同一 sceneId/
  );
  assert.throws(
    () => validateFrameReferenceMode(crossScene, "independent"),
    /transition 只允许同一 sceneId/
  );
});

test("transition validation requires EndState changes to be declared by Changes", () => {
  const undeclaredCamera = shotFixture();
  undeclaredCamera.endFrame.camera.angle = "俯视";
  assert.throws(
    () => validateFrameReferenceMode(undeclaredCamera, "transition"),
    /cameraMove\.mode=continuous/u
  );

  const noCameraEndpoint = shotFixture();
  noCameraEndpoint.motion.cameraMove.mode = "continuous";
  assert.throws(
    () => validateFrameReferenceMode(noCameraEndpoint, "transition"),
    /EndState/u
  );

  const changedLight = shotFixture();
  changedLight.endFrame.lighting.direction = "左前方";
  changedLight.motion.lightingChange = "光线从右后方连续转为左前方";
  assert.equal(validateFrameReferenceMode(changedLight, "transition"), "transition");
});

test("generation validation separates independent generation from start-frame requirements", () => {
  const shot = shotFixture();
  assert.throws(
    () => validateFrameReferenceMode(shot, "inherit", { hasStartFrameReference: false }),
    /必须先选择首帧/
  );
  assert.throws(
    () => validateFrameReferenceMode(shot, "transition", { hasStartFrameReference: false }),
    /必须先选择首帧/
  );
  assert.equal(
    validateFrameReferenceMode(shot, "independent", { hasStartFrameReference: false }),
    "independent"
  );
});

test("structured end-frame references ignore Changes and video-only characters", async () => {
  const references = [{
    characterName: "甲",
    referenceImageDataUrl: image(70)
  }, {
    characterName: "乙",
    referenceImageDataUrl: image(71)
  }];
  const shot = shotFixture();
  shot.startFrame.characters = [{ name: "甲" }];
  shot.endFrame.characters = [{ name: "甲" }];
  shot.motion.primaryAction = "甲抬起右手，乙在画外说话";
  shot.motion.audio = { speaker: "乙", dialogue: "画外音" };
  shot.videoPrompt = "乙的画外音继续，镜头保持不变";

  const beforeReferences = shotRelatedCharacterReferences(shot, references, { frameKind: "end" });
  const beforeManifest = await buildFrameReferenceManifest({
    frameKind: "end",
    frameReferenceMode: "independent",
    characterReferences: beforeReferences
  });
  const beforeHash = await computeDependencyHash({
    endState: shot.endFrame,
    referenceImages: beforeManifest.additionalReferences,
    frameReferenceMode: "independent"
  });

  shot.motion.primaryAction = "乙在画外换了一句台词";
  shot.motion.audio.dialogue = "新的画外音";
  shot.videoPrompt = "只修改视频过程描述，乙仍不出现在尾帧";
  const afterReferences = shotRelatedCharacterReferences(shot, references, { frameKind: "end" });
  const afterManifest = await buildFrameReferenceManifest({
    frameKind: "end",
    frameReferenceMode: "independent",
    characterReferences: afterReferences
  });
  const afterHash = await computeDependencyHash({
    endState: shot.endFrame,
    referenceImages: afterManifest.additionalReferences,
    frameReferenceMode: "independent"
  });

  assert.deepEqual(beforeReferences.map((item) => item.characterName), ["甲"]);
  assert.deepEqual(afterReferences.map((item) => item.characterName), ["甲"]);
  assert.equal(afterHash, beforeHash);
});

test("cross-shot tail reuse is limited to the same source scene, sceneId and camera", () => {
  const previous = shotFixture();
  previous.sourceSceneId = "SOURCE01";
  const current = shotFixture();
  current.shotId = "A02";
  current.sourceSceneId = "SOURCE01";
  current.startFrame.camera = structuredClone(previous.endFrame.camera);
  assert.equal(canReusePreviousEndFrameAsStart(previous, current), true);

  const crossScene = structuredClone(current);
  crossScene.sceneId = "LOC02";
  crossScene.startFrame.environment.sceneId = "LOC02";
  assert.equal(canReusePreviousEndFrameAsStart(previous, crossScene), false);

  const changedSourceScene = structuredClone(current);
  changedSourceScene.sourceSceneId = "SOURCE02";
  assert.equal(canReusePreviousEndFrameAsStart(previous, changedSourceScene), false);

  const changedCamera = structuredClone(current);
  changedCamera.startFrame.camera.angle = "俯视";
  assert.equal(canReusePreviousEndFrameAsStart(previous, changedCamera), false);

  const inconsistentPreviousEndpoint = structuredClone(previous);
  inconsistentPreviousEndpoint.endFrame.environment.sceneId = "LOC02";
  assert.equal(canReusePreviousEndFrameAsStart(inconsistentPreviousEndpoint, current), false);

  const inconsistentCurrentEndpoint = structuredClone(current);
  inconsistentCurrentEndpoint.startFrame.environment.sceneId = "LOC02";
  assert.equal(canReusePreviousEndFrameAsStart(previous, inconsistentCurrentEndpoint), false);

  const missingPreviousCamera = structuredClone(previous);
  delete missingPreviousCamera.endFrame.camera;
  assert.equal(canReusePreviousEndFrameAsStart(missingPreviousCamera, current), false);

  const missingCurrentCamera = structuredClone(current);
  delete missingCurrentCamera.startFrame.camera;
  assert.equal(canReusePreviousEndFrameAsStart(previous, missingCurrentCamera), false);
});
