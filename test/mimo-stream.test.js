import test from "node:test";
import assert from "node:assert/strict";
import { MimoClient, buildRequestBody } from "../src/mimo-client.js";
import { runWithDurableTaskContext } from "../src/durable-task-context.js";
import { runWithUsageAccounting, readModelUsageFromError } from "../src/token-usage.js";
import { classifyAttemptError } from "../src/model-call-coordinator.js";
import { sseChunks, sseResponse } from "./helpers/sse-response.js";

const usage = { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 };
const config = { baseUrl: "https://mimo.invalid/v1", model: "mimo-v2.6-flash", requestTimeoutMs: 1000, jsonRetryAttempts: 2, mediaMode: "auto" };

test("all MiMo models request streaming while preserving thinking, JSON and media settings", () => {
  for (const model of ["mimo-v2.5", "mimo-v2.5-pro", "mimo-v2.6-flash", "mimo-v2.6-pro", "mimo-v2.6-pro-ultraspeed"]) {
    const body = buildRequestBody({ ...config, thinking: "enabled", jsonMode: true },
      { prompt: "Return JSON.", video: { dataUrl: "data:video/mp4;base64,fixture" }, useVideo: true }, { model });
    assert.equal(body.model, model);
    assert.equal(body.stream, true);
    assert.deepEqual(body.thinking, { type: "enabled" });
    assert.deepEqual(body.response_format, { type: "json_object" });
    assert.equal(body.messages[1].content[0].type, "video_url");
  }
});

test("MiMo consumes split UTF-8 SSE, excludes reasoning and records final usage exactly once", async (t) => {
  const text = '{"message":"你好，小猫"}';
  const bytes = new TextEncoder().encode(sseChunks({ content: text, reasoningContent: "not JSON reasoning", usage, id: "body-id" }));
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    requests++;
    assert.equal(JSON.parse(options.body).stream, true);
    return new Response(new ReadableStream({ start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    } }), { headers: { "content-type": "text/event-stream" } });
  });
  let heartbeatCount = 0;
  const result = await runWithUsageAccounting(() => runWithDurableTaskContext({ heartbeat() { heartbeatCount++; } },
    () => new MimoClient(config).requestCompletion({ prompt: "fixture" })));
  assert.equal(result.result.content, text);
  assert.equal(result.result.requestId, "body-id");
  assert.equal(result.result.finishReason, "stop");
  assert.equal(result.result.providerName, "MiMo");
  assert.equal(result.result.model, config.model);
  assert.equal(result.usage.calls, 1);
  assert.equal(result.usage.totalTokens, 30);
  assert.equal(heartbeatCount, 1, "progress must be throttled, not emitted for every byte");
  assert.equal(requests, 1);
});

test("MiMo rejects unfinished SSE even when the accumulated JSON is valid, with no media fallback or retry", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response(sseChunks({ content: '{"ok":true}', usage, finishReason: null }).replace("data: [DONE]\n\n", ""));
  });
  await assert.rejects(runWithUsageAccounting(() => new MimoClient(config).generateJsonWithMedia({
    prompt: "fixture", frames: [{ dataUrl: "data:image/png;base64,fixture" }], video: { dataUrl: "data:video/mp4;base64,fixture" }
  })), error => {
    assert.equal(error.code, "MODEL_STREAM_INCOMPLETE");
    assert.equal(classifyAttemptError(error).retryable, true);
    assert.equal(readModelUsageFromError(error).totalTokens, 30);
    return true;
  });
  assert.equal(calls, 1);
});

test("MiMo wraps a disconnect during reasoning before any body text as a stream transport error", async (t) => {
  const first = new TextEncoder().encode(sseChunks({ reasoningContent: "thinking" }).split("\n\n")[0] + "\n\n");
  let reads = 0;
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({ pull(controller) {
    if (reads++ === 0) controller.enqueue(first);
    else controller.error(new TypeError("terminated"));
  } })));
  await assert.rejects(new MimoClient(config).requestCompletion({ prompt: "fixture" }), error => {
    assert.equal(error.code, "MODEL_STREAM_ABORTED");
    assert.equal(error.provider, "MiMo");
    assert.match(error.message, /0 字正文/);
    assert.equal(classifyAttemptError(error).retryable, true);
    return true;
  });
});

test("MiMo never switches back to non-streaming for an unexpected JSON envelope", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));
  });
  await assert.rejects(new MimoClient(config).generateJson({ prompt: "fixture" }), { code: "MODEL_STREAM_INCOMPLETE" });
  assert.equal(calls, 1);
});

test("MiMo progress observation failures cannot fail a completed stream", async (t) => {
  t.mock.method(globalThis, "fetch", async () => sseResponse({ content: '{"ok":true}' }));
  const result = await runWithDurableTaskContext({ async heartbeat() { throw new Error("observer failed"); } },
    () => new MimoClient(config).generateJson({ prompt: "fixture", strictJson: true }));
  assert.deepEqual(result, { ok: true });
});
