import test from "node:test";
import assert from "node:assert/strict";
import { MimoClient, buildRequestBody } from "../src/mimo-client.js";
import { QwenClient, buildQwenRequestBody } from "../src/qwen-client.js";
import { DeepSeekClient, buildDeepSeekRequestBody } from "../src/deepseek-client.js";
import { SYSTEM_PROMPT } from "../src/prompts.js";
import { sseResponse } from "./helpers/sse-response.js";

// 单次请求的 thinking 开关（2026-10-09）：只有导演助手会传，用来在全局开着思考时
// 让一条对话几秒出结果。不传时三家客户端的请求体必须与改动前逐字节相同——
// 下面三份金标准是在改动前的代码上算出来的，键的顺序也锁住。

const system = { role: "system", content: SYSTEM_PROMPT };

test("不传 thinking：三家客户端的请求体与改动前逐字节相同", () => {
  assert.equal(
    JSON.stringify(buildRequestBody({ model: "mimo-v2.6-pro", thinking: "enabled", jsonMode: true, maxCompletionTokens: 131072 }, { prompt: "p" })),
    JSON.stringify({
      model: "mimo-v2.6-pro", max_completion_tokens: 131072, temperature: 0.3, top_p: 0.95, stream: true,
      thinking: { type: "enabled" },
      messages: [system, { role: "user", content: [{ type: "text", text: "p" }] }],
      response_format: { type: "json_object" }
    })
  );
  assert.equal(
    JSON.stringify(buildRequestBody({ model: "mimo-v2.6-pro", jsonMode: true }, { prompt: "p" })),
    JSON.stringify({
      model: "mimo-v2.6-pro", max_completion_tokens: 8192, temperature: 0.3, top_p: 0.95, stream: true,
      thinking: { type: "disabled" },
      messages: [system, { role: "user", content: [{ type: "text", text: "p\n/no_think" }] }],
      response_format: { type: "json_object" }
    })
  );
  assert.equal(
    JSON.stringify(buildQwenRequestBody({ model: "qwen3.7-max", enableThinking: true, jsonMode: true, maxCompletionTokens: 65536 }, { prompt: "p" })),
    JSON.stringify({
      model: "qwen3.7-max", max_tokens: 65536, temperature: 0.3, top_p: 0.95, stream: true,
      stream_options: { include_usage: true },
      messages: [system, { role: "user", content: "p" }],
      enable_thinking: true,
      response_format: { type: "json_object" }
    })
  );
  assert.equal(
    JSON.stringify(buildQwenRequestBody({ model: "qwen3.7-max", jsonMode: true }, { prompt: "p" })),
    JSON.stringify({
      model: "qwen3.7-max", max_tokens: 12288, temperature: 0.3, top_p: 0.95, stream: true,
      stream_options: { include_usage: true },
      messages: [system, { role: "user", content: "p" }],
      response_format: { type: "json_object" }
    })
  );
  assert.equal(
    JSON.stringify(buildQwenRequestBody({ model: "ZHIPU/GLM-5.3", jsonMode: true }, { prompt: "p" })),
    JSON.stringify({
      model: "ZHIPU/GLM-5.3", max_tokens: 12288, temperature: 0.3, top_p: 0.95, stream: true,
      stream_options: { include_usage: true },
      messages: [system, { role: "user", content: "p" }],
      enable_thinking: true,
      reasoning_effort: "low"
    })
  );
  assert.equal(
    JSON.stringify(buildDeepSeekRequestBody({ model: "deepseek-v4-flash", thinking: "enabled", jsonMode: true }, { prompt: "p" })),
    JSON.stringify({
      model: "deepseek-v4-flash", max_tokens: 16384, temperature: 1, top_p: 1, stream: false,
      thinking: { type: "enabled" },
      messages: [system, { role: "user", content: "p" }],
      response_format: { type: "json_object" }
    })
  );
});

test("MiMo：全局开着思考时单次关闭，只改 thinking 与提示词末尾的 /no_think，其余逐字不变", () => {
  const config = { model: "mimo-v2.6-pro", thinking: "enabled", jsonMode: true, maxCompletionTokens: 131072 };
  const base = buildRequestBody(config, { prompt: "p" });
  const off = buildRequestBody(config, { prompt: "p" }, { thinking: "disabled" });
  assert.deepEqual(off.thinking, { type: "disabled" });
  assert.equal(off.messages[1].content.at(-1).text, "p\n/no_think");
  assert.deepEqual({ ...off, thinking: base.thinking, messages: base.messages }, base);
  // 反方向：全局关着时单次打开。
  const on = buildRequestBody({ ...config, thinking: "disabled" }, { prompt: "p" }, { thinking: "enabled" });
  assert.deepEqual(on.thinking, { type: "enabled" });
  assert.equal(on.messages[1].content.at(-1).text, "p");
});

test("千问：单次关闭写 enable_thinking:false；GLM-5.3 关不掉思考时明确报错，不静默忽略", () => {
  const off = buildQwenRequestBody({ model: "qwen3.7-max", enableThinking: true, jsonMode: true }, { prompt: "p" }, { thinking: "disabled" });
  assert.equal(off.enable_thinking, false);
  const offWithoutGlobal = buildQwenRequestBody({ model: "qwen3.7-max", jsonMode: true }, { prompt: "p" }, { thinking: "disabled" });
  assert.equal(offWithoutGlobal.enable_thinking, false);
  const on = buildQwenRequestBody({ model: "qwen3.7-max", enableThinking: false, jsonMode: true }, { prompt: "p" }, { thinking: "enabled" });
  assert.equal(on.enable_thinking, true);
  assert.throws(
    () => buildQwenRequestBody({ model: "ZHIPU/GLM-5.3", jsonMode: true }, { prompt: "p" }, { thinking: "disabled" }),
    /不能关闭思考/u
  );
  const glmOn = buildQwenRequestBody({ model: "ZHIPU/GLM-5.3", jsonMode: true }, { prompt: "p" }, { thinking: "enabled" });
  assert.deepEqual(glmOn, buildQwenRequestBody({ model: "ZHIPU/GLM-5.3", jsonMode: true }, { prompt: "p" }));
});

test("DeepSeek：单次关闭只改 thinking.type", () => {
  const config = { model: "deepseek-v4-flash", thinking: "enabled", jsonMode: true };
  const base = buildDeepSeekRequestBody(config, { prompt: "p" });
  const off = buildDeepSeekRequestBody(config, { prompt: "p" }, { thinking: "disabled" });
  assert.deepEqual(off, { ...base, thinking: { type: "disabled" } });
});

test("thinking 只接受 enabled / disabled，别的值直接报错", () => {
  for (const build of [
    () => buildRequestBody({ model: "m" }, { prompt: "p" }, { thinking: "off" }),
    () => buildQwenRequestBody({ model: "qwen3.7-max" }, { prompt: "p" }, { thinking: false }),
    () => buildDeepSeekRequestBody({ model: "deepseek-v4-flash" }, { prompt: "p" }, { thinking: "none" })
  ]) assert.throws(build, TypeError);
});

test("requestCompletion 把 thinking 一路传进请求体（协调器走的就是这条路）", async (t) => {
  const bodies = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const body = JSON.parse(options.body);
    bodies.push(body);
    if (body.stream) return sseResponse({ content: '{"a":"x"}' });
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"a":"x"}' }, finish_reason: "stop" }] }), { status: 200 });
  });
  await new MimoClient({ baseUrl: "https://mimo.invalid/v1", model: "mimo-v2.6-pro", thinking: "enabled", jsonMode: true })
    .requestCompletion({ prompt: "p", thinking: "disabled" });
  await new QwenClient({ baseUrl: "https://qwen.invalid/v1", apiKey: "k", model: "qwen3.7-max", enableThinking: true, jsonMode: true })
    .requestCompletion({ prompt: "p", thinking: "disabled" });
  await new DeepSeekClient({ baseUrl: "https://deepseek.invalid", apiKey: "k", model: "deepseek-v4-flash", thinking: "enabled", jsonMode: true })
    .requestCompletion({ prompt: "p", thinking: "disabled" });
  assert.equal(bodies.length, 3);
  assert.deepEqual(bodies[0].thinking, { type: "disabled" });
  assert.equal(bodies[1].enable_thinking, false);
  assert.deepEqual(bodies[2].thinking, { type: "disabled" });
});
