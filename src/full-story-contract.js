// Explicitly version the smaller Full Story contract. Unversioned artifacts
// remain legacy data; readers must not migrate them or change their digest.
export { FULL_STORY_SCHEMA_VERSION, isNarrativeFullStory } from "../public/full-story-format.js";

export const NARRATIVE_FULL_STORY_FIELDS = Object.freeze([
  "schemaVersion", "selectedVariantId", "title", "oneLinePremise",
  "targetDurationSeconds", "shootingSynopsis", "characterBible", "sceneScript",
  "keyProps", "dialogueStyleGuide", "uncertainties"
]);

const candidateFactFields = Object.freeze([
  "id", "title", "oneLineHook", "logline", "narrativeMode", "characterSetup",
  "newTask", "emotionalMedium", "environmentPressure", "storyOutline",
  "keyChoiceBeat", "climaxBeat", "keyChoice", "climax", "emotionalPayoff",
  "endingRitual", "visualPotential"
]);

function projectFields(value, fields) {
  return Object.fromEntries(fields
    .filter((field) => Object.hasOwn(value || {}, field))
    .map((field) => [field, structuredClone(value[field])]));
}

// A read-only view of the already selected Candidate, not a new model-written
// kernel, Artifact or source of facts. In particular, do not feed source proof
// pairs, Brief evaluation labels or draft dialogue back into story generation.
// Full Story writes dialogue from the selected actions and user speech rules;
// candidate keyDialogueDirections must not become a second plot authority.
export function fullStoryCandidateFacts(variant = {}) {
  return projectFields(variant, candidateFactFields);
}

const userDialogueSourcePaths = new Set([
  "creatorProfile.fixedCharacter",
  "creatorProfile.constraints"
]);

// Older Guardrails may turn reference dialogue style into a speech rule.
// Only wholly user-sourced rules have authority in this read-only projection.
// Mixed/unknown provenance cannot authorize the whole rule; never guess which
// words to remove or rewrite the signed upstream Artifact to make it fit.
function fullStoryUserDialogueRules(dialogueRules) {
  return (Array.isArray(dialogueRules) ? dialogueRules : [])
    .filter(rule => typeof rule?.text === "string" && rule.text.trim()
      && Array.isArray(rule.triggerEvidence) && rule.triggerEvidence.length > 0
      && rule.triggerEvidence.every(entry => userDialogueSourcePaths.has(entry?.sourcePath)
        && typeof entry.evidence === "string" && entry.evidence.trim()))
    .map(rule => projectFields(rule, ["text", "triggerEvidence"]));
}

// Called only after the workflow has verified the original full boundary.
// Keep every granted/forbidden trait, including its scope, while leaving
// signatures and upstream source prose out of the model request.
export function fullStoryCharacterFacts(visualGuardrails = {}) {
  const boundary = visualGuardrails.fixedCharacterBoundary || {};
  return {
    ...projectFields(boundary, ["characterName", "canonicalDescription", "bodyForm"]),
    ...Object.fromEntries(["requiredTraits", "allowedTraits", "forbiddenTraits"].map((field) => [
      field,
      (Array.isArray(boundary[field]) ? boundary[field] : []).map((trait) => (
        projectFields(trait, ["canonicalName", "terms", "scope"])
      ))
    ])),
    dialogueRules: fullStoryUserDialogueRules(visualGuardrails.dialogueRules)
  };
}
