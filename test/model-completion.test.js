import test from "node:test";
import assert from "node:assert/strict";
import {
  MimoClient,
  ModelResponseError,
  parseSingleJsonObject
} from "../src/mimo-client.js";
import { QwenClient } from "../src/qwen-client.js";
import { sseResponse } from "./helpers/sse-response.js";

test("MiMo requestCompletion performs one call and preserves completion metadata", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({
      id: "body-request",
      choices: [{
        finish_reason: "length",
        message: { content: "{\"ok\":true}" }
      }],
      usage: { prompt_tokens: 10, completion_tokens: 20 }
    }), {
      status: 200,
      headers: { "x-request-id": "header-request" }
    });
  };
  try {
    const completion = await new MimoClient(config()).requestCompletion({
      prompt: "return json"
    });
    assert.equal(calls, 1);
    assert.equal(completion.content, "{\"ok\":true}");
    assert.equal(completion.finishReason, "length");
    assert.equal(completion.requestId, "header-request");
    assert.deepEqual(completion.usage, { prompt_tokens: 10, completion_tokens: 20 });
    assert.match(completion.raw, /completion_tokens/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Qwen requestCompletion reads body request id when no request-id header is present", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    // qwen-client 自 2026-09-05 起走流式，响应体里的 id 由 SSE 数据块携带。
    // 本测试的意图不变：没有 request-id 响应头时，requestId 从响应体读取。
    return sseResponse({
      id: "qwen-body-request",
      content: "{\"ok\":true}",
      finishReason: "stop",
      usage: { total_tokens: 12 }
    });
  };
  try {
    const completion = await new QwenClient(config()).requestCompletion({
      prompt: "return json"
    });
    assert.equal(calls, 1);
    assert.equal(completion.finishReason, "stop");
    assert.equal(completion.requestId, "qwen-body-request");
    assert.deepEqual(completion.usage, { total_tokens: 12 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("requestCompletion classifies invalid envelopes without an internal retry", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("not-json", { status: 200 });
  };
  try {
    await assert.rejects(
      () => new MimoClient(config()).requestCompletion({ prompt: "return json" }),
      (error) => error instanceof ModelResponseError
        && error.code === "MODEL_ENVELOPE_INVALID"
        && error.raw === "not-json"
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Full Story strict parser accepts exactly one object and preserves string contents", () => {
  assert.deepEqual(
    parseSingleJsonObject("  {\"text\":\"A<think>keep</think>B\"}  "),
    { text: "A<think>keep</think>B" }
  );
  for (const invalid of [
    "prefix {\"ok\":true}",
    "{\"ok\":true} suffix",
    "```json\n{\"ok\":true}\n```",
    "{\"one\":1}{\"two\":2}",
    "[{\"ok\":true}]",
    "null",
    "\"text\""
  ]) {
    assert.throws(
      () => parseSingleJsonObject(invalid, "MiMo"),
      (error) => error instanceof ModelResponseError
    );
  }
});

function config() {
  return {
    baseUrl: "https://example.invalid/v1",
    apiKey: "",
    model: "test-model",
    maxCompletionTokens: 1_000,
    requestTimeoutMs: 1_000,
    jsonRetryAttempts: 3,
    mediaMode: "frames"
  };
}
