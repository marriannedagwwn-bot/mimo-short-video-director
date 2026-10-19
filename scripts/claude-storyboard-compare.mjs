#!/usr/bin/env node
// Claude 四个型号写 4.0 分镜（设计分镜这一步）的对比（2026-10-19），用来定 Claude 的默认型号。
//
// 做法与 scripts/storyboard-design-ab.mjs 相同：冻结输入按生产同一口径投影（storyboardInput），
// 「粘贴完整故事」的输入用锁台词版提示词；每次只调用一次、不走重试，判据用生产的 ensureStoryboardDesign。
// 不建 Run、不写 Artifact，输入文件只读。与 MiMo 那次的差别只有一处：Claude 不发 responseSchema
// （生产里也不发，原因见 docs/claude-provider-2026-10-19.md），所以结构类失败会如实算进来。
// 指标里的表面计数照抄 storyboard-design-ab.mjs（58b927d），便于和 MiMo 的 round5-kite 并排看。
//
// 提示词默认取当前工作区；--prompt-rev 可以取指定提交里的 src/storyboard-prompts.js（用 git show 取出来临时加载），
// 新分镜写法还没合进本分支时用 --prompt-rev 58b927d。
//
// 用法：
//   node --use-env-proxy scripts/claude-storyboard-compare.mjs --env <.env 路径> --package <run-artifacts.json> [选项]
// 选项：
//   --models a,b        跑哪几个型号，默认四个都跑
//   --samples <n>       每个型号跑几次，默认 2
//   --prompt-rev <提交> 提示词取自哪个提交，默认当前工作区
//   --concurrency <n>   同时进行的调用数，默认 4
//   --out <dir>         输出目录，默认 reports/claude-storyboard-compare-<日期>
//   --dry-run           不调用模型：只投影输入、用免费的 count_tokens 数输入 token，并按假设的输出量估费用
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadEnv, getConfig } from "../src/config.js";
import { initializeSystemProxy } from "../src/system-proxy.js";
import { CLAUDE_MODELS, ClaudeClient } from "../src/claude-client.js";
import { ModelCallCoordinator } from "../src/model-call-coordinator.js";
import * as currentPrompts from "../src/storyboard-prompts.js";
import { storyboardInput } from "../src/storyboard-workflow.js";
import { ensureStoryboardDesign } from "../src/storyboard-contract.js";
import { storyCharacterNames } from "../src/full-story-character-registry.js";
import { normalizeDialogueChars } from "../src/validation.js";
import { STORY_MODE_FULL_TEXT } from "../public/story-entry.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 美元 / 百万 token（输入 / 输出；思考 token 按输出计费）。
// https://platform.claude.com/docs/en/about-claude/models/overview（2026-10-19 核对；Haiku 5.5 是 10 万 token 以内提示词的价格）
const PRICES_USD_PER_MILLION = Object.freeze({
  "claude-opus-5-5": [4, 20],
  "claude-sonnet-5-5": [2, 10],
  "claude-haiku-5-5": [0.1, 0.5],
  "claude-fable-5-1": [10, 50]
});
// 只用于 --dry-run 的输出量假设：MiMo 同一输入两次是 2.0–2.3 万 token（其中推理 1.2–1.3 万）。
const ASSUMED_OUTPUT_TOKENS = [12_000, 25_000];

async function loadPrompts(rev) {
  if (!rev) return currentPrompts;
  const source = execFileSync("git", ["show", `${rev}:src/storyboard-prompts.js`], { cwd: projectRoot, encoding: "utf8" });
  const rewritten = source.replace(/from "\.\/([^"]+)"/gu, (_, file) => `from "${pathToFileURL(path.join(projectRoot, "src", file)).href}"`);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-compare-prompts-"));
  const file = path.join(dir, "storyboard-prompts.mjs");
  await fs.writeFile(file, rewritten);
  return import(pathToFileURL(file).href);
}

function parseArgs(argv) {
  const options = { env: "", pkg: "", models: [...CLAUDE_MODELS], samples: 2, promptRev: "", concurrency: 4, out: "", dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === "--env") { options.env = value; i += 1; }
    else if (key === "--package") { options.pkg = value; i += 1; }
    else if (key === "--models") { options.models = String(value || "").split(",").map((item) => item.trim()).filter(Boolean); i += 1; }
    else if (key === "--samples") { options.samples = Number(value); i += 1; }
    else if (key === "--prompt-rev") { options.promptRev = value; i += 1; }
    else if (key === "--concurrency") { options.concurrency = Number(value); i += 1; }
    else if (key === "--out") { options.out = value; i += 1; }
    else if (key === "--dry-run") options.dryRun = true;
    else throw new Error(`不认识的参数：${key}`);
  }
  if (!options.env || !options.pkg) throw new Error("需要 --env 与 --package");
  if (!Number.isInteger(options.samples) || options.samples < 1) throw new Error("--samples 必须是正整数");
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) throw new Error("--concurrency 必须是正整数");
  const unknown = options.models.filter((model) => !CLAUDE_MODELS.includes(model));
  if (!options.models.length || unknown.length) throw new Error(`--models 只能是 ${CLAUDE_MODELS.join("、")}`);
  return options;
}

// 以下表面计数照抄 scripts/storyboard-design-ab.mjs（58b927d），写得对不对要逐份读。
const DIRECTION_WORDS = /画面(?:左|右)(?:侧|边)?|从(?:画面)?(?:左|右)(?:侧|边)?|朝(?:画面)?(?:左|右)|向(?:画面)?(?:左|右)|入画|出画/gu;
const count = (text, pattern) => (String(text || "").match(pattern) || []).length;

function metrics(design, fullStory) {
  const shots = Array.isArray(design?.shotPlan) ? design.shotPlan : [];
  const beats = shots.flatMap((shot) => (Array.isArray(shot.beats) ? shot.beats : []));
  const lengths = beats.map((beat) => Number(beat.endSeconds) - Number(beat.startSeconds));
  const names = storyCharacterNames(fullStory || {});
  const protagonist = String(fullStory?.characterBible?.protagonist?.name || names[0] || "");
  const storyLines = new Set((fullStory?.sceneScript || []).flatMap((scene) => (scene.dialogue || []).map((row) => normalizeDialogueChars(row.line))).filter(Boolean));
  const planLines = beats.flatMap((beat) => (Array.isArray(beat.dialogue) ? beat.dialogue : []).map((row) => normalizeDialogueChars(row.text))).filter(Boolean);
  return {
    shots: shots.length,
    beats: beats.length,
    totalSeconds: shots.reduce((sum, shot) => sum + (Number(shot.durationSeconds) || 0), 0),
    minBeatSeconds: lengths.length ? Math.min(...lengths) : 0,
    beatsUnder1s: lengths.filter((length) => length < 1).length,
    nonIntegerBeats: beats.filter((beat) => !Number.isInteger(Number(beat.startSeconds)) || !Number.isInteger(Number(beat.endSeconds))).length,
    emptyBeats: beats.filter((beat) => Array.isArray(beat.characters) && beat.characters.length === 0).length,
    opensOnEmptyShot: Boolean(shots[0]?.beats?.[0] && shots[0].beats[0].characters?.length === 0),
    beatsNamingCharacterInSound: beats.filter((beat) => names.some((name) => String(beat.soundDesign || "").includes(name))).length,
    dialogueNotInStory: planLines.filter((line) => !storyLines.has(line)).length,
    dialogueLines: planLines.length,
    closeUps: beats.filter((beat) => /特写|微距/u.test(beat.framing)).length,
    povShots: beats.filter((beat) => /视角|主观/u.test(`${beat.framing} ${beat.camera}`)).length,
    specialAngles: beats.filter((beat) => /低机位|贴地|俯拍|仰拍|顶拍|地板高度/u.test(`${beat.framing} ${beat.camera}`)).length,
    movingCamera: beats.filter((beat) => /推近|拉远|后拉|跟拍|跟摇|上摇|前推|横移|推到|摇向|摇到/u.test(beat.camera)).length,
    protagonistVoiced: beats.filter((beat) => (beat.dialogue || []).some((row) => row.speaker === protagonist)
      || new RegExp(`${protagonist}[^，。；]{0,12}(?:叫|喊|哼|笑|「|“)`, "u").test(beat.soundDesign || "")).length,
    beatsWithDirectionWords: beats.filter((beat) => count(`${beat.framing} ${beat.camera} ${beat.visibleAction}`, DIRECTION_WORDS) > 0).length,
    beatTextChars: beats.reduce((sum, beat) => sum + `${beat.framing}${beat.camera}${beat.visibleAction}${beat.soundDesign}`.length, 0)
  };
}

function costUsd(model, inputTokens, outputTokens) {
  const [input, output] = PRICES_USD_PER_MILLION[model];
  return (inputTokens * input + outputTokens * output) / 1_000_000;
}

async function mapPool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}

function renderSummary({ runs, options, startedAt, projected }) {
  const lines = ["# Claude 四个型号写分镜（设计分镜一步）", ""];
  lines.push(`- 时间：${startedAt}`);
  lines.push(`- 冻结输入：${options.pkg}（时长窗口 ${projected.durationWindow.min}–${projected.durationWindow.max} 秒，画风「${projected.artStyle || "无"}」，背景音乐 ${projected.backgroundMusicMode}）`);
  lines.push(`- 提示词：${options.promptRev ? `${options.promptRev} 的 src/storyboard-prompts.js` : "当前工作区"}；每次只调用一次，不走重试，不带 responseSchema；思考与 effort 用各型号默认值；每个型号 ${options.samples} 次`, "");
  lines.push("| 型号 | 次 | 判据 | 片段 / beat | 总时长 | 平均每镜 | 最短 beat / 不到 1 秒 / 非整数 | 空镜 beat / 开场是空镜 | 特写 / 视角 / 特殊机位 / 带运镜（代理） | 主角出声的 beat（代理） | soundDesign 点到角色名的 beat（代理） | 对不上剧情的台词 | 含方向词的 beat（代理） | 文字量 | 输入 / 输出（其中思考）token | 费用 | 耗时 |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const run of runs) {
    const m = run.metrics || {};
    const u = run.usage || {};
    lines.push(`| ${run.model} | ${run.sample} | ${run.error ? `调用失败：${run.error}` : run.codes.length ? run.codes.join("、") : "通过"} | ${m.shots ?? "—"} / ${m.beats ?? "—"} | ${m.totalSeconds ?? "—"} 秒 | ${m.beats ? (m.totalSeconds / m.beats).toFixed(1) : "—"} 秒 | ${m.minBeatSeconds ?? "—"} / ${m.beatsUnder1s ?? "—"} / ${m.nonIntegerBeats ?? "—"} | ${m.emptyBeats ?? "—"} / ${m.opensOnEmptyShot === undefined ? "—" : m.opensOnEmptyShot ? "是" : "否"} | ${m.closeUps ?? "—"} / ${m.povShots ?? "—"} / ${m.specialAngles ?? "—"} / ${m.movingCamera ?? "—"} | ${m.protagonistVoiced ?? "—"}/${m.beats ?? "—"} | ${m.beatsNamingCharacterInSound ?? "—"}/${m.beats ?? "—"} | ${m.dialogueNotInStory ?? "—"}/${m.dialogueLines ?? "—"} | ${m.beatsWithDirectionWords ?? "—"}/${m.beats ?? "—"} | ${m.beatTextChars ?? "—"} | ${u.input_tokens ?? "—"} / ${u.output_tokens ?? "—"}（${u.output_tokens_details?.thinking_tokens ?? "—"}） | ${run.costUsd === undefined ? "—" : `$${run.costUsd.toFixed(3)}`} | ${Math.round(run.durationMs / 1000)} 秒 |`);
  }
  const total = runs.reduce((sum, run) => sum + (run.costUsd || 0), 0);
  lines.push("", `合计费用约 $${total.toFixed(2)}（按官方单价与实际用量算；调用失败但已产生输出的也计入）。`);
  lines.push("逐片段原文在 calls.jsonl（design 字段）。带「代理」的列只是表面计数，写得对不对要逐份读。");
  return lines.join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const pkg = JSON.parse(await fs.readFile(path.resolve(options.pkg), "utf8"));
  const plan = pkg.animationPlan;
  const workflow = { assertGlobalCharacterBoundary: () => pkg.visualGuardrails, resolveStage: () => ({}), hasLiveClient: false };
  const { projected } = await storyboardInput(workflow, {
    fullStory: pkg.fullStory, creatorProfile: pkg.creatorProfile, artStyle: plan.productionStrategy.artStyle,
    targetAspectRatio: plan.productionStrategy.targetAspectRatio, backgroundMusicEnabled: plan.productionStrategy.backgroundMusicMode !== "none",
    characterExpressionRules: plan.productionStrategy.characterExpressionRules || ""
  });
  if (JSON.stringify(projected.characterRegistry) !== JSON.stringify(plan.characterRegistry)) throw new Error("投影出的角色表与原分镜不一致");
  const dialogueLocked = pkg.storySource?.storyMode === STORY_MODE_FULL_TEXT;
  const prompts = await loadPrompts(options.promptRev);
  const prompt = (dialogueLocked ? prompts.storyboardPromptWithLockedDialogue : prompts.storyboardPrompt)(projected);
  const systemPrompt = prompts.storyboardSystem;

  loadEnv(path.resolve(options.env));
  const systemProxy = await initializeSystemProxy();
  try {
    const config = getConfig().claude;
    if (!config.enabled) throw new Error("Claude 没有配置（CLAUDE_API_KEY），跑不了真实对比");
    const client = new ClaudeClient(config);
    process.stdout.write(`提示词 ${prompt.length} 字（系统提示 ${systemPrompt.length} 字），锁台词 ${dialogueLocked ? "是" : "否"}，max_tokens ${config.maxCompletionTokens}，effort ${config.effort || "各型号默认"}\n`);

    if (options.dryRun) {
      // count_tokens 免费；按每个型号自己的分词器数。
      const sdk = client.sdkClient();
      let low = 0;
      let high = 0;
      for (const model of options.models) {
        const counted = await sdk.messages.countTokens({ model, system: systemPrompt, messages: [{ role: "user", content: prompt }] });
        const perCall = ASSUMED_OUTPUT_TOKENS.map((output) => costUsd(model, counted.input_tokens, output));
        low += perCall[0] * options.samples;
        high += perCall[1] * options.samples;
        process.stdout.write(`${model}：输入 ${counted.input_tokens} token；假设输出 ${ASSUMED_OUTPUT_TOKENS.join("–")} token 时每次约 $${perCall[0].toFixed(3)}–$${perCall[1].toFixed(3)}\n`);
      }
      process.stdout.write(`${options.models.length} 个型号 × ${options.samples} 次合计约 $${low.toFixed(2)}–$${high.toFixed(2)}（没有调用模型）\n`);
      return;
    }

    const startedAt = new Date().toISOString();
    const outDir = path.resolve(options.out || path.join(projectRoot, "reports", `claude-storyboard-compare-${startedAt.slice(0, 10)}`));
    await fs.mkdir(outDir, { recursive: true });
    const jobs = options.models.flatMap((model) => Array.from({ length: options.samples }, (_, i) => ({ model, sample: i + 1 })));
    process.stdout.write(`${options.models.length} 个型号 × ${options.samples} 次 = ${jobs.length} 次调用 → ${outDir}\n`);
    const coordinator = new ModelCallCoordinator({ maxProviderCalls: 1 });
    const runs = await mapPool(jobs, options.concurrency, async (job) => {
      const startedMs = Date.now();
      let attempt = null;
      const finish = (extra) => {
        const usage = attempt?.usage || null;
        const cost = usage ? costUsd(job.model, Number(usage.input_tokens) || 0, Number(usage.output_tokens) || 0) : undefined;
        return { ...job, durationMs: Date.now() - startedMs, usage, costUsd: cost, ...extra };
      };
      try {
        const design = await coordinator.runJson({
          client, provider: "Claude", stage: "storyboardDesign", maxProviderCalls: 1,
          request: { prompt, systemPrompt, model: job.model, maxCompletionTokens: config.maxCompletionTokens },
          // 失败的那次也留下模型原文：2026-10-19 第一轮 3 次「未返回严格 JSON」没存原文，事后查不出是哪种失败。
          attemptObserver: async (info) => { attempt = { finishReason: info.finishReason, status: info.status, code: info.code, usage: info.usage || info.metadata?.usage || null, content: info.status === "failed" ? info.content : undefined }; },
          validate: (candidate) => candidate
        });
        let codes = [];
        try { ensureStoryboardDesign(structuredClone(design), projected); }
        catch (error) {
          const details = Array.isArray(error?.details) && error.details.length ? error.details : [{ code: error?.code || error?.name || "INVALID" }];
          codes = details.map((item) => item.code || "INVALID");
        }
        const run = finish({ attempt, codes, metrics: metrics(design, pkg.fullStory), design });
        process.stdout.write(`${job.model} #${job.sample}：${codes.length ? codes.join("、") : "过判据"}，${run.metrics.shots} 段 ${run.metrics.totalSeconds} 秒，$${(run.costUsd ?? 0).toFixed(3)}，${Math.round(run.durationMs / 1000)}s\n`);
        return run;
      } catch (error) {
        process.stdout.write(`${job.model} #${job.sample}：失败 ${error?.code || ""} ${error?.message || error}\n`);
        return finish({ attempt, error: `${error?.code || "ERROR"} ${error?.message || error}` });
      }
    });
    await fs.writeFile(path.join(outDir, "calls.jsonl"), runs.map((run) => JSON.stringify(run)).join("\n") + "\n");
    await fs.writeFile(path.join(outDir, "summary.md"), renderSummary({ runs, options, startedAt, projected }) + "\n");
    process.stdout.write(`已写入 ${path.join(outDir, "summary.md")}\n`);
  } finally {
    await systemProxy?.close?.();
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
