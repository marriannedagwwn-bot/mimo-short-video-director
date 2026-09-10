import { AsyncLocalStorage } from "node:async_hooks";

/**
 * 请求级 token 记账。
 *
 * 一次用户操作背后可能有十几次模型调用（Foundation + 每批 shot + 局部修复 +
 * 语义审计），调用点散落在 workflow、compiler、partial-repair 多个模块里。用
 * AsyncLocalStorage 建立请求作用域，客户端在解析响应时把 usage 投进当前作用域，
 * 调用点一处都不用改，并发请求之间也不会串账。
 *
 * 这套记账是**纯旁路**：它不是 Artifact、不进 Production Lineage、不是恢复数据，
 * 也绝不允许改变任何生成的成功失败结论。所有对外入口都 fail-open。
 */

const storage = new AsyncLocalStorage();

// 与 full-model-output-log.js 的 usage 字段允许集保持一致，覆盖各家兼容写法。
const PROMPT_TOKEN_KEYS = ["prompt_tokens", "promptTokens", "input_tokens", "inputTokens"];
const COMPLETION_TOKEN_KEYS = ["completion_tokens", "completionTokens", "output_tokens", "outputTokens"];
const TOTAL_TOKEN_KEYS = ["total_tokens", "totalTokens"];

let accountingWarned = false;

function warnOnce(error) {
  if (accountingWarned) return;
  accountingWarned = true;
  console.warn(`token 记账失败，已跳过本次统计（不影响生成结果）：${error?.message || error}`);
}

function firstFiniteNumber(source, keys) {
  for (const key of keys) {
    const number = Number(source[key]);
    if (Number.isFinite(number) && number >= 0) return number;
  }
  return null;
}

/** 把各家 usage 归一成 promptTokens / completionTokens / totalTokens；无法识别返回 null。 */
export function normalizeModelUsage(usage) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const promptTokens = firstFiniteNumber(usage, PROMPT_TOKEN_KEYS);
  const completionTokens = firstFiniteNumber(usage, COMPLETION_TOKEN_KEYS);
  const reportedTotal = firstFiniteNumber(usage, TOTAL_TOKEN_KEYS);
  if (promptTokens === null && completionTokens === null && reportedTotal === null) return null;
  const prompt = promptTokens ?? 0;
  const completion = completionTokens ?? 0;
  // 供应商报了总数就用它；只有分项时自己求和。两者都缺的分项按 0 计。
  const totalTokens = reportedTotal ?? (prompt + completion);
  return { promptTokens: prompt, completionTokens: completion, totalTokens };
}

/**
 * 记录一次模型调用的 token 消耗。作用域之外调用是 no-op。
 * 任何异常都吞掉：记账出问题绝不能让一次生成失败。
 */
export function recordModelUsage({ provider = "", model = "", usage = null } = {}) {
  try {
    const store = storage.getStore();
    if (!store) return;
    const normalized = normalizeModelUsage(usage);
    if (!normalized) return;
    store.calls.push({
      provider: String(provider || "").trim(),
      model: String(model || "").trim(),
      ...normalized
    });
    const onUsage = store.onUsage;
    if (typeof onUsage === "function") {
      // 每次重新汇总产生独立快照；观察者无法通过改写它污染底层 calls。
      const summary = summarizeStore(store, store.prices);
      if (summary) {
        // 同步交出当前用量，不等待旁路异步工作，也不让拒绝变成未处理异常。
        Promise.resolve(onUsage(summary)).catch(warnOnce);
      }
    }
  } catch (error) {
    warnOnce(error);
  }
}

function roundCents(value) {
  return Math.round(value * 100) / 100;
}

/**
 * 汇总一个作用域内的全部调用。
 * `prices` 是 Map<模型ID, { inputPerMillion, outputPerMillion }>。
 * 只要有一个模型查不到单价，costKnown 就是 false——宁可只报 token，也不报错数字。
 */
export function summarizeModelUsage(calls = [], prices = new Map()) {
  const list = Array.isArray(calls) ? calls : [];
  const lookup = prices instanceof Map ? prices : new Map();
  const byModelKey = new Map();
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let costCny = 0;
  let costKnown = list.length > 0;

  for (const call of list) {
    promptTokens += call.promptTokens;
    completionTokens += call.completionTokens;
    totalTokens += call.totalTokens;

    const key = `${call.provider}\u0000${call.model}`;
    const entry = byModelKey.get(key) || {
      provider: call.provider,
      model: call.model,
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costCny: null
    };
    entry.calls += 1;
    entry.promptTokens += call.promptTokens;
    entry.completionTokens += call.completionTokens;
    entry.totalTokens += call.totalTokens;
    byModelKey.set(key, entry);
  }

  for (const entry of byModelKey.values()) {
    const price = lookup.get(entry.model);
    if (!price) {
      costKnown = false;
      continue;
    }
    const modelCost = (entry.promptTokens / 1e6) * price.inputPerMillion
      + (entry.completionTokens / 1e6) * price.outputPerMillion;
    entry.costCny = roundCents(modelCost);
    costCny += modelCost;
  }

  return {
    calls: list.length,
    promptTokens,
    completionTokens,
    totalTokens,
    costCny: costKnown ? roundCents(costCny) : null,
    costKnown,
    byModel: [...byModelKey.values()]
  };
}

/**
 * 失败响应上的 usage 用 Symbol 挂在 Error 上，而不是普通属性：
 * 错误对象会经过 serializeServerError、日志脱敏与 JSON.stringify，
 * Symbol 键不会被枚举，不可能被误当成业务字段或渗进 Artifact。
 */
const USAGE_ON_ERROR = Symbol("modelUsageAccounting");

function summarizeStore(store, prices) {
  try {
    // 没发生模型调用就不返回 usage（记账、状态更新这类簿记请求属于这一类），
    // 否则浏览器把一堆零消耗条目并进阶段合计，会把 costKnown 误判成 false。
    return store.calls.length ? summarizeModelUsage(store.calls, prices) : null;
  } catch (error) {
    warnOnce(error);
    return null;
  }
}

function attachUsageToError(error, usage) {
  try {
    if (!usage) return;
    if (!error || (typeof error !== "object" && typeof error !== "function")) return;
    Object.defineProperty(error, USAGE_ON_ERROR, {
      value: usage,
      enumerable: false,
      configurable: true,
      writable: true
    });
  } catch (attachError) {
    // 冻结的错误对象、异常的 defineProperty：只放弃记账，不改变失败语义。
    warnOnce(attachError);
  }
}

/** 取出失败请求在失败前已经花掉的 usage；没有则返回 null。纯展示用，fail-open。 */
export function readModelUsageFromError(error) {
  try {
    if (!error || (typeof error !== "object" && typeof error !== "function")) return null;
    return error[USAGE_ON_ERROR] || null;
  } catch (readError) {
    warnOnce(readError);
    return null;
  }
}

/**
 * 在一个记账作用域里跑 fn，返回 { result, usage }。
 * fn 抛错时错误原样向上抛——记账不改变任何失败语义；
 * 但失败前已经花掉的 token 是真实费用，会挂到错误上一并报出来，
 * 不能让用户以为一次失败的生成是免费的。
 * onUsage 可同步取得每次入账后的累计快照；观察失败不改变生成或记账结论。
 */
export async function runWithUsageAccounting(fn, { prices = new Map(), onUsage = null } = {}) {
  const store = { calls: [], prices, onUsage };
  return storage.run(store, async () => {
    let result;
    try {
      result = await fn();
    } catch (error) {
      attachUsageToError(error, summarizeStore(store, prices));
      throw error;
    }
    return { result, usage: summarizeStore(store, prices) };
  });
}

/**
 * 解析 MODEL_PRICE_CNY_PER_MILLION：`模型ID=输入单价/输出单价`，逗号分隔，单位元/百万 token。
 * 单条格式错误只跳过该条并告警，不让一个笔误拖垮启动。
 *
 * 分隔符同时接受半角 `,` 与全角 `，`、`、`，价格分隔同时接受 `/` 与全角 `／`：
 * 这份配置是中文输入法下手写的，一个全角逗号会把它后面那条也吞进同一个条目，
 * 让本来合法的单价被静默丢弃。宁可宽容分隔符，也不要静默少算钱。
 */
export function parseModelPrices(value) {
  const prices = new Map();
  const invalid = [];
  String(value || "").split(/[,，、]/u).forEach((rawEntry) => {
    const entry = rawEntry.trim();
    if (!entry) return;
    const match = /^([^=]+)=\s*([0-9]*\.?[0-9]+)\s*[/／]\s*([0-9]*\.?[0-9]+)\s*$/u.exec(entry);
    if (!match) {
      invalid.push(entry);
      return;
    }
    const model = match[1].trim();
    const inputPerMillion = Number(match[2]);
    const outputPerMillion = Number(match[3]);
    if (!model || !Number.isFinite(inputPerMillion) || !Number.isFinite(outputPerMillion)) {
      invalid.push(entry);
      return;
    }
    prices.set(model, { inputPerMillion, outputPerMillion });
  });
  return { prices, invalid };
}
