import test from "node:test";
import assert from "node:assert/strict";
import {
  DEGENERATION_CHECK_EVERY_CHARS,
  DEGENERATION_WINDOW_CHARS,
  createDegenerationWatch,
  detectRepetitionLoop
} from "../src/output-degeneration.js";
import { SseStreamDegenerateError, readSseCompletion } from "../src/sse-stream.js";
import { MimoClient } from "../src/mimo-client.js";
import { QwenClient } from "../src/qwen-client.js";
import { ModelCallCoordinator, classifyAttemptError } from "../src/model-call-coordinator.js";
import {
  MIMO_OUTPUT_TOKEN_CEILING,
  SHARED_OUTPUT_TOKEN_CEILING,
  growOutputTokenLimit
} from "../src/output-token-ceilings.js";

// 真实形状取自 2026-08-30 那 12 份陷入重复的完整剧情：在约 490 字处开始，把同一小段吐到额度用完。
const LEGIT_PREFIX = "{\"characterBible\":{\"protagonist\":{\"name\":\"小白子\",\"speechRules\":[\"只用简短的词回应\",";
const LOOP_UNITS = [`":"  :"",  `, `,"再见"  \t\t: "小白子会说"  `, `  "  :",  "  ,",  `];

function looping(unit, totalLength = DEGENERATION_WINDOW_CHARS + 500) {
  let text = LEGIT_PREFIX;
  while (text.length < totalLength) text += unit;
  return text;
}

// 合法但结构重复的输出：同一形状的对象，字段值各不相同。它绝不能被当成死循环。
function repetitiveButLegitJson(count = 60) {
  return JSON.stringify({
    storyOutline: Array.from({ length: count }, (_, index) => ({
      beat: index + 1,
      action: `小白子在第 ${index + 1} 拍把竹篮往左边挪了 ${index * 3 + 1} 厘米`,
      emotion: ["好奇", "着急", "开心", "安静"][index % 4]
    }))
  });
}

test("08-30 那三种真实的重复形状都被判出来，并报出重复单元", () => {
  for (const unit of LOOP_UNITS) {
    const hit = detectRepetitionLoop(looping(unit));
    assert.ok(hit, JSON.stringify(unit));
    assert.equal(hit.period, unit.length);
    assert.ok(hit.repeats * hit.period >= DEGENERATION_WINDOW_CHARS * 0.6);
  }
});

test("结构重复但逐项不同的 JSON、普通长文与不满一个窗口的文本都不判", () => {
  assert.equal(detectRepetitionLoop(repetitiveButLegitJson()), null);
  const prose = Array.from({ length: 120 }, (_, index) => `第${index}句：她把手伸进口袋摸了摸，又抬头看向远处的第${index % 7}棵树。`).join("");
  assert.equal(detectRepetitionLoop(prose), null);
  assert.equal(detectRepetitionLoop(`":"  :"",  `.repeat(150)), null, "不满 2000 字不判定");
  assert.equal(detectRepetitionLoop(""), null);
  assert.equal(detectRepetitionLoop(undefined), null);
});

test("边收边查只在每新增一段时检查一次，不随数据块多少变化", () => {
  const watch = createDegenerationWatch();
  const loop = looping(LOOP_UNITS[0], DEGENERATION_WINDOW_CHARS * 3);
  assert.equal(watch.check("content", loop.slice(0, DEGENERATION_WINDOW_CHARS - 1)), null, "窗口不满不检查");
  assert.ok(watch.check("content", loop.slice(0, DEGENERATION_WINDOW_CHARS)), "第一次检查点");
  // 下一个检查点在 +1000 字之后：之间无论调用多少次都不再检查。
  assert.equal(watch.check("content", loop.slice(0, DEGENERATION_WINDOW_CHARS + DEGENERATION_CHECK_EVERY_CHARS - 1)), null);
  assert.ok(watch.check("content", loop.slice(0, DEGENERATION_WINDOW_CHARS + DEGENERATION_CHECK_EVERY_CHARS)));
  // 正文与推理各自计数。
  assert.ok(watch.check("reasoning", loop.slice(0, DEGENERATION_WINDOW_CHARS)));
});

// 一个永远不结束的流：每次 pull 都再吐一小段。检测不生效的话测试会一直挂着，所以它同时验证了「真的断开了」。
function endlessStream(field, unit, { onCancel } = {}) {
  const encoder = new TextEncoder();
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      const text = sent === 0 ? LEGIT_PREFIX : unit.repeat(8);
      sent += 1;
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { [field]: text } }] })}\n\n`));
    },
    cancel(reason) {
      onCancel?.(reason);
    }
  });
}

// 这三条用的是永不结束的流：检测一旦失效就会一直挂着，所以设超时，让它明确失败而不是卡住整个 npm test。
const ENDLESS = { timeout: 10_000 };

test("正文陷入重复时读取流程主动中断连接，抛出可识别的错误，不返回半截内容", ENDLESS, async () => {
  let cancelled = null;
  await assert.rejects(
    readSseCompletion(endlessStream("content", LOOP_UNITS[0], { onCancel: (reason) => { cancelled = reason; } })),
    (error) => {
      assert.ok(error instanceof SseStreamDegenerateError);
      assert.equal(error.code, "MODEL_OUTPUT_DEGENERATE");
      assert.equal(error.stream, "content");
      assert.equal(error.period, LOOP_UNITS[0].length);
      assert.match(error.message, /正文最后 2000 字里/u);
      assert.ok(error.partialContentLength >= DEGENERATION_WINDOW_CHARS);
      return true;
    }
  );
  assert.ok(cancelled instanceof SseStreamDegenerateError, "底层连接必须被关掉，否则供应商会继续吐、继续计费");
});

test("推理流陷入重复同样中断，并标明是推理", ENDLESS, async () => {
  await assert.rejects(readSseCompletion(endlessStream("reasoning_content", LOOP_UNITS[1])), (error) => {
    assert.ok(error instanceof SseStreamDegenerateError);
    assert.equal(error.stream, "reasoning");
    assert.match(error.message, /推理最后 2000 字里/u);
    return true;
  });
});

test("结构重复的合法长输出照常读完", async () => {
  const content = repetitiveButLegitJson(120);
  const encoder = new TextEncoder();
  const pieces = content.match(/[\s\S]{1,50}/gu);
  const body = new ReadableStream({
    start(controller) {
      for (const piece of pieces) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`));
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`));
      controller.close();
    }
  });
  const result = await readSseCompletion(body);
  assert.equal(result.content, content);
  assert.equal(result.finishReason, "stop");
});

test("MiMo 与 Qwen 都把它归为 MODEL_OUTPUT_DEGENERATE，而不是网络中断", ENDLESS, async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(endlessStream("content", LOOP_UNITS[2]), {
    status: 200, headers: { "content-type": "text/event-stream" }
  }));
  const clients = [
    new MimoClient({ baseUrl: "https://mimo.invalid/v1", model: "mimo-v2.6-pro", jsonRetryAttempts: 0, mediaMode: "auto" }),
    new QwenClient({ baseUrl: "https://qwen.invalid/v1", apiKey: "", model: "qwen3.7-max", maxCompletionTokens: 1000 })
  ];
  for (const client of clients) {
    await assert.rejects(client.requestCompletion({ prompt: "fixture" }), (error) => {
      assert.equal(error.code, "MODEL_OUTPUT_DEGENERATE", client.constructor.name);
      assert.match(error.message, /输出陷入重复/u);
      const classified = classifyAttemptError(error);
      assert.equal(classified.category, "degeneration");
      assert.equal(classified.origin, "model");
      assert.equal(classified.retryable, true);
      return true;
    });
  }
});

test("重试抬额度只抬不降：到上限就停，没写上限就保持不写", () => {
  const shared = { factor: 1.5, ceiling: SHARED_OUTPUT_TOKEN_CEILING };
  assert.equal(growOutputTokenLimit(32768, shared), 49152);
  assert.equal(growOutputTokenLimit(60000, shared), SHARED_OUTPUT_TOKEN_CEILING);
  // 此前 MiMo 与 coordinator 的重试把结果夹在 32768：默认一抬到 131072，重试反而会把它压回去。
  assert.equal(growOutputTokenLimit(MIMO_OUTPUT_TOKEN_CEILING, shared), MIMO_OUTPUT_TOKEN_CEILING);
  assert.equal(growOutputTokenLimit(undefined, shared), undefined);
  assert.equal(growOutputTokenLimit(null, shared), null);
});

test("coordinator 截断后重试：没写上限的请求保持不写，写了 131072 的不被压低", async () => {
  for (const initial of [undefined, MIMO_OUTPUT_TOKEN_CEILING]) {
    const requests = [];
    const client = {
      async requestCompletion(request) {
        requests.push(request);
        return requests.length === 1
          ? { content: "{\"a\":", finishReason: "length", requestId: "", usage: null, raw: "" }
          : { content: "{\"ok\":true}", finishReason: "stop", requestId: "", usage: null, raw: "{\"ok\":true}" };
      }
    };
    const coordinator = new ModelCallCoordinator({ maxProviderCalls: 2 });
    const result = await coordinator.runJson({
      client, provider: "MiMo", stage: "fixture", maxProviderCalls: 2,
      request: { prompt: "p", ...(initial ? { maxCompletionTokens: initial } : {}) },
      validate: (value) => value
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(requests.length, 2);
    assert.equal(requests[1].maxCompletionTokens, initial);
  }
});
