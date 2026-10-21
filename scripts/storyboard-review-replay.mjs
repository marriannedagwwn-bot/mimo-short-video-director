#!/usr/bin/env node
// 4.0 分镜「审阅分镜」这一步的回放（2026-10-21）：查 Opus 5.5 在审阅一步 0/2 的原因。
//
// 输入：冻结的 run-artifacts.json（按生产同一口径投影，做法照 scripts/claude-storyboard-compare.mjs）
// 加一份已经通过设计校验的分镜（--design）。提示词、系统提示、重试话术都直接取生产的
// storyboardReviewPrompt / storyboardSystem / storyboardRetryPrompt，判据用生产的 validateStoryboardReview。
// 预算默认 2 次、与生产 call() 同一套重试逻辑；--budget 1 只看第一次。不建 Run、不写 Artifact，输入文件只读。
//
// 生产校验遇到第一处问题就抛错，只报一条。为了数失败形状，另有一个只做统计的 analyzeReview：
// 把同样几条判据全部走一遍、收集所有问题，并给逐字没对上的引用找最接近的原文、写出差在哪几个字。
// 它不参与判定，通过与否只看生产校验器。
//
// 代码默认取本仓库；--code-root 可以指向另一个工作区（例如还没提交的分支），src/ 一律从那里加载、只读。
//
// 用法：
//   node --use-env-proxy scripts/storyboard-review-replay.mjs --env <.env> --package <run-artifacts.json> --design <design.json> [选项]
// 选项：
//   --code-root <dir>   src/ 从哪个工作区加载，默认本仓库
//   --models a,b        型号，claude-* 走 Claude，mimo-* 走 MiMo；默认 claude-opus-5-5
//   --samples <n>       每个型号几次，默认 3
//   --budget <1|2>      每次最多几次调用，默认 2（与生产相同）
//   --concurrency <n>   同时进行的调用数，默认 3
//   --out <dir>         输出目录
//   --baseline a,b      先用同一份输入核对这几份已有的审阅原文（不花钱），确认投影与生产一致
//   --dry-run           不调用模型：Claude 用免费的 count_tokens 数输入，按假设的输出量估费用
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 美元 / 百万 token（输入 / 输出；思考 token 按输出计费）。与 claude-storyboard-compare.mjs 同一份出处：
// https://platform.claude.com/docs/en/about-claude/models/overview（2026-10-19 核对）
const PRICES_USD_PER_MILLION = Object.freeze({
  "claude-opus-5-5": [4, 20],
  "claude-sonnet-5-5": [2, 10],
  "claude-haiku-5-5": [0.1, 0.5],
  "claude-fable-5-1": [10, 50]
});
// 只用于 --dry-run：2026-10-20 生产路径上 Opus 审阅两次输出 4969 / 6216 token（含思考）。
// Sonnet 默认 effort 是 high，思考可能更多，所以上限放宽到 12000。
const ASSUMED_OUTPUT_TOKENS = [5_000, 12_000];

function parseArgs(argv) {
  const options = { env: "", pkg: "", design: "", codeRoot: projectRoot, models: ["claude-opus-5-5"], samples: 3, budget: 2, concurrency: 3, out: "", baseline: [], dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === "--env") { options.env = value; i += 1; }
    else if (key === "--package") { options.pkg = value; i += 1; }
    else if (key === "--design") { options.design = value; i += 1; }
    else if (key === "--code-root") { options.codeRoot = path.resolve(value); i += 1; }
    else if (key === "--models") { options.models = String(value || "").split(",").map((item) => item.trim()).filter(Boolean); i += 1; }
    else if (key === "--samples") { options.samples = Number(value); i += 1; }
    else if (key === "--budget") { options.budget = Number(value); i += 1; }
    else if (key === "--concurrency") { options.concurrency = Number(value); i += 1; }
    else if (key === "--out") { options.out = value; i += 1; }
    else if (key === "--baseline") { options.baseline = String(value || "").split(",").map((item) => item.trim()).filter(Boolean); i += 1; }
    else if (key === "--dry-run") options.dryRun = true;
    else throw new Error(`不认识的参数：${key}`);
  }
  if (!options.env || !options.pkg || !options.design) throw new Error("需要 --env、--package 与 --design");
  if (!Number.isInteger(options.samples) || options.samples < 1) throw new Error("--samples 必须是正整数");
  if (![1, 2].includes(options.budget)) throw new Error("--budget 只能是 1 或 2");
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) throw new Error("--concurrency 必须是正整数");
  if (!options.models.length || options.models.some((model) => !/^(claude|mimo)-/u.test(model))) throw new Error("--models 只能是 claude-* 或 mimo-*");
  return options;
}

const providerOf = (model) => (model.startsWith("claude-") ? "Claude" : "MiMo");

// ---------- 只做统计的全量扫描（不参与判定） ----------

const PUNCTUATION = /[\s，。、；：！？「」『』“”‘’（）()《》〈〉…—\-,.;:!?'"~～·]/u;

// 近似子串匹配（Sellers）：quote 与 text 任意一段的最小编辑距离，并回溯出差在哪几个字。
function closestSubstring(quote, text) {
  const q = [...quote];
  const t = [...text];
  const m = q.length;
  const n = t.length;
  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = 1; i <= m; i += 1) dp[i][0] = i;
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      const sub = dp[i - 1][j - 1] + (q[i - 1] === t[j - 1] ? 0 : 1);
      dp[i][j] = Math.min(sub, dp[i - 1][j] + 1, dp[i][j - 1] + 1);
    }
  }
  let end = 0;
  for (let j = 1; j <= n; j += 1) if (dp[m][j] < dp[m][end]) end = j;
  const ops = [];
  let i = m;
  let j = end;
  while (i > 0) {
    if (j > 0 && dp[i][j] === dp[i - 1][j - 1] + (q[i - 1] === t[j - 1] ? 0 : 1)) {
      if (q[i - 1] !== t[j - 1]) ops.push({ op: "替换", source: t[j - 1], quote: q[i - 1] });
      i -= 1; j -= 1;
    } else if (dp[i][j] === dp[i - 1][j] + 1) {
      ops.push({ op: "多写", quote: q[i - 1] }); i -= 1;
    } else {
      ops.push({ op: "漏写", source: t[j - 1] }); j -= 1;
    }
  }
  ops.reverse();
  return { distance: dp[m][end], matched: t.slice(j, end).join(""), ops };
}

function describeMiss(quote, lookup, id) {
  const own = lookup.get(id);
  const elsewhere = [...lookup.values()].filter((row) => row.id !== id && row.value.includes(quote)).map((row) => row.id);
  if (!own) return { kind: elsewhere.length ? "id 不存在，但原文在别的 id" : "id 不存在", elsewhere };
  if (elsewhere.length) return { kind: "引用了别的 id 的原文", elsewhere };
  const near = closestSubstring(quote, own.value);
  const allPunct = near.ops.every((op) => PUNCTUATION.test(op.source || "") || PUNCTUATION.test(op.quote || ""));
  const kind = near.distance / Math.max(1, [...quote].length) > 0.3 ? "改写或拼接（差太多）" : allPunct ? "只差标点或空白" : `差 ${near.distance} 个字`;
  return { kind, distance: near.distance, matched: near.matched, ops: near.ops };
}

function analyzeReview(value, { input, plan }, catalog) {
  const problems = [];
  const stats = { items: 0, quotes: 0, verbatimQuotes: 0, quoteChars: 0 };
  const add = (code, pointer, detail) => problems.push({ code, pointer, detail });
  if (!value || typeof value !== "object" || Array.isArray(value)) { add("TOP_NOT_OBJECT", "/", typeof value); return { problems, stats }; }
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "guidance,items,strengths") add("TOP_KEYS", "/", `顶层键：${keys}`);
  for (const key of ["strengths", "guidance"]) {
    const arr = value[key];
    if (!Array.isArray(arr)) add("TOP_FIELD_NOT_ARRAY", `/${key}`, arr === undefined ? "缺失" : typeof arr);
    else arr.forEach((text, i) => { if (typeof text !== "string" || !text.trim()) add("TOP_FIELD_ITEM_NOT_STRING", `/${key}/${i}`, Array.isArray(text) ? "数组" : typeof text); });
  }
  if (!Array.isArray(value.items)) { add("ITEMS_NOT_ARRAY", "/items", typeof value.items); return { problems, stats }; }
  if (value.items.length > 8) add("ITEMS_TOO_MANY", "/items", String(value.items.length));
  const lookup = new Map([...catalog(input, "U"), ...catalog(plan, "P")].map((row) => [row.id, row]));
  value.items.forEach((item, index) => {
    stats.items += 1;
    const at = `/items/${index}`;
    if (!item || typeof item !== "object") { add("ITEM_NOT_OBJECT", at, typeof item); return; }
    const itemKeys = Object.keys(item).sort().join(",");
    if (itemKeys !== "guidance,originalEvidence,ref,reportedProblem") add("ITEM_KEYS", at, `键：${itemKeys}`);
    if (item.ref !== `I${index + 1}`) add("ITEM_REF", `${at}/ref`, String(item.ref));
    for (const key of ["reportedProblem", "guidance"]) {
      const v = item[key];
      if (typeof v !== "string" || !v.trim()) add(`ITEM_${key.toUpperCase()}_NOT_STRING`, `${at}/${key}`, Array.isArray(v) ? `数组（${v.length} 条）` : v === undefined ? "缺失" : typeof v);
    }
    if (!Array.isArray(item.originalEvidence) || !item.originalEvidence.length) { add("ITEM_EVIDENCE_EMPTY", `${at}/originalEvidence`, typeof item.originalEvidence); return; }
    item.originalEvidence.forEach((evidence, k) => {
      const ep = `${at}/originalEvidence/${k}`;
      stats.quotes += 1;
      const evKeys = evidence && typeof evidence === "object" ? Object.keys(evidence).sort().join(",") : typeof evidence;
      if (evKeys !== "id,quote") add("EVIDENCE_KEYS", ep, `键：${evKeys}`);
      const quote = typeof evidence?.quote === "string" ? evidence.quote : "";
      if (!quote.trim()) return;
      stats.quoteChars += [...quote].length;
      if (lookup.get(evidence.id)?.value.includes(quote)) { stats.verbatimQuotes += 1; return; }
      add("EVIDENCE_NOT_VERBATIM", ep, { id: evidence.id, quote, ...describeMiss(quote, lookup, evidence.id) });
    });
  });
  return { problems, stats };
}

function parseContent(content) {
  try { return { value: JSON.parse(content) }; } catch (error) { return { parseError: String(error?.message || error) }; }
}

function costUsd(model, inputTokens, outputTokens) {
  const price = PRICES_USD_PER_MILLION[model];
  return price ? (inputTokens * price[0] + outputTokens * price[1]) / 1_000_000 : undefined;
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

function problemLine(problem) {
  if (problem.code !== "EVIDENCE_NOT_VERBATIM") return `${problem.code} ${problem.pointer}（${problem.detail}）`;
  const d = problem.detail;
  const ops = (d.ops || []).map((op) => (op.op === "替换" ? `「${op.source}」→「${op.quote}」` : op.op === "漏写" ? `漏「${op.source}」` : `多「${op.quote}」`)).join(" ");
  return `${problem.code} ${problem.pointer} ${d.id}：${d.kind}${ops ? `，${ops}` : ""}；引用「${d.quote}」${d.matched ? `，原文最接近处「${d.matched}」` : ""}${d.elsewhere?.length ? `，原文在 ${d.elsewhere.join("、")}` : ""}`;
}

function attemptLabel(a) {
  if (a.parseError) return `JSON 解析失败：${a.parseError}`;
  if (a.transportError) return `调用失败：${a.transportError}`;
  return a.verdict?.pass ? "通过" : a.verdict?.codes.join("、");
}

function renderSummary({ runs, baseline, options, startedAt, promptChars }) {
  const lines = ["# 4.0 分镜审阅一步回放", ""];
  lines.push(`- 时间：${startedAt}`);
  lines.push(`- 代码：${options.codeRoot}`);
  lines.push(`- 冻结输入：${options.pkg}；分镜：${options.design}`);
  lines.push(`- 提示词：storyboardReviewPrompt（${promptChars} 字），系统提示 storyboardSystem，不带 responseSchema；每次预算 ${options.budget} 次调用，重试话术与生产 call() 相同；判据用生产的 validateStoryboardReview`, "");
  if (baseline.length) {
    lines.push("## 已有原文核对（不花钱）", "", "| 文件 | 生产判据 | 全量扫描 |", "|---|---|---|");
    for (const row of baseline) lines.push(`| ${row.file} | ${row.verdict.pass ? "通过" : row.verdict.codes.join("、")} | ${row.analysis.problems.length ? row.analysis.problems.map(problemLine).join("<br>") : "无问题"} |`);
    lines.push("");
  }
  lines.push("## 每次调用", "", "| 型号 | 次 | 第几次调用 | 生产判据 | 全量扫描到的问题 | 意见条数 / 引用数 / 逐字对上 | 输入 / 输出 token | 费用 | 耗时 |", "|---|---|---|---|---|---|---|---|---|");
  for (const run of runs) {
    for (const a of run.attempts) {
      const s = a.analysis?.stats || {};
      lines.push(`| ${run.model} | ${run.sample} | ${a.callIndex + 1} | ${attemptLabel(a)} | ${a.analysis?.problems.length ? a.analysis.problems.map(problemLine).join("<br>") : a.analysis ? "无" : "—"} | ${s.items ?? "—"} / ${s.quotes ?? "—"} / ${s.verbatimQuotes ?? "—"} | ${a.usage?.input_tokens ?? a.usage?.prompt_tokens ?? "—"} / ${a.usage?.output_tokens ?? a.usage?.completion_tokens ?? "—"} | ${a.costUsd === undefined ? "—" : `$${a.costUsd.toFixed(3)}`} | ${Math.round((a.durationMs || 0) / 1000)} 秒 |`);
    }
  }
  lines.push("", "## 汇总", "", "| 型号 | 样本 | 第一次通过 | 这一步通过（预算内） | 第一次失败形状 | 每条引用逐字对上 | 费用 |", "|---|---|---|---|---|---|---|");
  for (const model of options.models) {
    const mine = runs.filter((run) => run.model === model);
    const first = mine.map((run) => run.attempts[0]).filter(Boolean);
    const firstPass = first.filter((a) => a.verdict?.pass).length;
    const stepPass = mine.filter((run) => run.stepPass).length;
    const shapes = first.filter((a) => !a.verdict?.pass).map((a) => (a.parseError ? "JSON 解析失败" : a.transportError ? "调用失败" : a.verdict?.codes[0]?.split(" ")[0])).join("、") || "—";
    const analysed = mine.flatMap((run) => run.attempts).filter((a) => a.analysis);
    const quotes = analysed.reduce((sum, a) => sum + a.analysis.stats.quotes, 0);
    const verbatim = analysed.reduce((sum, a) => sum + a.analysis.stats.verbatimQuotes, 0);
    const cost = mine.flatMap((run) => run.attempts).reduce((sum, a) => sum + (a.costUsd || 0), 0);
    lines.push(`| ${model} | ${mine.length} | ${firstPass}/${first.length} | ${stepPass}/${mine.length} | ${shapes} | ${verbatim}/${quotes} | ${providerOf(model) === "Claude" ? `$${cost.toFixed(2)}` : "—（MiMo 没有单价）"} |`);
  }
  const total = runs.flatMap((run) => run.attempts).reduce((sum, a) => sum + (a.costUsd || 0), 0);
  lines.push("", `Claude 合计约 $${total.toFixed(2)}（按官方单价与实际用量算，失败但已产生输出的也计入）。每次调用的原文在 raw/。`);
  return lines.join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const load = (file) => import(pathToFileURL(path.join(options.codeRoot, file)).href);
  const [{ loadEnv, getConfig }, { initializeSystemProxy }, { ClaudeClient }, { MimoClient }, { MIMO_OUTPUT_TOKEN_CEILING }, { ModelCallCoordinator },
    { storyboardRetryPrompt, storyboardSystem }, { storyboardReviewPrompt, validateStoryboardReview }, { storyboardInput }, { ensureStoryboardDesign },
    { catalog }, { OutputContractError }] = await Promise.all([
    "src/config.js", "src/system-proxy.js", "src/claude-client.js", "src/mimo-client.js", "src/output-token-ceilings.js", "src/model-call-coordinator.js",
    "src/storyboard-prompts.js", "src/storyboard-review.js", "src/storyboard-workflow.js", "src/storyboard-contract.js",
    "src/storyboard-editorial-utils.js", "src/validation.js"
  ].map(load));

  // 生产校验器只报第一处，这里照抄它的 code 与指针。
  const productionVerdict = (value, context) => {
    try { validateStoryboardReview(structuredClone(value), context); return { pass: true, codes: [] }; }
    catch (error) {
      const details = Array.isArray(error?.details) && error.details.length ? error.details : [{ code: error?.code || error?.name || "INVALID" }];
      return { pass: false, codes: details.map((item) => `${item.code}${item.path ? ` ${item.path}` : ""}`) };
    }
  };

  const pkg = JSON.parse(await fs.readFile(path.resolve(options.pkg), "utf8"));
  const design = JSON.parse(await fs.readFile(path.resolve(options.design), "utf8"));
  const plan = pkg.animationPlan;
  const workflow = { assertGlobalCharacterBoundary: () => pkg.visualGuardrails, resolveStage: () => ({}), hasLiveClient: false };
  const { projected } = await storyboardInput(workflow, {
    fullStory: pkg.fullStory, creatorProfile: pkg.creatorProfile, artStyle: plan.productionStrategy.artStyle,
    targetAspectRatio: plan.productionStrategy.targetAspectRatio, backgroundMusicEnabled: plan.productionStrategy.backgroundMusicMode !== "none",
    characterExpressionRules: plan.productionStrategy.characterExpressionRules || ""
  });
  if (JSON.stringify(projected.characterRegistry) !== JSON.stringify(plan.characterRegistry)) throw new Error("投影出的角色表与原分镜不一致");
  // 审阅拿到的是通过设计校验的那一份；这份分镜过不了就不是生产会送审的东西。
  ensureStoryboardDesign(structuredClone(design), projected);
  const context = { input: projected, plan: design };
  const prompt = storyboardReviewPrompt(context);
  process.stdout.write(`代码 ${options.codeRoot}\n审阅提示词 ${prompt.length} 字（系统提示 ${storyboardSystem.length} 字），可引用的原文 ${catalog(projected, "U").length + catalog(design, "P").length} 条\n`);

  const baseline = [];
  for (const file of options.baseline) {
    const parsed = parseContent(await fs.readFile(path.resolve(file), "utf8"));
    const row = { file: path.resolve(file), verdict: parsed.parseError ? { pass: false, codes: [`JSON 解析失败：${parsed.parseError}`] } : productionVerdict(parsed.value, context),
      analysis: parsed.parseError ? { problems: [] } : analyzeReview(parsed.value, context, catalog) };
    baseline.push(row);
    process.stdout.write(`核对 ${row.file}：生产判据 ${row.verdict.pass ? "通过" : row.verdict.codes.join("、")}；全量扫描 ${row.analysis.problems.length} 处\n${row.analysis.problems.map((p) => `  - ${problemLine(p)}\n`).join("")}`);
  }

  loadEnv(path.resolve(options.env));
  const systemProxy = await initializeSystemProxy();
  try {
    const config = getConfig();
    const clients = {};
    for (const model of options.models) {
      const provider = providerOf(model);
      if (clients[provider]) continue;
      if (provider === "Claude") {
        if (!config.claude.enabled) throw new Error("Claude 没有配置（CLAUDE_API_KEY）");
        clients.Claude = { client: new ClaudeClient(config.claude), maxCompletionTokens: config.claude.maxCompletionTokens };
      } else {
        if (!config.mimo.enabled) throw new Error("MiMo 没有配置");
        clients.MiMo = { client: new MimoClient(config.mimo), maxCompletionTokens: MIMO_OUTPUT_TOKEN_CEILING };
      }
    }

    if (options.dryRun) {
      let low = 0;
      let high = 0;
      for (const model of options.models) {
        if (providerOf(model) !== "Claude") { process.stdout.write(`${model}：MiMo 没有单价，不估费用\n`); continue; }
        const counted = await clients.Claude.client.sdkClient().messages.countTokens({ model, system: storyboardSystem, messages: [{ role: "user", content: prompt }] });
        const perCall = ASSUMED_OUTPUT_TOKENS.map((output) => costUsd(model, counted.input_tokens, output));
        low += perCall[0] * options.samples;
        high += perCall[1] * options.samples * options.budget;
        process.stdout.write(`${model}：输入 ${counted.input_tokens} token；假设输出 ${ASSUMED_OUTPUT_TOKENS.join("–")} token 时每次调用约 $${perCall[0].toFixed(3)}–$${perCall[1].toFixed(3)}\n`);
      }
      process.stdout.write(`${options.models.join("、")} 各 ${options.samples} 个样本：合计约 $${low.toFixed(2)}（每个样本一次就过、输出取下限）–$${high.toFixed(2)}（每个样本都用满 ${options.budget} 次、输出取上限）；没有调用模型\n`);
      return;
    }

    const startedAt = new Date().toISOString();
    const outDir = path.resolve(options.out || path.join(projectRoot, "reports", `storyboard-review-replay-${startedAt.slice(0, 10)}`));
    await fs.mkdir(path.join(outDir, "raw"), { recursive: true });
    const jobs = options.models.flatMap((model) => Array.from({ length: options.samples }, (_, i) => ({ model, sample: i + 1 })));
    process.stdout.write(`${jobs.length} 个样本，每个最多 ${options.budget} 次调用 → ${outDir}\n`);
    const coordinator = new ModelCallCoordinator({ maxProviderCalls: options.budget });
    const runs = await mapPool(jobs, options.concurrency, async (job) => {
      const provider = providerOf(job.model);
      const { client, maxCompletionTokens } = clients[provider];
      const attempts = [];
      const rejections = [];
      let lastStartedMs = Date.now();
      let stepPass = false;
      let error = "";
      try {
        await coordinator.runJson({
          client, provider, stage: "storyboardReview", maxProviderCalls: options.budget,
          request: { prompt, systemPrompt: storyboardSystem, model: job.model, maxCompletionTokens },
          attemptObserver: async (info) => {
            const usage = info.usage || null;
            const content = typeof info.content === "string" ? info.content : "";
            const row = { callIndex: info.callIndex, status: info.status, code: info.code, finishReason: info.finishReason, usage, durationMs: Date.now() - lastStartedMs,
              costUsd: usage ? costUsd(job.model, Number(usage.input_tokens ?? usage.prompt_tokens) || 0, Number(usage.output_tokens ?? usage.completion_tokens) || 0) : undefined };
            lastStartedMs = Date.now();
            if (content) {
              // 成功的也存：通过的那份里引用写得多长、有几条，是估「每条引用出错率」的分母。
              await fs.writeFile(path.join(outDir, "raw", `${job.model}-${job.sample}-call${info.callIndex + 1}.txt`), content);
              const parsed = parseContent(content);
              if (parsed.parseError) row.parseError = parsed.parseError;
              else { row.verdict = productionVerdict(parsed.value, context); row.analysis = analyzeReview(parsed.value, context, catalog); }
            } else if (info.status === "failed") row.transportError = `${info.category || ""} ${info.code || ""}`.trim();
            attempts.push(row);
          },
          // 与生产 call() 同一套：截断单独一种话术；被校验拦下时只追加上一次的结构化诊断。
          retryPrompt: ({ originalPrompt, issue, error: failure }) => {
            if (String(issue?.code || failure?.code || "") === "MODEL_OUTPUT_TRUNCATED") return storyboardRetryPrompt({ originalPrompt, truncated: true });
            const last = rejections[rejections.length - 1];
            return last?.details?.length ? storyboardRetryPrompt({ originalPrompt, details: last.details }) : originalPrompt;
          },
          validate: (candidate) => {
            try { return validateStoryboardReview(candidate, context); } catch (failure) {
              if (failure instanceof OutputContractError) rejections.push({ details: Array.isArray(failure.details) ? failure.details : [] });
              throw failure;
            }
          }
        });
        stepPass = true;
      } catch (failure) {
        error = `${failure?.code || "ERROR"} ${failure?.message || failure}`;
      }
      process.stdout.write(`${job.model} #${job.sample}：${attempts.map(attemptLabel).join(" → ")}；$${attempts.reduce((sum, a) => sum + (a.costUsd || 0), 0).toFixed(3)}\n`);
      return { ...job, attempts, stepPass, error };
    });
    await fs.writeFile(path.join(outDir, "calls.jsonl"), runs.map((run) => JSON.stringify(run)).join("\n") + "\n");
    await fs.writeFile(path.join(outDir, "summary.md"), renderSummary({ runs, baseline, options, startedAt, promptChars: prompt.length }) + "\n");
    process.stdout.write(`已写入 ${path.join(outDir, "summary.md")}\n`);
  } finally {
    await systemProxy?.close?.();
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
