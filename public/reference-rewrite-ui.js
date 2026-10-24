// 参考片仿写（2026-10-24）的页面渲染：只拼 HTML 字符串，不碰状态、不发请求；接线在 app.js。
// 设计见 docs/reference-rewrite-2026-10-24.md。
import {
  REFERENCE_REWRITE_STEPS,
  referenceRewriteDraftStoryText,
  referenceRewriteStepLabel
} from "./reference-rewrite.js";

const NUMERALS = ["一", "二", "三", "四"];

/** 按钮下面那一行：可不可以点、为什么不能点、点了要花多少。 */
export function referenceRewriteHint({ available = true, reason = "", demo = false, provider = "", model = "" } = {}) {
  if (!available) return reason || "参考片仿写现在用不了。";
  if (demo) return "演示模式：不调用模型，四稿是占位文字。";
  const label = [provider, model].filter(Boolean).join(" · ");
  const cost = provider === "Claude" && model === "claude-opus-5-5" ? "约 12 分钟、约 1 美元" : "约 12 分钟";
  return `用 ${label || "所选模型"} 看抽帧图和去配乐后的台词，写原片拆解和四篇类似的剧本（${cost}）。`;
}

/** 任务进行中的一行状态：第几步、在做什么、模型已推理多少字。 */
export function referenceRewriteProgressText(task = {}) {
  const progress = task.progress || {};
  const total = REFERENCE_REWRITE_STEPS.length;
  const label = referenceRewriteStepLabel(progress.step);
  if (task.status === "queued") return "参考片仿写排队中…";
  if (!label) return "参考片仿写准备中…";
  const parts = [`第 ${progress.stepIndex || 1}/${progress.stepMax || total} 步 ${label}`];
  if (progress.step === "write") {
    const reasoning = Number(progress.reasoningChars) || 0;
    const streamed = Number(progress.streamedChars) || 0;
    if (streamed) parts.push(`已写出 ${streamed} 字`);
    else if (reasoning) parts.push(`推理中（已推理 ${reasoning} 字）`);
    else parts.push("等模型开始写…");
  }
  return `${parts.join(" · ")}`;
}

/** 结果面板：原片拆解在前，四张稿件卡在后。 */
export function referenceRewriteResultHtml(result, { escape }) {
  if (!result?.drafts?.length) return "";
  const original = result.original || {};
  const dialogue = Array.isArray(original.dialogue) ? original.dialogue : [];
  const strengths = Array.isArray(original.strengths) ? original.strengths : [];
  const model = result.model || {};
  const meta = [model.provider, model.model, model.effort ? `effort ${model.effort}` : "", model.providerCalls > 1 ? `第 ${model.providerCalls} 次调用的结果` : ""]
    .filter(Boolean).map(escape).join(" · ");
  return `<div class="reference-rewrite-original">
    <h3>原片拆解</h3>
    <p class="reference-rewrite-summary">${escape(original.summary)}</p>
    <details class="reference-rewrite-dialogue">
      <summary>台词（${dialogue.length} 句）</summary>
      <table>
        <thead><tr><th>时间</th><th>谁</th><th>台词</th><th>画面</th></tr></thead>
        <tbody>${dialogue.map((row) => `<tr><td>${escape(row.time)}</td><td>${escape(row.speaker)}</td><td>${escape(row.line)}</td><td>${escape(row.picture)}</td></tr>`).join("")}</tbody>
      </table>
    </details>
    <h4>原片好看在哪</h4>
    <ul>${strengths.map((item) => `<li>${escape(item)}</li>`).join("")}</ul>
  </div>
  <div class="reference-rewrite-drafts-grid">
    ${result.drafts.map((draft, index) => `<article class="reference-rewrite-draft" data-reference-draft="${index}">
      <p class="eyebrow">稿${NUMERALS[index] || index + 1}</p>
      <h3>${escape(draft.title)}</h3>
      <p class="reference-rewrite-direction">${escape(draft.direction)}</p>
      <p>${escape(draft.summary)}</p>
      <details><summary>看剧本</summary><pre class="reference-rewrite-script">${escape(draft.script)}</pre></details>
      <button class="primary-button" type="button" data-reference-draft-use="${index}">用这一稿开拍</button>
    </article>`).join("")}
  </div>
  <div class="reference-rewrite-footer">
    <button class="outline-button" type="button" data-reference-rewrite-download>下载四稿（Markdown）</button>
    ${meta ? `<small>${meta}</small>` : ""}
  </div>`;
}

/** 剧情入口粘贴框上方的四稿列表（只在页面内存里，刷新即清空）。 */
export function referenceRewriteDraftPickerHtml(drafts, { escape, currentText = "" }) {
  if (!Array.isArray(drafts) || !drafts.length) return "";
  const current = String(currentText || "").trim();
  return `<p class="reference-rewrite-picker-title">参考片仿写的四稿 <small>只在这个页面里，刷新后就没有了</small></p>
  <div class="reference-rewrite-picker">${drafts.map((draft, index) => {
    const active = referenceRewriteDraftStoryText(draft) === current;
    return `<button class="outline-button${active ? " is-active" : ""}" type="button" data-reference-draft-fill="${index}"${active ? " aria-pressed=\"true\"" : ""}>稿${NUMERALS[index] || index + 1} · ${escape(draft.title)}</button>`;
  }).join("")}</div>`;
}

/** 当前粘贴框里的字是不是四稿之一（换稿前判断用户有没有改过字）。 */
export function referenceRewriteTextIsDraft(drafts, text) {
  const current = String(text || "").trim();
  if (!current) return true;
  return (Array.isArray(drafts) ? drafts : []).some((draft) => referenceRewriteDraftStoryText(draft) === current);
}
