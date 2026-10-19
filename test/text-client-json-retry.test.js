import test from "node:test";
import assert from "node:assert/strict";
import { MimoClient, ModelResponseError } from "../src/mimo-client.js";
import { QwenClient } from "../src/qwen-client.js";
import { DeepSeekClient } from "../src/deepseek-client.js";
import { ClaudeClient } from "../src/claude-client.js";
import { sseResponse } from "./helpers/sse-response.js";
import { anthropicSseResponse } from "./helpers/anthropic-sse-response.js";

// 三家文本客户端在调用方显式传 jsonRetryAttempts: 0 时只发一次请求。用例原在
// test/static-frame-compiler-config.test.js（Static Frame Compiler 用这个参数关掉客户端内重试），
// 编译器已于 2026-10-11 删除，客户端行为仍在用，用例原样挪到这里。

test("Qwen、MiMo 与 DeepSeek 显式禁用 JSON 内容重试；只有非流式的 DeepSeek 使用单次请求的总 timeout", async () => {
  const originalFetch = globalThis.fetch;
  const originalTimeout = AbortSignal.timeout;
  const fetchCalls = [];
  const observedTimeouts = [];

  try {
    AbortSignal.timeout = (milliseconds) => {
      observedTimeouts.push(milliseconds);
      return new AbortController().signal;
    };
    const compilerContent = "```json\n{\"patches\":[]}\n```";
    globalThis.fetch = async (url, init) => {
      fetchCalls.push({ url: String(url), init });
      // 三个 client 共用同一个 mock，按请求自己声明的 stream 决定响应格式，
      // 与真实服务器一致：qwen-client 走 SSE，MiMo 与 DeepSeek 仍是完整 JSON。
      if (JSON.parse(String(init?.body || "{}")).stream) {
        return sseResponse({ content: compilerContent });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: compilerContent } }]
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

    const sharedConfig = {
      baseUrl: "https://provider.invalid/v1",
      apiKey: "",
      model: "configured-model",
      maxCompletionTokens: 4096,
      requestTimeoutMs: 900_000,
      jsonRetryAttempts: 3
    };

    await assert.rejects(
      new QwenClient(sharedConfig).generateJson({
        prompt: "只返回 JSON",
        requestTimeoutMs: 61_111,
        jsonRetryAttempts: 0,
        strictJson: true
      }),
      (error) => error instanceof ModelResponseError && /Qwen 未返回严格 JSON/u.test(error.message)
    );
    assert.equal(fetchCalls.length, 1);

    await assert.rejects(
      new MimoClient(sharedConfig).generateJson({
        prompt: "只返回 JSON",
        requestTimeoutMs: 72_222,
        jsonRetryAttempts: 0,
        strictJson: true
      }),
      (error) => error instanceof ModelResponseError && /MiMo 未返回严格 JSON/u.test(error.message)
    );
    assert.equal(fetchCalls.length, 2);

    await assert.rejects(
      new DeepSeekClient(sharedConfig).generateJson({
        prompt: "只返回 JSON",
        requestTimeoutMs: 83_333,
        jsonRetryAttempts: 0,
        strictJson: true
      }),
      (error) => error instanceof ModelResponseError && /DeepSeek 未返回严格 JSON/u.test(error.message)
    );
    assert.equal(fetchCalls.length, 3);
    // Qwen 与 MiMo 是流式：不设总时长，只判空闲（stream-idle-timeout.js），
    // 单次请求的 requestTimeoutMs 对它们不再生效；非流式 DeepSeek 仍按它设总超时。
    assert.deepEqual(observedTimeouts, [83_333]);
  } finally {
    globalThis.fetch = originalFetch;
    AbortSignal.timeout = originalTimeout;
  }
});

test("Claude 同样遵守 jsonRetryAttempts: 0，只发一次请求；流式不设总时长，不用 requestTimeoutMs", async (t) => {
  const observedTimeouts = [];
  t.mock.method(AbortSignal, "timeout", (milliseconds) => {
    observedTimeouts.push(milliseconds);
    return new AbortController().signal;
  });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    // 整段只被一对代码块包着的会被 Claude 客户端去掉包裹（unwrapWholeCodeFence），所以这里用前面多了说明文字的。
    return anthropicSseResponse({ content: "下面是结果：\n```json\n{\"patches\":[]}\n```" });
  });
  await assert.rejects(
    new ClaudeClient({ baseUrl: "https://claude.invalid", apiKey: "k", model: "claude-opus-5-5", jsonRetryAttempts: 3 }).generateJson({
      prompt: "只返回 JSON",
      requestTimeoutMs: 94_444,
      jsonRetryAttempts: 0,
      strictJson: true
    }),
    (error) => error instanceof ModelResponseError && /Claude 未返回严格 JSON/u.test(error.message)
  );
  assert.equal(calls, 1);
  assert.deepEqual(observedTimeouts, []);
});
