import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { OutputContractError } from "../src/validation.js";
import { ensureReferenceRewriteContract, referenceRewriteClaudeSchema, referenceRewriteMimoSchema } from "../src/reference-rewrite.js";
import {
  REFERENCE_REWRITE_SYSTEM_PROMPT,
  referenceRewritePrompt,
  referenceRewriteRetryPrompt
} from "../src/reference-rewrite-prompts.js";
import {
  REFERENCE_REWRITE_DEFAULT_SETTING,
  REFERENCE_REWRITE_PROVIDERS,
  referenceRewriteDraftFits,
  referenceRewriteDraftStoryText,
  referenceRewriteMarkdown
} from "../public/reference-rewrite.js";
import { STORY_SOURCE_TEXT_MAX_CHARS } from "../public/story-entry.js";
import { validRewrite } from "./helpers/reference-rewrite-fixture.js";

// 参考片仿写（2026-10-24）：输出契约只查形状，提示词由 golden 锁住。

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
  assert.equal(result.drafts.length, 4);
  assert.deepEqual(Object.keys(result), ["original", "drafts"]);
});

test("契约：不是 4 篇、缺字段、多字段、空字段、标题重复、剧本超长各有自己的诊断码与路径", () => {
  const three = validRewrite();
  three.drafts.pop();
  assert.deepEqual(codes(() => ensureReferenceRewriteContract(three)), ["REFERENCE_REWRITE_DRAFT_COUNT /drafts"]);

  const missing = validRewrite();
  delete missing.drafts[1].summary;
  assert.ok(codes(() => ensureReferenceRewriteContract(missing)).includes("REFERENCE_REWRITE_SCHEMA_INVALID /drafts/1/summary"));

  const extra = validRewrite({ verdict: "pass" });
  assert.ok(codes(() => ensureReferenceRewriteContract(extra)).includes("REFERENCE_REWRITE_SCHEMA_INVALID /verdict"));

  const empty = validRewrite();
  empty.original.dialogue[0].line = "  ";
  assert.deepEqual(codes(() => ensureReferenceRewriteContract(empty)), ["REFERENCE_REWRITE_FIELD_EMPTY /original/dialogue/0/line"]);

  const duplicate = validRewrite();
  duplicate.drafts[3].title = "热 红薯！";
  assert.deepEqual(codes(() => ensureReferenceRewriteContract(duplicate)), ["REFERENCE_REWRITE_DRAFT_TITLE_DUPLICATE /drafts/3/title"]);

  const long = validRewrite();
  long.drafts[2].script = "字".repeat(STORY_SOURCE_TEXT_MAX_CHARS);
  assert.deepEqual(codes(() => ensureReferenceRewriteContract(long)), ["REFERENCE_REWRITE_DRAFT_TOO_LONG /drafts/2/script"]);

  const noStrengths = validRewrite();
  noStrengths.original.strengths = [];
  assert.ok(codes(() => ensureReferenceRewriteContract(noStrengths)).includes("REFERENCE_REWRITE_SCHEMA_INVALID /original/strengths"));
  assert.deepEqual(codes(() => ensureReferenceRewriteContract([])), ["REFERENCE_REWRITE_SCHEMA_INVALID /"]);
});

test("选中一稿填进粘贴框的文字是「标题空一行接剧本」，长度按码点算、上限与剧情原文同一个数", () => {
  const draft = { title: " 热红薯 ", script: "\n**1　外　街口**\r\n\n咕嘎跑来。 " };
  assert.equal(referenceRewriteDraftStoryText(draft), "热红薯\n\n**1　外　街口**\n\n咕嘎跑来。");
  assert.equal(referenceRewriteDraftFits(draft), true);
  assert.equal(referenceRewriteDraftFits({ title: "", script: "😀".repeat(STORY_SOURCE_TEXT_MAX_CHARS) }), true, "emoji 按一个字算");
  assert.equal(referenceRewriteDraftFits({ title: "a", script: "字".repeat(STORY_SOURCE_TEXT_MAX_CHARS) }), false);
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
  const mimo = referenceRewriteMimoSchema();
  assert.equal(mimo.properties.drafts.minItems, 4);
  assert.equal(mimo.properties.drafts.maxItems, 4);
  assert.equal(mimo.properties.drafts.items.properties.script.minLength, 1);
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
  creatorProfile: { fixedCharacter: "咕嘎：穿企鹅连体衣、斜挎绿色小包的小女孩", vertical: "治愈系日常", constraints: "咕嘎只会说「咕嘎」" },
  targetDurationSeconds: 51
});
const sha = (text) => createHash("sha256").update(text).digest("hex");

test("提示词 golden：整段文字与 system 提示词逐字锁定", () => {
  assert.equal(sha(referenceRewritePrompt(promptInput)), "9f1f3ee525e214101d731290528d83ffd4986258cf9fe2c6728231e81aaed889");
  assert.equal(sha(REFERENCE_REWRITE_SYSTEM_PROMPT), "c387fd54e1028e816b9d7bf26af60ddcf352642ef2004b0b8f93ac70aa5b5a11");
});

test("提示词：接触表说明按张数生成，最后一张不满时写明；固定角色、时长窗口取输入，不写死咕嘎", () => {
  const text = referenceRewritePrompt(promptInput);
  assert.match(text, /前面附了 5 张图：原片按每秒 2 帧抽帧拼成的接触表，每张 6 列 × 4 行/u);
  assert.match(text, /图 1 是 0:00–0:11\.5，图 2 是 0:12–0:23\.5/u);
  assert.match(text, /图 5 是 0:48–0:50\.5（只有前 6 格有画面）/u);
  assert.match(text, /每篇时长 43–59 秒/u);
  assert.match(text, /参考这个故事，如果你想写一个类似的故事，你会怎么写剧本。/u);
  const other = referenceRewritePrompt({
    ...promptInput,
    creatorProfile: { fixedCharacter: "小白子：Q 版猫耳少女", vertical: "日常", constraints: "" },
    contactSheets: { fps: 1, columns: 6, rows: 4, sheets: [{ startSeconds: 0, endSeconds: 23, cells: 24 }, { startSeconds: 24, endSeconds: 25, cells: 2 }] },
    targetDurationSeconds: 90
  });
  assert.match(other, /- 固定角色：小白子：Q 版猫耳少女/u);
  assert.match(other, /- 创作限制：（没有写）/u);
  assert.match(other, /每秒 1 帧.*相邻两格相隔 1 秒/u);
  assert.match(other, /图 2 是 0:24–0:25（只有前 2 格有画面）/u);
  assert.match(other, /每篇时长 76–104 秒/u);
  assert.equal(other.includes("咕嘎"), false, "写稿要求里不写死某个角色");
  assert.throws(() => referenceRewritePrompt({ ...promptInput, targetDurationSeconds: 0 }), /targetDurationSeconds/u);
});

test("重试提示词只追加校验器数出来的诊断，不附失败的输出", () => {
  const retry = referenceRewriteRetryPrompt({
    originalPrompt: "原提示词",
    details: [{ code: "REFERENCE_REWRITE_DRAFT_COUNT", path: "/drafts", reason: "drafts 必须恰好 4 篇，这次是 3 篇" }]
  });
  assert.ok(retry.startsWith("原提示词\n\n上一次的输出没有通过格式校验："));
  assert.match(retry, /- \/drafts：drafts 必须恰好 4 篇，这次是 3 篇（REFERENCE_REWRITE_DRAFT_COUNT）/u);
});

test("下载的 Markdown：原片拆解在前、四稿在后，表格里的竖线与换行不会把表格打散", () => {
  const value = validRewrite();
  value.original.dialogue[0].picture = "左|右\n下一行";
  const markdown = referenceRewriteMarkdown(ensureReferenceRewriteContract(value), { videoTitle: "撑伞" });
  assert.ok(markdown.startsWith("# 撑伞 · 参考片仿写\n"));
  assert.match(markdown, /\| 0:11 \| 阿姨 \| 小咕嘎，怎么在外面啊？快进来。 \| 左｜右 下一行 \|/u);
  for (const heading of ["### 稿一　热红薯", "### 稿二　收被子", "### 稿三　伞下面还有伞", "### 稿四　摔开的西瓜"]) assert.ok(markdown.includes(heading), heading);
  assert.ok(markdown.indexOf("## 一、原片") < markdown.indexOf("## 二、四篇剧本"));
});
