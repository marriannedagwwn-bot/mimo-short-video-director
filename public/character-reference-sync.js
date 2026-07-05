export function syncShotCharacterReference(plan, previousCharacter, updatedCharacter) {
  const characterName = String(updatedCharacter?.characterName || previousCharacter?.characterName || "").trim();
  if (!characterName || !Array.isArray(plan?.shotPlan)) return 0;
  const visualAnchor = buildCharacterVisualAnchor(updatedCharacter, characterName);
  if (!visualAnchor) return 0;
  const fields = ["startFramePrompt", "endFramePrompt", "videoPrompt", "characterAction", "continuityNotes"];
  let changed = 0;
  for (const shot of plan.shotPlan) {
    if (!shot || !fields.some((field) => String(shot[field] || "").includes(characterName))) continue;
    let shotChanged = false;
    for (const field of fields) {
      const next = syncCharacterText(String(shot[field] || ""), characterName, visualAnchor);
      if (next !== String(shot[field] || "")) {
        shot[field] = next;
        shotChanged = true;
      }
    }
    if (shotChanged) changed += 1;
  }
  return changed;
}

export function buildCharacterVisualAnchor(character, characterName = "") {
  const appearance = String(character?.appearancePrompt || "").trim();
  const tags = Array.isArray(character?.consistencyTags) ? character.consistencyTags.map((item) => String(item || "").trim()).filter(Boolean) : [];
  const source = [appearance, tags.join("，")].filter(Boolean).join("，");
  const parts = source
    .split(/[。；;\n\r]/u)
    .map((item) => stripLeadingCharacterName(item.trim(), characterName))
    .filter(Boolean);
  return (parts[0] || stripLeadingCharacterName(source, characterName)).slice(0, 180).trim();
}

export function syncCharacterText(text, characterName, visualAnchor) {
  if (!text || !text.includes(characterName) || !visualAnchor) return text;
  const anchor = `${characterName}（${visualAnchor}）`;
  const escapedName = escapeRegExp(characterName);
  const anchoredPattern = new RegExp(`${escapedName}（[^）]{0,220}）`, "gu");
  const anchored = replaceCharacterMentions(text, anchoredPattern, anchor, { replaceAll: true });
  if (anchored.changed) return anchored.text;
  return replaceCharacterMentions(text, new RegExp(escapedName, "gu"), anchor, { replaceAll: false }).text;
}

function stripLeadingCharacterName(value, characterName) {
  const text = String(value || "").trim();
  const name = String(characterName || "").trim();
  if (!name) return text;
  return text
    .replace(new RegExp(`^(参考图中的)?${escapeRegExp(name)}[，,、：:\\s]*`, "u"), "")
    .trim();
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceCharacterMentions(text, pattern, replacement, options = {}) {
  let changed = false;
  const next = String(text || "").replace(pattern, (match, offset, fullText) => {
    if (changed && !options.replaceAll) return match;
    const after = suffixAfterOptionalParenthetical(fullText, offset + match.length);
    if (isLocationOwnerSuffix(after)) return match;
    changed = true;
    return replacement;
  });
  return { text: next, changed };
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
