import { hashDataUrl } from "./frame-dependency.js";

const FRAME_REFERENCE_MODES = new Set(["inherit", "transition", "independent"]);
const MAX_PROVIDER_IMAGES = 6;

export function shotRelatedCharacterReferences(shot = {}, characterReferences = [], {
  frameKind = ""
} = {}) {
  const references = Array.isArray(characterReferences) ? characterReferences.filter(Boolean) : [];
  if (!references.length) return [];
  const shotText = normalizeShotReferenceText(shot, frameKind);
  const matched = references.filter((item) => characterMatchesShot(item, shotText));
  if (hasStructuredPromptSource(shot)) return matched;
  return matched.length ? matched : references;
}

export function uploadedReferenceImages(characterReferences = [], maxImages = 6) {
  return (Array.isArray(characterReferences) ? characterReferences : [])
    .filter((item) => item?.referenceImageDataUrl)
    .slice(0, maxImages);
}

export async function buildFrameReferenceManifest({
  frameKind,
  frameReferenceMode,
  endpointReference,
  characterReferences,
  maxProviderImages = MAX_PROVIDER_IMAGES
} = {}) {
  const kind = normalizeFrameKind(frameKind);
  const mode = normalizeFrameReferenceMode(frameReferenceMode, kind);
  const providerLimit = normalizeProviderLimit(maxProviderImages);
  const usesEndpoint = kind === "end" && (mode === "inherit" || mode === "transition");
  const effectiveProviderLimit = usesEndpoint ? Math.max(1, providerLimit) : providerLimit;

  if (usesEndpoint && !validDataUrl(endpointReference?.dataUrl)) {
    throw new TypeError(`${mode} 模式必须提供有效的首帧视觉参考`);
  }

  const candidates = [];
  if (usesEndpoint) {
    candidates.push({
      role: "start_frame",
      dataUrl: endpointReference.dataUrl,
      sourceShotId: String(endpointReference.sourceShotId || "").trim()
    });
  }

  for (const reference of Array.isArray(characterReferences) ? characterReferences : []) {
    const dataUrl = reference?.referenceImageDataUrl || reference?.dataUrl;
    if (!validDataUrl(dataUrl)) continue;
    candidates.push({
      role: "character_reference",
      dataUrl,
      characterName: String(reference?.characterName || "").trim()
    });
  }

  const hashedCandidates = await Promise.all(candidates.map(async (item) => ({
    ...item,
    contentHash: await hashDataUrl(item.dataUrl)
  })));
  const seenContentHashes = new Set();
  const selected = [];
  if (effectiveProviderLimit > 0) {
    for (const candidate of hashedCandidates) {
      if (seenContentHashes.has(candidate.contentHash)) continue;
      seenContentHashes.add(candidate.contentHash);
      selected.push(candidate);
      if (selected.length >= effectiveProviderLimit) break;
    }
  }
  const providerImages = selected.map((item, arrayIndex) => ({
    index: arrayIndex + 1,
    token: formatProviderImageToken(arrayIndex + 1),
    role: item.role,
    dataUrl: item.dataUrl,
    contentHash: item.contentHash,
    ...(item.characterName ? { characterName: item.characterName } : {}),
    ...(item.sourceShotId ? { sourceShotId: item.sourceShotId } : {})
  }));

  const endpointImage = providerImages.find((item) => item.role === "start_frame") || null;
  const manifestEndpoint = endpointImage ? {
    role: "start_frame",
    dataUrl: endpointImage.dataUrl,
    contentHash: endpointImage.contentHash,
    sourceShotId: endpointImage.sourceShotId || "",
    usedByProvider: true
  } : null;
  const additionalReferences = providerImages
    .filter((item) => item.role !== "start_frame")
    .map((item) => ({
      role: item.role,
      contentHash: item.contentHash,
      ...(item.characterName ? { characterName: item.characterName } : {})
    }));
  const promptBindings = providerImages.map((item) => ({
    token: item.token,
    role: item.role,
    description: referenceBindingDescription(item, mode)
  }));

  return {
    endpointReference: manifestEndpoint,
    providerImages,
    additionalReferences,
    promptBindings
  };
}

export function resolveFrameReferenceMode(shot = {}) {
  ensureSameShotScene(shot);
  const startFrame = shot?.startFrame || {};
  const endFrame = shot?.endFrame || {};
  const cameraIsStable = stableEqual(startFrame.camera, endFrame.camera);
  const lightingIsStable = stableEqual(startFrame.lighting, endFrame.lighting);
  const environmentLayersAreStable = stableEqual(
    {
      timeAndWeather: startFrame.timeAndWeather || "",
      ...environmentLayers(startFrame.environment)
    },
    {
      timeAndWeather: endFrame.timeAndWeather || "",
      ...environmentLayers(endFrame.environment)
    }
  );
  const cameraMoveMode = String(shot?.motion?.cameraMove?.mode || "").trim();
  const motionMode = String(shot?.motion?.mode || "").trim();
  const continuousCameraNeedsDistinctEndpoint = cameraMoveMode === "continuous" && motionMode !== "loop";

  if (
    cameraIsStable
    && lightingIsStable
    && environmentLayersAreStable
    && !continuousCameraNeedsDistinctEndpoint
    && motionMode !== "object_transform"
  ) {
    return "inherit";
  }
  return "transition";
}

export function validateFrameReferenceMode(shot = {}, frameReferenceMode, {
  hasStartFrameReference = true
} = {}) {
  const mode = normalizeFrameReferenceMode(frameReferenceMode, "end");
  ensureSameShotScene(shot);
  if (mode === "independent") return mode;
  if (!hasStartFrameReference) {
    throw new TypeError(`${mode} 模式必须先选择首帧`);
  }
  if (mode === "inherit" && resolveFrameReferenceMode(shot) !== "inherit") {
    throw new TypeError("当前首尾帧的摄影机、光线或环境层级发生变化，不能使用 inherit 模式");
  }
  if (mode === "inherit" && !stableEqual(shot?.startFrame?.styleModifiers, shot?.endFrame?.styleModifiers)) {
    throw new TypeError("inherit 模式不得改变同一镜头的视觉风格");
  }
  if (mode === "inherit") return mode;

  const startFrame = shot?.startFrame || {};
  const endFrame = shot?.endFrame || {};
  const motion = shot?.motion || {};
  const cameraChanged = !stableEqual(startFrame.camera, endFrame.camera);
  const lightingChanged = !stableEqual(startFrame.lighting, endFrame.lighting);
  const environmentChanged = !stableEqual(startFrame.environment, endFrame.environment);
  const charactersChanged = !stableEqual(startFrame.characters, endFrame.characters);
  const timeAndWeatherChanged = startFrame.timeAndWeather !== endFrame.timeAndWeather;
  const styleChanged = !stableEqual(startFrame.styleModifiers, endFrame.styleModifiers);
  if (styleChanged) throw new TypeError("transition 模式不得改变同一镜头的视觉风格");
  if (!(cameraChanged || lightingChanged || environmentChanged || charactersChanged || timeAndWeatherChanged)) {
    throw new TypeError("transition 模式必须在 EndState 中声明至少一个可见终点变化");
  }
  if (cameraChanged && motion?.cameraMove?.mode !== "continuous") {
    throw new TypeError("transition 的摄影机变化必须同时由 motion.cameraMove.mode=continuous 声明");
  }
  if (motion?.cameraMove?.mode === "continuous" && !cameraChanged) {
    throw new TypeError("transition 的连续运镜必须在 EndState.camera 中留下可见终点差异");
  }
  if (lightingChanged && !hasDeclaredFrameChange(motion?.lightingChange)) {
    throw new TypeError("transition 的光线变化必须同时写入 motion.lightingChange");
  }
  if (environmentChanged && !hasDeclaredFrameChange(motion?.environmentChange)) {
    throw new TypeError("transition 的环境变化必须同时写入 motion.environmentChange");
  }
  if (timeAndWeatherChanged
    && !hasDeclaredFrameChange(motion?.environmentChange)
    && !hasDeclaredFrameChange(motion?.lightingChange)) {
    throw new TypeError("transition 的时段或天气变化必须同时写入 motion.environmentChange 或 motion.lightingChange");
  }
  if (charactersChanged && !String(motion?.primaryAction || "").trim()) {
    throw new TypeError("transition 的角色终点变化必须同时由 motion.primaryAction 声明");
  }
  if (motion?.mode === "object_transform" && !(environmentChanged || charactersChanged)) {
    throw new TypeError("object_transform 必须在 EndState 中留下可见物体状态差异");
  }
  return mode;
}

export function canReusePreviousEndFrameAsStart(previousShot = {}, currentShot = {}) {
  const sceneIds = [
    previousShot?.sceneId,
    previousShot?.endFrame?.environment?.sceneId,
    currentShot?.sceneId,
    currentShot?.startFrame?.environment?.sceneId
  ].map((value) => String(value || "").trim());
  const previousSourceSceneId = String(previousShot?.sourceSceneId || "").trim();
  const currentSourceSceneId = String(currentShot?.sourceSceneId || "").trim();
  const previousCamera = previousShot?.endFrame?.camera;
  const currentCamera = currentShot?.startFrame?.camera;
  if (sceneIds.some((sceneId) => !sceneId) || !sceneIds.every((sceneId) => sceneId === sceneIds[0])) return false;
  if (!previousSourceSceneId || previousSourceSceneId !== currentSourceSceneId) return false;
  if (!isNonEmptyRecord(previousCamera) || !isNonEmptyRecord(currentCamera)) return false;
  return stableEqual(previousCamera, currentCamera);
}

function characterMatchesShot(reference = {}, shotText = "") {
  const terms = [
    reference.characterName,
    reference.storyRole,
    reference.identity
  ].map((item) => String(item || "").trim()).filter(Boolean);
  return terms.some((term) => mentionsTermAsCharacter(shotText, term));
}

function normalizeShotText(shot = {}) {
  return [
    shot.shotId,
    shot.sourceSceneId,
    shot.storyPurpose,
    shot.startFramePrompt,
    shot.endFramePrompt,
    shot.videoPrompt,
    shot.cameraMotion,
    shot.characterAction,
    shot.dialogueOrSubtitle,
    shot.soundDesign,
    shot.emotionalTarget,
    structuredPromptText(shot.startFrame),
    structuredPromptText(shot.endFrame),
    structuredPromptText(shot.motion),
    ...(Array.isArray(shot.acceptanceCriteria) ? shot.acceptanceCriteria : [])
  ].map((item) => String(item || "")).join("\n");
}

function normalizeShotReferenceText(shot = {}, frameKind = "") {
  if (!hasStructuredPromptSource(shot)) return normalizeShotText(shot);
  if (frameKind === "start") return structuredPromptText(shot.startFrame);
  if (frameKind === "end") return structuredPromptText(shot.endFrame);
  return [
    structuredPromptText(shot.startFrame),
    structuredPromptText(shot.endFrame)
  ].filter(Boolean).join("\n");
}

function hasStructuredPromptSource(shot) {
  return Boolean(shot?.startFrame && shot?.endFrame && shot?.motion);
}

function structuredPromptText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(structuredPromptText).filter(Boolean).join("\n");
  if (typeof value === "object") return Object.values(value).map(structuredPromptText).filter(Boolean).join("\n");
  return "";
}

function mentionsTermAsCharacter(text = "", term = "") {
  const source = String(text || "");
  const needle = String(term || "").trim();
  if (!source || !needle) return false;
  const pattern = new RegExp(escapeRegExp(needle), "gu");
  let match;
  while ((match = pattern.exec(source))) {
    const after = suffixAfterOptionalParenthetical(source, match.index + needle.length);
    if (isLocationOwnerSuffix(after)) continue;
    return true;
  }
  return false;
}

function suffixAfterOptionalParenthetical(text, startIndex) {
  let after = String(text || "").slice(startIndex);
  if (after.startsWith("（")) {
    const closeIndex = after.indexOf("）");
    if (closeIndex >= 0) after = after.slice(closeIndex + 1);
  }
  return after;
}

function isLocationOwnerSuffix(value = "") {
  return /^(?:的)?(?:家|家里|院子|小院|院落|庭院|院|屋子|屋|房间|厨房|客厅|卧室|门口|门前|花园|菜园|农田|田地|学校|教室|办公室|店铺|店|摊位|摊|路边|村口|院墙|餐桌|房子|宅院)/u.test(String(value || ""));
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function normalizeFrameKind(frameKind) {
  const kind = String(frameKind || "").trim();
  if (kind !== "start" && kind !== "end") {
    throw new TypeError("frameKind 只允许 start 或 end");
  }
  return kind;
}

function normalizeFrameReferenceMode(frameReferenceMode, frameKind) {
  const mode = String(frameReferenceMode || "").trim();
  if (!mode && frameKind === "start") return null;
  if (!FRAME_REFERENCE_MODES.has(mode)) {
    throw new TypeError("frameReferenceMode 只允许 inherit、transition 或 independent");
  }
  return mode;
}

function normalizeProviderLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return MAX_PROVIDER_IMAGES;
  return Math.max(0, Math.min(MAX_PROVIDER_IMAGES, Math.floor(parsed)));
}

function validDataUrl(value) {
  return /^data:image\/[^;,]+(?:;[^,]*)?,/u.test(String(value || ""));
}

function referenceBindingDescription(item, mode) {
  if (item.role === "start_frame") {
    return mode === "inherit"
      ? "当前镜头首帧视觉基底，保持同一场景、机位、构图与光线"
      : "当前镜头首帧内容参考，锁定同场景人物、服装、道具与视觉风格";
  }
  return item.characterName
    ? `角色“${item.characterName}”的外观与身份参考`
    : "角色外观与身份参考";
}

function formatProviderImageToken(index) {
  const numerals = ["零", "一", "二", "三", "四", "五", "六"];
  return `@图${numerals[index] || String(index)}`;
}

function ensureSameShotScene(shot) {
  const shotSceneId = String(shot?.sceneId || "").trim();
  const startSceneId = String(shot?.startFrame?.environment?.sceneId || "").trim();
  const endSceneId = String(shot?.endFrame?.environment?.sceneId || "").trim();
  if (!shotSceneId || !startSceneId || !endSceneId) {
    throw new TypeError("镜头及首尾帧必须提供 sceneId");
  }
  if (shotSceneId !== startSceneId || shotSceneId !== endSceneId) {
    throw new TypeError("transition 只允许同一 sceneId；跨场景镜头不属于本次首尾帧参考策略");
  }
}

function environmentLayers(environment = {}) {
  return {
    sceneId: environment?.sceneId || "",
    foreground: environment?.foreground || "",
    midground: environment?.midground || "",
    background: environment?.background || "",
    atmosphere: environment?.atmosphere || ""
  };
}

function stableEqual(left, right) {
  return stableSerialize(left) === stableSerialize(right);
}

function isNonEmptyRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length);
}

function stableSerialize(value) {
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hasDeclaredFrameChange(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  return !/^(?:无|不变|没有变化|保持(?:不变|一致|连续|原样)?|同首帧)/u.test(text);
}
