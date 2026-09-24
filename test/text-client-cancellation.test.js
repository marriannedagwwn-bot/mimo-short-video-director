import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { MimoClient } from "../src/mimo-client.js";
import { DeepSeekClient } from "../src/deepseek-client.js";
import { QwenClient } from "../src/qwen-client.js";
import { runWithDurableTaskContext } from "../src/durable-task-context.js";
import { ModelCallCoordinator, classifyAttemptError } from "../src/model-call-coordinator.js";
import { readModelUsageFromError, runWithUsageAccounting } from "../src/token-usage.js";
import { sseChunks } from "./helpers/sse-response.js";
import { AnimationPromptCapture } from "../src/animation-prompt-capture.js";

const USAGE = { prompt_tokens: 101, completion_tokens: 37, total_tokens: 138 };
const CONTENT = '{"ok":true}';
const CLIENTS = [
  { provider: "MiMo", Client: MimoClient, model: "mimo-v2.5", streaming: true },
  { provider: "DeepSeek", Client: DeepSeekClient, model: "deepseek-v4-flash" },
  { provider: "Qwen", Client: QwenClient, model: "qwen3.7-max", streaming: true }
];

function controlReason(code = "DIRECTOR_RUN_TERMINATED") {
  return Object.assign(new Error(code === "DIRECTOR_STAGE_PAUSED" ? "当前阶段已暂停" : "本次 Run 已终止"), { code });
}

function complete(response, spec) {
  response.setHeader("content-type", spec.streaming ? "text/event-stream" : "application/json");
  response.end(spec.streaming
    ? sseChunks({ content: CONTENT, usage: USAGE })
    : JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: CONTENT } }], usage: USAGE }));
}

async function fixture(t, handler) {
  let calls = 0;
  const requested = Promise.withResolvers();
  const disconnected = Promise.withResolvers();
  const server = createServer((request, response) => {
    calls += 1;
    request.resume();
    response.once("close", () => disconnected.resolve());
    handler(request, response);
    requested.resolve();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    requested: requested.promise,
    disconnected: disconnected.promise,
    calls: () => calls
  };
}

function clientFor(spec, baseUrl, overrides = {}) {
  // Longer than each cancellation test's deadline: waiting for the ordinary
  // provider timeout and merely relabelling its error must never pass.
  return new spec.Client({ baseUrl, model: spec.model, requestTimeoutMs: 60_000, jsonRetryAttempts: 2, ...overrides });
}

function start(client, context, operation = () => client.generateJson({ prompt: "Local cancellation fixture", strictJson: true })) {
  return runWithUsageAccounting(() => runWithDurableTaskContext(context, operation));
}

test("MiMo: enabled animation logging preserves streamed heartbeats and immediate cancellation", { timeout: 5_000 }, async (t) => {
  const attempts = [];
  const capture = new AnimationPromptCapture({ modelOutputLogWriter: {
    enabled: true,
    async recordAttempt(value) { attempts.push(value); return value; },
    async finalizeAttempt(ref, value) { Object.assign(ref, value); }
  } });
  t.mock.method(globalThis, "fetch", capture.wrapFetch(globalThis.fetch));
  const server = await fixture(t, (_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(sseChunks({ content: CONTENT, usage: USAGE, finishReason: null }).replace("data: [DONE]\n\n", ""));
  });
  const controller = new AbortController();
  const reason = controlReason("DIRECTOR_STAGE_PAUSED");
  await assert.rejects(() => capture.run({ provider: "MiMo" }, () => start(clientFor(CLIENTS[0], server.baseUrl), {
    signal: controller.signal,
    heartbeat: () => controller.abort(reason)
  })), error => {
    assert.equal(error, reason);
    assert.equal(readModelUsageFromError(error).totalTokens, 138);
    return true;
  });
  await server.disconnected;
  assert.equal(server.calls(), 1);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].validationStatus, "failed");
});

for (const spec of CLIENTS) {
  test(`${spec.provider}: terminating while waiting for headers closes HTTP and makes no retry`, { timeout: 5_000 }, async (t) => {
    const server = await fixture(t, () => {});
    const controller = new AbortController();
    const reason = controlReason();
    let dispatched = 0;
    const operation = start(clientFor(spec, server.baseUrl), {
      signal: controller.signal,
      providerRequestStarted: () => { dispatched += 1; }
    });
    const rejection = assert.rejects(operation, (error) => {
      assert.equal(error, reason);
      assert.equal(readModelUsageFromError(error), null);
      return true;
    });
    await server.requested;
    controller.abort(reason);
    await rejection;
    await server.disconnected;
    assert.equal(server.calls(), 1);
    assert.equal(dispatched, 1);
  });

  test(`${spec.provider}: pause aborts an active response body with its original reason`, { timeout: 5_000 }, async (t) => {
    const readStarted = Promise.withResolvers();
    const server = await fixture(t, (_request, response) => {
      response.writeHead(200, { "content-type": spec.streaming ? "text/event-stream" : "application/json" });
      response.write(spec.streaming ? sseChunks({ content: "partial" }).split("\n\n")[0] + "\n\n" : '{"choices":[');
    });
    const controller = new AbortController();
    const reason = controlReason("DIRECTOR_STAGE_PAUSED");
    const operation = start(clientFor(spec, server.baseUrl), {
      signal: controller.signal,
      heartbeat: () => readStarted.resolve(),
      afterProviderCall: () => { throw new Error("late ownership conflict"); }
    });
    const rejection = assert.rejects(operation, (error) => error === reason);
    await server.requested;
    // A streaming client's heartbeat proves the client consumed an SSE chunk before cancellation.
    if (spec.streaming) await readStarted.promise;
    else await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort(reason);
    await rejection;
    await server.disconnected;
    assert.equal(server.calls(), 1);
  });

  test(`${spec.provider}: a pre-aborted task makes zero requests`, async (t) => {
    const server = await fixture(t, (_request, response) => complete(response, spec));
    const controller = new AbortController();
    const reason = controlReason();
    controller.abort(reason);
    await assert.rejects(start(clientFor(spec, server.baseUrl), { signal: controller.signal }), (error) => error === reason);
    assert.equal(server.calls(), 0);
  });

  test(`${spec.provider}: cancellation after the async guard but before fetch records zero dispatches`, async (t) => {
    const server = await fixture(t, (_request, response) => complete(response, spec));
    const controller = new AbortController();
    const reason = controlReason("DIRECTOR_STAGE_PAUSED");
    let guards = 0;
    let dispatched = 0;
    await assert.rejects(start(clientFor(spec, server.baseUrl), {
      signal: controller.signal,
      beforeProviderCall() {
        guards += 1;
        // Abort after beforeDurableProviderCall's final guard has resumed,
        // but before requestCompletion resumes to construct fetch's signal.
        queueMicrotask(() => queueMicrotask(() => controller.abort(reason)));
      },
      providerRequestStarted: () => { dispatched += 1; }
    }), (error) => {
      assert.equal(error, reason);
      assert.equal(readModelUsageFromError(error), null);
      return true;
    });
    assert.equal(guards, 1);
    assert.equal(dispatched, 0);
    assert.equal(server.calls(), 0);
  });

  test(`${spec.provider}: task cancellation is isolated from another concurrent task`, { timeout: 5_000 }, async (t) => {
    const pending = new Map();
    const bothRequested = Promise.withResolvers();
    const server = await fixture(t, (request, response) => {
      pending.set(request.url.split("/")[1], response);
      if (pending.size === 2) bothRequested.resolve();
    });
    const cancelled = new AbortController();
    const unaffected = new AbortController();
    const reason = controlReason();
    const first = start(clientFor(spec, `${server.baseUrl}/first`), { signal: cancelled.signal });
    const rejection = assert.rejects(first, (error) => error === reason);
    const second = start(clientFor(spec, `${server.baseUrl}/second`), { signal: unaffected.signal });
    await bothRequested.promise;
    cancelled.abort(reason);
    complete(pending.get("second"), spec);
    await rejection;
    const result = await second;
    assert.deepEqual(result.result, { ok: true });
    assert.equal(result.usage.calls, 1);
    assert.equal(result.usage.totalTokens, 138);
    assert.equal(unaffected.signal.aborted, false);
    assert.equal(server.calls(), 2);
  });

  test(`${spec.provider}: ordinary header timeouts retain their transport classification`, { timeout: 5_000 }, async (t) => {
    const server = await fixture(t, () => {});
    const controller = new AbortController();
    // 流式客户端等响应头也按空闲超时判；非流式客户端仍是总超时。
    const timeouts = spec.streaming ? { streamIdleTimeoutMs: 60 } : { requestTimeoutMs: 60 };
    await assert.rejects(start(clientFor(spec, server.baseUrl, timeouts), { signal: controller.signal }), (error) => {
      assert.equal(error.name, "TimeoutError");
      assert.equal(classifyAttemptError(error).code, "MODEL_TIMEOUT");
      assert.equal(classifyAttemptError(error).retryable, true);
      return true;
    });
    assert.equal(controller.signal.aborted, false);
    assert.equal(server.calls(), 1);
  });

  test(`${spec.provider}: completed usage survives cancellation during the post-provider guard`, async (t) => {
    const server = await fixture(t, (_request, response) => complete(response, spec));
    const controller = new AbortController();
    const reason = controlReason();
    await assert.rejects(start(clientFor(spec, server.baseUrl), {
      signal: controller.signal,
      afterProviderCall() {
        controller.abort(reason);
        throw new Error("owner released");
      }
    }), (error) => {
      assert.equal(error, reason);
      const usage = readModelUsageFromError(error);
      assert.equal(usage.calls, 1);
      assert.equal(usage.totalTokens, 138);
      return true;
    });
  });
}

for (const spec of CLIENTS.filter((item) => item.streaming)) {
  test(`${spec.provider}: usage received before a user abort is accounted once and never becomes a completion`, { timeout: 5_000 }, async (t) => {
    const controller = new AbortController();
    const reason = controlReason();
    const server = await fixture(t, (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      // Send real, structured provider usage without ending the HTTP response.
      response.write(sseChunks({ content: CONTENT, usage: USAGE }));
    });
    await assert.rejects(start(clientFor(spec, server.baseUrl), {
      signal: controller.signal,
      heartbeat: () => controller.abort(reason)
    }), (error) => {
      assert.equal(error, reason);
      assert.equal(readModelUsageFromError(error).calls, 1);
      assert.equal(readModelUsageFromError(error).totalTokens, 138);
      return true;
    });
    await server.disconnected;
    assert.equal(server.calls(), 1);
  });

  for (const interrupted of ["disconnect", "incomplete EOF"]) {
    test(`${spec.provider}: provider ${interrupted} retains received usage and its existing error classification`, { timeout: 5_000 }, async (t) => {
      let responseToInterrupt;
      const server = await fixture(t, (_request, response) => {
        responseToInterrupt = response;
        response.writeHead(200, { "content-type": "text/event-stream" });
        // Keep the helper's valid usage event but omit both completion markers.
        response.write(sseChunks({ content: "partial", usage: USAGE, finishReason: null }).replace("data: [DONE]\n\n", ""));
      });
      await assert.rejects(start(clientFor(spec, server.baseUrl), {
        heartbeat() {
          if (interrupted === "disconnect") responseToInterrupt.destroy();
          else responseToInterrupt.end();
        }
      }), (error) => {
        assert.equal(error.code, interrupted === "disconnect" ? "MODEL_STREAM_ABORTED" : "MODEL_STREAM_INCOMPLETE");
        assert.equal(classifyAttemptError(error).retryable, true);
        assert.equal(readModelUsageFromError(error).calls, 1);
        assert.equal(readModelUsageFromError(error).totalTokens, 138);
        return true;
      });
      assert.equal(server.calls(), 1);
    });
  }

  test(`${spec.provider}: a stream that goes silent mid-body fails as a retryable idle timeout`, { timeout: 5_000 }, async (t) => {
    const server = await fixture(t, (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(sseChunks({ content: "partial" }).split("\n\n")[0] + "\n\n");
    });
    const controller = new AbortController();
    await assert.rejects(start(clientFor(spec, server.baseUrl, { streamIdleTimeoutMs: 60 }), { signal: controller.signal }), (error) => {
      assert.equal(error.code, "MODEL_STREAM_IDLE_TIMEOUT");
      assert.match(error.message, /连续 \d+ 秒没有收到任何数据.*7 字正文、1 个数据块/u);
      const issue = classifyAttemptError(error);
      assert.equal(issue.category, "transport");
      assert.equal(issue.retryable, true);
      return true;
    });
    assert.equal(controller.signal.aborted, false);
  });

  test(`${spec.provider}: a stream that keeps sending data is never cut by a total deadline`, { timeout: 5_000 }, async (t) => {
    // 总时长远超空闲超时与 requestTimeoutMs，但每个间隔都短于空闲超时：必须完整读完。
    // 只发推理内容也算「有数据」——2026-09-22 MiMo 就是推理期被总超时掐断的。
    const server = await fixture(t, (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      let sent = 0;
      const timer = setInterval(() => {
        sent += 1;
        if (sent <= 8) {
          response.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "想" } }] })}\n\n`);
          return;
        }
        clearInterval(timer);
        response.end(sseChunks({ content: CONTENT, usage: USAGE }));
      }, 40);
    });
    const client = clientFor(spec, server.baseUrl, { streamIdleTimeoutMs: 150, requestTimeoutMs: 100 });
    const { result } = await start(client, {});
    assert.deepEqual(result, { ok: true });
    assert.equal(server.calls(), 1);
  });

  test(`${spec.provider}: coordinator preserves a cancelled stream reason and does not automatically retry`, { timeout: 5_000 }, async (t) => {
    const controller = new AbortController();
    const reason = controlReason();
    const server = await fixture(t, (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(sseChunks({ content: "partial" }).split("\n\n")[0] + "\n\n");
    });
    const client = clientFor(spec, server.baseUrl);
    await assert.rejects(start(client, {
      signal: controller.signal,
      heartbeat: () => controller.abort(reason)
    }, () => new ModelCallCoordinator().runJson({
      client, request: { prompt: "fixture", model: spec.model }, provider: spec.provider, stage: "fixture", validate: (value) => value
    })), (error) => error === reason);
    assert.equal(server.calls(), 1);
  });
}

for (const spec of CLIENTS) {
  test(`${spec.provider}: output cut at the token limit is reported as truncation, not as invalid JSON`, { timeout: 5_000 }, async (t) => {
    // 2026-09-23 MiMo 候选阶段：16384 额度全部用在推理上、正文 0 字、finish_reason=length，
    // 却被报成「未返回严格 JSON」。截断必须在解析 JSON 之前判定。
    const usage = { prompt_tokens: 12965, completion_tokens: 16384, total_tokens: 29349 };
    const server = await fixture(t, (_request, response) => {
      response.setHeader("content-type", spec.streaming ? "text/event-stream" : "application/json");
      response.end(spec.streaming
        ? sseChunks({ reasoningContent: "推理", content: "", finishReason: "length", usage })
        : JSON.stringify({ choices: [{ finish_reason: "length", message: { content: "" } }], usage }));
    });
    await assert.rejects(start(clientFor(spec, server.baseUrl), {}, () => (
      clientFor(spec, server.baseUrl).generateJson({ prompt: "fixture", strictJson: true, jsonRetryAttempts: 0 })
    )), (error) => {
      assert.equal(error.code, "MODEL_OUTPUT_TRUNCATED");
      assert.doesNotMatch(error.message, /严格 JSON/u);
      assert.match(error.message, /正文一个字都没写出来.*16384 token/u);
      const issue = classifyAttemptError(error);
      assert.equal(issue.category, "truncation");
      assert.equal(issue.code, "MODEL_OUTPUT_TRUNCATED");
      return true;
    });
    assert.equal(server.calls(), 1);
  });
}

for (const spec of CLIENTS) {
  test(`${spec.provider}: a content-filter block is reported as such and never retried as a JSON error`, { timeout: 5_000 }, async (t) => {
    const usage = { prompt_tokens: 11790, completion_tokens: 10535, total_tokens: 22325 };
    const refusal = "The request was rejected because it was considered high risk";
    const server = await fixture(t, (_request, response) => {
      response.setHeader("content-type", spec.streaming ? "text/event-stream" : "application/json");
      response.end(spec.streaming
        ? sseChunks({ reasoningContent: "推理", content: refusal, finishReason: "content_filter", usage })
        : JSON.stringify({ choices: [{ finish_reason: "content_filter", message: { content: refusal } }], usage }));
    });
    // jsonRetryAttempts 保持 2：审核拦截不得进入 JSON 内容重试循环。
    await assert.rejects(start(clientFor(spec, server.baseUrl), {}, () => (
      clientFor(spec, server.baseUrl).generateJson({ prompt: "fixture", jsonRetryAttempts: 2 })
    )), (error) => {
      assert.equal(error.code, "MODEL_CONTENT_FILTERED");
      assert.doesNotMatch(error.message, /JSON/u);
      assert.match(error.message, /内容审核拦截了这次输出/u);
      const issue = classifyAttemptError(error);
      assert.equal(issue.category, "content-filter");
      assert.equal(issue.retryable, false);
      return true;
    });
    assert.equal(server.calls(), 1);
  });
}
