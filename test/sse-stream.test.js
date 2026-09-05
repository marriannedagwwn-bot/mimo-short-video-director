import test from "node:test";
import assert from "node:assert/strict";
import { SseStreamIncompleteError, readSseCompletion } from "../src/sse-stream.js";

const encoder = new TextEncoder();

function streamOfBytes(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    }
  });
}

function streamOfText(text, chunkSize = 0) {
  const bytes = encoder.encode(text);
  if (!chunkSize) return streamOfBytes([bytes]);
  const chunks = [];
  for (let i = 0; i < bytes.length; i += chunkSize) chunks.push(bytes.slice(i, i + chunkSize));
  return streamOfBytes(chunks);
}

const DONE = "data: [DONE]\n\n";

test("汉字被拆到两个数据块之间也不会产生乱码", async () => {
  // 这是流式最常见的缺陷：对每个 chunk 单独 toString 会把多字节汉字劈开。
  // 逐字节切割能覆盖所有可能的切点。
  const text = `data: {"choices":[{"delta":{"content":"雨天的流浪猫窝"}}]}\n\n`
    + `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n${DONE}`;
  for (const size of [1, 2, 3, 5, 7, 13]) {
    const result = await readSseCompletion(streamOfText(text, size));
    assert.equal(result.content, "雨天的流浪猫窝", `chunkSize=${size}`);
  }
});

test("一个 data 行被切成多段仍能正确拼回", async () => {
  const text = `data: {"choices":[{"delta":{"content":"{\\"a\\":1}"}}]}\n\n`
    + `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n${DONE}`;
  const result = await readSseCompletion(streamOfText(text, 4));
  assert.equal(result.content, '{"a":1}');
  assert.equal(result.finishReason, "stop");
});

test("reasoning_content 单独收集，绝不混进正文", async () => {
  // 混进去会被当作 JSON 正文送进 validator，报成模型输出格式错误
  const text = `data: {"choices":[{"delta":{"reasoning_content":"我先想想用户要什么"}}]}\n\n`
    + `data: {"choices":[{"delta":{"content":"{\\"ok\\":true}"}}]}\n\n`
    + `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n${DONE}`;
  const result = await readSseCompletion(streamOfText(text));
  assert.equal(result.content, '{"ok":true}');
  assert.equal(result.reasoningContent, "我先想想用户要什么");
});

test("末块 usage、finish_reason 与 id 都被提取", async () => {
  const text = `data: {"id":"req-77","choices":[{"delta":{"content":"x"}}]}\n\n`
    + `data: {"choices":[{"delta":{},"finish_reason":"length"}],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}\n\n${DONE}`;
  const result = await readSseCompletion(streamOfText(text));
  assert.equal(result.id, "req-77");
  assert.equal(result.finishReason, "length");
  assert.deepEqual(result.usage, { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 });
});

test("SSE 注释行、event 行与空行被忽略", async () => {
  const text = `: keep-alive\n\nevent: message\n`
    + `data: {"choices":[{"delta":{"content":"ok"}}]}\n\n`
    + `retry: 1000\n`
    + `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n${DONE}`;
  const result = await readSseCompletion(streamOfText(text));
  assert.equal(result.content, "ok");
  assert.equal(result.finishReason, "stop");
});

test("[DONE] 之后的内容不再改变结果", async () => {
  const text = `data: {"choices":[{"delta":{"content":"good"}}]}\n\n`
    + `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n${DONE}`
    + `data: {"choices":[{"delta":{"content":"迟到的内容"}}]}\n\n`;
  const result = await readSseCompletion(streamOfText(text));
  assert.equal(result.content, "good");
});

test("单个数据块不是 JSON 不足以判定整流失败", async () => {
  const text = `data: not-json\n\n`
    + `data: {"choices":[{"delta":{"content":"ok"}}]}\n\n`
    + `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n${DONE}`;
  const result = await readSseCompletion(streamOfText(text));
  assert.equal(result.content, "ok");
});

test("流在没有结束标志时结束即为传输中断，且不返回半截内容", async () => {
  // 这是 2026-09-05 那批 306 秒失败的形态：上游放弃，但不给结束标志。
  // 返回半截内容会让残缺 JSON 被下游报成「JSON 格式错误」，
  // 把传输问题伪装成模型输出问题。
  const text = `data: {"choices":[{"delta":{"content":"{\\"标题\\":\\"雨天的"}}]}\n\n`;
  await assert.rejects(
    () => readSseCompletion(streamOfText(text)),
    (error) => {
      assert.ok(error instanceof SseStreamIncompleteError);
      assert.equal(error.code, "MODEL_STREAM_INCOMPLETE");
      assert.equal(error.partialLength, 10); // 已收到 {"标题":"雨天的
      // raw 保留已收到的片段供诊断
      assert.match(error.raw, /雨天的/u);
      return true;
    }
  );
});

test("只要有 finish_reason，缺少 [DONE] 也算正常结束", async () => {
  const text = `data: {"choices":[{"delta":{"content":"ok"}}]}\n\n`
    + `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n`;
  const result = await readSseCompletion(streamOfText(text));
  assert.equal(result.content, "ok");
  assert.equal(result.finishReason, "stop");
});

test("最后一行没有换行符也能被处理", async () => {
  const text = `data: {"choices":[{"delta":{"content":"ok"}}]}\n\n`
    + `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}`;
  const result = await readSseCompletion(streamOfText(text));
  assert.equal(result.finishReason, "stop");
});

test("onProgress 抛错不改变传输结论", async () => {
  const text = `data: {"choices":[{"delta":{"content":"ok"}}]}\n\n`
    + `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n${DONE}`;
  let calls = 0;
  const result = await readSseCompletion(streamOfText(text, 8), {
    onProgress() { calls += 1; throw new Error("观测失败"); }
  });
  assert.equal(result.content, "ok");
  assert.ok(calls > 0, "onProgress 应当被调用过");
});

test("raw 超过上限时保留头尾并标注省略量", async () => {
  const filler = "永".repeat(5000);
  const text = `data: {"choices":[{"delta":{"content":"${filler}"}}]}\n\n`
    + `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n${DONE}`;
  const result = await readSseCompletion(streamOfText(text), { maxRawChars: 400 });
  assert.ok(result.raw.length < 600);
  assert.match(result.raw, /中段 \d+ 字符已省略/u);
  // 正文本身不受 raw 上限影响
  assert.equal(result.content.length, 5000);
});

// ---- 客户端层：流式与非流式必须返回同一个形状 ----

test("qwen-client 流式返回的字段与非流式逐字一致，中断则归类为可重试的传输失败", async (t) => {
  const { QwenClient } = await import("../src/qwen-client.js");
  const { classifyAttemptError } = await import("../src/model-call-coordinator.js");
  const http = await import("node:http");

  const full = `data: {"id":"req-abc","choices":[{"delta":{"reasoning_content":"先想一下"}}]}\n\n`
    + `data: {"choices":[{"delta":{"content":"{\\"ok\\":true}"}}]}\n\n`
    + `data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"total_tokens":30}}\n\n`
    + "data: [DONE]\n\n";

  const server = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (request.url.startsWith("/cut")) {
      // 干净 EOF 但没有结束标志：上游中途放弃的形态
      response.end(full.split("\n\n")[0] + "\n\n");
      return;
    }
    response.end(full);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();

  const ok = await new QwenClient({
    baseUrl: `http://127.0.0.1:${port}/ok`, apiKey: "", model: "kimi-k3", maxCompletionTokens: 1000
  }).requestCompletion({ prompt: "hi", model: "kimi-k3" });

  // 这 7 个字段一个都不能少：providerName 被 model-call-coordinator 与 workflow
  // 用于错误归属，model 被 workflow 用于用量记账，漏掉会静默降级到回退值。
  assert.deepEqual(Object.keys(ok).sort(), [
    "content", "finishReason", "model", "providerName", "raw", "requestId", "usage"
  ]);
  assert.equal(ok.content, '{"ok":true}');
  assert.ok(!ok.content.includes("先想一下"), "推理内容不得混进正文");
  assert.equal(ok.finishReason, "stop");
  assert.equal(ok.requestId, "req-abc");
  assert.deepEqual(ok.usage, { total_tokens: 30 });
  assert.equal(ok.providerName, "Qwen");
  assert.equal(ok.model, "kimi-k3");

  await assert.rejects(
    () => new QwenClient({
      baseUrl: `http://127.0.0.1:${port}/cut`, apiKey: "", model: "kimi-k3", maxCompletionTokens: 1000
    }).requestCompletion({ prompt: "hi", model: "kimi-k3" }),
    (error) => {
      assert.equal(error.code, "MODEL_STREAM_INCOMPLETE");
      const classified = classifyAttemptError(error);
      // 不单独分类的话会落到 ModelResponseError 的兜底分支：
      // status=0 → category "protocol" 且 retryable false，把可重试的网络中断
      // 变成不可重试的协议错误。
      assert.equal(classified.category, "transport");
      assert.equal(classified.retryable, true);
      return true;
    }
  );
});
