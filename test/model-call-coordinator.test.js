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

test("Coordinator reports finish_reason=content_filter as a non-retryable moderation block, never as invalid JSON", async () => {
  // 2026-09-23：MiMo 审核拦截后正文是一句英文拒绝语，此前被当成 JSON 格式错误、
  // 按可重试处理——等于在第三方安全闸门上「问到放行为止」。
  let calls = 0;
  await assert.rejects(new ModelCallCoordinator().runJson({
    client: {
      async requestCompletion() {
        calls += 1;
        return completion("The request was rejected because it was considered high risk", {
          finishReason: "content_filter",
          usage: { completion_tokens: 10535, total_tokens: 22325 }
        });
      }
    },
    request: { prompt: "primary", model: "mimo-v2.6-pro" },
    provider: "MiMo",
    stage: "variants",
    maxProviderCalls: 2,
    validate: (value) => value
  }), (error) => {
    assert.ok(error instanceof ModelPipelineError);
    assert.equal(error.code, "MODEL_CONTENT_FILTERED");
    assert.equal(error.category, "content-filter");
    assert.equal(error.retryable, false);
    assert.match(error.message, /内容审核拦截了这次输出.*10535 token.*high risk.*系统不会自动重试/u);
    assert.doesNotMatch(error.message, /JSON/u);
    return true;
  });
  assert.equal(calls, 1);
});

// 2026-09-24：走 coordinator 的阶段（候选评审、承诺核对、自主分镜……）失败时，阶段日志里的
// diagnostics 恒为 []，每次都要离线重放才看得到被拦的原因。失败交给观测方的数据现在带上校验器的
// 结构化 details；写入器只留 code / jsonPointer / reason 并脱敏。
test("coordinator 被校验拦下时，阶段日志记下校验器的结构化诊断", async (t) => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { FullModelOutputLogWriter, MODEL_OUTPUT_LOG_SCOPES } = await import("../src/full-model-output-log.js");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "coordinator-diagnostics-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const writer = new FullModelOutputLogWriter({ scope: MODEL_OUTPUT_LOG_SCOPES.STORYBOARD_DESIGN, outputRoot: root });
  const details = [
    {
      code: "STORYBOARD_BEAT_SOURCE_OUT_OF_SHOT",
      path: "/shotPlan/2/beats/1/sourceSceneIds",
      reason: "beat 来源不属于本片段；本片段只允许 S2",
      keyword: "不应落盘的额外字段"
    }
  ];
  await assert.rejects(() => new ModelCallCoordinator().runJson({
    client: { async requestCompletion() { return completion("{\"ok\":false}"); } },
    request: { prompt: "PRIVATE_PROMPT", model: "storyboard-model" },
    provider: "MiMo",
    stage: "storyboardDesign",
    maxProviderCalls: 1,
    validate: () => { throw new OutputContractError("自主分镜校验失败", details); },
    attemptObserver: (attempt) => writer.recordAttempt(attempt)
  }));

  const files = [];
  const walk = async (dir) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name === "metadata.json") files.push(full);
    }
  };
  await walk(root);
  assert.equal(files.length, 1);
  const metadata = JSON.parse(await fs.readFile(files[0], "utf8"));
  assert.equal(metadata.attempt.status, "failed");
  assert.equal(metadata.attempt.code, "OUTPUT_CONTRACT_INVALID");
  assert.deepEqual(metadata.attempt.diagnostics, [{
    code: "STORYBOARD_BEAT_SOURCE_OUT_OF_SHOT",
    jsonPointer: "/shotPlan/2/beats/1/sourceSceneIds",
    reason: "beat 来源不属于本片段；本片段只允许 S2"
  }]);
  assert.doesNotMatch(JSON.stringify(metadata), /PRIVATE_PROMPT|不应落盘的额外字段/u);
});

test("coordinator 成功与传输失败时交给观测方的 diagnostics 都是空数组", async () => {
  const observed = [];
  let calls = 0;
  await new ModelCallCoordinator().runJson({
    client: {
      async requestCompletion() {
        calls += 1;
        if (calls === 1) throw Object.assign(new TypeError("fetch failed"), { code: "ECONNRESET" });
        return completion("{\"ok\":true}");
      }
    },
    request: { prompt: "primary" },
    maxProviderCalls: 2,
    validate: (candidate) => candidate,
    attemptObserver: (attempt) => observed.push(attempt)
  });
  assert.equal(observed.length, 2);
  assert.equal(observed[0].status, "failed");
  assert.deepEqual(observed[0].diagnostics, []);
  assert.equal(observed[1].status, "succeeded");
  assert.deepEqual(observed[1].diagnostics ?? [], []);
});
