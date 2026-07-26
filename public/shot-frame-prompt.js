import { compileShotNegativePrompt } from "./negative-prompts.js";

export function buildShotFrameImagePrompt(input = {}) {
  const shot = input.shot || {};
  const visualBible = input.visualBible || {};
  const frameKind = input.frameKind === "end" ? "end" : "start";
  const frameLabel = frameKind === "end" ? "尾帧" : "首帧";
  const framePrompt = frameKind === "end" ? shot.endFramePrompt : shot.startFramePrompt;
  const characterReferences = Array.isArray(input.characterReferences) ? input.characterReferences : [];
  const sceneReference = input.sceneReference || null;
  const referenceManifest = normalizeReferenceManifest(input.referenceManifest);
  const frameReferenceMode = normalizeFrameReferenceMode(input.frameReferenceMode, frameKind);
  const characterMappings = manifestCharacterMappings(referenceManifest);
  const framePromptText = buildFramePromptText(framePrompt, characterMappings, frameLabel);
  const sceneReferenceText = buildSceneReferenceText(sceneReference);
  const sceneContinuityText = buildFrameReferenceModeText({
    shot,
    frameKind,
    frameReferenceMode,
    referenceManifest,
    sceneReference
  });
  const characterReferenceText = buildCharacterReferenceText(characterReferences, characterMappings);
  const promptBindingsText = buildPromptBindingsText(referenceManifest);
  const hasReferenceImage = referenceManifest.providerImages.length > 0
    || characterReferences.some((item) => item?.referenceImageDataUrl);
  const referenceNote = hasReferenceImage
    ? "参考图只承担下方绑定声明的角色或端点职责；不得交换角色、改写绑定或让一张图控制未声明的内容。"
    : "未提供角色参考图，请严格依据角色文字设定保持一致。";
  const styleText = [
    visualBible.overallStyle ? `整体风格：${visualBible.overallStyle}` : "",
    visualBible.animationStyle ? `动画风格：${visualBible.animationStyle}` : "",
    visualBible.colorPalette?.length ? `色彩：${visualBible.colorPalette.join(" / ")}` : "",
    visualBible.lighting ? `光线：${visualBible.lighting}` : "",
    visualBible.cameraLanguage ? `镜头语言：${visualBible.cameraLanguage}` : ""
  ].filter(Boolean).join("\n");
  const noTextRule = "画面禁止出现任何字幕、对白文字、旁白文字、中文、英文、标题、说明字、对白气泡、漫画拟声词、Logo、水印、UI 文本或边框；对白/字幕信息只用于理解人物情绪和动作，不得渲染成画面文字。";
  const staticFrameRule = [
    `${frameLabel}是静态关键帧，不是连续动作图。只画这一帧被冻结的一瞬间，不要把动作前后两个状态同时画进同一张图。`,
    `${frameKind === "end" ? "只描述 EndState 的可见结果" : "只描述 StartState 的可见起点"}；不要写“准备、即将、将要、想要、试图”等无法直接画出的意图，也不要展示变化过程。`
  ].join("\n");
  const negativePromptApplication = compileShotFrameNegativePrompt(shot);
  const positiveIdentityConstraint = negativePromptApplication.positiveConstraints.join("\n");
  const prompt = [
    `生成竖屏 9:16 动画短视频分镜${frameLabel}图。`,
    referenceNote,
    promptBindingsText,
    styleText,
    sceneReferenceText,
    characterReferenceText ? `角色参考：\n${characterReferenceText}` : "",
    staticFrameRule,
    sceneContinuityText,
    framePromptText,
    positiveIdentityConstraint,
    `要求：单张清晰可用的关键帧图片；构图稳定；不要生成多格漫画、分屏、动作轨迹、连环画或前后对比图；${noTextRule}；不要改变角色身份。`
  ].filter(Boolean).join("\n");
  if (!framePrompt) throw new Error(`${frameLabel}提示词为空，无法生成镜头图。`);
  return prompt;
}

export function buildFramePromptText(framePrompt = "", characterMappings = [], frameLabel = "首帧") {
  const text = stripLocationOwnerAppearance(String(framePrompt || "").trim());
  if (!text) return "";
  if (!characterMappings.length) return `${frameLabel}画面提示词：${text}`;
  const sanitized = sanitizeImageMappedFramePrompt(text, characterMappings);
  return `${frameLabel}画面提示词（人物身份和外观以参考图绑定为准；以下只保留可见场景、姿态、手部、道具、视线和表情）：${sanitized}`;
}

export function buildFrameReferenceModeText(input = {}) {
  const frameKind = input.frameKind === "end" ? "end" : "start";
  const sceneReference = input.sceneReference || null;
  const referenceAnchor = sceneReferenceAnchor(sceneReference);
  if (frameKind !== "end") {
    return [
      "StartState：生成动作开始时已经可见的静态状态，不描述动作意图或后续过程。",
      referenceAnchor ? `当前镜头场景锚点：${referenceAnchor}` : ""
    ].filter(Boolean).join("\n");
  }

  const shot = input.shot || {};
  const frameReferenceMode = normalizeFrameReferenceMode(input.frameReferenceMode, "end");
  const referenceManifest = normalizeReferenceManifest(input.referenceManifest);
  const startFrameToken = referenceManifest.providerImages
    .find((item) => item?.role === "start_frame" && item?.token)?.token || "";
  const sceneId = String(shot?.endFrame?.environment?.sceneId || shot?.sceneId || sceneReference?.sceneId || "").trim();
  const sameSceneRule = sceneId
    ? `场景边界：尾帧仍属于 sceneId=${sceneId}，不得切换地点或进入其它 sceneId。`
    : "场景边界：不得切换地点；跨场景不属于当前普通镜头。";

  if (frameReferenceMode === "inherit") {
    return [
      startFrameToken ? `${startFrameToken} 是当前镜头首帧视觉基底。` : "当前镜头首帧是尾帧的强视觉基底。",
      "只生成 EndState 的单张静态结果；保持首帧的场景结构、机位、景别、构图和光线，只改变 EndState 明确写出的角色姿态、手部、道具、视线、表情和位置。",
      sameSceneRule,
      "不要展示动作过程。"
    ].join("\n");
  }
  if (frameReferenceMode === "transition") {
    return [
      startFrameToken ? `${startFrameToken} 用于锁定人物、服装、道具、同一场景内容和视觉风格。` : "当前镜头首帧只用于锁定人物、服装、道具、同一场景内容和视觉风格。",
      "只生成 EndState 的单张静态结果；采用 EndState 指定的新机位、构图、光线或同场景物体状态，不要求与首帧像素级一致。",
      sameSceneRule,
      "不要展示变化过程。"
    ].join("\n");
  }
  if (frameReferenceMode === "independent") {
    return [
      "独立生成 EndState 的单张静态尾帧，不使用首帧作为视觉参考。",
      "只读取 EndState 中可见的角色状态、场景、摄影机和光线；角色身份只由角色参考图或文字设定锁定。",
      sameSceneRule,
      "不要展示动作过程。"
    ].join("\n");
  }
  return [
    "只生成 EndState 的单张静态结果，不复述 StartState，不展示动作过程。",
    sameSceneRule
  ].join("\n");
}

export function compileShotFrameNegativePrompt(shot = {}) {
  const compiled = compileShotNegativePrompt(shot, "image");
  const positiveConstraintEntries = compiled.negativePromptEntries.filter((entry) => (
    entry.priority === "high" && entry.reasonCode === "explicit_identity_conflict"
  ));
  const ignoredEntries = compiled.negativePromptEntries.filter((entry) => !positiveConstraintEntries.includes(entry));
  return {
    provider: "Jimeng",
    target: "image",
    negativePromptEntries: compiled.negativePromptEntries,
    compiledNegativePrompt: compiled.compiledNegativePrompt,
    appliedMode: positiveConstraintEntries.length ? "positive_constraint" : "not_supported",
    positiveConstraintEntries,
    ignoredEntries,
    providerIgnored: ignoredEntries.length > 0,
    positiveConstraints: positiveConstraintEntries.length
      ? ["角色身份正向锁定：严格沿用当前正向角色设定与参考图中的身份、物种和已授权外观特征。"]
      : []
  };
}

function uniqueNonEmpty(values = []) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const text = String(value || "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    output.push(text);
  }
  return output;
}

function buildSceneReferenceText(sceneReference = null) {
  if (!sceneReference) return "";
  const lines = [
    `场景参考（必须继承，不要重新设计地点）：${sceneReference.sceneId || ""} ${sceneReference.sceneName || ""}`.trim(),
    sceneReference.environmentPrompt ? `场景画面：${sceneReference.environmentPrompt}` : "",
    Array.isArray(sceneReference.continuityAnchors) && sceneReference.continuityAnchors.length ? `场景连续性锚点：${sceneReference.continuityAnchors.join(" / ")}` : ""
  ].filter(Boolean);
  return lines.join("\n");
}

function sceneReferenceAnchor(sceneReference = null) {
  if (!sceneReference) return "";
  return uniqueNonEmpty([
    sceneReference.sceneName,
    ...(Array.isArray(sceneReference.continuityAnchors) ? sceneReference.continuityAnchors : [])
  ]).join("，").slice(0, 220);
}

function sanitizeImageMappedFramePrompt(framePrompt = "", characterMappings = []) {
  let text = String(framePrompt || "").trim();
  characterMappings.forEach((item) => {
    const name = String(item.characterName || "").trim();
    const token = String(item.token || "").trim();
    if (!name || !token) return;
    const namePattern = new RegExp(`${escapeRegExp(name)}(?:（[^）]*）)?`, "gu");
    text = text.replace(namePattern, (match, offset, fullText) => {
      const after = suffixAfterOptionalParenthetical(fullText, offset + match.length);
      if (isLocationOwnerSuffix(after)) return String(name);
      return `${name}（${token}）`;
    });
  });
  text = stripMappedCharacterAppearancePrefix(text, characterMappings);
  return removeAppearanceClauses(text);
}

function stripLocationOwnerAppearance(text = "") {
  return String(text || "").replace(/([\p{L}\p{N}_-]{1,12})（[^）]{0,220}）(?=(?:的)?(?:家|家里|院子|小院|院落|庭院|院|屋子|屋|房间|厨房|客厅|卧室|门口|门前|花园|菜园|农田|田地|学校|教室|办公室|店铺|店|摊位|摊|路边|村口|院墙|餐桌|房子|宅院))/gu, "$1");
}

function removeAppearanceClauses(text = "") {
  const parts = String(text || "").split(/([，。；,;])/u);
  const kept = [];
  for (let index = 0; index < parts.length; index += 2) {
    const clause = parts[index] || "";
    const delimiter = parts[index + 1] || "";
    if (isAppearanceClause(clause)) continue;
    kept.push(clause + delimiter);
  }
  const cleaned = kept.join("").replace(/^[，。；,;]+|[，。；,;]+$/gu, "").trim();
  return cleaned || text;
}

function stripMappedCharacterAppearancePrefix(text = "", characterMappings = []) {
  let output = String(text || "");
  characterMappings.forEach((item) => {
    const name = String(item.characterName || "").trim();
    const token = String(item.token || "").trim();
    if (!name || !token) return;
    const mappedName = `${name}（${token}）`;
    const pattern = new RegExp(`(^|[，。；,;])([^，。；,;]{1,40})${escapeRegExp(mappedName)}`, "gu");
    output = output.replace(pattern, (match, delimiter, prefix) => {
      if (!isAppearanceClause(prefix)) return match;
      return `${delimiter}${mappedName}`;
    });
  });
  return output;
}

function isAppearanceClause(value = "") {
  return /(穿着|身穿|头顶|身后|发型|发色|头发|长发|短发|耳朵|狼耳|猫耳|狐耳|尾巴|猫尾|狐尾|狼尾|眼睛|瞳孔|脸型|面部|衣服|服装|外套|衬衫|裙|长袜|背带裙|校服|病号服|围裙|布衫)/u.test(String(value || ""));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
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

function buildCharacterReferenceText(characterReferences = [], characterMappings = []) {
  const mappingByName = new Map(characterMappings.map((item) => [item.characterName, item]));
  const lines = characterReferences.map((item) => {
    const characterName = String(item?.characterName || "").trim();
    const mapping = mappingByName.get(characterName);
    if (mapping?.token) {
      return `${characterName || "角色"}：${mapping.token}（身份与外观参考）`;
    }
    return [
      characterName ? `角色：${characterName}` : "",
      item.appearancePrompt ? `外观：${item.appearancePrompt}` : "",
      item.consistencyTags?.length ? `一致性标签：${item.consistencyTags.join(" / ")}` : ""
    ].filter(Boolean).join("；");
  }).filter(Boolean);
  return lines.join("\n");
}

function normalizeFrameReferenceMode(mode, frameKind) {
  if (frameKind !== "end") return "";
  return ["inherit", "transition", "independent"].includes(mode) ? mode : "";
}

function normalizeReferenceManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { providerImages: [], promptBindings: [] };
  }
  return {
    ...manifest,
    providerImages: Array.isArray(manifest.providerImages) ? manifest.providerImages.filter(Boolean) : [],
    promptBindings: Array.isArray(manifest.promptBindings) ? manifest.promptBindings.filter(Boolean) : []
  };
}

function manifestCharacterMappings(referenceManifest) {
  const seen = new Set();
  return referenceManifest.providerImages.flatMap((item) => {
    const characterName = String(item?.characterName || "").trim();
    const token = String(item?.token || "").trim();
    if (!characterName || !token || item?.role === "start_frame") return [];
    const key = `${characterName}\u0000${token}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ characterName, token }];
  });
}

function buildPromptBindingsText(referenceManifest) {
  if (!referenceManifest.promptBindings.length) return "";
  const lines = referenceManifest.promptBindings.flatMap((binding) => {
    const token = String(binding?.token || "").trim();
    if (!token) return [];
    const description = String(binding?.description || binding?.role || "参考图").trim();
    return [`${token}：${description}`];
  });
  return lines.length ? `参考图绑定（顺序与服务端上传顺序一致）：\n${lines.join("\n")}` : "";
}
