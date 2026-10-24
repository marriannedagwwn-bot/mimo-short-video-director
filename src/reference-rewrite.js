// 参考片仿写（2026-10-24）的输出契约：只查形状，不查写得好不好。设计见 docs/reference-rewrite-2026-10-24.md。
//
// 模型交一个 JSON：原片拆解（概要、台词表、好看在哪）＋恰好四篇剧本。校验全是键、类型、非空、
// 条数、标题不重复与长度，零语义；「读对了原片没有」「四篇是不是换了事件」没有确定性兜底，只能靠人读。
import { OutputContractError } from "./validation.js";
import { STORY_SOURCE_TEXT_MAX_CHARS, storyTextLength } from "../public/story-entry.js";
import {
  REFERENCE_REWRITE_DRAFT_COUNT,
  referenceRewriteDraftStoryText
} from "../public/reference-rewrite.js";

export const REFERENCE_REWRITE_MODEL_SCHEMA_NAME = "reference_rewrite";

const TOP_KEYS = ["original", "drafts"];
const ORIGINAL_KEYS = ["summary", "dialogue", "strengths"];
const DIALOGUE_KEYS = ["time", "speaker", "line", "picture"];
const DRAFT_KEYS = ["title", "direction", "summary", "script"];

/** 通过时返回去掉首尾空白的副本；不通过抛 OutputContractError，details 是 {code, path, reason}。 */
export function ensureReferenceRewriteContract(value) {
  const issues = [];
  const add = (code, path, reason) => issues.push({ code, path, reason });
  if (!isPlainObject(value)) {
    throw new OutputContractError("参考片仿写的输出不是对象", [{ code: "REFERENCE_REWRITE_SCHEMA_INVALID", path: "/", reason: "只输出一个 JSON 对象" }]);
  }
  checkKeys(value, "", TOP_KEYS, add);

  const original = isPlainObject(value.original) ? value.original : null;
  if (!original) add("REFERENCE_REWRITE_SCHEMA_INVALID", "/original", "original 必须是对象");
  else {
    checkKeys(original, "/original", ORIGINAL_KEYS, add);
    checkText(original.summary, "/original/summary", add);
    if (!Array.isArray(original.dialogue)) add("REFERENCE_REWRITE_SCHEMA_INVALID", "/original/dialogue", "dialogue 必须是数组");
    else {
      original.dialogue.forEach((row, index) => {
        const path = `/original/dialogue/${index}`;
        if (!isPlainObject(row)) return add("REFERENCE_REWRITE_SCHEMA_INVALID", path, "每一行台词必须是对象");
        checkKeys(row, path, DIALOGUE_KEYS, add);
        for (const key of ["time", "speaker", "line"]) checkText(row[key], `${path}/${key}`, add);
        // 画面一格允许空（实验里的台词表就有几行没写画面），但必须是字符串。
        if (typeof row.picture !== "string") add("REFERENCE_REWRITE_SCHEMA_INVALID", `${path}/picture`, "picture 必须是字符串，可以为空");
      });
    }
    if (!Array.isArray(original.strengths) || !original.strengths.length) {
      add("REFERENCE_REWRITE_SCHEMA_INVALID", "/original/strengths", "strengths 必须是至少一条的数组");
    } else {
      original.strengths.forEach((item, index) => checkText(item, `/original/strengths/${index}`, add));
    }
  }

  if (!Array.isArray(value.drafts)) add("REFERENCE_REWRITE_SCHEMA_INVALID", "/drafts", "drafts 必须是数组");
  else {
    if (value.drafts.length !== REFERENCE_REWRITE_DRAFT_COUNT) {
      add("REFERENCE_REWRITE_DRAFT_COUNT", "/drafts", `drafts 必须恰好 ${REFERENCE_REWRITE_DRAFT_COUNT} 篇，这次是 ${value.drafts.length} 篇`);
    }
    const seenTitles = new Map();
    value.drafts.forEach((draft, index) => {
      const path = `/drafts/${index}`;
      if (!isPlainObject(draft)) return add("REFERENCE_REWRITE_SCHEMA_INVALID", path, "每一篇必须是对象");
      checkKeys(draft, path, DRAFT_KEYS, add);
      for (const key of DRAFT_KEYS) checkText(draft[key], `${path}/${key}`, add);
      if (typeof draft.title === "string" && draft.title.trim()) {
        const titleKey = normalizeTitle(draft.title);
        if (seenTitles.has(titleKey)) {
          add("REFERENCE_REWRITE_DRAFT_TITLE_DUPLICATE", `${path}/title`, `标题和第 ${seenTitles.get(titleKey) + 1} 篇重复，四篇要各有各的标题`);
        } else seenTitles.set(titleKey, index);
      }
      if (typeof draft.title === "string" && typeof draft.script === "string") {
        const length = storyTextLength(referenceRewriteDraftStoryText(draft));
        if (length > STORY_SOURCE_TEXT_MAX_CHARS) {
          add("REFERENCE_REWRITE_DRAFT_TOO_LONG", `${path}/script`, `标题加剧本 ${length} 字，超过 ${STORY_SOURCE_TEXT_MAX_CHARS} 字；请压到上限以内`);
        }
      }
    });
  }

  if (issues.length) throw new OutputContractError("参考片仿写的输出不符合格式", issues);
  return {
    original: {
      summary: original.summary.trim(),
      dialogue: original.dialogue.map((row) => ({
        time: row.time.trim(), speaker: row.speaker.trim(), line: row.line.trim(), picture: row.picture.trim()
      })),
      strengths: original.strengths.map((item) => item.trim())
    },
    drafts: value.drafts.map((draft) => ({
      title: draft.title.trim(), direction: draft.direction.trim(), summary: draft.summary.trim(), script: draft.script.trim()
    }))
  };
}

// Claude 结构化输出用的 Schema：只用 type / properties / required / additionalProperties / items。
// minLength、maxItems 这类关键字 Claude 不支持（src/claude-client.js 头注释），条数与非空由上面的校验器管。
export function referenceRewriteClaudeSchema() {
  const text = { type: "string" };
  return {
    type: "object",
    additionalProperties: false,
    required: TOP_KEYS,
    properties: {
      original: {
        type: "object",
        additionalProperties: false,
        required: ORIGINAL_KEYS,
        properties: {
          summary: text,
          dialogue: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: DIALOGUE_KEYS,
              properties: Object.fromEntries(DIALOGUE_KEYS.map((key) => [key, text]))
            }
          },
          strengths: { type: "array", items: text }
        }
      },
      drafts: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: DRAFT_KEYS,
          properties: Object.fromEntries(DRAFT_KEYS.map((key) => [key, text]))
        }
      }
    }
  };
}

// MiMo 的约束解码 Schema：在 Claude 那份上加已在 MiMo 实测生效的 minItems / maxItems / minLength
// （docs/variants-mimo-format-2026-09-24.md）。不用 pattern（MiMo 会当成全串匹配）。
export function referenceRewriteMimoSchema() {
  const schema = referenceRewriteClaudeSchema();
  const nonEmpty = { type: "string", minLength: 1 };
  const original = schema.properties.original.properties;
  original.summary = nonEmpty;
  original.dialogue.items.properties = {
    time: nonEmpty, speaker: nonEmpty, line: nonEmpty, picture: { type: "string" }
  };
  original.strengths = { type: "array", minItems: 1, items: nonEmpty };
  const drafts = schema.properties.drafts;
  drafts.minItems = REFERENCE_REWRITE_DRAFT_COUNT;
  drafts.maxItems = REFERENCE_REWRITE_DRAFT_COUNT;
  drafts.items.properties = Object.fromEntries(DRAFT_KEYS.map((key) => [key, nonEmpty]));
  return schema;
}

function checkKeys(value, path, keys, add) {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) add("REFERENCE_REWRITE_SCHEMA_INVALID", `${path}/${key}`, `多了未定义的字段 ${key}`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) add("REFERENCE_REWRITE_SCHEMA_INVALID", `${path}/${key}`, `缺少字段 ${key}`);
  }
}

function checkText(value, path, add) {
  if (typeof value !== "string") add("REFERENCE_REWRITE_SCHEMA_INVALID", path, "必须是字符串");
  else if (!value.trim()) add("REFERENCE_REWRITE_FIELD_EMPTY", path, "不能为空");
}

function normalizeTitle(title) {
  return title.replace(/[\s\p{P}\p{S}]/gu, "");
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
