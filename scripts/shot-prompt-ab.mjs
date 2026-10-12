#!/usr/bin/env node
// 4.0 单镜视频提示词新旧写法对比（2026-10-12）。
//
// 拿一份已签发的 4.0 分镜，逐镜用旧写法（cbc407e 的 shotPrompt，冻结副本见下方）与新写法
// （src/storyboard-prompts.js 当前的 shotPrompt）各写 N 次，每次只调用写稿模型一次、不走重试，
// 把原文与能确定性统计的指标写进报告目录，供逐镜人工对照。
//
// 不做的事：不创建 Run、不写 Artifact、不进 Task Store；分镜文件只读。
//
// 用法：
//   node --use-env-proxy scripts/shot-prompt-ab.mjs --env <.env 路径> --plan <animationPlan JSON> [选项]
// 选项：
//   --samples <n>       每镜每种写法跑几次，默认 2
//   --shots A01,A02     只跑这几镜，默认全部
//   --concurrency <n>   同时进行的调用数，默认 4
//   --out <dir>         输出目录，默认 reports/shot-prompt-ab-<日期>
//   --arms new          只跑这几种写法（old,new），默认两种都跑
//   --reuse <calls.jsonl>  没跑的写法从这份旧记录取原文，指标按当前判据重算（只改了新写法后重跑用）
//   --rescore <calls.jsonl>  不调用模型，只按当前判据重算这份记录的指标并重写报告（输出目录默认是记录所在目录）
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadEnv, getConfig } from "../src/config.js";
import { initializeSystemProxy } from "../src/system-proxy.js";
import { MimoClient } from "../src/mimo-client.js";
import { ModelCallCoordinator } from "../src/model-call-coordinator.js";
import { shotPrompt, storyboardSystem } from "../src/storyboard-prompts.js";
import { shotVideoPromptViolations, singleShotPromptInput } from "../src/storyboard-workflow.js";
import { storyboardShotCharacterNames } from "../public/storyboard-plan.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = { provider: "Seedance", model: "doubao-seedance-2-0-260128" };
const OLD_COMMIT = "cbc407e";

// ---- 旧写法：cbc407e 的 shotPrompt 与 artStyleShotRule，逐字照抄；启动时与 git 里的原文核对 ----
function oldArtStyleShotRule(input) {
  return input.artStyle
    ? `画风：全片统一为「${input.artStyle}」。提示词里必须逐字写出「${input.artStyle}」，人物、场景和道具都按这个画风呈现，不写成真人实拍。\n`
    : "";
}
const OLD_LINES = [
  "你是单镜视频提示词撰写者。分镜已经设计完成，你只把当前片段翻译成可直接提交视频模型的中文自然语言提示词。",
  "不得改剧情、角色、对白、片段时长、beat 时间与摄影顺序；不补新动作，不做新的导演改编。上/下片段仅用于理解已完成与尚未发生的事，不得重演前段或提前发生后段。不得把计划中的状态写成已观察到的成片状态。当前没有提供实际参考图片，因此不得声称看过图片，不生成尚未绑定的 @图片/@视频/@音频 编号。",
  "提示词按具体主体与当前动作、地点、风格和物理光线、各 beat 的时间与摄影、对白及声音、连续性与终点自然组织。逐段说明画面实际包含谁；保留已设计的合理局部特写。画外说话者只发声，不因台词而新增入画。台词原话全部逐字带入；不用字幕替代人声。若同一片段内部声音跨剪辑，明确其持续范围。保持 start/continuous/cut/ellipsis 的已定含义，不添加统一的“必须从上一镜最后一帧继续”命令。",
  "角色设定只细化已登记的身份与外观，场景风格只落实已给制作参数。不要重复整片故事、不堆质量形容词、不用“生成视频”等操作说明替代画面。用户关闭背景音乐时以“全片无背景音乐，只保留现场环境声与动作声。”逐字收尾（对白照常保留）。"
];
function oldShotPrompt(input) {
  return `${OLD_LINES.join("\n")}
${oldArtStyleShotRule(input)}只输出 {"videoPrompt":"完整中文自然语言提示词"}，不输出其他键、不修改任何分镜字段。
冻结输入：${JSON.stringify(input)}`;
}
function assertOldPromptMatchesGit() {
  const source = execFileSync("git", ["show", `${OLD_COMMIT}:src/storyboard-prompts.js`], { cwd: projectRoot, encoding: "utf8" });
  for (const line of [...OLD_LINES, "画风：全片统一为「${input.artStyle}」。提示词里必须逐字写出「${input.artStyle}」，人物、场景和道具都按这个画风呈现，不写成真人实拍。"]) {
    if (!source.includes(line)) throw new Error(`旧写法副本与 ${OLD_COMMIT} 的原文对不上：${line.slice(0, 40)}…`);
  }
}

const ARMS = { old: oldShotPrompt, new: shotPrompt };

// ---- 人工标注的切点（按分镜 framing/camera 读出来的，见报告开头的说明） ----
// cut = 这里换了机位/景别，应写「在第N秒的地方，切镜头」；continue = 同一机位延续，应写「第N秒起，镜头不切换」。
const EXPECTED_BOUNDARIES = {
  "A03@2.5": "cut", "A04@3": "cut", "A06@3": "cut", "A07@3": "cut",
  "A05@3": "continue", "A08@5": "continue", "A08@8": "continue",
  "A01@4": "ambiguous", "A02@3.5": "ambiguous", "A07@6": "ambiguous"
};

function parseArgs(argv) {
  const options = { env: "", plan: "", samples: 2, shots: [], concurrency: 4, out: "", arms: Object.keys(ARMS), reuse: "", rescore: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === "--env") { options.env = value; i += 1; }
    else if (key === "--plan") { options.plan = value; i += 1; }
    else if (key === "--samples") { options.samples = Number(value); i += 1; }
    else if (key === "--shots") { options.shots = String(value || "").split(",").map((item) => item.trim()).filter(Boolean); i += 1; }
    else if (key === "--concurrency") { options.concurrency = Number(value); i += 1; }
    else if (key === "--out") { options.out = value; i += 1; }
    else if (key === "--arms") { options.arms = String(value || "").split(",").map((item) => item.trim()).filter(Boolean); i += 1; }
    else if (key === "--reuse") { options.reuse = value; i += 1; }
    else if (key === "--rescore") { options.rescore = value; i += 1; }
    else throw new Error(`不认识的参数：${key}`);
  }
  if (!options.plan || (!options.env && !options.rescore)) throw new Error("需要 --plan，调用模型时还需要 --env");
  if (!Number.isInteger(options.samples) || options.samples < 1) throw new Error("--samples 必须是正整数");
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) throw new Error("--concurrency 必须是正整数");
  if (!options.arms.length || options.arms.some((arm) => !ARMS[arm])) throw new Error("--arms 只能是 old、new");
  return options;
}

const escapeRegExp = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const count = (text, pattern) => (String(text).match(pattern) || []).length;

function boundaryMarks(text, beats) {
  return beats.slice(1).map((beat) => {
    const n = escapeRegExp(String(beat.startSeconds));
    if (new RegExp(`在第\\s*${n}\\s*秒的地方[，,]?\\s*切镜头`, "u").test(text)) return "cut";
    if (new RegExp(`第\\s*${n}\\s*秒起[，,]?\\s*镜头不切换`, "u").test(text)) return "continue";
    if (new RegExp(`(?<![\\d.])${n}\\s*秒`, "u").test(text)) return "timed";
    return "unmarked";
  });
}

// 判据要拿模型返回的整个对象去查（和生产一样）：只交 videoPrompt 会漏掉「多出别的键」这种结构错误。
function metrics(value, projected) {
  const text = typeof value?.videoPrompt === "string" ? value.videoPrompt : "";
  const codes = shotVideoPromptViolations(value, projected).map((issue) => issue.code);
  const beats = projected.shot.beats;
  const firstBoundary = beats[1] ? text.search(new RegExp(`第\\s*${escapeRegExp(String(beats[1].startSeconds))}\\s*秒`, "u")) : -1;
  const firstCut = text.indexOf("切镜头");
  return {
    length: text.length,
    codes,
    passesNewValidator: codes.length === 0,
    namesRequired: storyboardShotCharacterNames(projected.shot),
    boundaries: boundaryMarks(text, beats),
    cutPhrases: count(text, /切镜头/gu),
    continuePhrases: count(text, /镜头不切换/gu),
    cutInOpening: firstCut >= 0 && firstBoundary >= 0 && firstCut < firstBoundary,
    // 以下三项只是表面代理，只作参考：数到的词不等于写对了。
    positionWords: count(text, /画面(?:左|右|中央|中间|上方|下方)|前景|后景|左侧|右侧|左边|右边/gu),
    facingWords: count(text, /面向|背对|面朝|朝向|侧对/gu),
    pronouns: count(text, /(?<![其尤极])[他她它](?!们)|其(?![他中余实])/gu)
  };
}

// 记录里还原模型返回的对象：早先的记录只留了多出来的键名，没留值；结构判据只看键名，够用。
function recordedValue(run) {
  return { videoPrompt: run.videoPrompt, ...(run.extra || Object.fromEntries((run.extraKeys || []).map((key) => [key, ""]))) };
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

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function renderSummary({ runs, plan, model, options, startedAt }) {
  const arms = ["old", "new"];
  const ok = (arm) => runs.filter((run) => run.arm === arm && !run.error);
  const lines = [];
  lines.push(`# 单镜视频提示词新旧写法对比`, "");
  lines.push(`- 时间：${startedAt}`);
  lines.push(`- 分镜：${options.plan}（${plan.shotPlan.length} 镜，画风「${plan.productionStrategy.artStyle || "无"}」，背景音乐 ${plan.productionStrategy.backgroundMusicMode}）`);
  lines.push(`- 写稿模型：MiMo ${model}（每次只调用一次，不走重试）；每镜每种写法 ${options.samples} 次`);
  lines.push(`- 旧写法：${OLD_COMMIT} 的 shotPrompt（启动时已与 git 原文逐行核对）；新写法：当前工作区的 shotPrompt`);
  const reusedArms = arms.filter((arm) => !options.arms.includes(arm));
  if (reusedArms.length) lines.push(`- 本次只调用了 ${options.arms.join("、")} 写法；${reusedArms.join("、")} 写法的原文取自 ${options.reuse}，指标按当前判据重算`);
  lines.push("", "## 汇总", "");
  lines.push("| 指标 | 旧写法 | 新写法 |", "|---|---|---|");
  const row = (label, fn) => lines.push(`| ${label} | ${arms.map(fn).join(" | ")} |`);
  row("调用次数（失败）", (arm) => `${runs.filter((run) => run.arm === arm).length}（${runs.filter((run) => run.arm === arm && run.error).length}）`);
  row("过判据（结构 + 原有三条 + 新增两条）", (arm) => `${ok(arm).filter((run) => run.metrics.passesNewValidator).length}/${ok(arm).length}`);
  row("结构不对（如多出别的键）", (arm) => String(ok(arm).filter((run) => run.metrics.codes.includes("SHOT_PROMPT_STRUCTURE_INVALID")).length));
  row("缺出镜角色名", (arm) => String(ok(arm).filter((run) => run.metrics.codes.includes("SHOT_PROMPT_CHARACTER_NAME_MISSING")).length));
  row("写了素材编号", (arm) => String(ok(arm).filter((run) => run.metrics.codes.includes("SHOT_PROMPT_UNBOUND_REFERENCE_TOKEN")).length));
  row("漏台词", (arm) => String(ok(arm).filter((run) => run.metrics.codes.includes("SHOT_PROMPT_DIALOGUE_MISSING")).length));
  row("收尾句不对", (arm) => String(ok(arm).filter((run) => run.metrics.codes.includes("SHOT_PROMPT_BACKGROUND_MUSIC_SENTENCE")).length));
  row("长度中位数（字）", (arm) => String(median(ok(arm).map((run) => run.metrics.length))));
  row("开场就写了切镜头", (arm) => String(ok(arm).filter((run) => run.metrics.cutInOpening).length));
  row("方位词 / 次（代理）", (arm) => String(ok(arm).reduce((sum, run) => sum + run.metrics.positionWords, 0)));
  row("朝向词 / 次（代理）", (arm) => String(ok(arm).reduce((sum, run) => sum + run.metrics.facingWords, 0)));
  row("代词 / 次（代理）", (arm) => String(ok(arm).reduce((sum, run) => sum + run.metrics.pronouns, 0)));

  lines.push("", "## 切点写法（人工标注 vs 实际写法）", "");
  lines.push("cut=在第N秒的地方，切镜头；continue=第N秒起，镜头不切换；timed=只写了秒数；unmarked=没写这个时间点。", "");
  lines.push("| 交界 | 标注 | 旧写法 | 新写法 |", "|---|---|---|---|");
  let clear = 0;
  let right = 0;
  for (const shot of plan.shotPlan) {
    shot.beats.slice(1).forEach((beat, index) => {
      const key = `${shot.shotId}@${beat.startSeconds}`;
      const expected = EXPECTED_BOUNDARIES[key] || "未标注";
      const marksOf = (arm) => runs.filter((run) => run.arm === arm && run.shotId === shot.shotId && !run.error).map((run) => run.metrics.boundaries[index]);
      const newMarks = marksOf("new");
      if (expected === "cut" || expected === "continue") {
        clear += newMarks.length;
        right += newMarks.filter((mark) => mark === expected).length;
      }
      lines.push(`| ${key} | ${expected} | ${marksOf("old").join("、") || "—"} | ${newMarks.join("、") || "—"} |`);
    });
  }
  lines.push("", `新写法在明确交界上写对 ${right}/${clear} 次。`);

  lines.push("", "## 逐镜原文（每种写法的第 1 次）", "");
  for (const shot of plan.shotPlan) {
    lines.push(`### ${shot.shotId}（${shot.durationSeconds}s，${shot.transitionIn.type}，beats ${shot.beats.map((beat) => `${beat.startSeconds}–${beat.endSeconds}`).join(" / ")}）`, "");
    for (const arm of arms) {
      const run = runs.find((entry) => entry.arm === arm && entry.shotId === shot.shotId && entry.sample === 1);
      lines.push(`**${arm === "old" ? "旧写法" : "新写法"}**${run?.error ? `（失败：${run.error}）` : `（${run.metrics.length} 字；判据：${run.metrics.codes.join("、") || "通过"}）`}`, "");
      if (run && !run.error) lines.push("```text", run.videoPrompt, "```", "");
    }
  }
  lines.push("其余各次的原文与指标在 calls.jsonl。");
  return lines.join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  assertOldPromptMatchesGit();
  if (options.rescore) {
    const raw = JSON.parse(await fs.readFile(path.resolve(options.plan), "utf8"));
    const plan = raw.content || raw;
    const shots = plan.shotPlan.filter((shot) => !options.shots.length || options.shots.includes(shot.shotId));
    const recorded = (await fs.readFile(path.resolve(options.rescore), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const runs = recorded.filter((run) => shots.some((shot) => shot.shotId === run.shotId))
      .map((run) => (run.error ? run : { ...run, metrics: metrics(recordedValue(run), singleShotPromptInput(plan, run.shotId, TARGET)) }));
    const outDir = path.resolve(options.out || path.dirname(options.rescore));
    const arms = [...new Set(runs.filter((run) => !run.reused).map((run) => run.arm))];
    await fs.writeFile(path.join(outDir, "calls.jsonl"), runs.map((run) => JSON.stringify(run)).join("\n") + "\n");
    let model = "（写稿模型见原记录）";
    if (options.env) { loadEnv(path.resolve(options.env)); model = getConfig().mimo.animationModel; }
    await fs.writeFile(path.join(outDir, "summary.md"), renderSummary({ runs, plan: { ...plan, shotPlan: shots }, model: `${model}（本报告按当前判据重算，没有重新调用）`,
      options: { ...options, arms: arms.length ? arms : options.arms, reuse: options.reuse || "（见原记录）" }, startedAt: `重算于 ${new Date().toISOString()}` }) + "\n");
    process.stdout.write(`已按当前判据重算 ${runs.length} 条记录 → ${path.join(outDir, "summary.md")}\n`);
    return;
  }
  loadEnv(path.resolve(options.env));
  const systemProxy = await initializeSystemProxy();
  try {
    const config = getConfig();
    if (!config.mimo.enabled) throw new Error("MiMo 没有配置，跑不了真实对比");
    const client = new MimoClient(config.mimo);
    const model = config.mimo.animationModel;
    const raw = JSON.parse(await fs.readFile(path.resolve(options.plan), "utf8"));
    const plan = raw.content || raw;
    const shots = plan.shotPlan.filter((shot) => !options.shots.length || options.shots.includes(shot.shotId));
    const startedAt = new Date().toISOString();
    const outDir = path.resolve(options.out || path.join(projectRoot, "reports", `shot-prompt-ab-${startedAt.slice(0, 10)}`));
    await fs.mkdir(outDir, { recursive: true });
    const jobs = shots.flatMap((shot) => options.arms.flatMap((arm) => Array.from({ length: options.samples }, (_, i) => ({ shotId: shot.shotId, arm, sample: i + 1 }))));
    process.stdout.write(`MiMo ${model}，${shots.length} 镜 × ${options.arms.length} 种写法 × ${options.samples} 次 = ${jobs.length} 次调用 → ${outDir}\n`);

    const coordinator = new ModelCallCoordinator({ maxProviderCalls: 1 });
    const runs = await mapPool(jobs, options.concurrency, async (job) => {
      const projected = singleShotPromptInput(plan, job.shotId, TARGET);
      const prompt = ARMS[job.arm](projected);
      const startedMs = Date.now();
      let attemptInfo = null;
      try {
        const value = await coordinator.runJson({
          client, provider: "MiMo", stage: "shotVideoPrompt", maxProviderCalls: 1,
          request: { prompt, systemPrompt: storyboardSystem, model, maxCompletionTokens: config.mimo.animationMaxCompletionTokens },
          attemptObserver: async (attempt) => { attemptInfo = { finishReason: attempt.finishReason, status: attempt.status, usage: attempt.metadata?.usage || null }; },
          validate: (candidate) => candidate
        });
        const videoPrompt = typeof value?.videoPrompt === "string" ? value.videoPrompt : "";
        const extra = Object.fromEntries(Object.entries(value && typeof value === "object" ? value : {}).filter(([key]) => key !== "videoPrompt"));
        const run = { ...job, durationMs: Date.now() - startedMs, attempt: attemptInfo, promptChars: prompt.length,
          extraKeys: Object.keys(extra), extra, videoPrompt, metrics: metrics(value, projected) };
        process.stdout.write(`${job.shotId} ${job.arm} #${job.sample}：${run.metrics.length} 字，${run.metrics.codes.join("、") || "过判据"}，${Math.round(run.durationMs / 1000)}s\n`);
        return run;
      } catch (error) {
        process.stdout.write(`${job.shotId} ${job.arm} #${job.sample}：失败 ${error?.code || ""} ${error?.message || error}\n`);
        return { ...job, durationMs: Date.now() - startedMs, attempt: attemptInfo, error: `${error?.code || "ERROR"} ${error?.message || error}` };
      }
    });

    if (options.reuse) {
      const previous = (await fs.readFile(path.resolve(options.reuse), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      for (const run of previous) {
        if (options.arms.includes(run.arm) || !shots.some((shot) => shot.shotId === run.shotId)) continue;
        runs.push(run.error ? { ...run, reused: true } : { ...run, reused: true, metrics: metrics(recordedValue(run), singleShotPromptInput(plan, run.shotId, TARGET)) });
      }
    }
    await fs.writeFile(path.join(outDir, "calls.jsonl"), runs.map((run) => JSON.stringify(run)).join("\n") + "\n");
    await fs.writeFile(path.join(outDir, "summary.md"), renderSummary({ runs, plan: { ...plan, shotPlan: shots }, model, options, startedAt }) + "\n");
    process.stdout.write(`已写入 ${path.join(outDir, "summary.md")}\n`);
  } finally {
    await systemProxy.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
