#!/usr/bin/env node
// 4.0 分镜设计提示词新旧对比（2026-10-13）：只调用 storyboardDesign 这一步。
//
// 冻结输入取自一份已签发的 3.1 测试包（完整剧情、角色边界与原分镜的制作参数），用 storyboardInput
// 按生产同一口径投影；「粘贴完整故事」的包用锁台词版提示词，与生产 createStoryboardPlan 相同。
// 旧写法 = 现提示词去掉 2026-10-13 补的两段（第 6 条的进出画面方向、第 8 条的相邻片段方向接续），
// 启动时用 golden 测试的同一份输入核对：去掉后的哈希必须等于改动前的值。
// 每次只调用一次、不走重试；判据用生产的 ensureStoryboardDesign。不建 Run、不写 Artifact，包文件只读。
//
// 用法：
//   node --use-env-proxy scripts/storyboard-design-ab.mjs --env <.env 路径> --package <package-3.1.sealed.json> [选项]
// 选项：
//   --samples <n>       每种写法跑几次，默认 2
//   --arms old,new      跑哪几种写法，默认两种
//   --concurrency <n>   同时进行的调用数，默认 4
//   --out <dir>         输出目录，默认 reports/storyboard-design-ab-<日期>
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadEnv, getConfig } from "../src/config.js";
import { initializeSystemProxy } from "../src/system-proxy.js";
import { MimoClient } from "../src/mimo-client.js";
import { ModelCallCoordinator } from "../src/model-call-coordinator.js";
import { storyboardPrompt, storyboardPromptWithLockedDialogue, storyboardSystem } from "../src/storyboard-prompts.js";
import { storyboardInput } from "../src/storyboard-workflow.js";
import { ensureStoryboardDesign } from "../src/storyboard-contract.js";
import { STORYBOARD_DESIGN_MODEL_SCHEMA_NAME, storyboardDesignModelSchema } from "../src/contracts/storyboard-design-model-schema.js";
import { STORY_MODE_FULL_TEXT } from "../public/story-entry.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---- 旧写法：去掉 2026-10-13 补进第 6、8 条的两段 ----
const RULE6_ADDED = "角色进出画面或在画面里移动时，写清从画面哪一侧进来、朝哪一侧或哪个位置去、停在哪里；几个人一起跑或一前一后追赶，写清谁在前、谁在后、朝画面哪一侧跑——不写方向，视频模型会自己定，前后镜头常常接反。来回追赶、绕圈这类反复的走位，按 beat 的秒数压缩成观众一眼看得清的一段路线（例如追着横穿画面一次），不要求几秒里跑好几圈。";
const RULE8_NEW_TAIL = "不冒充已生成素材的观察结果；片段结束时还在移动的人，写明他在画面哪一侧、正朝哪个方向移动。相邻片段的画面方向要接得上：上一片段的人朝画面右侧跑出，下一片段就从画面左侧进来、继续朝右；朝画面左侧跑出，下一片段就从画面右侧进来、继续朝左。一起逃跑的人从同一侧进来，追赶的一方跟在他们后面、从同一侧出现，不会出现在他们前方。上一片段结束时人还在移动，下一片段的 transitionIn 写明他们从画面哪一侧进来；换到对面机位让方向反过来时，在 camera 里写明。";
const RULE8_OLD_TAIL = "不冒充已生成素材的观察结果。";
const GOLDEN_INPUT = { durationWindow: { min: 51, max: 69 }, targetDurationSeconds: 60, targetAspectRatio: "16:9", fullStory: {} };
const GOLDEN_BEFORE = "e7428f562be38b85e6f45758f657d2b775737b4393598bd411eba580d123ef8f";

function withoutDirectionRules(prompt) {
  if (!prompt.includes(RULE6_ADDED) || !prompt.includes(RULE8_NEW_TAIL)) throw new Error("现提示词里找不到 2026-10-13 补的两段，旧写法还原不了");
  return prompt.replace(RULE6_ADDED, "").replace(RULE8_NEW_TAIL, RULE8_OLD_TAIL);
}

function assertOldPromptMatchesBefore() {
  const sha = createHash("sha256").update(withoutDirectionRules(storyboardPrompt(GOLDEN_INPUT))).digest("hex");
  if (sha !== GOLDEN_BEFORE) throw new Error(`旧写法还原后与改动前的提示词不一致（${sha}）`);
}

function parseArgs(argv) {
  const options = { env: "", pkg: "", samples: 2, arms: ["old", "new"], concurrency: 4, out: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === "--env") { options.env = value; i += 1; }
    else if (key === "--package") { options.pkg = value; i += 1; }
    else if (key === "--samples") { options.samples = Number(value); i += 1; }
    else if (key === "--arms") { options.arms = String(value || "").split(",").map((item) => item.trim()).filter(Boolean); i += 1; }
    else if (key === "--concurrency") { options.concurrency = Number(value); i += 1; }
    else if (key === "--out") { options.out = value; i += 1; }
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

function metrics(design) {
  const shots = Array.isArray(design?.shotPlan) ? design.shotPlan : [];
  const beats = shots.flatMap((shot) => (Array.isArray(shot.beats) ? shot.beats : []));
  return {
    shots: shots.length,
    beats: beats.length,
    totalSeconds: shots.reduce((sum, shot) => sum + (Number(shot.durationSeconds) || 0), 0),
    beatsWithDirectionWords: beats.filter((beat) => count(`${beat.framing} ${beat.camera} ${beat.visibleAction}`, DIRECTION_WORDS) > 0).length,
    continuityOutWithDirectionWords: shots.filter((shot) => count(shot.continuityOut, DIRECTION_WORDS) > 0).length,
    beatTextChars: beats.reduce((sum, beat) => sum + `${beat.framing}${beat.camera}${beat.visibleAction}`.length, 0)
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
  lines.push(`- 旧写法：现提示词去掉 2026-10-13 补的两段（启动时已核对与改动前的哈希一致）；新写法：当前工作区`, "");
  lines.push("| 写法 | 次 | 判据 | 片段 / beat | 总时长 | 含方向词的 beat（代理） | continuityOut 含方向词（代理） | beat 文字量 | 耗时 |", "|---|---|---|---|---|---|---|---|---|");
  for (const run of runs) {
    const m = run.metrics || {};
    lines.push(`| ${run.arm} | ${run.sample} | ${run.error ? `调用失败：${run.error}` : run.codes.length ? run.codes.join("、") : "通过"} | ${m.shots ?? "—"} / ${m.beats ?? "—"} | ${m.totalSeconds ?? "—"} 秒 | ${m.beatsWithDirectionWords ?? "—"}/${m.beats ?? "—"} | ${m.continuityOutWithDirectionWords ?? "—"}/${m.shots ?? "—"} | ${m.beatTextChars ?? "—"} | ${Math.round(run.durationMs / 1000)} 秒 |`);
  }
  lines.push("", "逐片段原文在 calls.jsonl（design 字段）。");
  return lines.join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  assertOldPromptMatchesBefore();
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
  const newPrompt = (dialogueLocked ? storyboardPromptWithLockedDialogue : storyboardPrompt)(projected);
  const prompts = { new: newPrompt, old: withoutDirectionRules(newPrompt) };

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
        const run = { ...job, durationMs: Date.now() - startedMs, attempt, codes, metrics: metrics(design), design };
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
