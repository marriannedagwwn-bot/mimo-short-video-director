import test from "node:test";
import assert from "node:assert/strict";
import { getConfig } from "../src/config.js";
import { DeepSeekClient, buildDeepSeekRequestBody } from "../src/deepseek-client.js";
import { ModelResponseError } from "../src/mimo-client.js";
import { SYSTEM_PROMPT } from "../src/prompts.js";
import { WorkflowService } from "../src/workflow.js";

const DEEPSEEK_ENV_KEYS = [
  "DEEPSEEK_BASE_URL",
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_MODEL",
  "DEEPSEEK_MAX_COMPLETION_TOKENS",
  "DEEPSEEK_JSON_RETRY_ATTEMPTS",
  "DEEPSEEK_REQUEST_TIMEOUT_MS",
  "DEEPSEEK_THINKING",
  "DEEPSEEK_TEMPERATURE",
  "DEEPSEEK_TOP_P",
  "DEEPSEEK_JSON_MODE"
];

function preserveEnvironment(keys, callback) {
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    return callback();
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

function clientConfig(overrides = {}) {
  return {
    baseUrl: "https://api.deepseek.invalid",
    apiKey: "test-key",
    model: "deepseek-v4-flash",
    maxCompletionTokens: 16_384,
    requestTimeoutMs: 900_000,
    jsonRetryAttempts: 2,
    thinking: "disabled",
    temperature: 1,
    topP: 1,
    jsonMode: true,
    ...overrides
  };
}

test("DeepSeek 默认使用 V4 Flash，配置后保持纯文本请求参数", () => {
  preserveEnvironment(DEEPSEEK_ENV_KEYS, () => {
    const defaults = getConfig().deepseek;
    assert.equal(defaults.baseUrl, "https://api.deepseek.com");
    assert.equal(defaults.model, "deepseek-v4-flash");
    assert.equal(defaults.enabled, false);
    assert.equal(defaults.thinking, "disabled");
    assert.equal(defaults.jsonMode, true);

    process.env.DEEPSEEK_API_KEY = "configured-key";
    process.env.DEEPSEEK_MODEL = "deepseek-v4-pro";
    process.env.DEEPSEEK_MAX_COMPLETION_TOKENS = "24000";
    process.env.DEEPSEEK_REQUEST_TIMEOUT_MS = "345678";
    process.env.DEEPSEEK_THINKING = "enabled";
    process.env.DEEPSEEK_TEMPERATURE = "0.8";
    process.env.DEEPSEEK_TOP_P = "0.9";
    process.env.DEEPSEEK_JSON_MODE = "false";
    const configured = getConfig().deepseek;
    assert.equal(configured.enabled, true);
    assert.equal(configured.model, "deepseek-v4-pro");
    assert.equal(configured.maxCompletionTokens, 24_000);
    assert.equal(configured.requestTimeoutMs, 345_678);
    assert.equal(configured.thinking, "enabled");
    assert.equal(configured.temperature, 0.8);
    assert.equal(configured.topP, 0.9);
    assert.equal(configured.jsonMode, false);
  });
});

test("DeepSeek Chat Completions 请求只发送文本并启用 JSON Output", () => {
  const body = buildDeepSeekRequestBody(
    clientConfig(),
    { prompt: "生成完整剧情 JSON" },
    { model: "deepseek-v4-pro", maxCompletionTokens: 22_000 }
  );
  assert.equal(body.model, "deepseek-v4-pro");
  assert.equal(body.max_tokens, 22_000);
  assert.equal(body.temperature, 1);
  assert.equal(body.top_p, 1);
  assert.equal(body.stream, false);
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.equal(body.messages[0].content, SYSTEM_PROMPT);
  assert.deepEqual(body.messages[1], { role: "user", content: "生成完整剧情 JSON" });
});

test("DeepSeek 空 JSON 输出只按配置进行一次明确重试", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({
      id: `deepseek-request-${calls}`,
      choices: [{
        finish_reason: "stop",
        message: { content: calls === 1 ? "" : "{\"ok\":true}" }
      }],
      usage: { total_tokens: 12 }
    }), { status: 200 });
  };
  try {
    const result = await new DeepSeekClient(clientConfig({ jsonRetryAttempts: 1 })).generateJson({
      prompt: "只返回 JSON"
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("DeepSeek 客户端和工作流在 provider 调用前双重拒绝媒体阶段", async () => {
  const client = new DeepSeekClient(clientConfig());
  await assert.rejects(
    client.generateJsonWithMedia({ prompt: "分析图片", frames: [{ dataUrl: "data:image/jpeg;base64,AA==" }] }),
    (error) => error instanceof ModelResponseError
      && error.provider === "DeepSeek"
      && error.code === "MODEL_MEDIA_UNSUPPORTED"
  );

  let providerCalls = 0;
  const workflow = new WorkflowService({
    clients: {
      DeepSeek: {
        async generateJsonWithMedia() {
          providerCalls += 1;
          return {};
        }
      }
    },
    stageDefaults: {
      analysis: { provider: "DeepSeek", model: "deepseek-v4-flash", maxCompletionTokens: 16_384 }
    }
  });
  const frames = Array.from({ length: 3 }, (_, index) => ({
    timestamp: index,
    dataUrl: "data:image/jpeg;base64,AA=="
  }));
  await assert.rejects(
    workflow.analyze({ frames, metadata: {} }),
    /参考片分析需要图片或视频输入，DeepSeek-V4 仅允许用于纯文本阶段/u
  );
  assert.equal(providerCalls, 0);
});

test("工作流可将 DeepSeek 和深度求索别名路由到纯文本客户端", () => {
  const client = { generateJson() {} };
  const workflow = new WorkflowService({
    clients: { deepseek: client },
    stageDefaults: {
      fullStory: { provider: "MiMo", model: "mimo-v2.5-pro", maxCompletionTokens: 12_288 }
    }
  });
  const resolved = workflow.resolveStage("fullStory", {
    modelOverrides: {
      fullStory: { provider: "深度求索", model: "deepseek-v4-flash", maxCompletionTokens: 20_000 }
    }
  });
  assert.equal(resolved.provider, "DeepSeek");
  assert.equal(resolved.model, "deepseek-v4-flash");
  assert.equal(resolved.maxCompletionTokens, 20_000);
  assert.equal(resolved.client, client);
});

test("DeepSeek 健康检查返回可供模型设置 UI 使用的模型目录", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    object: "list",
    data: [
      { id: "deepseek-v4-flash", object: "model" },
      { id: "deepseek-v4-pro", object: "model" }
    ]
  }), { status: 200 });
  try {
    const health = await new DeepSeekClient(clientConfig()).checkHealth("deepseek-v4-pro");
    assert.equal(health.reachable, true);
    assert.equal(health.modelAvailable, true);
    assert.deepEqual(health.modelIds, ["deepseek-v4-flash", "deepseek-v4-pro"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
