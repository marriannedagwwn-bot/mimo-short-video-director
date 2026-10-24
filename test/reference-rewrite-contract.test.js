import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { InputError, OutputContractError } from "../src/validation.js";
import {
  ensureReferenceRewriteContract as ensureContract,
  ensureScriptVariant,
  referenceRewriteClaudeSchema,
  referenceRewriteMimoSchema,
  sealScriptThemeVariants
} from "../src/reference-rewrite.js";
import {
  REFERENCE_REWRITE_SYSTEM_PROMPT,
  referenceRewritePrompt,
  referenceRewriteRetryPrompt
} from "../src/reference-rewrite-prompts.js";
import {
  REFERENCE_REWRITE_DEFAULT_SETTING,
  REFERENCE_REWRITE_PROVIDERS,
  SCRIPT_THEME_VARIANTS_SCHEMA_VERSION,
  isScriptThemeVariants,
  isScriptVariant,
  scriptVariantStoryText,
  scriptVariantsMarkdown
} from "../public/reference-rewrite.js";
import { STORY_SOURCE_TEXT_MAX_CHARS } from "../public/story-entry.js";
import { validRewrite } from "./helpers/reference-rewrite-fixture.js";

// 主题变体的剧本格式（2026-10-24）：输出契约只查形状，提示词由 golden 锁住。
const options = { count: 4, characterName: "咕嘎" };
const ensureReferenceRewriteContract = (value, overrides = {}) => ensureContract(value, { ...options, ...overrides });

const codes = (fn) => {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof OutputContractError, error.message);
    return error.details.map((detail) => `${detail.code} ${detail.path}`);
  }
  assert.fail("应该抛出 OutputContractError");
};

test("契约：合格的输出去掉首尾空白原样返回，画面一格允许空", () => {
  const result = ensureReferenceRewriteContract(validRewrite());
  assert.equal(result.original.summary, "大雨里，咕嘎在便利店屋檐下躲雨。");
  assert.equal(result.original.dialogue[1].picture, "");
  assert.equal(result.variants.length, 4);
  assert.deepEqual(Object.keys(result), ["original", "variants"]);
});

test("篇数取页面「候选数量」；剧本里没写出签发的角色名就打回", () => {
  const three = validRewrite();
  three.variants.pop();
  assert.equal(ensureReferenceRewriteContract(three, { count: 3 }).variants.length, 3);
  const noName = validRewrite();
  noName.variants[2].script = "**1　外　街口**\n\n小女孩冲进画面。";
  assert.deepEqual(codes(() => ensureReferenceRewriteContract(noName)), ["SCRIPT_VARIANT_PROTAGONIST_NAME_MISSING /variants/2/script"]);
  assert.throws(() => ensureContract(validRewrite(), { count: 0 }), TypeError);
});

test("签发：服务端发 V1…VN 与 format，写 schemaVersion；读路径上的复核认得剧本格式", () => {
  const sealed = sealScriptThemeVariants(ensureReferenceRewriteContract(validRewrite()), { materials: { frameCount: 102 }, model: { provider: "Claude" } });
  assert.equal(sealed.schemaVersion, SCRIPT_THEME_VARIANTS_SCHEMA_VERSION);
  assert.deepEqual(sealed.variants.map((variant) => variant.id), ["V1", "V2", "V3", "V4"]);
  assert.ok(sealed.variants.every((variant) => variant.format === "script"));
  assert.deepEqual(Object.keys(sealed.variants[0]), ["id", "format", "title", "direction", "summary", "script"]);
  assert.equal(isScriptThemeVariants(sealed), true);
  assert.equal(isScriptVariant(sealed.variants[1]), true);
  assert.equal(isScriptThemeVariants({ variants: [] }), false, "旧格式的故事候选没有 schemaVersion");
  assert.equal(ensureScriptVariant(sealed.variants[1]), sealed.variants[1]);
  assert.throws(() => ensureScriptVariant({ ...sealed.variants[1], storyOutline: [] }), (error) => error instanceof InputError && /多了 storyOutline/u.test(error.message));
  assert.throws(() => ensureScriptVariant({ ...sealed.variants[1], id: "X1" }), InputError);
  assert.throws(() => ensureScriptVariant({ ...sealed.variants[1], script: " " }), InputError);
});

test("契约：篇数不对、缺字段、多字段、空字段、标题重复、剧本超长各有自己的诊断码与路径", () => {
  const three = validRewrite();
  three.variants.pop();
  assert.deepEqual(codes(() => ensureReferenceRewriteContract(three)), ["REFERENCE_REWRITE_DRAFT_COUNT /variants"]);

  const missing = validRewrite();
  delete missing.variants[1].summary;
  assert.ok(codes(() => ensureReferenceRewriteContract(missing)).includes("REFERENCE_REWRITE_SCHEMA_INVALID /variants/1/summary"));

  const extra = validRewrite({ verdict: "pass" });
  assert.ok(codes(() => ensureReferenceRewriteContract(extra)).includes("REFERENCE_REWRITE_SCHEMA_INVALID /verdict"));

  const empty = validRewrite();
  empty.original.dialogue[0].line = "  ";
  assert.deepEqual(codes(() => ensureReferenceRewriteContract(empty)), ["REFERENCE_REWRITE_FIELD_EMPTY /original/dialogue/0/line"]);

  const duplicate = validRewrite();
  duplicate.variants[3].title = "热 红薯！";
  assert.deepEqual(codes(() => ensureReferenceRewriteContract(duplicate)), ["REFERENCE_REWRITE_DRAFT_TITLE_DUPLICATE /variants/3/title"]);

  const long = validRewrite();
  long.variants[2].script = `咕嘎${"字".repeat(STORY_SOURCE_TEXT_MAX_CHARS)}`;
  assert.deepEqual(codes(() => ensureReferenceRewriteContract(long)), ["REFERENCE_REWRITE_DRAFT_TOO_LONG /variants/2/script"]);

  const noStrengths = validRewrite();
  noStrengths.original.strengths = [];
  assert.ok(codes(() => ensureReferenceRewriteContract(noStrengths)).includes("REFERENCE_REWRITE_SCHEMA_INVALID /original/strengths"));
  assert.deepEqual(codes(() => ensureReferenceRewriteContract([])), ["REFERENCE_REWRITE_SCHEMA_INVALID /"]);
});

test("按剧本拆场的原文是「标题空一行接剧本」，长度按码点算、上限与剧情原文同一个数", () => {
  const draft = { title: " 热红薯 ", script: "\n**1　外　街口**\r\n\n咕嘎跑来。 " };
  assert.equal(scriptVariantStoryText(draft), "热红薯\n\n**1　外　街口**\n\n咕嘎跑来。");
  const emoji = validRewrite();
  emoji.variants[0] = { ...emoji.variants[0], title: "", script: `咕嘎${"😀".repeat(STORY_SOURCE_TEXT_MAX_CHARS - 2)}` };
  assert.deepEqual(codes(() => ensureReferenceRewriteContract(emoji)), ["REFERENCE_REWRITE_FIELD_EMPTY /variants/0/title"], "emoji 按一个字算，只报标题空");
});

test("Claude 版 Schema 不用 Claude 不支持的关键字；MiMo 版在它上面锁 4 篇、非空", () => {
  const keywords = (schema) => {
    const found = new Set();
    const walk = (node) => {
      if (!node || typeof node !== "object" || Array.isArray(node)) return;
      for (const [key, value] of Object.entries(node)) {
        if (key === "properties") Object.values(value).forEach(walk);
        else { found.add(key); walk(value); }
      }
    };
    walk(schema);
    return found;
  };
  for (const keyword of keywords(referenceRewriteClaudeSchema())) {
    assert.ok(["type", "additionalProperties", "required", "properties", "items"].includes(keyword), keyword);
  }
  const mimo = referenceRewriteMimoSchema(4);
  assert.equal(mimo.properties.variants.minItems, 4);
  assert.equal(mimo.properties.variants.maxItems, 4);
  assert.equal(referenceRewriteMimoSchema(3).properties.variants.maxItems, 3);
  assert.equal(mimo.properties.variants.items.properties.script.minLength, 1);
  assert.equal(keywords(mimo).has("pattern"), false);
  // 两份 Schema 都接受合格输出的形状（键集合一致）。
  assert.deepEqual(mimo.required, Object.keys(validRewrite()));
});

test("默认设置：Claude Opus 5.5、effort xhigh；只允许 Claude 与 MiMo", () => {
  assert.deepEqual({ ...REFERENCE_REWRITE_DEFAULT_SETTING }, { provider: "Claude", model: "claude-opus-5-5", effort: "xhigh" });
  assert.deepEqual([...REFERENCE_REWRITE_PROVIDERS], ["Claude", "MiMo"]);
});

const promptInput = Object.freeze({
  videoTitle: "总有人会给你撑伞",
  durationSeconds: 51.107,
  contactSheets: {
    fps: 2, columns: 6, rows: 4,
    sheets: [
      { startSeconds: 0, endSeconds: 11.5, cells: 24 },
      { startSeconds: 12, endSeconds: 23.5, cells: 24 },
      { startSeconds: 24, endSeconds: 35.5, cells: 24 },
      { startSeconds: 36, endSeconds: 47.5, cells: 24 },
      { startSeconds: 48, endSeconds: 50.5, cells: 6 }
    ]
  },
  transcriptText: "# 音频转写资料\n\n（固定的测试转写）",
  characterFacts: {
    characterName: "咕嘎", canonicalDescription: "穿企鹅连体衣、斜挎绿色小包的小女孩", bodyForm: "人类小女孩",
    requiredTraits: [{ canonicalName: "企鹅连体衣", terms: ["企鹅连体衣"], scope: "appearance" }],
    allowedTraits: [], forbiddenTraits: [{ canonicalName: "猫耳", terms: ["猫耳"], scope: "appearance" }],
    dialogueRules: []
  },
  creatorProfile: { vertical: "治愈系日常", constraints: "咕嘎只会说「咕嘎」" },
  count: 4,
  targetDurationSeconds: 51
});
const sha = (text) => createHash("sha256").update(text).digest("hex");

test("提示词 golden：整段文字与 system 提示词逐字锁定", () => {
  assert.equal(sha(referenceRewritePrompt(promptInput)), "1a9b9e6887854ab9ee9276a3a2673a49ed2f02116bedfc82db63903ff375c032");
  assert.equal(sha(REFERENCE_REWRITE_SYSTEM_PROMPT), "c387fd54e1028e816b9d7bf26af60ddcf352642ef2004b0b8f93ac70aa5b5a11");
});

test("提示词：接触表说明按张数生成，最后一张不满时写明；角色事实、篇数、时长窗口取输入，不写死咕嘎", () => {
  const text = referenceRewritePrompt(promptInput);
  assert.match(text, /前面附了 5 张图：原片按每秒 2 帧抽帧拼成的接触表，每张 6 列 × 4 行/u);
  assert.match(text, /图 1 是 0:00–0:11\.5，图 2 是 0:12–0:23\.5/u);
  assert.match(text, /图 5 是 0:48–0:50\.5（只有前 6 格有画面）/u);
  assert.match(text, /每篇时长 43–59 秒/u);
  assert.match(text, /参考这个故事，如果你想写一个类似的故事，你会怎么写剧本。/u);
  assert.match(text, /- 固定角色（已签发的角色事实与用户的对白规则，只读素材）：\{"characterName":"咕嘎"/u);
  assert.match(text, /名字写「咕嘎」/u);
  assert.match(text, /写 4 篇，每篇换一个不同的角度。4 篇全部给出/u);
  assert.match(text, /variants 恰好 4 篇/u);
  const other = referenceRewritePrompt({
    ...promptInput,
    characterFacts: { characterName: "小白子", canonicalDescription: "Q 版猫耳少女", requiredTraits: [], allowedTraits: [], forbiddenTraits: [], dialogueRules: [] },
    creatorProfile: { vertical: "日常", constraints: "" },
    contactSheets: { fps: 1, columns: 6, rows: 4, sheets: [{ startSeconds: 0, endSeconds: 23, cells: 24 }, { startSeconds: 24, endSeconds: 25, cells: 2 }] },
    count: 3,
    targetDurationSeconds: 90
  });
  assert.match(other, /名字写「小白子」/u);
  assert.match(other, /写 3 篇/u);
  assert.match(other, /- 创作限制：（没有写）/u);
  assert.match(other, /每秒 1 帧.*相邻两格相隔 1 秒/u);
  assert.match(other, /图 2 是 0:24–0:25（只有前 2 格有画面）/u);
  assert.match(other, /每篇时长 76–104 秒/u);
  assert.equal(other.includes("咕嘎"), false, "写稿要求里不写死某个角色");
  assert.throws(() => referenceRewritePrompt({ ...promptInput, targetDurationSeconds: 0 }), /targetDurationSeconds/u);
  assert.throws(() => referenceRewritePrompt({ ...promptInput, characterFacts: {} }), /characterName/u);
});

test("重试提示词只追加校验器数出来的诊断，不附失败的输出", () => {
  const retry = referenceRewriteRetryPrompt({
    originalPrompt: "原提示词",
    count: 4,
    details: [{ code: "REFERENCE_REWRITE_DRAFT_COUNT", path: "/variants", reason: "variants 必须恰好 4 篇，这次是 3 篇" }]
  });
  assert.ok(retry.startsWith("原提示词\n\n上一次的输出没有通过格式校验："));
  assert.match(retry, /- \/variants：variants 必须恰好 4 篇，这次是 3 篇（REFERENCE_REWRITE_DRAFT_COUNT）/u);
  assert.match(retry, /variants 恰好 4 篇。$/u);
});

test("下载的 Markdown：原片拆解在前、N 篇在后，表格里的竖线与换行不会把表格打散", () => {
  const value = validRewrite();
  value.original.dialogue[0].picture = "左|右\n下一行";
  const sealed = sealScriptThemeVariants(ensureReferenceRewriteContract(value), { materials: {}, model: {} });
  const markdown = scriptVariantsMarkdown(sealed, { videoTitle: "撑伞" });
  assert.ok(markdown.startsWith("# 撑伞 · 主题变体\n"));
  assert.match(markdown, /\| 0:11 \| 阿姨 \| 小咕嘎，怎么在外面啊？快进来。 \| 左｜右 下一行 \|/u);
  for (const heading of ["### V1　热红薯", "### V2　收被子", "### V3　伞下面还有伞", "### V4　摔开的西瓜"]) assert.ok(markdown.includes(heading), heading);
  assert.ok(markdown.indexOf("## 一、原片") < markdown.indexOf("## 二、4 篇剧本"));
});
