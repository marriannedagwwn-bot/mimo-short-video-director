// 主题变体的剧本格式（2026-10-24）：只查形状，不查写得好不好。设计见 docs/reference-rewrite-2026-10-24.md。
//
// 模型交一个 JSON：原片拆解（概要、台词表、好看在哪）＋恰好 N 篇剧本。校验全是键、类型、非空、
// 条数、标题不重复、长度与「剧本里写出签发的角色名」，零语义；「读对了原片没有」「N 篇是不是换了事件」
// 没有确定性兜底，只能靠人读。服务端再给每篇发 id（V1…VN）与 format，写 schemaVersion、素材与模型信息。
import { InputError, OutputContractError } from "./validation.js";
import { STORY_SOURCE_TEXT_MAX_CHARS, storyTextLength } from "../public/story-entry.js";
import {
  SCRIPT_THEME_VARIANTS_SCHEMA_VERSION,
  SCRIPT_VARIANT_FORMAT,
  scriptVariantStoryText
} from "../public/reference-rewrite.js";

export const REFERENCE_REWRITE_MODEL_SCHEMA_NAME = "theme_variants_script";

const TOP_KEYS = ["original", "variants"];
const ORIGINAL_KEYS = ["summary", "dialogue", "strengths"];
const DIALOGUE_KEYS = ["time", "speaker", "line", "picture"];
const DRAFT_KEYS = ["title", "direction", "summary", "script"];
const STORED_VARIANT_KEYS = ["id", "format", ...DRAFT_KEYS];

/**
 * 模型输出的校验。通过时返回去掉首尾空白的副本；不通过抛 OutputContractError，details 是 {code, path, reason}。
 * @param {object} value 模型输出
 * @param {{count:number, characterName?:string}} options 篇数；签发的固定角色名（为空时不查）
 */
export function ensureReferenceRewriteContract(value, { count, characterName = "" } = {}) {
  if (!Number.isInteger(count) || count < 1) throw new TypeError("count 必须是正整数");
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

  if (!Array.isArray(value.variants)) add("REFERENCE_REWRITE_SCHEMA_INVALID", "/variants", "variants 必须是数组");
  else {
    if (value.variants.length !== count) {
      add("REFERENCE_REWRITE_DRAFT_COUNT", "/variants", `variants 必须恰好 ${count} 篇，这次是 ${value.variants.length} 篇`);
    }
    const seenTitles = new Map();
    const name = String(characterName || "").trim();
    value.variants.forEach((draft, index) => {
      const path = `/variants/${index}`;
      if (!isPlainObject(draft)) return add("REFERENCE_REWRITE_SCHEMA_INVALID", path, "每一篇必须是对象");
      checkKeys(draft, path, DRAFT_KEYS, add);
      for (const key of DRAFT_KEYS) checkText(draft[key], `${path}/${key}`, add);
      if (typeof draft.title === "string" && draft.title.trim()) {
        const titleKey = normalizeTitle(draft.title);
        if (seenTitles.has(titleKey)) {
          add("REFERENCE_REWRITE_DRAFT_TITLE_DUPLICATE", `${path}/title`, `标题和第 ${seenTitles.get(titleKey) + 1} 篇重复，每篇要各有各的标题`);
        } else seenTitles.set(titleKey, index);
      }
      if (typeof draft.title === "string" && typeof draft.script === "string") {
        const length = storyTextLength(scriptVariantStoryText(draft));
        if (length > STORY_SOURCE_TEXT_MAX_CHARS) {
          add("REFERENCE_REWRITE_DRAFT_TOO_LONG", `${path}/script`, `标题加剧本 ${length} 字，超过 ${STORY_SOURCE_TEXT_MAX_CHARS} 字；请压到上限以内`);
        }
      }
      // 主角必须是签发的固定角色：剧本里一次都没写出这个名字，拆场时就没有主角可对。
      if (name && typeof draft.script === "string" && draft.script.trim() && !draft.script.includes(name)) {
        add("SCRIPT_VARIANT_PROTAGONIST_NAME_MISSING", `${path}/script`, `剧本里没有写出固定角色的名字「${name}」；主角必须用这个名字`);
      }
    });
  }

  if (issues.length) throw new OutputContractError("主题变体（剧本）的输出不符合格式", issues);
  return {
    original: {
      summary: original.summary.trim(),
      dialogue: original.dialogue.map((row) => ({
        time: row.time.trim(), speaker: row.speaker.trim(), line: row.line.trim(), picture: row.picture.trim()
      })),
      strengths: original.strengths.map((item) => item.trim())
    },
    variants: value.variants.map((draft) => ({
      title: draft.title.trim(), direction: draft.direction.trim(), summary: draft.summary.trim(), script: draft.script.trim()
    }))
  };
}

/**
 * 服务端签发：给每篇发 id 与 format，写 schemaVersion、素材与模型信息。输入是 ensureReferenceRewriteContract 的结果。
 */
export function sealScriptThemeVariants(result, { materials, model }) {
  return {
    schemaVersion: SCRIPT_THEME_VARIANTS_SCHEMA_VERSION,
    original: result.original,
    variants: result.variants.map((draft, index) => ({ id: `V${index + 1}`, format: SCRIPT_VARIANT_FORMAT, ...draft })),
    materials,
    model
  };
}

/**
 * 读路径上的复核：选中的那一篇（variant:<id> 的内容）必须是完整的剧本格式。
 * 不通过抛 InputError（请求里带来的副本不对，不是模型的错）。
 */
export function ensureScriptVariant(variant, { path = "variant" } = {}) {
  if (!isPlainObject(variant)) throw new InputError(`${path} 必须是对象`);
  const keys = Object.keys(variant);
  const extra = keys.filter((key) => !STORED_VARIANT_KEYS.includes(key));
  const missing = STORED_VARIANT_KEYS.filter((key) => !keys.includes(key));
  if (extra.length || missing.length) {
    throw new InputError(`${path} 不是剧本格式的主题变体${missing.length ? `（缺少 ${missing.join("、")}）` : ""}${extra.length ? `（多了 ${extra.join("、")}）` : ""}`);
  }
  if (variant.format !== SCRIPT_VARIANT_FORMAT) throw new InputError(`${path}.format 必须是 ${SCRIPT_VARIANT_FORMAT}`);
  if (!/^V\d+$/u.test(String(variant.id))) throw new InputError(`${path}.id 必须是 V1、V2 这样的编号`);
  for (const key of DRAFT_KEYS) {
    if (typeof variant[key] !== "string" || !variant[key].trim()) throw new InputError(`${path}.${key} 必须是非空字符串`);
  }
  if (storyTextLength(scriptVariantStoryText(variant)) > STORY_SOURCE_TEXT_MAX_CHARS) {
    throw new InputError(`${path} 的标题加剧本超过 ${STORY_SOURCE_TEXT_MAX_CHARS} 字`);
  }
  return variant;
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
      variants: {
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
export function referenceRewriteMimoSchema(count) {
  if (!Number.isInteger(count) || count < 1) throw new TypeError("count 必须是正整数");
  const schema = referenceRewriteClaudeSchema();
  const nonEmpty = { type: "string", minLength: 1 };
  const original = schema.properties.original.properties;
  original.summary = nonEmpty;
  original.dialogue.items.properties = {
    time: nonEmpty, speaker: nonEmpty, line: nonEmpty, picture: { type: "string" }
  };
  original.strengths = { type: "array", minItems: 1, items: nonEmpty };
  const drafts = schema.properties.variants;
  drafts.minItems = count;
  drafts.maxItems = count;
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
