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
  if (anchoredPattern.test(text)) {
    return text.replace(anchoredPattern, anchor);
  }
  return text.replace(characterName, anchor);
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
