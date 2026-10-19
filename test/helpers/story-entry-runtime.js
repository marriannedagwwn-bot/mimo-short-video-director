import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { WorkflowService } from "../../src/workflow.js";
import { mockNarrativeFullStory, mockStoryEntryCandidates, mockVisualGuardrails } from "../../src/mock.js";
import { storyboardDesignFromPlan } from "../../src/storyboard-contract.js";
import { fullStoryCharacterRegistryInput, mockFullStoryCharacterRegistry } from "../../src/full-story-character-registry.js";
import { STORY_SOURCE_SCHEMA_VERSION } from "../../public/story-entry.js";
import { STORY_SCENE_SCRIPT_MARKER } from "../../src/story-entry-prompts.js";
import { DIRECTOR_AGENT_PROMPT_MARKER } from "../../src/director-agent-prompts.js";
import { ONE_SENTENCE_EDIT_PROMPT_MARKER } from "../../src/one-sentence-edit-prompts.js";

// 1×1 透明 PNG，只用来走通图片落盘路径。
const FIXTURE_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
export const FIXTURE_PNG_DATA_URL = `data:image/png;base64,${FIXTURE_PNG_BASE64}`;

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const STORY_ENTRY_FIXTURE_PROFILE = Object.freeze({ fixedCharacter: "阿岚，社区修理师", vertical: "动画", constraints: "" });
export const STORY_ENTRY_FIXTURE_TEXT = "雨夜，阿岚在社区修理铺里听见门外有小猫在叫。阿岚撑伞出门，在台阶下找到一只湿透的小猫。阿岚说：“别怕，我带你进屋。”她用旧毛巾把小猫擦干，又把一盏坏了的暖灯修好放在纸箱旁。天亮时，小猫在暖灯下睡着了。";

// 协议夹具：这里没有任何真实模型结果。假模型服务按提示词里的标记返回演示模式的同一份输出，
// 服务端照真实路径跑剧情入口：开 Run → storyPipeline → 完整剧情 → 4.0 分镜 → 单镜提示词。
// 粘贴完整故事没有候选：storyPipeline 的第二步直接按原文拆出可翻拍镜头（fullStory:V1）。
export async function createStoryEntryRuntime({ storyMode = "fullStoryText" } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mimo-story-entry-runtime-"));
  const workflow = new WorkflowService();
  const creatorProfile = { ...STORY_ENTRY_FIXTURE_PROFILE };
  const storySource = storyMode === "fullStoryText"
    ? { schemaVersion: STORY_SOURCE_SCHEMA_VERSION, storyMode, storyText: STORY_ENTRY_FIXTURE_TEXT }
    : { schemaVersion: STORY_SOURCE_SCHEMA_VERSION, storyMode };
  const storyEntry = { storyMode, storySource };
  // 演示模式在进程内把同一条链跑一遍，得到假模型要返回的内容，以及服务端应该签出的结果。
  const visualGuardrails = await workflow.createStoryEntryVisualGuardrails({ creatorProfile }, { storyEntry });
  const fromStorySource = storyMode === "fullStoryText";
  const themeVariants = fromStorySource
    ? null
    : await workflow.createStoryEntryCandidate({ creatorProfile, visualGuardrails, targetDurationSeconds: 60 }, { storyEntry });
  const variant = themeVariants ? themeVariants.variants[0] : null;
  const fullStoryInput = {
    creatorProfile, visualGuardrails, fullStorySchemaVersion: "full_story/1.2", targetDurationSeconds: 60,
    ...(variant ? { themeVariants, variant } : {})
  };
  const fullStory = await workflow.createFullStory(fullStoryInput, { storyEntry });
  const rawFullStory = mockNarrativeFullStory({ ...fullStoryInput, storySource, visualGuardrails });
  const planResult = await workflow.createAnimationPlanWithMetadata({
    creatorProfile, visualGuardrails, fullStory, ...(variant ? { variant } : {}),
    animationPlanVersion: "4.0", targetAspectRatio: "16:9", backgroundMusicEnabled: false
  }, { storyEntry });
  const plan = planResult.animationPlan;
  const video = await workflow.createShotVideoPrompt({ plan, shotId: plan.shotPlan[0].shotId, planDigest: "fixture", target: { provider: "Seedance", model: "doubao-seedance-2-0-260128" } });

  const requests = [];
  const imageRequests = [];
  // 一句话修改：测试按顺序塞好假模型的回复（对象，或收到提示词后算出回复的函数）；用完再来就 400。
  const oneSentenceEditReplies = [];
  const createdProjects = new Set();
  const provider = http.createServer(async (req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "qwen3.7-max" }, { id: "qwen3.7-plus" }] }));
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (req.url.endsWith("/images/generations")) {
      imageRequests.push(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ model: body.model, created: 1, data: [{ b64_json: FIXTURE_PNG_BASE64, size: "1x1" }], usage: {} }));
      return;
    }
    requests.push(body);
    const prompt = body.messages.find((row) => row.role === "user")?.content || "";
    const text = typeof prompt === "string" ? prompt : JSON.stringify(prompt);
    let value;
    if (text.includes("本次没有参考视频，只有用户自己预设的固定角色内容")) value = mockVisualGuardrails({ creatorProfile });
    else if (text.includes("原创一个可以实际拍摄的短视频故事候选")) value = mockStoryEntryCandidates({ creatorProfile, targetDurationSeconds: 60 });
    else if (text.includes(STORY_SCENE_SCRIPT_MARKER) || text.includes("你现在进入 AI 导演的“完整剧情”阶段")) value = rawFullStory;
    else if (text.includes("任务：整理本次 Full Story")) value = mockFullStoryCharacterRegistry(fullStoryCharacterRegistryInput(rawFullStory, creatorProfile));
    else if (text.includes("任务：将完整 Full Story")) value = storyboardDesignFromPlan(plan);
    else if (text.includes("你是分镜修稿编辑")) value = { strengths: [], guidance: ["协议测试的合成意见，未进行真实模型评审"], items: [] };
    else if (text.includes("你是单镜视频提示词撰写者")) {
      // 分镜签发了画风时，提示词会要求逐字写出它（服务端有确定性校验），假模型照做。
      const artStyle = /画风：全片统一为「([^」]+)」/u.exec(text)?.[1];
      value = { videoPrompt: `${artStyle ? `画风：${artStyle}。\n` : ""}${video.videoPrompt}` };
    }
    else if (text.includes(ONE_SENTENCE_EDIT_PROMPT_MARKER) && oneSentenceEditReplies.length) {
      const next = oneSentenceEditReplies.shift();
      value = typeof next === "function" ? next(text, body) : next;
    }
    else if (text.includes(DIRECTOR_AGENT_PROMPT_MARKER)) {
      // 导演助手：照提示词里标着「系统建议的下一步」的编号回答；没有就写 none。
      const suggested = /^- (\S+)：.*← 系统建议的下一步$/mu.exec(text)?.[1];
      value = { actionKey: suggested || "none", reply: "协议测试的导演助手回复。" };
    }
    else if (text.includes("你现在会看到一张用户上传的人物参考图")) {
      const reference = plan.characterReferencePrompts[0];
      value = {
        characterName: reference.characterName, storyRole: reference.storyRole, identity: reference.identity,
        appearancePrompt: reference.appearancePrompt, consistencyTags: reference.consistencyTags, forbiddenChanges: reference.forbiddenChanges,
        referenceImageNotes: "协议测试：未进行真实图像理解", referenceImageOverrideNotice: ""
      };
    }
    else {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Unexpected fixture prompt" } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(value) }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
  });
  const providerPort = await listen(provider);
  const reservation = http.createServer();
  const port = await listen(reservation);
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(process.execPath, ["--use-env-proxy", "server.js"], {
    cwd: path.resolve(import.meta.dirname, "../.."),
    env: {
      ...process.env,
      PORT: String(port),
      QWEN_BASE_URL: `http://127.0.0.1:${providerPort}/v1`,
      QWEN_API_KEY: "protocol-fixture-key",
      QWEN_ANIMATION_MODEL: "qwen3.7-max",
      MIMO_BASE_URL: "", DEFAULT_LLM_PROVIDER: "", DEEPSEEK_API_KEY: "", CLAUDE_API_KEY: "", MINIMAX_API_KEY: "",
      JIMENG_BASE_URL: `http://127.0.0.1:${providerPort}/api/v3`, JIMENG_API_KEY: "protocol-fixture-key", SEEDANCE_API_KEY: "", KLING_API_KEY: "", KLING_ACCESS_KEY: "", KLING_SECRET_KEY: "",
      WORKFLOW_PRODUCTION_STATE_DIR: path.join(root, "state"),
      WORKFLOW_GROUNDING_KEY: workflow.groundingKey.toString("hex"),
      WORKFLOW_CHARACTER_BOUNDARY_KEY: workflow.characterBoundaryKey.toString("hex"),
      FULL_STORY_MODEL_OUTPUT_LOG_DIR: path.join(root, "logs/story"),
      ANIMATION_PLAN_MODEL_OUTPUT_LOG_DIR: path.join(root, "logs/plan"),
      STAGE_MODEL_OUTPUT_LOG_DIR: path.join(root, "logs/stages"),
      PARTIAL_REPAIR_DEBUG_DIR: path.join(root, "logs/repair")
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i += 1) {
    if (child.exitCode !== null) throw new Error(logs);
    try { if ((await fetch(base)).ok) break; } catch {}
    await pause(50);
    if (i === 99) throw new Error("Fixture server startup timed out");
  }
  const post = async (route, body) => {
    const response = await fetch(base + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, json: await response.json() };
  };
  const api = async (route, body) => {
    const { status, json } = await post(route, body);
    if (status >= 400 || !json.ok) throw Object.assign(new Error(json.error || JSON.stringify(json)), { response: json, status });
    for (const projectId of [json.result?.projectId, json.result?.production?.projectId]) if (projectId) createdProjects.add(projectId);
    return json.result;
  };
  const wait = async (task, run) => {
    for (let i = 0; i < 200; i += 1) {
      const response = await fetch(`${base}/api/tasks/${task.taskId}?projectId=${run.projectId}&runId=${run.runId}`);
      const current = (await response.json()).result;
      if (!["queued", "running"].includes(current.status)) return current;
      await pause(50);
    }
    throw new Error("Task did not finish");
  };
  return {
    root, base, workflow, creatorProfile, storySource, storyEntry, visualGuardrails, themeVariants, variant, fullStory, plan, video,
    requests, imageRequests, oneSentenceEditReplies, api, post, wait,
    close: async () => {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
      provider.closeAllConnections();
      await new Promise((resolve) => provider.close(resolve));
      await fs.rm(root, { recursive: true, force: true });
      // 角色参考图按媒体命名空间写进 public/generated-images/<project>/…，测试结束一并清掉。
      for (const projectId of createdProjects) {
        await fs.rm(path.resolve(import.meta.dirname, "../../public/generated-images", projectId), { recursive: true, force: true });
      }
    },
    logs: () => logs
  };
}
