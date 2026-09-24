import { FULL_STORY_CAST_SCHEMA_VERSION } from "../public/full-story-format.js";
import { OutputContractError } from "./validation.js";

const facts = ["identity", "appearanceFacts", "personalityFacts", "speechRules", "relationshipToProtagonist", "storyRole"];

export function storyCharacterNames(story) {
  return [...new Set((story.sceneScript || []).flatMap(scene => [
    ...(scene.characters || []), ...(scene.offscreenSoundSources || []),
    ...(scene.dialogue || []).map(row => row.speaker)
  ]))];
}

export function fullStoryCharacterRegistryInput(fullStory, creatorProfile = {}) {
  const source = { fullStory: structuredClone(fullStory), userSettings: {
    fixedCharacter: creatorProfile.fixedCharacter || "", constraints: creatorProfile.constraints || ""
  } };
  const evidenceCatalog = [];
  const visit = (value, path) => {
    if (typeof value === "string" && value.trim()) {
      evidenceCatalog.push({ sourceId: `E${String(evidenceCatalog.length + 1).padStart(3, "0")}`, path, text: value });
    } else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) visit(child, `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`);
    }
  };
  visit(source, "");
  return { ...source, protagonistName: fullStory.characterBible.protagonist.name,
    actualCharacterNames: storyCharacterNames(fullStory), evidenceCatalog };
}

export function mergeFullStoryCharacterRegistry(story, response, input) {
  const fail = message => { throw new OutputContractError(`完整角色表：${message}`); };
  if (!response || Object.keys(response).join(",") !== "supportingCharacters" || !Array.isArray(response.supportingCharacters)) fail("输出只能包含 supportingCharacters 数组");
  const expected = input.actualCharacterNames.filter(name => name !== input.protagonistName);
  const names = response.supportingCharacters.map(row => row?.name);
  if (names.length !== expected.length || names.length !== new Set(names).size || expected.some(name => !names.includes(name))) fail("必须逐字覆盖所有实际出镜或发声的非主角，包括单场角色");
  const catalog = new Map(input.evidenceCatalog.map(row => [row.sourceId, row]));
  const supportingCharacters = response.supportingCharacters.map(row => {
    if (!row || Object.keys(row).sort().join(",") !== ["name", ...facts, "sourceEvidence"].sort().join(",")) fail("角色包含未知字段或缺少字段");
    for (const field of ["identity", "relationshipToProtagonist", "storyRole"]) if (typeof row[field] !== "string") fail(`${row.name}.${field} 必须是字符串`);
    for (const field of ["appearanceFacts", "personalityFacts", "speechRules"]) if (!Array.isArray(row[field]) || row[field].some(text => typeof text !== "string" || !text.trim())) fail(`${row.name}.${field} 必须是非空字符串数组，未知时用 []`);
    if (!Array.isArray(row.sourceEvidence)) fail("sourceEvidence 必须是数组");
    const sourceEvidence = row.sourceEvidence.map(evidence => {
      if (!evidence || Object.keys(evidence).sort().join(",") !== "field,quote,sourceId" || !facts.includes(evidence.field)) fail("来源字段无效");
      const original = catalog.get(evidence.sourceId);
      if (!original || typeof evidence.quote !== "string" || !evidence.quote.trim() || !original.text.includes(evidence.quote)) fail(`${row.name} 的来源摘句不在冻结原文中`);
      return { ...evidence, sourcePath: original.path };
    });
    for (const field of facts) if (row[field].length && !sourceEvidence.some(evidence => evidence.field === field)) fail(`${row.name}.${field} 缺少来源证据`);
    return { ...structuredClone(row), sourceEvidence };
  });
  return { ...structuredClone(story), schemaVersion: FULL_STORY_CAST_SCHEMA_VERSION,
    characterBible: { protagonist: structuredClone(story.characterBible.protagonist), supportingCharacters } };
}

// Demonstration mode only: retain names already in its synthetic story, with
// no invented appearance. Live requests always use the model extraction above.
export function mockFullStoryCharacterRegistry(input) {
  return { supportingCharacters: input.actualCharacterNames.filter(name => name !== input.protagonistName).map(name => ({
    name, identity: "", appearanceFacts: [], personalityFacts: [], speechRules: [],
    relationshipToProtagonist: "", storyRole: "", sourceEvidence: []
  })) };
}
