// 导演助手（2026-10-09）服务端：请求检查与回复校验。设计见 docs/director-agent-chat-2026-10-09.md。
//
// /api/director-agent/turn 只出建议，与剧情体检同规格：不签发 Artifact、不进 lineage、
// 不建任务、不写盘。模型只能从页面送来的动作清单里选一个编号（或 none），服务端核对；
// 真正执行的是页面上原有按钮背后的同一段代码，而且只在用户点卡片上的「确认执行」之后。
import { InputError, OutputContractError } from "./validation.js";
import { validateDirectorAgentTurnStrict } from "./contracts/contract-validator.js";
import {
  DIRECTOR_AGENT_COST_KINDS,
  DIRECTOR_AGENT_ENTRY_LABELS,
  DIRECTOR_AGENT_LIMITS,
  DIRECTOR_AGENT_NO_ACTION,
  DIRECTOR_AGENT_STEP_STATUSES,
  isModelSelectableDirectorAgentAction
} from "../public/director-agent-actions.js";

// 阶段名：模型设置、阶段默认值、调试侧车 scope 都用这一个名字（取值必须逐字相同，
// 侧车按 scope 建 writer、按 stage 查，对不上就静默不写）。
export const DIRECTOR_AGENT_STAGE = "directorAgent";

const LIMITS = DIRECTOR_AGENT_LIMITS;

// 请求检查：一切超限或形状不对都在调用模型之前 400，不截断、不猜。
// 进度说明由页面按固定规则生成，只有状态、计数和固定标签；这里只核形状与长度，
// 并拒收模型不能选的动作（挑候选只做成按钮，由用户自己点）。
export function normalizeDirectorAgentTurnInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new InputError("请求必须是对象");
  return {
    message: boundedText(input.message, "message", LIMITS.messageChars, { required: true }),
    history: normalizeHistory(input.history),
    progress: normalizeProgress(input.progress)
  };
}

function normalizeHistory(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new InputError("history 必须是数组");
  if (value.length > LIMITS.historyEntries) throw new InputError(`history 不能超过 ${LIMITS.historyEntries} 条`);
  return value.map((entry, index) => {
    const name = `history[${index}]`;
    exactKeys(entry, name, ["role", "text"]);
    if (!["user", "agent"].includes(entry.role)) throw new InputError(`${name}.role 只能是 user 或 agent`);
    return { role: entry.role, text: boundedText(entry.text, `${name}.text`, LIMITS.historyChars, { required: true }) };
  });
}

function normalizeProgress(value) {
  exactKeys(value, "progress", ["entry", "steps", "busy", "waitingFor", "notes", "nextKey", "actions"], { optional: ["busy", "waitingFor", "notes", "nextKey"] });
  if (!DIRECTOR_AGENT_ENTRY_LABELS.includes(value.entry)) throw new InputError("progress.entry 不是已知的入口");
  if (!Array.isArray(value.steps) || value.steps.length > LIMITS.steps) {
    throw new InputError(`progress.steps 必须是不超过 ${LIMITS.steps} 项的数组`);
  }
  const steps = value.steps.map((step, index) => {
    const name = `progress.steps[${index}]`;
    exactKeys(step, name, ["label", "status", "detail"], { optional: ["detail"] });
    if (!DIRECTOR_AGENT_STEP_STATUSES.includes(step.status)) throw new InputError(`${name}.status 不是已知的状态`);
    return {
      label: boundedText(step.label, `${name}.label`, LIMITS.stepLabelChars, { required: true }),
      status: step.status,
      detail: boundedText(step.detail, `${name}.detail`, LIMITS.stepDetailChars)
    };
  });
  if (!Array.isArray(value.actions) || value.actions.length > LIMITS.actions) {
    throw new InputError(`progress.actions 必须是不超过 ${LIMITS.actions} 项的数组`);
  }
  const seen = new Set();
  const actions = value.actions.map((action, index) => {
    const name = `progress.actions[${index}]`;
    exactKeys(action, name, ["key", "label", "cost"]);
    if (!isModelSelectableDirectorAgentAction(action.key)) throw new InputError(`${name}.key 不是导演助手可以选的动作`);
    if (seen.has(action.key)) throw new InputError(`${name}.key 重复：${action.key}`);
    seen.add(action.key);
    if (!DIRECTOR_AGENT_COST_KINDS.includes(action.cost)) throw new InputError(`${name}.cost 不是已知的花费类型`);
    return { key: action.key, label: boundedText(action.label, `${name}.label`, LIMITS.actionLabelChars, { required: true }), cost: action.cost };
  });
  if (value.notes !== undefined && (!Array.isArray(value.notes) || value.notes.length > LIMITS.notes)) {
    throw new InputError(`progress.notes 必须是不超过 ${LIMITS.notes} 项的数组`);
  }
  const notes = (value.notes || []).map((note, index) => boundedText(note, `progress.notes[${index}]`, LIMITS.statusTextChars, { required: true }));
  const nextKey = boundedText(value.nextKey, "progress.nextKey", LIMITS.actionLabelChars);
  if (nextKey && !seen.has(nextKey)) throw new InputError("progress.nextKey 必须是动作清单里的一个编号");
  return {
    entry: value.entry,
    steps,
    busy: boundedText(value.busy, "progress.busy", LIMITS.statusTextChars),
    waitingFor: boundedText(value.waitingFor, "progress.waitingFor", LIMITS.statusTextChars),
    notes,
    nextKey,
    actions
  };
}

// 回复校验：严格 Schema + 编号必须在这一轮的清单里。抛 OutputContractError，
// 由协调器带诊断重试一次；第二次仍不对就如实报错，不拿确定性答案顶替。
export function ensureDirectorAgentTurnContract(value, offeredKeys) {
  const checked = validateDirectorAgentTurnStrict(value);
  if (!checked.ok) throw new OutputContractError("导演助手的回复不符合格式", checked.diagnostics);
  if (value.actionKey !== DIRECTOR_AGENT_NO_ACTION && !offeredKeys.includes(value.actionKey)) {
    throw new OutputContractError("导演助手选了清单之外的动作", [{
      code: "DIRECTOR_AGENT_ACTION_NOT_OFFERED",
      path: "/actionKey",
      reason: `「${value.actionKey}」不在这一轮的动作清单里；只能从清单里选，或者写 ${DIRECTOR_AGENT_NO_ACTION}`
    }]);
  }
  return { actionKey: value.actionKey, reply: value.reply.trim() };
}

function boundedText(value, name, max, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new InputError(`${name} 不能为空`);
    return "";
  }
  if (typeof value !== "string") throw new InputError(`${name} 必须是字符串`);
  const text = value.trim();
  if (required && !text) throw new InputError(`${name} 不能为空`);
  if (text.length > max) throw new InputError(`${name} 不能超过 ${max} 字`);
  return text;
}

function exactKeys(value, name, keys, { optional = [] } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InputError(`${name} 必须是对象`);
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length) throw new InputError(`${name} 有未定义的字段：${unknown.join("、")}`);
  const missing = keys.filter((key) => !optional.includes(key) && !Object.hasOwn(value, key));
  if (missing.length) throw new InputError(`${name} 缺少字段：${missing.join("、")}`);
}
