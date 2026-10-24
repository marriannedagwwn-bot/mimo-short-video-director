// 参考片仿写（2026-10-24）：浏览器与服务端共用的常量与纯函数。设计见 docs/reference-rewrite-2026-10-24.md。
//
// 从参考视频抽帧、去配乐、转写，再让模型写「原片拆解＋四篇类似剧本」。选中的一稿由用户填进
// 「从剧情开始 · 粘贴完整故事」的输入框，之后走现有的拆镜头与 4.0 分镜；这里不签发 storySource。

import { STORY_SOURCE_TEXT_MAX_CHARS, normalizeStoryText, storyTextLength } from "./story-entry.js";

// 阶段名、任务名与 Artifact id 都用这一个名字（侧车日志按 scope 建 writer、按 stage 查，必须逐字相同）。
export const REFERENCE_REWRITE_STAGE = "referenceRewrite";
export const REFERENCE_REWRITE_TASK_KIND = "referenceRewrite";
export const REFERENCE_REWRITE_ARTIFACT_ID = "referenceRewrite";
export const REFERENCE_REWRITE_ARTIFACT_TYPE = "referenceRewrite";
export const REFERENCE_REWRITE_SCHEMA_VERSION = "reference_rewrite/1.0";
export const REFERENCE_REWRITE_DRAFT_COUNT = 4;

// 只有这两家能看图写稿：Claude 走 requestCompletion 的 frames（唯一允许 Claude 收图的阶段），
// MiMo 本来就能看图。千问的多图请求会被拼成视频块，DeepSeek 不收图，都不放。
export const REFERENCE_REWRITE_PROVIDERS = Object.freeze(["Claude", "MiMo"]);
// 默认设置不跟随 DEFAULT_LLM_PROVIDER：10-23 对照实验里只有 Claude Opus 5.5（effort xhigh）复现了效果。
export const REFERENCE_REWRITE_DEFAULT_SETTING = Object.freeze({
  provider: "Claude",
  model: "claude-opus-5-5",
  effort: "xhigh"
});

// 参考片上限 180 秒；超过 120 秒改每秒 1 帧，接触表不超过 8 张。
export const REFERENCE_REWRITE_MAX_VIDEO_SECONDS = 180;
export const REFERENCE_REWRITE_DENSE_FPS_MAX_SECONDS = 120;

// 进度的四步。页面文字与服务端 progress.step 用同一份。
export const REFERENCE_REWRITE_STEPS = Object.freeze([
  Object.freeze({ key: "frames", label: "抽帧" }),
  Object.freeze({ key: "separate", label: "去配乐" }),
  Object.freeze({ key: "transcribe", label: "转写台词" }),
  Object.freeze({ key: "write", label: "写四稿" })
]);

export function referenceRewriteStepLabel(key) {
  return REFERENCE_REWRITE_STEPS.find((step) => step.key === key)?.label || "";
}

// 选中一稿后填进粘贴框的文字：标题空一行接剧本。概要与方向是给人挑稿看的，不进原文。
export function referenceRewriteDraftStoryText(draft) {
  const title = String(draft?.title || "").trim();
  const script = String(draft?.script || "").trim();
  return normalizeStoryText(title ? `${title}\n\n${script}` : script);
}

// 校验器用它保证「选中后一定能开 Run」：按码点计数，与剧情原文的上限同一个数。
export function referenceRewriteDraftFits(draft) {
  return storyTextLength(referenceRewriteDraftStoryText(draft)) <= STORY_SOURCE_TEXT_MAX_CHARS;
}

// 「下载四稿」导出的 Markdown：原片拆解在前，四稿在后，与实验交给用户读的那份同一个结构。
export function referenceRewriteMarkdown(result, { videoTitle = "" } = {}) {
  const original = result?.original || {};
  const drafts = Array.isArray(result?.drafts) ? result.drafts : [];
  const lines = [`# ${videoTitle ? `${videoTitle} · ` : ""}参考片仿写`, "", "## 一、原片", "", "### 概要", "", String(original.summary || ""), "", "### 台词", ""];
  lines.push("| 时间 | 谁 | 台词 | 画面 |", "| --- | --- | --- | --- |");
  for (const row of Array.isArray(original.dialogue) ? original.dialogue : []) {
    lines.push(`| ${cell(row.time)} | ${cell(row.speaker)} | ${cell(row.line)} | ${cell(row.picture)} |`);
  }
  lines.push("", "### 原片好看在哪", "");
  for (const item of Array.isArray(original.strengths) ? original.strengths : []) lines.push(`- ${String(item)}`);
  lines.push("", "## 二、四篇剧本");
  const numerals = ["一", "二", "三", "四"];
  drafts.forEach((draft, index) => {
    lines.push("", `### 稿${numerals[index] || index + 1}　${String(draft.title || "")}`, "", `**方向**：${String(draft.direction || "")}`, "", `**概要**：${String(draft.summary || "")}`, "", "**剧本**", "", String(draft.script || ""));
  });
  return `${lines.join("\n")}\n`;
}

function cell(value) {
  return String(value ?? "").replace(/\|/gu, "｜").replace(/\s*\n\s*/gu, " ");
}
