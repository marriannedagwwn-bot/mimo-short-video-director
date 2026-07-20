import { compileShotNegativePrompt } from "./negative-prompts.js";

export function buildShotFrameImagePrompt(input = {}) {
  const shot = input.shot || {};
  const visualBible = input.visualBible || {};
  const frameKind = input.frameKind === "end" ? "end" : "start";
  const frameLabel = frameKind === "end" ? "尾帧" : "首帧";
  const framePrompt = frameKind === "end" ? shot.endFramePrompt : shot.startFramePrompt;
  const characterReferences = Array.isArray(input.characterReferences) ? input.characterReferences : [];
  const sceneReference = input.sceneReference || null;
  const framePromptText = buildFramePromptText(framePrompt, characterReferences, frameLabel);
  const sceneReferenceText = buildSceneReferenceText(sceneReference);
  const sceneContinuityText = buildSceneContinuityText(shot, characterReferences, frameKind, sceneReference);
  const characterReferenceText = buildCharacterReferenceText(characterReferences);
  const hasReferenceImage = characterReferences.some((item) => item.referenceImageDataUrl);
  const referenceNote = hasReferenceImage
    ? "已提供角色参考图。@图一=第1张输入图片，@图二=第2张输入图片，依此类推。带 @图 的角色必须完全沿用对应输入参考图中的人物外观、服装、发型、配色、年龄感和可见身份特征，不再使用文字外观描述，不得重新设计成普通新角色。"
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
    "严格锁定画幅、景别、机位、主体位置、手部/道具状态、视线方向、表情、背景层级和光线；不要自行改成其它景别或镜头角度。"
  ].join("\n");
  const negativePromptApplication = compileShotFrameNegativePrompt(shot);
  const positiveIdentityConstraint = negativePromptApplication.positiveConstraints.join("\n");
  const prompt = [
    `生成竖屏 9:16 动画短视频分镜${frameLabel}图。`,
    referenceNote,
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

function buildFramePromptText(framePrompt = "", characterReferences = [], frameLabel = "首帧") {
  const text = stripLocationOwnerAppearance(String(framePrompt || "").trim());
  if (!text) return "";
  const imageReferences = characterReferences.filter((item) => item?.referenceImageDataUrl);
  if (!imageReferences.length) return `${frameLabel}画面提示词：${text}`;
  const sanitized = sanitizeImageMappedFramePrompt(text, imageReferences);
  return `${frameLabel}画面提示词（人物外观、服装、发型、年龄感和身份特征以 @图 为准；以下只保留场景、动作、道具和情绪）：${sanitized}`;
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

function buildSceneContinuityText(shot = {}, characterReferences = [], frameKind = "start", sceneReference = null) {
  const referenceAnchor = sceneReferenceAnchor(sceneReference);
  if (frameKind !== "end") return referenceAnchor ? `当前镜头场景锚点：${referenceAnchor}` : "";
  const anchor = referenceAnchor || extractSceneAnchor(shot.startFramePrompt, characterReferences);
  const baseRule = "同镜头连续性锁定：尾帧必须与首帧保持同一地点、同一室内/户外属性、同一背景层级、同一景别、同一机位方向和同一光线；只改变人物动作、表情、手部和道具状态，不要重新设计环境。";
  const guard = sceneTransitionGuard(anchor);
  if (!anchor) return `${baseRule}\n${guard}`;
  return `${baseRule}\n首帧场景锚点（只用于继承场景，不要画首帧动作）：${anchor}\n${guard}`;
}

function sceneReferenceAnchor(sceneReference = null) {
  if (!sceneReference) return "";
  return uniqueNonEmpty([
    sceneReference.sceneName,
    ...(Array.isArray(sceneReference.continuityAnchors) ? sceneReference.continuityAnchors : [])
  ]).join("，").slice(0, 220);
}

function extractSceneAnchor(framePrompt = "", characterReferences = []) {
  let text = stripLocationOwnerAppearance(String(framePrompt || "").trim());
  const imageReferences = characterReferences.filter((item) => item?.referenceImageDataUrl);
  if (imageReferences.length) text = sanitizeImageMappedFramePrompt(text, imageReferences);
  const clauses = text
    .split(/([。；;])/u)
    .flatMap((part) => String(part || "").split(/[，,]/u))
    .map((item) => item.replace(/[。；;,，]+$/gu, "").trim())
    .filter(Boolean);
  const sceneClauses = clauses.filter(isSceneClause);
  const anchor = uniqueNonEmpty(sceneClauses).slice(0, 5).join("，");
  if (anchor) return anchor.slice(0, 180);
  return clauses.slice(0, 2).join("，").slice(0, 120);
}

function isSceneClause(value = "") {
  return /(地点|时间|天气|背景|光线|阳光|晨光|夕阳|阴天|雨|雪|雾|夜晚|清晨|黄昏|室内|室外|户外|屋内|屋外|院子|小院|院落|庭院|村庄|石板路|路边|村口|街道|摊位|公交|车站|山洞|梯田|草地|草堆|田地|农田|森林|树林|绿植|树|木质|栅栏|围栏|院墙|家|客厅|房间|卧室|厨房|木工房|门口|门前|窗户|走廊|玄关|中景|近景|远景|特写|平视|俯视|仰视|机位|景别|镜头)/u.test(String(value || ""));
}

function sceneTransitionGuard(anchor = "") {
  const text = String(anchor || "");
  const outdoor = /(室外|户外|院子|小院|院落|庭院|村庄|石板路|路边|村口|街道|摊位|车站|山洞|梯田|草地|草堆|田地|农田|森林|树林|绿植|树|栅栏|围栏|院墙)/u.test(text);
  const indoor = /(室内|屋内|客厅|房间|卧室|厨房|木工房|走廊|玄关|窗户|门内)/u.test(text);
  if (outdoor && !indoor) return "禁止切换到室内、屋内、玄关、客厅、厨房、走廊、门内或窗边等新场景。";
  if (indoor && !outdoor) return "禁止切换到室外、院子、街道、山野、天空或其它户外新场景。";
  return "禁止从室外切到室内，或从室内切到室外；禁止更换地点。";
}

function sanitizeImageMappedFramePrompt(framePrompt = "", imageReferences = []) {
  let text = String(framePrompt || "").trim();
  imageReferences.forEach((item, index) => {
    const name = String(item.characterName || "").trim();
    if (!name) return;
    const imageLabel = `@图${toChineseNumber(index + 1)}`;
    const namePattern = new RegExp(`${escapeRegExp(name)}(?:（[^）]*）)?`, "gu");
    text = text.replace(namePattern, (match, offset, fullText) => {
      const after = suffixAfterOptionalParenthetical(fullText, offset + match.length);
      if (isLocationOwnerSuffix(after)) return String(name);
      return `${name}（${imageLabel}）`;
    });
  });
  text = stripMappedCharacterAppearancePrefix(text, imageReferences);
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

function stripMappedCharacterAppearancePrefix(text = "", imageReferences = []) {
  let output = String(text || "");
  imageReferences.forEach((item, index) => {
    const name = String(item.characterName || "").trim();
    if (!name) return;
    const mappedName = `${name}（@图${toChineseNumber(index + 1)}）`;
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

function buildCharacterReferenceText(characterReferences = []) {
  let imageIndex = 0;
  const lines = characterReferences.map((item) => {
    if (item?.referenceImageDataUrl) {
      imageIndex += 1;
      return `${item.characterName || `角色${imageIndex}`}：@图${toChineseNumber(imageIndex)}（第${imageIndex}张输入参考图）`;
    }
    return [
      item.characterName ? `角色：${item.characterName}` : "",
      item.appearancePrompt ? `外观：${item.appearancePrompt}` : "",
      item.consistencyTags?.length ? `一致性标签：${item.consistencyTags.join(" / ")}` : ""
    ].filter(Boolean).join("；");
  }).filter(Boolean);
  if (imageIndex) {
    lines.unshift("图片映射如下，请按映射识别人物：");
  }
  return lines.join("\n");
}

function toChineseNumber(value) {
  return ["零", "一", "二", "三", "四", "五", "六"][Number(value)] || String(value);
}
