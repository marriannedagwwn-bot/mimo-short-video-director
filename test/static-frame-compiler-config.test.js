import test from "node:test";
import assert from "node:assert/strict";
import { getConfig } from "../src/config.js";
import { MimoClient, ModelResponseError } from "../src/mimo-client.js";
import { QwenClient } from "../src/qwen-client.js";

const COMPILER_ENV_KEYS = [
  "STATIC_FRAME_COMPILER_PROVIDER",
  "STATIC_FRAME_COMPILER_MODEL",
  "STATIC_FRAME_COMPILER_MAX_COMPLETION_TOKENS",
  "STATIC_FRAME_COMPILER_TIMEOUT_MS",
  "QWEN_MODEL",
  "QWEN_ANIMATION_MODEL",
  "MIMO_MODEL",
  "MIMO_ANIMATION_MODEL"
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

test("Static Frame Compiler 配置默认独立且不回退 animationPlan 路由", () => {
  preserveEnvironment(COMPILER_ENV_KEYS, () => {
    process.env.QWEN_MODEL = "qwen-base-existing";
    process.env.QWEN_ANIMATION_MODEL = "qwen-animation-existing";
    process.env.MIMO_MODEL = "mimo-base-existing";
    process.env.MIMO_ANIMATION_MODEL = "mimo-animation-existing";

    const config = getConfig();

    assert.deepEqual(config.staticFrameCompiler, {
      provider: "",
      model: "",
      maxCompletionTokens: 4096,
      requestTimeoutMs: 300_000,
      configured: false
    });
  });
});

test("Static Frame Compiler 显式配置被规范化并保持独立模型参数", () => {
  preserveEnvironment(COMPILER_ENV_KEYS, () => {
    process.env.STATIC_FRAME_COMPILER_PROVIDER = " qWeN ";
    process.env.STATIC_FRAME_COMPILER_MODEL = " compiler-only-model ";
    process.env.STATIC_FRAME_COMPILER_MAX_COMPLETION_TOKENS = "8192";
    process.env.STATIC_FRAME_COMPILER_TIMEOUT_MS = "456789";
    process.env.QWEN_ANIMATION_MODEL = "animation-model-must-not-leak";

    const qwenConfig = getConfig();
    assert.deepEqual(qwenConfig.staticFrameCompiler, {
      provider: "Qwen",
      model: "compiler-only-model",
      maxCompletionTokens: 8192,
      requestTimeoutMs: 456_789,
      configured: true
    });

    process.env.STATIC_FRAME_COMPILER_PROVIDER = "MIMO";
    process.env.STATIC_FRAME_COMPILER_MODEL = "mimo-compiler-only";
    const mimoConfig = getConfig();
    assert.equal(mimoConfig.staticFrameCompiler.provider, "MiMo");
    assert.equal(mimoConfig.staticFrameCompiler.model, "mimo-compiler-only");
    assert.equal(mimoConfig.staticFrameCompiler.configured, true);
  });
});

test("Qwen 与 MiMo 显式禁用 JSON 内容重试，并使用单次请求的 timeout 覆盖", async () => {
  const originalFetch = globalThis.fetch;
  const originalTimeout = AbortSignal.timeout;
  const fetchCalls = [];
  const observedTimeouts = [];

  try {
    AbortSignal.timeout = (milliseconds) => {
      observedTimeouts.push(milliseconds);
      return new AbortController().signal;
    };
    globalThis.fetch = async (url, init) => {
      fetchCalls.push({ url: String(url), init });
      return new Response(JSON.stringify({
        choices: [{ message: { content: "```json\n{\"patches\":[]}\n```" } }]
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
    assert.deepEqual(observedTimeouts, [61_111, 72_222]);
  } finally {
    globalThis.fetch = originalFetch;
    AbortSignal.timeout = originalTimeout;
  }
});
