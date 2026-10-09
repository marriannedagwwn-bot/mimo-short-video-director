// 「从剧情开始」入口（Run 元数据 entryMode = "story"）的常量与输入校验。
//
// 浏览器表单与服务端 /api/production/run/story/start 共用这一份（与 story-duration.js
// 同一模式）：页面拦下的和服务端拒绝的必须是同一套规则。
//
// 用户原文的唯一存放处是服务端在开 Run 时提交的 storySource Artifact；它不进
// creatorProfile（那三个字段整体进角色边界 sourceDigest）、不进 Task Store，
// 也不进 localStorage / sessionStorage（长期只存创作宇宙七项设置）。

export const STORY_ENTRY_MODE = "story";
export const STORY_SOURCE_ARTIFACT_ID = "storySource";
export const STORY_SOURCE_ARTIFACT_TYPE = "storySource";
export const STORY_SOURCE_SCHEMA_VERSION = "story_source/1.0";
export const STORY_MODE_FULL_TEXT = "fullStoryText";
export const STORY_MODE_CHARACTER_ONLY = "characterOnly";
export const STORY_SOURCE_MODES = Object.freeze([STORY_MODE_FULL_TEXT, STORY_MODE_CHARACTER_ONLY]);
export const STORY_SOURCE_TEXT_MAX_CHARS = 5000;
// 剧情入口只出一个候选，id 由服务端签发，不让模型写。
export const STORY_ENTRY_VARIANT_ID = "V1";
// 与 src/validation.js requireText 的默认上限同一个数。
export const STORY_ENTRY_PROFILE_FIELD_MAX_CHARS = 12000;

const STORY_SOURCE_KEYS = new Set(["schemaVersion", "storyMode", "storyText"]);
const CREATOR_PROFILE_KEYS = new Set(["fixedCharacter", "vertical", "constraints"]);

export class StoryEntryInputError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = "StoryEntryInputError";
    this.code = "STORY_ENTRY_INPUT_INVALID";
    this.details = Array.isArray(details) ? details : [];
  }
}

// 按码点计数：页面计数器与服务端上限用同一种数法，emoji 不会被算成两个字。
export function storyTextLength(text) {
  return [...String(text ?? "")].length;
}

// 只做两件确定性的事：换行统一成 \n、去掉首尾空白。正文中间一个字都不动——
// 「严格按原文」的依据就是这份文本。
export function normalizeStoryText(text) {
  return String(text ?? "").replace(/\r\n?/gu, "\n").trim();
}

export function normalizeStorySource(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StoryEntryInputError("storySource 必须是对象。");
  }
  const unknown = Object.keys(value).filter((key) => !STORY_SOURCE_KEYS.has(key));
  if (unknown.length) {
    throw new StoryEntryInputError(`storySource 含有不认识的字段：${unknown.join("、")}`, unknown.map((key) => ({ key })));
  }
  if (value.schemaVersion !== undefined && value.schemaVersion !== STORY_SOURCE_SCHEMA_VERSION) {
    throw new StoryEntryInputError(`storySource.schemaVersion 必须是 ${STORY_SOURCE_SCHEMA_VERSION}`);
  }
  const storyMode = value.storyMode;
  if (!STORY_SOURCE_MODES.includes(storyMode)) {
    throw new StoryEntryInputError(`storySource.storyMode 必须是 ${STORY_SOURCE_MODES.join(" 或 ")}`);
  }
  if (value.storyText !== undefined && typeof value.storyText !== "string") {
    throw new StoryEntryInputError("storySource.storyText 必须是字符串。");
  }
  const storyText = normalizeStoryText(value.storyText);
  if (storyMode === STORY_MODE_CHARACTER_ONLY) {
    if (storyText) throw new StoryEntryInputError("「只给角色设定」不接受故事正文；要用自己的故事请选「粘贴完整故事」。");
    return { schemaVersion: STORY_SOURCE_SCHEMA_VERSION, storyMode };
  }
  if (!storyText) throw new StoryEntryInputError("请粘贴完整故事正文。");
  const length = storyTextLength(storyText);
  if (length > STORY_SOURCE_TEXT_MAX_CHARS) {
    throw new StoryEntryInputError(`故事正文最多 ${STORY_SOURCE_TEXT_MAX_CHARS} 字，当前 ${length} 字。`);
  }
  return { schemaVersion: STORY_SOURCE_SCHEMA_VERSION, storyMode, storyText };
}

// creatorProfile 恰好三个字段，与浏览器 profile() 同形；多一个键就拒绝，
// 避免故事正文或其它偏好被塞进会作废角色边界的那个对象。
export function normalizeStoryEntryCreatorProfile(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StoryEntryInputError("creatorProfile 必须是对象。");
  }
  const unknown = Object.keys(value).filter((key) => !CREATOR_PROFILE_KEYS.has(key));
  if (unknown.length) {
    throw new StoryEntryInputError(`creatorProfile 只接受固定角色、垂直赛道和创作限制，多出：${unknown.join("、")}`, unknown.map((key) => ({ key })));
  }
  const profile = {};
  for (const key of CREATOR_PROFILE_KEYS) {
    const raw = value[key] ?? "";
    if (typeof raw !== "string") throw new StoryEntryInputError(`creatorProfile.${key} 必须是字符串。`);
    const text = raw.trim();
    if (text.length > STORY_ENTRY_PROFILE_FIELD_MAX_CHARS) {
      throw new StoryEntryInputError(`creatorProfile.${key} 不能超过 ${STORY_ENTRY_PROFILE_FIELD_MAX_CHARS} 字。`);
    }
    profile[key] = text;
  }
  if (!profile.fixedCharacter) throw new StoryEntryInputError("请填写固定角色。");
  if (!profile.vertical) throw new StoryEntryInputError("请填写垂直赛道。");
  return profile;
}

export function isStoryEntryMetadata(metadata) {
  return metadata?.entryMode === STORY_ENTRY_MODE;
}
