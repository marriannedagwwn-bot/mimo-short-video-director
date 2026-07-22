export function shotRelatedCharacterReferences(shot = {}, characterReferences = []) {
  const references = Array.isArray(characterReferences) ? characterReferences.filter(Boolean) : [];
  if (!references.length) return [];
  const shotText = normalizeShotText(shot);
  const matched = references.filter((item) => characterMatchesShot(item, shotText));
  if (hasStructuredPromptSource(shot)) return matched;
  return matched.length ? matched : references;
}

export function uploadedReferenceImages(characterReferences = [], maxImages = 6) {
  return (Array.isArray(characterReferences) ? characterReferences : [])
    .filter((item) => item?.referenceImageDataUrl)
    .slice(0, maxImages);
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
