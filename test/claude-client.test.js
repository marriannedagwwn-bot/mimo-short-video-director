import test from "node:test";
import assert from "node:assert/strict";
import { getConfig, resolveDefaultLlmProvider } from "../src/config.js";
import {
  CLAUDE_MODELS,
  CLAUDE_THINKING_OFF,
  ClaudeClient,
  buildClaudeRequestBody,
  claudeThinkingOffProblem,
  normalizeClaudeStopReason,
  unwrapWholeCodeFence
} from "../src/claude-client.js";
import { ModelResponseError } from "../src/mimo-client.js";
import { ModelCallCoordinator, classifyAttemptError } from "../src/model-call-coordinator.js";
import { describeProviderError } from "../src/provider-error-codes.js";
import { describeServerProviderError } from "../src/server-error.js";
import { SYSTEM_PROMPT } from "../src/prompts.js";
import { WorkflowService } from "../src/workflow.js";
import { CLAUDE_OUTPUT_TOKEN_CEILING } from "../src/output-token-ceilings.js";
import { anthropicErrorResponse, anthropicSseResponse } from "./helpers/anthropic-sse-response.js";

// Claude（Anthropic）纯文本客户端（2026-10-19）。走官方 SDK，流式、只判空闲；SDK 自带重试关掉；
// stop_reason 只统一截断与审核两个值；思考按型号映射，关不掉的型号在发请求前报错。

const CLAUDE_ENV_KEYS = [
  "CLAUDE_API_KEY",
  "CLAUDE_API_BASE_URL",
  "CLAUDE_API_MODEL",
  "CLAUDE_API_MAX_COMPLETION_TOKENS",
  "CLAUDE_API_EFFORT",
  "CLAUDE_API_JSON_RETRY_ATTEMPTS",
  "CLAUDE_API_STREAM_IDLE_TIMEOUT_MS",
  // Claude Code 会给它启动的进程导出这几个；本工作流一个都不能读。
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_EFFORT",
  "DEFAULT_LLM_PROVIDER"
];

function withEnvironment(values, callback) {
  const previous = Object.fromEntries(CLAUDE_ENV_KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of CLAUDE_ENV_KEYS) delete process.env[key];
    Object.assign(process.env, values);
    return callback();
  } finally {
    for (const key of CLAUDE_ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

function clientConfig(overrides = {}) {
  return {
    baseUrl: "https://claude.invalid",
    apiKey: "fixture-key",
    model: "claude-opus-5-5",
    maxCompletionTokens: 16_384,
    jsonRetryAttempts: 2,
    streamIdleTimeoutMs: 60_000,
    ...overrides
  };
}

function mockFetch(t, respond) {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    const request = {
      url: String(url),
      headers: Object.fromEntries(new Headers(init.headers)),
      body: init.body ? JSON.parse(init.body) : null
    };
    requests.push(request);
    return respond(request, requests.length);
  });
  return requests;
}

test("配置：默认不启用；只读 CLAUDE_API_*，不读 Claude Code 会导出的 ANTHROPIC_* / CLAUDE_EFFORT", () => {
  withEnvironment({
    ANTHROPIC_API_KEY: "should-not-be-used",
    ANTHROPIC_BASE_URL: "https://claude-code-proxy.invalid",
    CLAUDE_EFFORT: "xhigh"
  }, () => {
    const config = getConfig().claude;
    assert.equal(config.enabled, false);
    assert.equal(config.apiKey, "");
    assert.equal(config.baseUrl, "https://api.anthropic.com");
    assert.equal(config.model, "claude-sonnet-5-5", "默认型号按《鲸鱼风筝》对比定为 Sonnet 5.5");
    assert.equal(config.maxCompletionTokens, CLAUDE_OUTPUT_TOKEN_CEILING);
    assert.equal(config.effort, "");
    assert.equal(config.jsonRetryAttempts, 2);
    assert.equal(config.streamIdleTimeoutMs, 120_000);
  });
  withEnvironment({
    CLAUDE_API_KEY: " configured-key ",
    CLAUDE_API_BASE_URL: "https://gateway.invalid",
    CLAUDE_API_MODEL: "claude-sonnet-5-5",
    CLAUDE_API_MAX_COMPLETION_TOKENS: "999999",
    CLAUDE_API_EFFORT: "high",
    CLAUDE_API_STREAM_IDLE_TIMEOUT_MS: "45000"
  }, () => {
    const config = getConfig().claude;
    assert.equal(config.enabled, true);
    assert.equal(config.apiKey, "configured-key");
    assert.equal(config.baseUrl, "https://gateway.invalid");
    assert.equal(config.model, "claude-sonnet-5-5");
    assert.equal(config.maxCompletionTokens, CLAUDE_OUTPUT_TOKEN_CEILING, "超过官方上限按上限夹住");
    assert.equal(config.effort, "high");
    assert.equal(config.streamIdleTimeoutMs, 45_000);
  });
});

test("配置了 Claude 也不改默认路由；Claude 不能当 DEFAULT_LLM_PROVIDER", () => {
  const base = { qwen: { enabled: false }, mimo: { enabled: true }, claude: { enabled: true } };
  assert.equal(resolveDefaultLlmProvider({ ...base, defaultLlmProvider: "" }), "MiMo");
  assert.equal(resolveDefaultLlmProvider({ ...base, qwen: { enabled: true }, defaultLlmProvider: "" }), "Qwen");
  assert.throws(
    () => resolveDefaultLlmProvider({ ...base, defaultLlmProvider: "Claude" }),
    /只能是 Qwen 或 MiMo.*Claude 在本工作流只接纯文本/u
  );
});

test("请求体：只有 model/max_tokens/system/messages/stream/thinking，没有 temperature、format、fallbacks、预填", () => {
  assert.equal(
    JSON.stringify(buildClaudeRequestBody(clientConfig(), { prompt: "p" })),
    JSON.stringify({
      model: "claude-opus-5-5",
      max_tokens: 16_384,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: "p" }],
      stream: true,
      thinking: { type: "adaptive", display: "summarized" }
    })
  );
  const custom = buildClaudeRequestBody(
    clientConfig({ effort: "low" }),
    { prompt: "p" },
    { model: "claude-haiku-5-5", maxCompletionTokens: 2048, systemPrompt: "只回 JSON" }
  );
  assert.equal(custom.model, "claude-haiku-5-5");
  assert.equal(custom.max_tokens, 2048);
  assert.equal(custom.system, "只回 JSON");
  assert.deepEqual(custom.output_config, { effort: "low" });
  // 不传上限时用官方的 128K。
  assert.equal(buildClaudeRequestBody({ model: "claude-opus-5-5" }, { prompt: "p" }).max_tokens, CLAUDE_OUTPUT_TOKEN_CEILING);
  for (const body of [custom, buildClaudeRequestBody(clientConfig(), { prompt: "p" })]) {
    for (const key of ["temperature", "top_p", "top_k", "fallbacks", "response_format"]) assert.equal(key in body, false, key);
    assert.equal(body.output_config?.format, undefined);
    assert.equal(body.messages.at(-1).role, "user", "不做 assistant 预填");
  }
});

test("结构化输出：只有拿到 claudeResponseSchema 才发 output_config.format；responseSchema 仍被忽略（2026-10-21）", async (t) => {
  const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };
  const withSchema = buildClaudeRequestBody(clientConfig(), { prompt: "p" }, { claudeResponseSchema: { name: "fixture", schema } });
  assert.deepEqual(withSchema.output_config, { format: { type: "json_schema", schema } });
  // 与 effort 并存，effort 照旧在 output_config 里。
  assert.deepEqual(
    buildClaudeRequestBody(clientConfig({ effort: "low" }), { prompt: "p" }, { claudeResponseSchema: { name: "fixture", schema } }).output_config,
    { effort: "low", format: { type: "json_schema", schema } }
  );
  // 给 MiMo 派生的 responseSchema 用了 Claude 不支持的关键字，照旧不发。
  const mimoOnly = buildClaudeRequestBody(clientConfig(), { prompt: "p" }, { responseSchema: { name: "fixture", schema } });
  assert.equal(JSON.stringify(mimoOnly), JSON.stringify(buildClaudeRequestBody(clientConfig(), { prompt: "p" })));
  assert.throws(() => buildClaudeRequestBody(clientConfig(), { prompt: "p" }, { claudeResponseSchema: { name: "fixture" } }), /claudeResponseSchema 必须是/u);

  // 经 coordinator 那条路（requestCompletion）真的发出去，generateJson 那条路也带着。
  const requests = mockFetch(t, () => anthropicSseResponse({ content: '{"ok":true}' }));
  const client = new ClaudeClient(clientConfig());
  await client.requestCompletion({ prompt: "p", claudeResponseSchema: { name: "fixture", schema } });
  assert.deepEqual(requests[0].body.output_config, { format: { type: "json_schema", schema } });
  assert.deepEqual(await client.generateJson({ prompt: "p", strictJson: true, claudeResponseSchema: { name: "fixture", schema } }), { ok: true });
  assert.deepEqual(requests[1].body.output_config, { format: { type: "json_schema", schema } });
  await client.requestCompletion({ prompt: "p" });
  assert.equal("output_config" in requests[2].body, false);
});

test("CLAUDE_API_EFFORT 只接受官方五档，写错在构造客户端时就报错", () => {
  for (const effort of ["low", "medium", "high", "xhigh", "max", "HIGH", ""]) new ClaudeClient(clientConfig({ effort }));
  assert.throws(() => new ClaudeClient(clientConfig({ effort: "extreme" })), /CLAUDE_API_EFFORT 只能是/u);
});

test("思考覆盖：enabled 发 adaptive；disabled 按型号映射，关不掉或没登记的型号一次请求都不发", async (t) => {
  assert.deepEqual(CLAUDE_MODELS, ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"]);
  const off = (model, effort = "") => buildClaudeRequestBody(clientConfig({ model, effort }), { prompt: "p" }, { thinking: "disabled" });
  assert.deepEqual(off("claude-sonnet-5-5").thinking, { type: "between_tools" });
  assert.deepEqual(off("claude-haiku-5-5").thinking, { type: "disabled" });
  assert.deepEqual(off("claude-sonnet-5-5", "high").thinking, { type: "between_tools" });
  assert.deepEqual(
    buildClaudeRequestBody(clientConfig(), { prompt: "p" }, { thinking: "enabled" }).thinking,
    { type: "adaptive", display: "summarized" }
  );
  for (const [model, effort, pattern] of [
    ["claude-opus-5-5", "", /不能关闭思考/u],
    ["claude-fable-5-1", "", /不能关闭思考/u],
    ["claude-sonnet-5-5", "xhigh", /effort 只能是 high 或更低/u],
    ["claude-haiku-5-5", "max", /effort 只能是 high 或更低/u],
    ["claude-opus-4-8", "", /没有登记能不能关闭思考/u]
  ]) {
    assert.match(claudeThinkingOffProblem(model, effort), pattern);
    assert.throws(() => off(model, effort), (error) => error instanceof ModelResponseError
      && error.code === "MODEL_THINKING_UNSUPPORTED" && error.provider === "Claude");
  }
  assert.equal(CLAUDE_THINKING_OFF["claude-opus-5-5"], null);

  const requests = mockFetch(t, () => anthropicSseResponse({ content: "{}" }));
  await assert.rejects(
    new ClaudeClient(clientConfig()).requestCompletion({ prompt: "p", thinking: "disabled" }),
    (error) => error.code === "MODEL_THINKING_UNSUPPORTED"
  );
  assert.equal(requests.length, 0, "关不掉思考时不发请求");
  // 不能被 coordinator 当成网络故障重试。
  assert.equal(classifyAttemptError(new ModelResponseError("x", "", 0, { code: "MODEL_THINKING_UNSUPPORTED" })).retryable, false);
  await new ClaudeClient(clientConfig({ model: "claude-sonnet-5-5" })).requestCompletion({ prompt: "p", thinking: "disabled" });
  assert.deepEqual(requests[0].body.thinking, { type: "between_tools" });
});

test("读流：正文与推理分开收集，usage 合并 message_start 与 message_delta，返回与其他客户端相同的字段", async (t) => {
  const requests = mockFetch(t, () => anthropicSseResponse({ content: '{"ok":true}', thinking: "先想一想", requestId: "req_abc" }));
  const completion = await new ClaudeClient(clientConfig()).requestCompletion({ prompt: "p" });
  assert.equal(completion.content, '{"ok":true}');
  assert.equal(completion.finishReason, "end_turn");
  assert.equal(completion.requestId, "req_abc");
  assert.equal(completion.providerName, "Claude");
  assert.equal(completion.model, "claude-opus-5-5");
  assert.deepEqual(completion.usage, { input_tokens: 101, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 37 });
  assert.match(completion.raw, /"type":"message_stop"/u);
  assert.equal(completion.raw.includes("先想一想"), true);
  assert.equal(completion.content.includes("先想一想"), false, "推理绝不混进正文");
  assert.equal(requests[0].url, "https://claude.invalid/v1/messages");
  assert.equal(requests[0].headers["x-api-key"], "fixture-key");
  assert.equal(requests[0].body.stream, true);
});

test("SDK 不读 shell 里的 ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN", async (t) => {
  const requests = mockFetch(t, () => anthropicSseResponse({ content: "{}" }));
  await withEnvironment({ ANTHROPIC_BASE_URL: "https://wrong.invalid", ANTHROPIC_AUTH_TOKEN: "leaked-token" }, () => (
    new ClaudeClient(clientConfig()).requestCompletion({ prompt: "p" })
  ));
  assert.equal(requests[0].url, "https://claude.invalid/v1/messages");
  assert.equal(requests[0].headers.authorization, undefined);
  assert.equal(requests[0].headers["x-api-key"], "fixture-key");
});

test("截断：max_tokens 与 model_context_window_exceeded 都统一成 length，走 MODEL_OUTPUT_TRUNCATED", async (t) => {
  assert.equal(normalizeClaudeStopReason("max_tokens"), "length");
  assert.equal(normalizeClaudeStopReason("model_context_window_exceeded"), "length");
  assert.equal(normalizeClaudeStopReason("refusal"), "content_filter");
  assert.equal(normalizeClaudeStopReason("end_turn"), "end_turn");
  mockFetch(t, () => anthropicSseResponse({ content: '{"a":', stopReason: "max_tokens", outputTokens: 512 }));
  await assert.rejects(
    new ClaudeClient(clientConfig()).generateJson({ prompt: "p", jsonRetryAttempts: 0 }),
    (error) => error.code === "MODEL_OUTPUT_TRUNCATED" && /本次输出 512 token/u.test(error.message)
  );
});

test("审核：refusal 统一成 content_filter，消息带拒绝类别与说明；coordinator 不重试", async (t) => {
  const requests = mockFetch(t, () => anthropicSseResponse({
    content: "",
    stopReason: "refusal",
    stopDetails: { type: "refusal", category: "cyber", explanation: "示例说明" }
  }));
  const client = new ClaudeClient(clientConfig());
  await assert.rejects(
    new ModelCallCoordinator().runJson({ client, request: { prompt: "p" }, provider: "Claude", stage: "fullStory", validate: (value) => value }),
    (error) => error.code === "MODEL_CONTENT_FILTERED" && error.retryable === false
      && /拒绝类别 cyber，说明：示例说明/u.test(error.message)
  );
  assert.equal(requests.length, 1, "审核拦截不自动重试");
});

test("HTTP 错误：SDK 不重试，转成 ModelResponseError 并能查到官方码表", async (t) => {
  const requests = mockFetch(t, () => anthropicErrorResponse(529, "overloaded_error", "Overloaded"));
  let caught;
  await assert.rejects(new ClaudeClient(clientConfig()).requestCompletion({ prompt: "p" }), (error) => {
    caught = error;
    return error instanceof ModelResponseError && error.code === "MODEL_HTTP_ERROR" && error.status === 529
      && error.provider === "Claude" && error.requestId === "req_error_fixture";
  });
  assert.equal(requests.length, 1, "SDK 自带的重试必须关掉，重试只归 coordinator 管");
  assert.equal(classifyAttemptError(caught).retryable, true);
  const described = describeServerProviderError(caught);
  assert.equal(described.code, "overloaded_error");
  assert.equal(described.title, "Anthropic API 暂时过载");
  assert.equal(described.docUrl, "https://platform.claude.com/docs/en/api/errors");

  const auth = describeProviderError({ provider: "anthropic", httpStatus: 401, payload: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } } });
  assert.equal(auth.provider, "Claude");
  assert.equal(auth.matchedBy, "code");
  assert.equal(auth.retryable, false);
  const htmlBody = describeProviderError({ provider: "Claude", httpStatus: 413, payload: "<html>Request Entity Too Large</html>" });
  assert.equal(htmlBody.matchedBy, "httpStatus");
  assert.match(htmlBody.guidance, /32 MB/u);
});

test("流途中的 error 事件按类型还原状态码，沿用 429/5xx 可重试", async (t) => {
  mockFetch(t, () => anthropicSseResponse({ content: '{"a":', errorEvent: { type: "overloaded_error", message: "Overloaded" } }));
  let caught;
  await assert.rejects(new ClaudeClient(clientConfig()).requestCompletion({ prompt: "p" }), (error) => {
    caught = error;
    return error.code === "MODEL_PROVIDER_STREAM_ERROR" && error.status === 529;
  });
  assert.equal(classifyAttemptError(caught).retryable, true);
  assert.equal(describeServerProviderError(caught).code, "overloaded_error");
});

test("没收到 message_stop 就是流不完整，绝不返回半截内容", async (t) => {
  mockFetch(t, () => anthropicSseResponse({ content: '{"a":', stop: false }));
  let caught;
  await assert.rejects(new ClaudeClient(clientConfig()).requestCompletion({ prompt: "p" }), (error) => {
    caught = error;
    return error.code === "MODEL_STREAM_INCOMPLETE";
  });
  assert.equal(classifyAttemptError(caught).category, "transport");
  assert.equal(classifyAttemptError(caught).retryable, true);
});

test("发请求前的网络失败还原成 fetch 的 TypeError，与另外三家同样归为可重试的传输错误", async (t) => {
  mockFetch(t, () => { throw new TypeError("fetch failed"); });
  let caught;
  await assert.rejects(new ClaudeClient(clientConfig()).requestCompletion({ prompt: "p" }), (error) => {
    caught = error;
    return error instanceof TypeError;
  });
  assert.equal(classifyAttemptError(caught).code, "MODEL_TRANSPORT_ERROR");
});

test("整段正文恰好被一对代码块包着时去掉包裹，严格解析与 coordinator 都能过；raw 保留原样", async (t) => {
  // 2026-10-19《鲸鱼风筝》对比：Haiku 把整份 JSON 包在 ```json … ``` 里，里面的 JSON 完整合法。
  for (const wrapped of [
    "```json\n{\"ok\":true}\n```",
    "```\n{\"ok\":true}\n```",
    "```JSON\r\n{\"ok\":true}\r\n```",
    "\n  ```json\n{\n \"ok\": true\n}\n```  \n"
  ]) {
    assert.deepEqual(unwrapWholeCodeFence(wrapped).unwrapped, true, JSON.stringify(wrapped));
    assert.deepEqual(JSON.parse(unwrapWholeCodeFence(wrapped).content), { ok: true });
  }
  const requests = mockFetch(t, () => anthropicSseResponse({ content: "```json\n{\"ok\":true}\n```" }));
  const client = new ClaudeClient(clientConfig());
  const completion = await client.requestCompletion({ prompt: "p" });
  assert.equal(completion.content, "{\"ok\":true}");
  assert.equal(completion.contentUnwrappedFromCodeFence, true);
  assert.match(completion.raw, /```json/u, "去掉包裹之前的正文在 raw 里照样查得到");
  assert.deepEqual(await client.generateJson({ prompt: "p", strictJson: true, jsonRetryAttempts: 0 }), { ok: true });
  const value = await new ModelCallCoordinator().runJson({ client, request: { prompt: "p" }, provider: "Claude", stage: "storyboardDesign", validate: (candidate) => candidate });
  assert.deepEqual(value, { ok: true });
  assert.equal(requests.length, 3, "去掉包裹不需要重试");
});

test("其余形状一律原样交回，照旧由严格解析判失败：前后有说明文字、两个代码块、没有收尾", async (t) => {
  const samples = [
    "下面是分镜：\n```json\n{\"ok\":true}\n```",
    "```json\n{\"ok\":true}\n```\n以上。",
    "```json\n{\"a\":1}\n```\n\n```json\n{\"b\":2}\n```",
    "```json\n{\"ok\":true}",
    "```python\n{\"ok\":true}\n```",
    "{\"ok\":true}"
  ];
  for (const text of samples) {
    const result = unwrapWholeCodeFence(text);
    assert.equal(result.unwrapped, false, JSON.stringify(text));
    assert.equal(result.content, text, "不改动原文");
  }
  mockFetch(t, () => anthropicSseResponse({ content: "下面是分镜：\n```json\n{\"ok\":true}\n```" }));
  const completion = await new ClaudeClient(clientConfig()).requestCompletion({ prompt: "p" });
  assert.equal("contentUnwrappedFromCodeFence" in completion, false);
  await assert.rejects(
    new ClaudeClient(clientConfig()).generateJson({ prompt: "p", strictJson: true, jsonRetryAttempts: 0 }),
    (error) => error instanceof ModelResponseError && /Claude 未返回严格 JSON/u.test(error.message)
  );
});

test("JSON：不合法时带纠偏提示重试一次，重试时只抬不降输出上限", async (t) => {
  const requests = mockFetch(t, (_request, index) => anthropicSseResponse({ content: index === 1 ? "不是 JSON" : '{"ok":true}' }));
  const value = await new ClaudeClient(clientConfig()).generateJson({ prompt: "p", maxCompletionTokens: 4096, jsonRetryAttempts: 1 });
  assert.deepEqual(value, { ok: true });
  assert.equal(requests.length, 2);
  assert.match(requests[1].body.messages[0].content, /上一次模型输出不是完整合法 JSON/u);
  assert.equal(requests[1].body.max_tokens, 6144);
});

test("纯文本：客户端与工作流在调用前双重拒绝媒体阶段", async () => {
  await assert.rejects(
    new ClaudeClient(clientConfig()).generateJsonWithMedia({ prompt: "看图", frames: [{ dataUrl: "data:image/jpeg;base64,AA==" }] }),
    (error) => error instanceof ModelResponseError && error.provider === "Claude" && error.code === "MODEL_MEDIA_UNSUPPORTED"
  );
  let providerCalls = 0;
  const workflow = new WorkflowService({
    clients: { Claude: { async generateJsonWithMedia() { providerCalls += 1; return {}; } } },
    stageDefaults: { analysis: { provider: "Claude", model: "claude-opus-5-5", maxCompletionTokens: 16_384 } }
  });
  const frames = Array.from({ length: 3 }, (_, index) => ({ timestamp: index, dataUrl: "data:image/jpeg;base64,AA==" }));
  await assert.rejects(workflow.analyze({ frames, metadata: {} }), /参考片分析需要图片或视频输入，Claude 在本工作流只允许用于纯文本阶段/u);
  assert.equal(providerCalls, 0);
});

test("工作流按阶段覆盖能路由到 Claude，claude / anthropic 都认", () => {
  const client = { generateJson() {} };
  const workflow = new WorkflowService({
    clients: { claude: client },
    stageDefaults: { fullStory: { provider: "MiMo", model: "mimo-v2.5-pro", maxCompletionTokens: 12_288 } }
  });
  for (const provider of ["Claude", "anthropic"]) {
    const resolved = workflow.resolveStage("fullStory", { modelOverrides: { fullStory: { provider, model: "claude-sonnet-5-5" } } });
    assert.equal(resolved.provider, "Claude");
    assert.equal(resolved.model, "claude-sonnet-5-5");
    assert.equal(resolved.client, client);
  }
});

test("健康检查只核对所选型号，不把 /v1/models 的全部型号交给页面", async (t) => {
  const requests = mockFetch(t, (request) => (request.url.endsWith("/v1/models/claude-opus-5-5")
    ? new Response(JSON.stringify({ id: "claude-opus-5-5", type: "model" }), { status: 200, headers: { "content-type": "application/json" } })
    : anthropicErrorResponse(404, "not_found_error", "model not found")));
  const client = new ClaudeClient(clientConfig());
  assert.deepEqual(await client.checkHealth(), { reachable: true, modelAvailable: true, status: 200, modelIds: [] });
  assert.deepEqual(await client.checkHealth("claude-nope"), { reachable: true, modelAvailable: false, status: 404, modelIds: [] });
  assert.equal(requests.length, 2, "健康检查不重试");
});
