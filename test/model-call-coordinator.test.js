import test from "node:test";
import assert from "node:assert/strict";
import { AttemptStore } from "../src/attempt-store.js";
import { ModelCallCoordinator } from "../src/model-call-coordinator.js";
import { ModelPipelineError } from "../src/model-errors.js";
import { ModelResponseError } from "../src/mimo-client.js";
import { mockFullStory } from "../src/mock.js";
import { ensureOutputContract, OutputContractError } from "../src/validation.js";

test("Coordinator handles finish_reason=length before parsing and retries once", async () => {
  let calls = 0;
  const prompts = [];
  const coordinator = new ModelCallCoordinator();
  const result = await coordinator.runJson({
    client: {
      async requestCompletion(request) {
        calls += 1;
        prompts.push(request.prompt);
        return calls === 1
          ? completion("not valid JSON", { finishReason: "length" })
          : completion("{\"ok\":true}");
      }
    },
    request: { prompt: "primary", model: "story-model", maxCompletionTokens: 1000 },
    provider: "MiMo",
    stage: "fullStory",
    validate: (value) => value,
    retryPrompt: ({ issue }) => `retry:${issue.code}`
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 2);
  assert.deepEqual(prompts, ["primary", "retry:MODEL_OUTPUT_TRUNCATED"]);
});

test("Coordinator retries invalid envelopes and transient HTTP errors but not permanent HTTP errors", async (t) => {
  await t.test("invalid envelope", async () => {
    let calls = 0;
    const result = await new ModelCallCoordinator().runJson({
      client: {
        async requestCompletion() {
          calls += 1;
          if (calls === 1) {
            throw new ModelResponseError("invalid envelope", "raw-envelope", 0, {
              code: "MODEL_ENVELOPE_INVALID",
              provider: "Qwen"
            });
          }
          return completion("{\"ok\":true}");
        }
      },
      request: { prompt: "primary" },
      provider: "Qwen",
      stage: "fullStory",
      validate: (value) => value
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(calls, 2);
  });

  await t.test("HTTP 503", async () => {
    let calls = 0;
    const result = await new ModelCallCoordinator().runJson({
      client: {
        async requestCompletion() {
          calls += 1;
          if (calls === 1) {
            throw new ModelResponseError("unavailable", "provider-503", 503, {
              code: "MODEL_HTTP_ERROR",
              provider: "MiMo"
            });
          }
          return completion("{\"ok\":true}");
        }
      },
      request: { prompt: "primary" },
      provider: "MiMo",
      stage: "fullStory",
      validate: (value) => value
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(calls, 2);
  });

  await t.test("HTTP 400", async () => {
    let calls = 0;
    await assert.rejects(
      () => new ModelCallCoordinator().runJson({
        client: {
          async requestCompletion() {
            calls += 1;
            throw new ModelResponseError("bad request", "provider-400", 400, {
              code: "MODEL_HTTP_ERROR",
              provider: "MiMo"
            });
          }
        },
        request: { prompt: "primary" },
        provider: "MiMo",
        stage: "fullStory",
        validate: (value) => value
      }),
      (error) => error instanceof ModelPipelineError
        && error.category === "provider"
        && error.attempts.length === 1
    );
    assert.equal(calls, 1);
  });
});

test("Coordinator performs one controlled schema retry and never a third provider call", async () => {
  const valid = mockFullStory({
    creatorProfile: {
      fixedCharacter: "阿岚，社区修理师",
      vertical: "社区维修"
    },
    variant: {
      id: "V1",
      characterSetup: {
        careRecipient: "铃木奶奶",
        helper: "夜班便利店员"
      }
    }
  });
  const invalid = structuredClone(valid);
  invalid.title = null;
  let calls = 0;
  let retryIssue = null;
  const result = await new ModelCallCoordinator().runJson({
    client: {
      async requestCompletion() {
        calls += 1;
        if (calls > 2) throw new Error("third call is forbidden");
        return completion(JSON.stringify(calls === 1 ? invalid : valid));
      }
    },
    request: { prompt: "primary" },
    provider: "MiMo",
    stage: "fullStory",
    validate: (value) => ensureOutputContract(value, "fullStory"),
    retryPrompt: ({ issue }) => {
      retryIssue = issue;
      return "schema retry";
    }
  });

  assert.equal(result.title, valid.title);
  assert.equal(calls, 2);
  assert.equal(retryIssue.category, "schema");
  assert.equal(retryIssue.code, "FULL_STORY_SCHEMA_INVALID");
});

test("Coordinator final error exposes only attempt references while raw outputs remain in the bounded store", async () => {
  const store = new AttemptStore();
  let calls = 0;
  let caught;
  try {
    await new ModelCallCoordinator({ attemptStore: store }).runJson({
      client: {
        async requestCompletion() {
          calls += 1;
          return completion(`secret-provider-output-${calls}`);
        }
      },
      request: { prompt: "primary" },
      provider: "MiMo",
      stage: "fullStory",
      validate: (value) => value,
      retryPrompt: () => "retry"
    });
  } catch (error) {
    caught = error;
  }

  assert.ok(caught instanceof ModelPipelineError);
  assert.equal(calls, 2);
  assert.equal(caught.attempts.length, 2);
  assert.ok(caught.attempts.every((attempt) => attempt.rawOutputRef));
  assert.doesNotMatch(JSON.stringify(caught), /secret-provider-output/u);
  assert.match(store.getRawOutput(caught.attempts[0].rawOutputRef), /secret-provider-output-1/u);
});

test("Coordinator compatibility adapter disables nested client JSON retries", async () => {
  const requests = [];
  const result = await new ModelCallCoordinator().runJson({
    client: {
      async generateJson(request) {
        requests.push(request);
        return { ok: true };
      }
    },
    request: { prompt: "primary" },
    provider: "test-double",
    stage: "fullStory",
    validate: (value) => value
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].jsonRetryAttempts, 0);
  assert.equal(requests[0].strictJson, true);
});

test("Coordinator 等待异步 validate 完成后才构造并发送纠错请求", async () => {
  const events = [];
  let calls = 0;
  const result = await new ModelCallCoordinator().runJson({
    client: {
      async requestCompletion(request) {
        calls += 1;
        events.push(`provider:${request.prompt}`);
        return completion(JSON.stringify({ ok: calls === 2 }));
      }
    },
    request: { prompt: "primary" },
    provider: "test-double",
    stage: "animationFoundation",
    validate: async (candidate) => {
      events.push(`validate:${candidate.ok}`);
      await Promise.resolve();
      if (!candidate.ok) {
        events.push("debug-written");
        throw new OutputContractError("需要局部纠错");
      }
      return candidate;
    },
    retryPrompt: () => {
      assert.equal(events.at(-1), "debug-written");
      events.push("retry-prompt");
      return "repair";
    }
  });

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(events, [
    "provider:primary",
    "validate:false",
    "debug-written",
    "retry-prompt",
    "provider:repair",
    "validate:true"
  ]);
});

test("Coordinator attempt observer 收到每次完整模型 content，且区分 provider requestId", async () => {
  let calls = 0;
  const observed = [];
  const result = await new ModelCallCoordinator().runJson({
    client: {
      async requestCompletion() {
        calls += 1;
        return completion(JSON.stringify({ ok: calls === 2, text: `完整输出-${calls}` }), {
          requestId: `provider-${calls}`
        });
      }
    },
    request: { prompt: "PRIVATE_PROMPT", model: "story-model" },
    provider: "Qwen",
    stage: "fullStory",
    validate: (candidate) => {
      if (!candidate.ok) throw new OutputContractError("首轮语义错误");
      return candidate;
    },
    retryPrompt: () => "retry",
    attemptObserver: (attempt) => observed.push(attempt)
  });

  assert.equal(result.ok, true);
  assert.equal(observed.length, 2);
  assert.deepEqual(observed.map((item) => item.status), ["failed", "succeeded"]);
  assert.deepEqual(observed.map((item) => item.providerRequestId), ["provider-1", "provider-2"]);
  assert.match(observed[0].content, /完整输出-1/u);
  assert.match(observed[1].content, /完整输出-2/u);
  assert.doesNotMatch(JSON.stringify(observed), /PRIVATE_PROMPT/u);
});

test("attempt observer 写入失败不会改变业务结果或增加模型调用", async () => {
  let calls = 0;
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const result = await new ModelCallCoordinator().runJson({
      client: {
        async requestCompletion() {
          calls += 1;
          return completion("{\"ok\":true}");
        }
      },
      request: { prompt: "primary" },
      validate: (candidate) => candidate,
      attemptObserver: async () => {
        throw new Error("disk unavailable");
      }
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(calls, 1);
  } finally {
    console.warn = originalWarn;
  }
});

function completion(content, {
  finishReason = "stop",
  requestId = "req-1",
  usage = { total_tokens: 10 }
} = {}) {
  return {
    content,
    finishReason,
    requestId,
    usage,
    raw: JSON.stringify({ content, finishReason, requestId, usage })
  };
}
