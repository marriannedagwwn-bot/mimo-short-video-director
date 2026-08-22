import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeModelUsage,
  parseModelPrices,
  recordModelUsage,
  runWithUsageAccounting,
  summarizeModelUsage
} from "../src/token-usage.js";
import {
  formatCostCny,
  formatStageUsageSuffix,
  mergeStageUsage
} from "../public/token-usage-format.js";
import { MimoClient } from "../src/mimo-client.js";

const PRICES = new Map([
  ["qwen3.7-max", { inputPerMillion: 2.4, outputPerMillion: 9.6 }],
  ["deepseek-v4-flash", { inputPerMillion: 0.5, outputPerMillion: 1.5 }]
]);

test("usage 归一覆盖各家字段写法，无法识别时返回 null", () => {
  assert.deepEqual(
    normalizeModelUsage({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }),
    { promptTokens: 100, completionTokens: 20, totalTokens: 120 }
  );
  assert.deepEqual(
    normalizeModelUsage({ inputTokens: 7, outputTokens: 3 }),
    { promptTokens: 7, completionTokens: 3, totalTokens: 10 }
  );
  // 供应商报了总数就以总数为准，不自己改写。
  assert.equal(normalizeModelUsage({ prompt_tokens: 5, completion_tokens: 5, total_tokens: 99 }).totalTokens, 99);
  assert.equal(normalizeModelUsage(null), null);
  assert.equal(normalizeModelUsage({ foo: 1 }), null);
  assert.equal(normalizeModelUsage([1, 2]), null);
});

test("记账作用域按调用累加，作用域之外记录是 no-op 且不抛错", async () => {
  // 作用域外：既不抛错也不留下任何痕迹。
  assert.doesNotThrow(() => recordModelUsage({ provider: "Qwen", model: "x", usage: { total_tokens: 5 } }));

  const { result, usage } = await runWithUsageAccounting(async () => {
    recordModelUsage({ provider: "Qwen", model: "qwen3.7-max", usage: { prompt_tokens: 1000, completion_tokens: 200 } });
    recordModelUsage({ provider: "Qwen", model: "qwen3.7-max", usage: { prompt_tokens: 500, completion_tokens: 100 } });
    return "done";
  }, { prices: PRICES });

  assert.equal(result, "done");
  assert.equal(usage.calls, 2);
  assert.equal(usage.promptTokens, 1500);
  assert.equal(usage.completionTokens, 300);
  assert.equal(usage.totalTokens, 1800);
  assert.equal(usage.byModel.length, 1);
  assert.equal(usage.byModel[0].calls, 2);
  // 1500/1e6*2.4 + 300/1e6*9.6 = 0.0036 + 0.00288 = 0.00648 → 分位四舍五入 0.01
  assert.equal(usage.costKnown, true);
  assert.equal(usage.costCny, 0.01);
});

test("没有模型调用的请求不返回 usage", async () => {
  const { result, usage } = await runWithUsageAccounting(async () => "bookkeeping", { prices: PRICES });
  assert.equal(result, "bookkeeping");
  assert.equal(usage, null);
});

test("并发的两个记账作用域互不串账", async () => {
  const scope = (model, tokens) => runWithUsageAccounting(async () => {
    await new Promise((resolve) => { setTimeout(resolve, 5); });
    recordModelUsage({ provider: "Qwen", model, usage: { prompt_tokens: tokens, completion_tokens: 0 } });
    await new Promise((resolve) => { setTimeout(resolve, 5); });
    return model;
  }, { prices: PRICES });

  const [a, b] = await Promise.all([scope("qwen3.7-max", 100), scope("deepseek-v4-flash", 900)]);
  assert.equal(a.usage.totalTokens, 100);
  assert.equal(b.usage.totalTokens, 900);
  assert.equal(a.usage.byModel[0].model, "qwen3.7-max");
  assert.equal(b.usage.byModel[0].model, "deepseek-v4-flash");
});

test("任一模型缺单价时只报 token 不报金额", () => {
  const usage = summarizeModelUsage([
    { provider: "Qwen", model: "qwen3.7-max", promptTokens: 1e6, completionTokens: 0, totalTokens: 1e6 },
    { provider: "MiMo", model: "mimo-v2.5-pro", promptTokens: 1e6, completionTokens: 0, totalTokens: 2e6 }
  ], PRICES);
  assert.equal(usage.totalTokens, 3e6);
  assert.equal(usage.costKnown, false);
  assert.equal(usage.costCny, null);
  // 有单价的那个模型自己那份仍然算得出来，只是整段不给总额。
  assert.equal(usage.byModel.find((item) => item.model === "qwen3.7-max").costCny, 2.4);
  assert.equal(usage.byModel.find((item) => item.model === "mimo-v2.5-pro").costCny, null);
});

test("输入与输出分别计价，按百万 token 折算", () => {
  const usage = summarizeModelUsage([
    { provider: "Qwen", model: "qwen3.7-max", promptTokens: 2e6, completionTokens: 1e6, totalTokens: 3e6 }
  ], PRICES);
  // 2 * 2.4 + 1 * 9.6 = 14.4
  assert.equal(usage.costCny, 14.4);
  assert.equal(usage.costKnown, true);
});

test("记账内部出错不影响被包裹函数的返回", async () => {
  const { result, usage } = await runWithUsageAccounting(async () => {
    // 传入畸形 usage：应被安静忽略，而不是让整次生成失败。
    recordModelUsage({ provider: "Qwen", model: "qwen3.7-max", usage: "not-an-object" });
    recordModelUsage(undefined);
    return "still fine";
  }, { prices: PRICES });
  assert.equal(result, "still fine");
  assert.equal(usage, null);
});

test("被包裹函数抛错时错误原样向上抛，记账不改变失败语义", async () => {
  await assert.rejects(
    () => runWithUsageAccounting(async () => {
      recordModelUsage({ provider: "Qwen", model: "qwen3.7-max", usage: { total_tokens: 10 } });
      throw new Error("生成失败");
    }, { prices: PRICES }),
    /生成失败/u
  );
});

test("单价解析接受合法条目，跳过畸形条目", () => {
  const { prices, invalid } = parseModelPrices("qwen3.7-max=2.4/9.6, deepseek-v4-flash = 0.5/1.5 ,坏条目, x=1");
  assert.deepEqual(prices.get("qwen3.7-max"), { inputPerMillion: 2.4, outputPerMillion: 9.6 });
  assert.deepEqual(prices.get("deepseek-v4-flash"), { inputPerMillion: 0.5, outputPerMillion: 1.5 });
  assert.deepEqual(invalid, ["坏条目", "x=1"]);

  const empty = parseModelPrices("");
  assert.equal(empty.prices.size, 0);
  assert.deepEqual(empty.invalid, []);
  assert.equal(parseModelPrices(undefined).prices.size, 0);
});

test("阶段合计跨请求累加，任一请求缺单价则整段不给金额", () => {
  const merged = mergeStageUsage([
    { calls: 1, promptTokens: 100, completionTokens: 10, totalTokens: 110, costCny: 0.02, costKnown: true },
    { calls: 2, promptTokens: 200, completionTokens: 20, totalTokens: 220, costCny: 0.03, costKnown: true }
  ]);
  assert.equal(merged.calls, 3);
  assert.equal(merged.totalTokens, 330);
  assert.equal(merged.costCny, 0.05);
  assert.equal(merged.costKnown, true);

  const partial = mergeStageUsage([
    { calls: 1, totalTokens: 110, costCny: 0.02, costKnown: true },
    { calls: 1, totalTokens: 220, costCny: null, costKnown: false }
  ]);
  assert.equal(partial.totalTokens, 330);
  assert.equal(partial.costKnown, false);
  assert.equal(partial.costCny, null);

  assert.equal(mergeStageUsage([]), null);
});

test("展示：千分位、不足一分显示 < ¥0.01、缺单价时不输出金额", () => {
  assert.equal(formatCostCny(0), "¥0.00");
  assert.equal(formatCostCny(0.004), "< ¥0.01");
  assert.equal(formatCostCny(0.12), "¥0.12");
  assert.equal(formatCostCny(14.4), "¥14.40");

  assert.equal(
    formatStageUsageSuffix({ totalTokens: 12345, costCny: 0.12, costKnown: true }),
    " · 本次消耗 12,345 tokens · 约 ¥0.12"
  );
  assert.equal(
    formatStageUsageSuffix({ totalTokens: 12345, costCny: null, costKnown: false }),
    " · 本次消耗 12,345 tokens"
  );
  // 演示模式没有模型调用：后缀为空，原状态文案保持不变。
  assert.equal(formatStageUsageSuffix(null), "");
  assert.equal(formatStageUsageSuffix({ totalTokens: 0, costKnown: false }), "");
});


// 闭环验证：真实客户端解析响应时把 usage 投进作用域，中间不经过任何调用点改造。
test("真实客户端的一次调用会被记进当前作用域，并按单价算出金额", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: "{\"ok\":true}" } }],
      usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000, total_tokens: 2_000_000 }
    }), { status: 200 });
  };
  try {
    const client = new MimoClient({
      baseUrl: "https://example.invalid/v1",
      apiKey: "",
      model: "qwen3.7-max",
      maxCompletionTokens: 1_000,
      requestTimeoutMs: 1_000,
      jsonRetryAttempts: 0,
      mediaMode: "frames"
    });
    const { result, usage } = await runWithUsageAccounting(
      () => client.generateJson({ prompt: "hi" }),
      { prices: PRICES }
    );
    assert.deepEqual(result, { ok: true });
    assert.equal(calls, 1);
    assert.equal(usage.calls, 1);
    assert.equal(usage.totalTokens, 2_000_000);
    assert.equal(usage.byModel[0].provider, "MiMo");
    assert.equal(usage.byModel[0].model, "qwen3.7-max");
    // 1 * 2.4 + 1 * 9.6 = 12
    assert.equal(usage.costCny, 12);
    assert.equal(usage.costKnown, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("供应商没返回 usage 时不伪造数字，该请求不产生 usage", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ finish_reason: "stop", message: { content: "{\"ok\":true}" } }]
  }), { status: 200 });
  try {
    const client = new MimoClient({
      baseUrl: "https://example.invalid/v1",
      apiKey: "",
      model: "qwen3.7-max",
      maxCompletionTokens: 1_000,
      requestTimeoutMs: 1_000,
      jsonRetryAttempts: 0,
      mediaMode: "frames"
    });
    const { result, usage } = await runWithUsageAccounting(
      () => client.generateJson({ prompt: "hi" }),
      { prices: PRICES }
    );
    assert.deepEqual(result, { ok: true });
    assert.equal(usage, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
