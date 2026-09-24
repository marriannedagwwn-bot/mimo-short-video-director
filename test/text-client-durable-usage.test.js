import test from "node:test";
import assert from "node:assert/strict";
import { MimoClient } from "../src/mimo-client.js";
import { DeepSeekClient } from "../src/deepseek-client.js";
import { QwenClient } from "../src/qwen-client.js";
import { runWithDurableTaskContext } from "../src/durable-task-context.js";
import { readModelUsageFromError, runWithUsageAccounting } from "../src/token-usage.js";
import { sseResponse } from "./helpers/sse-response.js";

const USAGE = { prompt_tokens: 101, completion_tokens: 37, total_tokens: 138 };
const CONTENT = '{"ok":true}';

function jsonResponse() {
  return new Response(JSON.stringify({
    id: "fixture-completion",
    choices: [{ finish_reason: "stop", message: { content: CONTENT } }],
    usage: USAGE
  }), { status: 200 });
}

const CLIENTS = [
  { provider: "Qwen", Client: QwenClient, model: "qwen3.7-max", streaming: true, response: () => sseResponse({ content: CONTENT, usage: USAGE }) },
  { provider: "MiMo", Client: MimoClient, model: "mimo-v2.5", streaming: true, response: () => sseResponse({ content: CONTENT, usage: USAGE }) },
  { provider: "DeepSeek", Client: DeepSeekClient, model: "deepseek-v4-flash", response: jsonResponse }
];

function conflictError() {
  return Object.assign(new Error("Frozen dependency changed"), { code: "TASK_FROZEN_CONTEXT_CONFLICT" });
}

function harness(t, spec, { beforeError, afterError, response = spec.response } = {}) {
  const events = [];
  t.mock.method(globalThis, "fetch", async () => {
    events.push("fetch");
    return response();
  });
  const client = new spec.Client({
    baseUrl: "https://text-provider.invalid/v1",
    apiKey: "fixture-key",
    model: spec.model,
    requestTimeoutMs: 1_000,
    jsonRetryAttempts: 2
  });
  const context = {
    async beforeProviderCall() {
      events.push("before");
      if (beforeError) throw beforeError;
    },
    async afterProviderCall() {
      events.push("after");
      if (afterError) throw afterError;
    }
  };
  return {
    events,
    invoke: () => runWithUsageAccounting(() => runWithDurableTaskContext(context, () => client.generateJson({
      prompt: "Return fixture JSON",
      strictJson: true,
      jsonRetryAttempts: 0,
      onCompletion: () => { events.push("completion"); }
    })))
  };
}

function assertSingleUsage(usage, spec) {
  assert.deepEqual(usage, {
    calls: 1,
    promptTokens: 101,
    completionTokens: 37,
    totalTokens: 138,
    costCny: null,
    costKnown: false,
    byModel: [{
      provider: spec.provider,
      model: spec.model,
      calls: 1,
      promptTokens: 101,
      completionTokens: 37,
      totalTokens: 138,
      costCny: null
    }]
  });
}

for (const spec of CLIENTS) {
  test(`${spec.provider}: a conflict before the provider makes zero calls and records no usage`, async (t) => {
    const conflict = conflictError();
    const run = harness(t, spec, { beforeError: conflict });
    await assert.rejects(run.invoke(), (error) => {
      assert.equal(error, conflict);
      assert.equal(readModelUsageFromError(error), null);
      return true;
    });
    assert.deepEqual(run.events, ["before"]);
  });

  test(`${spec.provider}: a conflict after a completed response retains its usage and original error`, async (t) => {
    const conflict = conflictError();
    const run = harness(t, spec, { afterError: conflict });
    await assert.rejects(run.invoke(), (error) => {
      assert.equal(error, conflict);
      assertSingleUsage(readModelUsageFromError(error), spec);
      return true;
    });
    assert.deepEqual(run.events, ["before", "fetch", "after"]);
  });

  test(`${spec.provider}: a successful response records usage once and completes only after the guard`, async (t) => {
    const run = harness(t, spec);
    const { result, usage } = await run.invoke();
    assert.deepEqual(result, { ok: true });
    assertSingleUsage(usage, spec);
    assert.deepEqual(run.events, ["before", "fetch", "after", "completion"]);
  });

  const errorResponses = [
    {
      name: "HTTP error",
      response: () => new Response(JSON.stringify({ error: "rejected", usage: USAGE }), { status: 400 }),
      assertError: (error) => {
        assert.equal(error.code, "MODEL_HTTP_ERROR");
        assert.equal(error.status, 400);
      }
    },
    {
      name: spec.streaming ? "incomplete SSE" : "malformed envelope",
      response: () => new Response("broken response", { status: 200 }),
      assertError: (error) => assert.equal(error.code, spec.streaming ? "MODEL_STREAM_INCOMPLETE" : "MODEL_ENVELOPE_INVALID")
    }
  ];
  if (!spec.streaming) {
    errorResponses.push({
      name: "null envelope",
      response: () => new Response("null", { status: 200 }),
      assertError: (error) => assert.ok(error instanceof TypeError)
    });
  }

  for (const fixture of errorResponses) {
    for (const guardConflicts of [false, true]) {
      test(`${spec.provider}: ${fixture.name} still checks the frozen context${guardConflicts ? " and preserves conflict precedence" : " before the provider error"}`, async (t) => {
        const conflict = guardConflicts ? conflictError() : null;
        const run = harness(t, spec, { response: fixture.response, afterError: conflict });
        await assert.rejects(run.invoke(), (error) => {
          if (conflict) assert.equal(error, conflict);
          else fixture.assertError(error);
          assert.equal(readModelUsageFromError(error), null);
          return true;
        });
        assert.deepEqual(run.events, ["before", "fetch", "after"]);
      });
    }
  }
}
