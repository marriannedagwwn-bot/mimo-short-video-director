import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { WorkflowService } from "../src/workflow.js";
import { InputError, OutputContractError } from "../src/validation.js";
import {
  DIRECTOR_AGENT_STAGE,
  ensureDirectorAgentTurnContract,
  normalizeDirectorAgentTurnInput
} from "../src/director-agent.js";
import { DIRECTOR_AGENT_PROMPT_MARKER, DIRECTOR_AGENT_SYSTEM_PROMPT } from "../src/director-agent-prompts.js";
import { directorAgentTurnModelSchema } from "../src/contracts/director-agent-turn-model-schema.js";
import { directorAgentTurnStrictSchema } from "../src/contracts/contract-validator.js";
import { MODEL_OUTPUT_LOG_SCOPES } from "../src/full-model-output-log.js";
import { DIRECTOR_AGENT_LIMITS } from "../public/director-agent-actions.js";
import { createStoryEntryRuntime } from "./helpers/story-entry-runtime.js";

// 导演助手的服务端（2026-10-09）：只出建议。模型只能从页面送来的动作清单里选一个编号，
// 服务端核对；每次关闭思考；最多 2 次调用；审核拦截不重试。

const progress = Object.freeze({
  entry: "粘贴完整故事",
  steps: [{ label: "拆镜头", status: "done", detail: "5 场 · 60 秒" }, { label: "分镜", status: "todo" }],
  busy: "",
  waitingFor: "",
  nextKey: "generateStoryboard:V1",
  actions: [
    { key: "generateStoryboard:V1", label: "生成分镜（16:9，无背景音乐）", cost: "text" },
    { key: "openStoryPage:V1", label: "打开分场页", cost: "free" }
  ]
});
const turnInput = (overrides = {}) => ({ message: "下一步做什么", history: [], progress: structuredClone(progress), ...overrides });

function liveWorkflow(answers, { provider = "MiMo", model = "mimo-v2.6-pro" } = {}) {
  const requests = [];
  const client = {
    requestCompletion: async (request) => {
      requests.push(request);
      const next = answers.shift();
      if (typeof next === "function") return next(request);
      return { content: typeof next === "string" ? next : JSON.stringify(next), finishReason: "stop", usage: null };
    }
  };
  const workflow = new WorkflowService({ clients: { [provider]: client }, stageDefaults: { directorAgent: { provider, model, maxCompletionTokens: 8192 } } });
  return { workflow, requests };
}

test("请求检查：一切超限或形状不对都在调用模型之前 400", () => {
  const rejects = (input, pattern) => assert.throws(() => normalizeDirectorAgentTurnInput(input), (error) => error instanceof InputError && pattern.test(error.message));
  rejects(turnInput({ message: "" }), /message 不能为空/u);
  rejects(turnInput({ message: "字".repeat(DIRECTOR_AGENT_LIMITS.messageChars + 1) }), /message 不能超过 500 字/u);
  rejects(turnInput({ history: Array.from({ length: 7 }, () => ({ role: "user", text: "a" })) }), /history 不能超过 6 条/u);
  rejects(turnInput({ history: [{ role: "system", text: "a" }] }), /role 只能是/u);
  rejects(turnInput({ history: [{ role: "user", text: "字".repeat(401) }] }), /不能超过 400 字/u);
  rejects(turnInput({ progress: { ...progress, extra: 1 } }), /未定义的字段/u);
  rejects(turnInput({ progress: { ...progress, entry: "别的入口" } }), /不是已知的入口/u);
  rejects(turnInput({ progress: { ...progress, steps: [{ label: "x", status: "finished" }] } }), /不是已知的状态/u);
  rejects(turnInput({ progress: { ...progress, nextKey: "generateFullStory:V1" } }), /nextKey 必须是动作清单里的一个编号/u);
  // 挑候选只做成按钮，由用户自己点；进度说明里出现它就是页面写错了。
  rejects(turnInput({ progress: { ...progress, actions: [...progress.actions, { key: "chooseCandidate:V1", label: "选 V1", cost: "text" }] } }), /不是导演助手可以选的动作/u);
  rejects(turnInput({ progress: { ...progress, actions: [progress.actions[0], progress.actions[0]] } }), /重复/u);
  rejects(turnInput({ progress: { ...progress, actions: [{ ...progress.actions[0], cost: "money" }] } }), /花费类型/u);
  // 一句话修改给每个写好提示词的镜头各一个动作（2026-10-11），上限从 40 提到 80。
  rejects(turnInput({ progress: { ...progress, actions: Array.from({ length: 81 }, (_, index) => ({ key: `openShotVideo:V1:A${index}`, label: "x", cost: "video" })) } }), /不超过 80 项/u);
  rejects(turnInput({ progress: { ...progress, notes: ["a", "b", "c", "d"] } }), /notes 必须是不超过 3 项的数组/u);
  rejects(turnInput({ progress: { ...progress, notes: ["字".repeat(201)] } }), /不能超过 200 字/u);
  const ok = normalizeDirectorAgentTurnInput(turnInput({ message: "  继续  " }));
  assert.equal(ok.message, "继续");
  assert.equal(ok.progress.busy, "");
});

test("回复校验：编号必须在这一轮的清单里或是 none；严格 Schema 拦多余字段与空回复", () => {
  const offered = progress.actions.map((action) => action.key);
  assert.deepEqual(ensureDirectorAgentTurnContract({ actionKey: "generateStoryboard:V1", reply: " 可以生成分镜了。 " }, offered),
    { actionKey: "generateStoryboard:V1", reply: "可以生成分镜了。" });
  assert.equal(ensureDirectorAgentTurnContract({ actionKey: "none", reply: "现在在等你挑候选。" }, offered).actionKey, "none");
  assert.throws(() => ensureDirectorAgentTurnContract({ actionKey: "generateStoryboard:V2", reply: "好" }, offered),
    (error) => error instanceof OutputContractError && error.details[0].code === "DIRECTOR_AGENT_ACTION_NOT_OFFERED");
  for (const bad of [{ actionKey: "none", reply: " " }, { actionKey: "none", reply: "好", extra: 1 }, { actionKey: "none" }, { actionKey: "none", reply: "字".repeat(301) }]) {
    assert.throws(() => ensureDirectorAgentTurnContract(bad, offered), OutputContractError);
  }
});

test("模型侧 Schema 从严格 Schema 派生：枚举就是这一轮的清单加 none，只用 MiMo 实测过的关键字", () => {
  const schema = directorAgentTurnModelSchema(["generateStoryboard:V1", "openStoryPage:V1"]);
  assert.deepEqual(schema.properties.actionKey.enum, ["generateStoryboard:V1", "openStoryPage:V1", "none"]);
  assert.deepEqual(schema.required, ["actionKey", "reply"]);
  const keywords = new Set();
  const walk = (node) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    for (const [key, value] of Object.entries(node)) {
      if (key !== "properties") keywords.add(key);
      if (key === "properties") Object.values(value).forEach(walk);
      else walk(value);
    }
  };
  walk(schema);
  for (const keyword of keywords) assert.ok(["type", "additionalProperties", "required", "properties", "enum", "minLength"].includes(keyword), keyword);
  const changed = directorAgentTurnStrictSchema();
  changed.properties.intent = { type: "string" };
  assert.throws(() => directorAgentTurnModelSchema([], changed), /结构变了/u);
});

test("演示模式：不调用模型，提议进度里的下一步，走同一个校验器，调用次数如实写 0", async () => {
  const workflow = new WorkflowService({ clients: {}, stageDefaults: {} });
  const result = await workflow.createDirectorAgentTurn(turnInput());
  assert.equal(result.turn.actionKey, "generateStoryboard:V1");
  assert.match(result.turn.reply, /演示模式/u);
  assert.equal(result.metadata.directorAgent.providerCalls, 0);
  const waiting = await workflow.createDirectorAgentTurn(turnInput({ progress: { ...progress, nextKey: "", waitingFor: "挑一个故事候选。" } }));
  assert.equal(waiting.turn.actionKey, "none");
  assert.match(waiting.turn.reply, /挑一个故事候选/u);
});

test("真实调用：关闭思考、带系统提示词与枚举 Schema；选了清单外的编号带诊断重试一次", async () => {
  const { workflow, requests } = liveWorkflow([
    { actionKey: "generateStoryboard:V2", reply: "好" },
    { actionKey: "generateStoryboard:V1", reply: "可以生成分镜了，卡片上写了花费。" }
  ]);
  const result = await workflow.createDirectorAgentTurn(turnInput({ history: [{ role: "user", text: "到哪了" }, { role: "agent", text: "拆好了。" }] }));
  assert.equal(result.turn.actionKey, "generateStoryboard:V1");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].thinking, "disabled");
  assert.equal(requests[0].systemPrompt, DIRECTOR_AGENT_SYSTEM_PROMPT);
  assert.deepEqual(requests[0].responseSchema.schema.properties.actionKey.enum, ["generateStoryboard:V1", "openStoryPage:V1", "none"]);
  assert.ok(requests[0].prompt.includes(DIRECTOR_AGENT_PROMPT_MARKER));
  assert.ok(requests[0].prompt.includes("- generateStoryboard:V1：生成分镜（16:9，无背景音乐）（会调用文本模型）  ← 系统建议的下一步"));
  assert.ok(requests[0].prompt.includes("用户：到哪了\n导演助手：拆好了。"));
  assert.ok(requests[0].prompt.includes("<<<\n下一步做什么\n>>>"));
  assert.equal(requests[0].prompt.includes("## 补充说明"), false, "没有补充说明时整节不出现");
  assert.match(requests[1].prompt, /DIRECTOR_AGENT_ACTION_NOT_OFFERED/u);
  assert.equal(result.metadata.directorAgent.providerCalls, 2);
  assert.equal(result.metadata.directorAgent.rejections.length, 1);
});

test("补充说明原样进提示词，模型据此解释某一步为什么不在清单里", async () => {
  const { workflow, requests } = liveWorkflow([{ actionKey: "none", reply: "要先换镜头视频模型。" }]);
  await workflow.createDirectorAgentTurn(turnInput({ progress: { ...progress, notes: ["镜头视频现在做不了：镜头视频模型是 Kling kling-v3。"] } }));
  assert.ok(requests[0].prompt.includes("## 补充说明（某一步为什么不在清单里、顺序是不是硬性要求，以这里为准）\n- 镜头视频现在做不了：镜头视频模型是 Kling kling-v3。"));
});

test("两次都选错：如实报错，两次的诊断都在，不拿确定性答案顶替；禁止第三次", async () => {
  const { workflow, requests } = liveWorkflow([
    { actionKey: "openShotVideo:V1:A09", reply: "好" },
    { actionKey: "generateFullStory:V1", reply: "好" },
    { actionKey: "none", reply: "不该被调用" }
  ]);
  await assert.rejects(() => workflow.createDirectorAgentTurn(turnInput()), (error) => {
    assert.equal(error.name, "ModelPipelineError");
    // 序号挂在 metadata.attempt 上（ValidationDiagnostic.toJSON 把额外字段带在那里）。
    assert.deepEqual(error.diagnostics.map((detail) => detail?.metadata?.attempt), [1, 2]);
    return true;
  });
  assert.equal(requests.length, 2);
});

test("内容审核拦截不重试，只调用一次", async () => {
  const { workflow, requests } = liveWorkflow([
    () => ({ content: "The request was rejected because it was considered high risk", finishReason: "content_filter", usage: null }),
    { actionKey: "none", reply: "不该被调用" }
  ]);
  await assert.rejects(() => workflow.createDirectorAgentTurn(turnInput()), (error) => error.code === "MODEL_CONTENT_FILTERED");
  assert.equal(requests.length, 1);
});

test("千问的 GLM-5.3 关不掉思考：在调用之前说清楚，不发请求", async () => {
  const { workflow, requests } = liveWorkflow([], { provider: "Qwen", model: "ZHIPU/GLM-5.3" });
  await assert.rejects(() => workflow.createDirectorAgentTurn(turnInput()), (error) => error instanceof InputError && /不能关闭思考/u.test(error.message));
  assert.equal(requests.length, 0);
});

test("源码登记：路由、阶段默认值、阶段兜底与名称、侧车 scope、模型设置表都用同一个名字", async () => {
  const server = await fs.readFile(new URL("../server.js", import.meta.url), "utf8");
  assert.match(server, /"\/api\/director-agent\/turn": \(body\) => workflow\.createDirectorAgentTurn\(body\),/u);
  assert.match(server, /directorAgent: stageSetting\(provider, source\.model, 8192\)/u);
  assert.match(server, /MODEL_OUTPUT_LOG_SCOPES\.DIRECTOR_AGENT\n\];/u);
  assert.equal(MODEL_OUTPUT_LOG_SCOPES.DIRECTOR_AGENT, DIRECTOR_AGENT_STAGE);
  const workflow = await fs.readFile(new URL("../src/workflow.js", import.meta.url), "utf8");
  assert.match(workflow, /directorAgent: \{ provider, model: "", maxCompletionTokens: 8192 \}/u);
  assert.match(workflow, /directorAgent: "导演助手"/u);
  assert.match(workflow, /thinking: "disabled",/u);
  const app = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /\{ key: "directorAgent", label: "导演助手", [^\n]*optional: true \}/u);
  // 对话不进任何浏览器存储。
  for (const file of ["director-agent-controller.js", "director-agent-progress.js", "director-agent-panel.js", "director-agent-messages.js", "director-agent-actions.js"]) {
    const source = await fs.readFile(new URL(`../public/${file}`, import.meta.url), "utf8");
    assert.equal(/\b(?:localStorage|sessionStorage|indexedDB)\s*\./u.test(source), false, file);
  }
});

test("真实 HTTP：/api/director-agent/turn 只出建议，带用量信封；千问请求关闭思考", async () => {
  const runtime = await createStoryEntryRuntime();
  try {
    const { post, requests } = runtime;
    const ok = await post("/api/director-agent/turn", turnInput());
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.ok, true);
    assert.deepEqual(ok.json.result.turn, { actionKey: "generateStoryboard:V1", reply: "协议测试的导演助手回复。" });
    assert.equal(ok.json.result.metadata.directorAgent.providerCalls, 1);
    assert.equal(ok.json.usage.calls, 1);
    const sent = requests.at(-1);
    assert.equal(sent.enable_thinking, false);
    assert.equal(sent.messages.find((row) => row.role === "system").content, DIRECTOR_AGENT_SYSTEM_PROMPT);
    const bad = await post("/api/director-agent/turn", turnInput({ message: "" }));
    assert.equal(bad.status, 400);
    assert.equal(requests.length, 1, "请求不合法时不调用模型");
  } finally {
    await runtime.close();
  }
});

// ---- 一句话修改（2026-10-11，第三期）----

test("一句话修改的动作：页面送来的清单里可以有；演示模式说到「改」「删」时对上修改，点名某一镜优先只改那一镜的提示词", async () => {
  const editProgress = {
    ...structuredClone(progress),
    actions: [
      ...progress.actions,
      { key: "editStory:V1", label: "按用户的话修改可翻拍镜头（情节、动作、台词）", cost: "text" },
      { key: "editStoryboard:V1", label: "按用户的话修改分镜", cost: "text" },
      { key: "editShotPrompt:V1:A03", label: "按用户的话只改镜头 A03 的视频提示词（不改分镜）", cost: "text" }
    ]
  };
  assert.equal(normalizeDirectorAgentTurnInput(turnInput({ progress: editProgress })).progress.actions.length, 5);
  const workflow = new WorkflowService({ clients: {}, stageDefaults: {} });
  const pick = async (message) => (await workflow.createDirectorAgentTurn(turnInput({ message, progress: editProgress }))).turn.actionKey;
  assert.equal(await pick("A03 别让她回头，改一下"), "editShotPrompt:V1:A03");
  assert.equal(await pick("把第二场改成雨夜"), "editStory:V1");
  assert.equal(await pick("继续"), "generateStoryboard:V1");
});

test("导演助手的规则：修改对到「按用户的话修改」，点名某一镜先选只改提示词，没说改成什么就请用户说完整", async () => {
  const { workflow, requests } = liveWorkflow([{ actionKey: "none", reply: "请把要改的内容说完整。" }]);
  await workflow.createDirectorAgentTurn(turnInput({ message: "好的改吧" }));
  const prompt = requests[0].prompt;
  assert.match(prompt, /5\. 用户要改剧情、分镜、台词或某一镜的画面，从清单里选对应的「按用户的话修改……」编号。/u);
  assert.match(prompt, /清单里有「只改镜头 A03 的视频提示词」就选它，没有才选修改分镜/u);
  assert.match(prompt, /「好的改吧」「改一下」「再好一点」这类/u);
  assert.doesNotMatch(prompt, /这些现在做不了，用户问到就直说：修改剧情/u, "旧的「不能改」那一条已经换掉");
  assert.match(DIRECTOR_AGENT_SYSTEM_PROMPT, /由另一个步骤按他的原话写修改稿/u);
});
