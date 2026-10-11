// 一句话修改（2026-10-11）的页面文字：修改稿预览、采纳前的确认、作废清单。纯函数，不碰 DOM。
//
// 修改稿显示在被改的东西所在的位置：剧情与分镜在分场页上，单镜提示词在那一镜的视频弹窗里。
// 页面只把修改稿留在内存里：不进任何浏览器存储，刷新即丢（已经花的那次调用不退）。
// 设计见 docs/one-sentence-edit-2026-10-11.md。

import { formatStageUsageSuffix } from "./token-usage-format.js";

const TARGET_LABELS = Object.freeze({ story: "剧情", storyboard: "分镜" });

// 「粘贴完整故事」的 Run 里页面把剧情叫「可翻拍镜头」（storySlot），卡片、预览和总结跟着页面叫。
export function oneSentenceEditTargetLabel(target, shotId = "", { storySlot = false } = {}) {
  if (target === "shotPrompt") return `镜头 ${shotId} 的视频提示词`;
  if (target === "story" && storySlot) return "可翻拍镜头";
  return TARGET_LABELS[target] || "";
}

// 修改稿在页面上的位置，导演助手的总结里用。
export function oneSentenceEditWhere(target, shotId = "", { storySlot = false } = {}) {
  if (target === "story") return `分场页上${storySlot ? "可翻拍镜头" : "剧情"}的上方`;
  if (target === "storyboard") return "分场页上分镜的上方";
  return `镜头 ${shotId} 的视频弹窗里`;
}

/**
 * 采纳后会作废什么，一行一项，卡片、预览和确认弹窗共用。
 * counts 来自服务端（修改稿）或页面上的当前产物（卡片），口径相同：都是当前版本里依赖它的产物。
 */
export function oneSentenceEditInvalidationLines(target, invalidation = {}) {
  invalidation = invalidation || {};
  const counts = invalidation.counts || {};
  if (target === "shotPrompt") return ["采纳后什么都不作废；这一镜已有的视频不会自动重做，要用新提示词就重新生成这一镜。"];
  const parts = oneSentenceEditInvalidatedParts(target, invalidation);
  const lines = [parts.length ? `采纳后作废：${parts.join("、")}。` : "采纳后没有别的东西作废。"];
  if (target === "story" && counts.animationPlan) lines.push("要重新生成分镜。");
  if (target === "storyboard" && invalidation.roleImagesKept) lines.push(`已设为人物参考图的 ${invalidation.roleImagesKept} 张图会保留。`);
  return lines;
}

// 会作废的东西逐项列出（卡片、预览、确认弹窗和采纳后的总结共用一份口径）。
export function oneSentenceEditInvalidatedParts(target, invalidation = {}) {
  invalidation = invalidation || {};
  const counts = invalidation.counts || {};
  if (target === "shotPrompt") return [];
  const parts = [];
  if (target === "story" && counts.animationPlan) parts.push("分镜");
  if (invalidation.roleImagesLost) parts.push(`${invalidation.roleImagesLost} 张已设为人物参考图的图（存在分镜里）`);
  if (counts.shotVideoPrompt) parts.push(`${counts.shotVideoPrompt} 条单镜提示词`);
  if (counts.shotVideo) parts.push(`${counts.shotVideo} 条镜头视频`);
  if (counts.characterImages) parts.push(`${counts.characterImages} 组角色候选图`);
  return parts;
}

// 采纳会作废东西时，先用这段话征求同意（window.confirm）；什么都不作废时返回空串，不弹窗。
export function oneSentenceEditConfirmText(draft, { manualPromptEdited = false, storySlot = false } = {}) {
  const target = draft?.target;
  const label = oneSentenceEditTargetLabel(target, draft?.shotId, { storySlot });
  const invalidation = draft?.invalidation || {};
  const counts = invalidation.counts || {};
  const loses = target !== "shotPrompt" && (counts.animationPlan || counts.shotVideoPrompt || counts.shotVideo
    || counts.characterImages || invalidation.roleImagesLost);
  const lines = [];
  if (loses) lines.push(`采纳会签发新的${label}版本。`, ...oneSentenceEditInvalidationLines(target, invalidation));
  if (manualPromptEdited) lines.push("弹窗里手动改过的提示词还没有用过：采纳后提示词换成修改稿这一版，手动改的地方会丢掉。");
  if (!lines.length) return "";
  return `${lines.join("\n")}\n\n是否继续？`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/gu, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[char]);
}

/**
 * 修改稿预览。entry 是页面内存里的一份：
 *   { status: "writing" | "ready" | "failed", target, shotId, instruction, result, error, adopting }
 * 按钮只带 data-one-sentence-action="adopt" / "discard"，事件由 app.js 绑定。
 */
export function renderOneSentenceEditPreview(entry) {
  if (!entry) return "";
  const label = oneSentenceEditTargetLabel(entry.target, entry.shotId, { storySlot: Boolean(entry.storySlot) });
  const said = entry.instruction ? `<p class="muted-note">你说的：「${escapeHtml(entry.instruction)}」</p>` : "";
  if (entry.status === "writing") {
    return `<div class="one-sentence-edit">
      <p class="story-review-status">正在按你的话写${escapeHtml(label)}的修改稿，通常半分钟到一两分钟…</p>
      ${said}
    </div>`;
  }
  if (entry.status === "failed") {
    return `<div class="one-sentence-edit">
      <p class="story-review-status error">${escapeHtml(label)}的修改稿没有写出来：${escapeHtml(entry.error || "未知原因")}</p>
      ${said}
      <div class="candidate-revision-action"><button type="button" class="outline-button" data-one-sentence-action="discard">关掉</button></div>
    </div>`;
  }
  const result = entry.result || {};
  const call = result.metadata?.oneSentenceEdit || null;
  const usage = entry.usage ? formatStageUsageSuffix(entry.usage, { label: "这次用了" }) : "";
  const retried = `${call && call.providerCalls > 1 ? ` · 第 ${escapeHtml(call.providerCalls)} 次调用的结果，第一次被程序拦下` : ""}${escapeHtml(usage)}`;
  if (result.decision === "decline") {
    return `<div class="one-sentence-edit">
      <p class="story-review-status warn">这句话没有改成${retried}</p>
      ${said}
      <p class="review-why">${escapeHtml(result.note)}</p>
      <p class="muted-note">${escapeHtml(label)}没有变。可以在导演助手里换个说法再说一次。</p>
      <div class="candidate-revision-action"><button type="button" class="outline-button" data-one-sentence-action="discard">知道了</button></div>
    </div>`;
  }
  const changes = (result.changes || []).map((change) => `
    <div class="revision-diff">
      <b>${escapeHtml(change.label)}</b>
      <p class="revision-before">${escapeHtml(change.before || "（空）")}</p>
      <p class="revision-after">${escapeHtml(change.after || "（删掉）")}</p>
    </div>`).join("");
  const promptText = entry.target === "shotPrompt" && result.afterText
    ? `<details class="one-sentence-edit-full"><summary>改完之后的整段提示词</summary><pre>${escapeHtml(result.afterText)}</pre></details>`
    : "";
  const scopeNote = entry.target === "storyboard"
    ? "完整剧情不跟着改；改完和剧情不一致的地方，AI 的说明里会写。"
    : entry.target === "shotPrompt" ? "分镜不跟着改。" : "";
  const adopting = Boolean(entry.adopting);
  return `<div class="one-sentence-edit">
    <p class="story-review-status">${escapeHtml(label)}的修改稿（还没有生效）${retried}</p>
    ${said}
    <p class="review-why">${escapeHtml(result.note)}</p>
    ${changes}
    ${promptText}
    ${oneSentenceEditInvalidationLines(entry.target, result.invalidation || {}).map((line) => `<p class="muted-note warn">${escapeHtml(line)}</p>`).join("")}
    ${scopeNote ? `<p class="muted-note">${escapeHtml(scopeNote)}</p>` : ""}
    <p class="muted-note warn">改得对不对程序判不了：改错了位置、把谁替谁做写反，都要你自己看。</p>
    <div class="candidate-revision-action">
      <button type="button" class="outline-button" data-one-sentence-action="adopt"${adopting ? " disabled" : ""}>${adopting ? "签发中…" : "采纳"}</button>
      <button type="button" class="text-button" data-one-sentence-action="discard"${adopting ? " disabled" : ""}>放弃</button>
    </div>
    ${entry.adoptError ? `<p class="story-review-status error">没有采纳：${escapeHtml(entry.adoptError)}</p>` : ""}
  </div>`;
}
