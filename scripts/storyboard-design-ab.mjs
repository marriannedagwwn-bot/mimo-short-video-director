#!/usr/bin/env node
// 4.0 分镜设计提示词新旧对比：只调用 storyboardDesign 这一步。
//
// 冻结输入取自一份已签发的 3.1 测试包（完整剧情、角色边界与原分镜的制作参数），用 storyboardInput
// 按生产同一口径投影；「粘贴完整故事」的包用锁台词版提示词，与生产 createStoryboardPlan 相同。
// 旧写法 = 指定提交（--old-rev）里的 src/storyboard-prompts.js，用 git show 取出来临时加载；
// 新写法 = 当前工作区。2026-10-13 的方向规则对比用 --old-rev cbc407e 可以复现。
// 每次只调用一次、不走重试；判据用生产的 ensureStoryboardDesign。不建 Run、不写 Artifact，包文件只读。
//
// 用法：
//   node --use-env-proxy scripts/storyboard-design-ab.mjs --env <.env 路径> --package <package-3.1.sealed.json> [选项]
// 选项：
//   --samples <n>       每种写法跑几次，默认 2
//   --arms old,new      跑哪几种写法，默认两种
//   --old-rev <提交>    旧写法取自哪个提交，默认 4b9bc03（2026-10-19 分镜写法替换之前）
//   --concurrency <n>   同时进行的调用数，默认 4
//   --out <dir>         输出目录，默认 reports/storyboard-design-ab-<日期>
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadEnv, getConfig } from "../src/config.js";
import { initializeSystemProxy } from "../src/system-proxy.js";
import { MimoClient } from "../src/mimo-client.js";
import { ModelCallCoordinator } from "../src/model-call-coordinator.js";
import { storyboardPrompt, storyboardPromptWithLockedDialogue, storyboardSystem } from "../src/storyboard-prompts.js";
import { storyboardInput } from "../src/storyboard-workflow.js";
import { ensureStoryboardDesign } from "../src/storyboard-contract.js";
import { storyCharacterNames } from "../src/full-story-character-registry.js";
import { normalizeDialogueChars } from "../src/validation.js";
import { STORYBOARD_DESIGN_MODEL_SCHEMA_NAME, storyboardDesignModelSchema } from "../src/contracts/storyboard-design-model-schema.js";
import { STORY_MODE_FULL_TEXT } from "../public/story-entry.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OLD_REV = "4b9bc03";

// 旧提示词模块里的相对 import 改成指向当前工作区的绝对路径（那两个模块这次没改）。
async function loadOldPrompts(rev) {
  const source = execFileSync("git", ["show", `${rev}:src/storyboard-prompts.js`], { cwd: projectRoot, encoding: "utf8" });
  const rewritten = source.replace(/from "\.\/([^"]+)"/gu, (_, file) => `from "${pathToFileURL(path.join(projectRoot, "src", file)).href}"`);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "storyboard-old-prompts-"));
  const file = path.join(dir, "storyboard-prompts.mjs");
  await fs.writeFile(file, rewritten);
  return import(pathToFileURL(file).href);
}

function parseArgs(argv) {
  const options = { env: "", pkg: "", samples: 2, arms: ["old", "new"], oldRev: DEFAULT_OLD_REV, concurrency: 4, out: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === "--env") { options.env = value; i += 1; }
    else if (key === "--package") { options.pkg = value; i += 1; }
    else if (key === "--samples") { options.samples = Number(value); i += 1; }
    else if (key === "--arms") { options.arms = String(value || "").split(",").map((item) => item.trim()).filter(Boolean); i += 1; }
    else if (key === "--concurrency") { options.concurrency = Number(value); i += 1; }
    else if (key === "--out") { options.out = value; i += 1; }
    else if (key === "--old-rev") { options.oldRev = value; i += 1; }
    else throw new Error(`不认识的参数：${key}`);
  }
  if (!options.env || !options.pkg) throw new Error("需要 --env 与 --package");
  if (!Number.isInteger(options.samples) || options.samples < 1) throw new Error("--samples 必须是正整数");
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) throw new Error("--concurrency 必须是正整数");
  if (!options.arms.length || options.arms.some((arm) => !["old", "new"].includes(arm))) throw new Error("--arms 只能是 old、new");
  return options;
}

// 只作参考的表面计数：写了「画面左/右」不等于写对了，方向对不对靠人工逐份看。
const DIRECTION_WORDS = /画面(?:左|右)(?:侧|边)?|从(?:画面)?(?:左|右)(?:侧|边)?|朝(?:画面)?(?:左|右)|向(?:画面)?(?:左|右)|入画|出画/gu;
const count = (text, pattern) => (String(text || "").match(pattern) || []).length;

function metrics(design, fullStory) {
  const shots = Array.isArray(design?.shotPlan) ? design.shotPlan : [];
  const beats = shots.flatMap((shot) => (Array.isArray(shot.beats) ? shot.beats : []));
  const lengths = beats.map((beat) => Number(beat.endSeconds) - Number(beat.startSeconds));
  const names = storyCharacterNames(fullStory || {});
  const protagonist = String(fullStory?.characterBible?.protagonist?.name || names[0] || "");
  // 只作参考的表面计数：soundDesign 里出现角色名不等于写了人声，人声写没写、写得对不对靠人工逐份看。
  const beatsNamingCharacterInSound = beats.filter((beat) => names.some((name) => String(beat.soundDesign || "").includes(name))).length;
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
    beatsNamingCharacterInSound,
    // 与完整剧情逐句（去标点空白后）对不上的分镜台词：锁台词时应为 0。
    dialogueNotInStory: planLines.filter((line) => !storyLines.has(line)).length,
    dialogueLines: planLines.length,
    // 以下同样只是表面计数（2026-10-19 第二轮）：用来和手写版比镜头结构，写得对不对要逐份读。
    closeUps: beats.filter((beat) => /特写|微距/u.test(beat.framing)).length,
    povShots: beats.filter((beat) => /视角|主观/u.test(`${beat.framing} ${beat.camera}`)).length,
    specialAngles: beats.filter((beat) => /低机位|贴地|俯拍|仰拍|顶拍|地板高度/u.test(`${beat.framing} ${beat.camera}`)).length,
    movingCamera: beats.filter((beat) => /推近|拉远|后拉|跟拍|跟摇|上摇|前推|横移|推到|摇向|摇到/u.test(beat.camera)).length,
    protagonistVoiced: beats.filter((beat) => (beat.dialogue || []).some((row) => row.speaker === protagonist)
      || new RegExp(`${protagonist}[^，。；]{0,12}(?:叫|喊|哼|笑|「|“)`, "u").test(beat.soundDesign || "")).length,
    beatsWithDirectionWords: beats.filter((beat) => count(`${beat.framing} ${beat.camera} ${beat.visibleAction}`, DIRECTION_WORDS) > 0).length,
    continuityOutWithDirectionWords: shots.filter((shot) => count(shot.continuityOut, DIRECTION_WORDS) > 0).length,
    beatTextChars: beats.reduce((sum, beat) => sum + `${beat.framing}${beat.camera}${beat.visibleAction}${beat.soundDesign}`.length, 0)
  };
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

function renderSummary({ runs, options, model, startedAt, projected }) {
  const lines = [`# 分镜设计提示词新旧对比`, ""];
  lines.push(`- 时间：${startedAt}`);
  lines.push(`- 冻结输入：${options.pkg}（时长窗口 ${projected.durationWindow.min}–${projected.durationWindow.max} 秒，画风「${projected.artStyle || "无"}」，背景音乐 ${projected.backgroundMusicMode}）`);
  lines.push(`- 写稿模型：MiMo ${model}（每次只调用一次，不走重试，带与生产相同的 responseSchema）；每种写法 ${options.samples} 次`);
  lines.push(`- 旧写法：${options.oldRev} 的 src/storyboard-prompts.js；新写法：当前工作区`, "");
  lines.push("| 写法 | 次 | 判据 | 片段 / beat | 总时长 | 平均每镜 | 最短 beat / 不到 1 秒 / 非整数 | 空镜 beat / 开场是空镜 | 特写 / 视角 / 特殊机位 / 带运镜（代理） | 主角出声的 beat（代理） | soundDesign 点到角色名的 beat（代理） | 对不上剧情的台词 | 含方向词的 beat（代理） | 文字量 | 耗时 |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const run of runs) {
    const m = run.metrics || {};
    lines.push(`| ${run.arm} | ${run.sample} | ${run.error ? `调用失败：${run.error}` : run.codes.length ? run.codes.join("、") : "通过"} | ${m.shots ?? "—"} / ${m.beats ?? "—"} | ${m.totalSeconds ?? "—"} 秒 | ${m.beats ? (m.totalSeconds / m.beats).toFixed(1) : "—"} 秒 | ${m.minBeatSeconds ?? "—"} / ${m.beatsUnder1s ?? "—"} / ${m.nonIntegerBeats ?? "—"} | ${m.emptyBeats ?? "—"} / ${m.opensOnEmptyShot === undefined ? "—" : m.opensOnEmptyShot ? "是" : "否"} | ${m.closeUps ?? "—"} / ${m.povShots ?? "—"} / ${m.specialAngles ?? "—"} / ${m.movingCamera ?? "—"} | ${m.protagonistVoiced ?? "—"}/${m.beats ?? "—"} | ${m.beatsNamingCharacterInSound ?? "—"}/${m.beats ?? "—"} | ${m.dialogueNotInStory ?? "—"}/${m.dialogueLines ?? "—"} | ${m.beatsWithDirectionWords ?? "—"}/${m.beats ?? "—"} | ${m.beatTextChars ?? "—"} | ${Math.round(run.durationMs / 1000)} 秒 |`);
  }
  lines.push("", "逐片段原文在 calls.jsonl（design 字段）。带「代理」的列只是表面计数，写得对不对要逐份读。");
  return lines.join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const pkg = JSON.parse(await fs.readFile(path.resolve(options.pkg), "utf8"));
  const plan = pkg.animationPlan;
  // 角色边界的签名在导出时已经验过；这里只读，按生产同一口径投影。
  const workflow = { assertGlobalCharacterBoundary: () => pkg.visualGuardrails, resolveStage: () => ({}), hasLiveClient: false };
  const { projected } = await storyboardInput(workflow, {
    fullStory: pkg.fullStory, creatorProfile: pkg.creatorProfile, artStyle: plan.productionStrategy.artStyle,
    targetAspectRatio: plan.productionStrategy.targetAspectRatio, backgroundMusicEnabled: plan.productionStrategy.backgroundMusicMode !== "none",
    characterExpressionRules: plan.productionStrategy.characterExpressionRules || ""
  });
  if (JSON.stringify(projected.characterRegistry) !== JSON.stringify(plan.characterRegistry)) throw new Error("投影出的角色表与原分镜不一致");
  const dialogueLocked = pkg.storySource?.storyMode === STORY_MODE_FULL_TEXT;
  const old = await loadOldPrompts(options.oldRev);
  const prompts = {
    new: (dialogueLocked ? storyboardPromptWithLockedDialogue : storyboardPrompt)(projected),
    old: (dialogueLocked ? old.storyboardPromptWithLockedDialogue : old.storyboardPrompt)(projected)
  };
  if (prompts.new === prompts.old) throw new Error(`当前工作区与 ${options.oldRev} 的提示词相同，没有可比的`);

  loadEnv(path.resolve(options.env));
  const systemProxy = await initializeSystemProxy();
  try {
    const config = getConfig();
    if (!config.mimo.enabled) throw new Error("MiMo 没有配置，跑不了真实对比");
    const client = new MimoClient(config.mimo);
    const model = config.mimo.animationModel;
    const startedAt = new Date().toISOString();
    const outDir = path.resolve(options.out || path.join(projectRoot, "reports", `storyboard-design-ab-${startedAt.slice(0, 10)}`));
    await fs.mkdir(outDir, { recursive: true });
    const jobs = options.arms.flatMap((arm) => Array.from({ length: options.samples }, (_, i) => ({ arm, sample: i + 1 })));
    process.stdout.write(`MiMo ${model}，锁台词 ${dialogueLocked ? "是" : "否"}，${options.arms.length} 种写法 × ${options.samples} 次 = ${jobs.length} 次调用 → ${outDir}\n`);

    const coordinator = new ModelCallCoordinator({ maxProviderCalls: 1 });
    const responseSchema = { name: STORYBOARD_DESIGN_MODEL_SCHEMA_NAME, schema: storyboardDesignModelSchema() };
    const runs = await mapPool(jobs, options.concurrency, async (job) => {
      const startedMs = Date.now();
      let attempt = null;
      try {
        const design = await coordinator.runJson({
          client, provider: "MiMo", stage: "storyboardDesign", maxProviderCalls: 1,
          request: { prompt: prompts[job.arm], systemPrompt: storyboardSystem, model, maxCompletionTokens: config.mimo.animationMaxCompletionTokens,
            requestTimeoutMs: config.mimo.requestTimeoutMs, responseSchema },
          attemptObserver: async (info) => { attempt = { finishReason: info.finishReason, status: info.status, usage: info.metadata?.usage || null }; },
          validate: (candidate) => candidate
        });
        let codes = [];
        try { ensureStoryboardDesign(structuredClone(design), projected); }
        catch (error) {
          // 没带结构化诊断的错误也要记成不通过，不能因为 details 为空就当成过了。
          const details = Array.isArray(error?.details) && error.details.length ? error.details : [{ code: error?.code || error?.name || "INVALID" }];
          codes = details.map((item) => item.code || "INVALID");
        }
        const run = { ...job, durationMs: Date.now() - startedMs, attempt, codes, metrics: metrics(design, pkg.fullStory), design };
        process.stdout.write(`${job.arm} #${job.sample}：${codes.length ? codes.join("、") : "过判据"}，${run.metrics.shots} 段 ${run.metrics.totalSeconds} 秒，${Math.round(run.durationMs / 1000)}s\n`);
        return run;
      } catch (error) {
        process.stdout.write(`${job.arm} #${job.sample}：失败 ${error?.code || ""} ${error?.message || error}\n`);
        return { ...job, durationMs: Date.now() - startedMs, attempt, error: `${error?.code || "ERROR"} ${error?.message || error}` };
      }
    });
    await fs.writeFile(path.join(outDir, "calls.jsonl"), runs.map((run) => JSON.stringify(run)).join("\n") + "\n");
    await fs.writeFile(path.join(outDir, "summary.md"), renderSummary({ runs, options, model, startedAt, projected }) + "\n");
    process.stdout.write(`已写入 ${path.join(outDir, "summary.md")}\n`);
  } finally {
    await systemProxy.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
