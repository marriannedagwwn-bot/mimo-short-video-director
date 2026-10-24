// 参考片仿写接进 AI 导演（2026-10-24）：浏览器与服务端共用的常量与纯函数。设计见 docs/reference-rewrite-2026-10-24.md。
//
// 参考视频的 Run 上，AI 导演第一步在本机去配乐、转写（Artifact sourceTranscript）；主题变体那一步由模型
// 看接触表、读转写稿、按角色边界写 N 篇完整剧本（themeVariants 的剧本格式）。选中一篇后完整剧情按剧本拆场。

import { normalizeStoryText } from "./story-entry.js";

// 主题变体（剧本格式）的模型阶段。阶段名与侧车日志 scope 用同一个名字（writer 按 scope 建、按 stage 查）。
export const REFERENCE_REWRITE_STAGE = "referenceRewrite";

// AI 导演第一步：去配乐与转写。任务、Artifact、阶段都叫这个名字；它不调模型。
export const SOURCE_TRANSCRIPT_ARTIFACT_ID = "sourceTranscript";
export const SOURCE_TRANSCRIPT_SCHEMA_VERSION = "source_transcript/1.0";

// 主题变体的剧本格式：themeVariants 仍是同一个 Artifact，用 schemaVersion 与每篇的 format 区分旧的故事候选。
export const SCRIPT_THEME_VARIANTS_SCHEMA_VERSION = "theme_variants_script/1.0";
export const SCRIPT_VARIANT_FORMAT = "script";

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

/** 接触表的抽帧率：与服务端切图用同一个判定。 */
export function contactSheetFps(durationSeconds) {
  return Number(durationSeconds) > REFERENCE_REWRITE_DENSE_FPS_MAX_SECONDS ? 1 : 2;
}

/** 还没切图时，按时长估一个帧数给页面「+N」用；切过之后以 themeVariants.materials.frameCount 为准。 */
export function estimatedContactSheetFrameCount(durationSeconds) {
  const seconds = Number(durationSeconds);
  if (!(seconds > 0)) return 0;
  return Math.max(1, Math.round(Math.min(seconds, REFERENCE_REWRITE_MAX_VIDEO_SECONDS) * contactSheetFps(seconds)));
}

// 两个阶段各自的进度步骤。页面文字与服务端 progress.step 用同一份。
export const SOURCE_TRANSCRIPT_STEPS = Object.freeze([
  Object.freeze({ key: "separate", label: "去配乐" }),
  Object.freeze({ key: "transcribe", label: "转写台词" })
]);
export const SCRIPT_VARIANT_STEPS = Object.freeze([
  Object.freeze({ key: "frames", label: "抽帧" }),
  Object.freeze({ key: "write", label: "写剧本" })
]);

export function referenceStepLabel(key) {
  return [...SOURCE_TRANSCRIPT_STEPS, ...SCRIPT_VARIANT_STEPS].find((step) => step.key === key)?.label || "";
}

export function isScriptThemeVariants(themeVariants) {
  return themeVariants?.schemaVersion === SCRIPT_THEME_VARIANTS_SCHEMA_VERSION;
}

export function isScriptVariant(variant) {
  return variant?.format === SCRIPT_VARIANT_FORMAT;
}

// 选中一篇后按剧本拆场的「原文」：标题空一行接剧本。概要与方向是给人挑稿看的，不进原文。
// 拆场提示词、台词核对与长度上限用的都是这一份。
export function scriptVariantStoryText(variant) {
  const title = String(variant?.title || "").trim();
  const script = String(variant?.script || "").trim();
  return normalizeStoryText(title ? `${title}\n\n${script}` : script);
}

// 「下载剧本」导出的 Markdown：原片拆解在前，N 篇在后，与实验交给用户读的那份同一个结构。
export function scriptVariantsMarkdown(themeVariants, { videoTitle = "" } = {}) {
  const original = themeVariants?.original || {};
  const variants = Array.isArray(themeVariants?.variants) ? themeVariants.variants : [];
  const lines = [`# ${videoTitle ? `${videoTitle} · ` : ""}主题变体`, "", "## 一、原片", "", "### 概要", "", String(original.summary || ""), "", "### 台词", ""];
  lines.push("| 时间 | 谁 | 台词 | 画面 |", "| --- | --- | --- | --- |");
  for (const row of Array.isArray(original.dialogue) ? original.dialogue : []) {
    lines.push(`| ${cell(row.time)} | ${cell(row.speaker)} | ${cell(row.line)} | ${cell(row.picture)} |`);
  }
  lines.push("", "### 原片好看在哪", "");
  for (const item of Array.isArray(original.strengths) ? original.strengths : []) lines.push(`- ${String(item)}`);
  lines.push("", `## 二、${variants.length} 篇剧本`);
  variants.forEach((variant) => {
    lines.push("", `### ${String(variant.id || "")}　${String(variant.title || "")}`, "", `**方向**：${String(variant.direction || "")}`, "", `**概要**：${String(variant.summary || "")}`, "", "**剧本**", "", String(variant.script || ""));
  });
  return `${lines.join("\n")}\n`;
}

function cell(value) {
  return String(value ?? "").replace(/\|/gu, "｜").replace(/\s*\n\s*/gu, " ");
}
