// 导演助手（2026-10-09）的面板：只负责把对话状态画出来。按钮的点击由 app.js 在面板上用一个
// 委托监听处理（data-agent-confirm / data-agent-dismiss / data-agent-chip / data-agent-quick）。
// 面板层级低于弹窗（z-index 30 < 40），弹窗和 window.confirm 总在它上面。
import { directorAgentStatusText } from "./director-agent-messages.js";

const ROLE_LABELS = Object.freeze({
  system: "导演助手",
  agent: "导演助手 · AI 回复（可能说错，以卡片为准）",
  user: "你",
  error: "导演助手 · 出错了"
});

// 进度条与「正在进行」那一行：每次刷新都画（正在运行的步骤每次轮询字数都会变）。
export function renderDirectorAgentStatus(elements, { entry, steps, busy }) {
  elements.entry.textContent = entry ? `入口：${entry}` : "";
  elements.steps.innerHTML = directorAgentStepsHtml(steps);
  elements.busy.textContent = busy ? `正在进行：${busy}` : "";
  elements.busy.classList.toggle("hidden", !busy);
}

// 消息列表：只在消息真的变了时由调用方重画；只有出现新消息时才滚到最下面，
// 免得用户往上翻看历史时被定时刷新拽回底部。
export function renderDirectorAgentMessages(elements, { messages, pendingTurn }, { scrollToEnd = false } = {}) {
  elements.messages.innerHTML = directorAgentMessagesHtml(messages, { pendingTurn });
  elements.send.disabled = pendingTurn;
  elements.send.textContent = pendingTurn ? "等回复…" : "发送";
  if (scrollToEnd) elements.messages.scrollTop = elements.messages.scrollHeight;
}

export function directorAgentStepsHtml(steps = []) {
  return steps.map((step) => `<li class="agent-step agent-step-${escapeHtml(step.status)}">`
    + `<span class="agent-step-dot" aria-hidden="true"></span>`
    + `<span class="agent-step-label">${escapeHtml(step.label)}</span>`
    + `<small>${escapeHtml(step.detail || directorAgentStatusText(step.status))}</small></li>`).join("");
}

export function directorAgentMessagesHtml(messages = [], { pendingTurn = false } = {}) {
  const body = messages.map(messageHtml).join("");
  return pendingTurn
    ? `${body}<div class="agent-message agent-message-agent agent-message-waiting"><span class="agent-message-who">导演助手</span><p>正在想…</p></div>`
    : body;
}

function messageHtml(message) {
  const parts = [`<span class="agent-message-who">${escapeHtml(ROLE_LABELS[message.role] || "导演助手")}</span>`];
  if (message.text) parts.push(`<p>${escapeHtml(message.text)}</p>`);
  if (message.meta) parts.push(`<p class="agent-message-meta">${escapeHtml(message.meta)}</p>`);
  if (message.card) parts.push(cardHtml(message.id, message.card));
  if (message.chips?.length) {
    parts.push(`<div class="agent-chips">${message.chips.map((chip) => (
      `<button class="outline-button" type="button" data-agent-chip="${escapeHtml(chip.key)}">${escapeHtml(chip.label)}</button>`
    )).join("")}</div>`);
  }
  return `<div class="agent-message agent-message-${escapeHtml(message.role)}">${parts.join("")}</div>`;
}

function cardHtml(id, card) {
  const lines = card.lines.map((line) => `<li>${escapeHtml(line)}</li>`).join("");
  const footer = card.state === "pending"
    ? `<div class="agent-card-actions">`
      + `<button class="agent-card-confirm" type="button" data-agent-confirm="${escapeHtml(id)}">确认执行</button>`
      + `<button class="text-button" type="button" data-agent-dismiss="${escapeHtml(id)}">先不</button></div>`
    : `<p class="agent-card-state">${escapeHtml(card.stateText || "")}</p>`;
  return `<div class="agent-card agent-card-${escapeHtml(card.state)}">`
    + `<strong>${escapeHtml(card.title)}</strong>`
    + (lines ? `<ul>${lines}</ul>` : "")
    + (card.warning ? `<p class="agent-card-warning">${escapeHtml(card.warning)}</p>` : "")
    + footer
    + `</div>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
