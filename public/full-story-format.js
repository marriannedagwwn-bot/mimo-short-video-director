export const FULL_STORY_SCHEMA_VERSION = "full_story/1.1";

export function isNarrativeFullStory(value) {
  return value?.schemaVersion === FULL_STORY_SCHEMA_VERSION;
}
