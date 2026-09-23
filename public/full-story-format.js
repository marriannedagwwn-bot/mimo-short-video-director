export const FULL_STORY_SCHEMA_VERSION = "full_story/1.1";
export const FULL_STORY_CAST_SCHEMA_VERSION = "full_story/1.2";

export function hasFullStoryCharacterRegistry(value) {
  return value?.schemaVersion === FULL_STORY_CAST_SCHEMA_VERSION;
}

export function isNarrativeFullStory(value) {
  return value?.schemaVersion === FULL_STORY_SCHEMA_VERSION || hasFullStoryCharacterRegistry(value);
}
