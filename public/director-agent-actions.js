// 导演助手（2026-10-09）：浏览器与服务端共用的动作词表、编号格式与长度上限。
//
// 导演助手是页面右侧的对话栏：它根据页面状态提议下一步，用户点卡片上的「确认执行」后，
// 执行的就是页面上那个按钮背后的同一段代码。「现在能做哪几步」只由
// public/director-agent-progress.js 一份规则算出来；模型（/api/director-agent/turn）
// 只负责把用户打的字对到其中一个动作编号，再写一句回复——它不能执行任何东西，
// 也不是事实来源（docs/GitHub-Benchmark-后续改造待办.md:283、:467）。
// 设计与边界见 docs/director-agent-chat-2026-10-09.md。

// 第二期只走主线。modelSelectable=false 的动作只做成按钮，由用户自己点，不交给模型对：
// 挑故事候选是用户的创作决定，模型可能把一句「继续」对到第一个候选上
// （docs/GitHub-Benchmark-后续改造待办.md:477 禁止默认选第一个候选）。
export const DIRECTOR_AGENT_ACTIONS = Object.freeze({
  startPipeline: Object.freeze({ modelSelectable: true }),
  regenerateCandidates: Object.freeze({ modelSelectable: true }),
  chooseCandidate: Object.freeze({ modelSelectable: false }),
  openStoryPage: Object.freeze({ modelSelectable: true }),
  generateFullStory: Object.freeze({ modelSelectable: true }),
  generateStoryboard: Object.freeze({ modelSelectable: true }),
  openCharacterImages: Object.freeze({ modelSelectable: true }),
  openShotVideo: Object.freeze({ modelSelectable: true }),
  openModelSettings: Object.freeze({ modelSelectable: true }),
  // 一句话修改（2026-10-11，第三期）：模型能选，但从不作为「下一步」主动提出、也不做成按钮——
  // 只在用户自己说要改什么时由模型对上。卡片带用户的原话，确认后另起一次调用按原话写修改稿。
  editStory: Object.freeze({ modelSelectable: true, editTarget: "story" }),
  editStoryboard: Object.freeze({ modelSelectable: true, editTarget: "storyboard" }),
  editShotPrompt: Object.freeze({ modelSelectable: true, editTarget: "shotPrompt" })
});

// 模型选「什么都不做、只回答」时写的编号。
export const DIRECTOR_AGENT_NO_ACTION = "none";

export const DIRECTOR_AGENT_COST_KINDS = Object.freeze(["free", "text", "image", "video"]);
export const DIRECTOR_AGENT_STEP_STATUSES = Object.freeze(["done", "running", "paused", "failed", "waiting", "todo"]);
export const DIRECTOR_AGENT_ENTRY_LABELS = Object.freeze(["参考视频", "粘贴完整故事", "只给角色设定"]);

// 发给模型的内容一律有上限：服务端在调用模型之前按这些数拦下超限请求（400）。
export const DIRECTOR_AGENT_LIMITS = Object.freeze({
  messageChars: 500,
  historyEntries: 6,
  historyChars: 400,
  replyChars: 300,
  steps: 12,
  stepLabelChars: 20,
  stepDetailChars: 80,
  // 一句话修改为每个写好提示词的镜头各提供一个动作（2026-10-11），40 在镜头多时会把后面的截掉。
  actions: 80,
  actionLabelChars: 80,
  statusTextChars: 200,
  notes: 3
});

// 动作编号：动作名，后面最多跟两段参数，例如 openShotVideo:V1:A03、openCharacterImages:V1:0。
const ACTION_KEY_PATTERN = /^([A-Za-z]+)((?::[A-Za-z0-9_-]{1,40}){0,2})$/u;

export function directorAgentActionKey(id, params = []) {
  const key = [id, ...params.map((param) => String(param))].join(":");
  if (!parseDirectorAgentActionKey(key)) throw new TypeError(`导演助手动作编号无效：${key}`);
  return key;
}

// 不认识的动作名或格式不对都返回 null，调用方按「不在清单里」处理，不猜。
export function parseDirectorAgentActionKey(key) {
  const match = typeof key === "string" ? key.match(ACTION_KEY_PATTERN) : null;
  if (!match || !Object.hasOwn(DIRECTOR_AGENT_ACTIONS, match[1])) return null;
  return { id: match[1], params: match[2] ? match[2].slice(1).split(":") : [] };
}

export function isModelSelectableDirectorAgentAction(key) {
  const parsed = parseDirectorAgentActionKey(key);
  return Boolean(parsed && DIRECTOR_AGENT_ACTIONS[parsed.id].modelSelectable);
}

// 一句话修改的三个动作改的是哪一类：story / storyboard / shotPrompt；不是修改动作返回空串。
export function directorAgentEditTarget(id) {
  return Object.hasOwn(DIRECTOR_AGENT_ACTIONS, id) ? DIRECTOR_AGENT_ACTIONS[id].editTarget || "" : "";
}
