import test from "node:test";
import assert from "node:assert/strict";
import { MimoClient, buildRequestBody } from "../src/mimo-client.js";
import { QwenClient } from "../src/qwen-client.js";
import { DeepSeekClient } from "../src/deepseek-client.js";
import { sseResponse } from "./helpers/sse-response.js";

// 2026-09-24：MiMo 文档外支持 json_schema 约束解码，实测可用。只在调用方给了 Schema 时发送，
// MIMO_JSON_SCHEMA=false 可关；千问与 DeepSeek 不变。见 docs/variants-mimo-format-2026-09-24.md。

const config = { baseUrl: "https://mimo.invalid/v1", model: "mimo-v2.6-pro", requestTimeoutMs: 1000, jsonRetryAttempts: 0, mediaMode: "auto", jsonMode: true };
const responseSchema = Object.freeze({
  name: "probe",
  schema: { type: "object", additionalProperties: false, required: ["a"], properties: { a: { type: "string" } } }
});

test("给了 Schema 且开关未关时发 json_schema + strict；开关关掉或没给 Schema 时照旧 json_object", () => {
  const withSchema = buildRequestBody(config, { prompt: "p" }, { responseSchema });
  assert.deepEqual(withSchema.response_format, {
    type: "json_schema",
    json_schema: { name: "probe", schema: responseSchema.schema, strict: true }
  });
  const switchedOff = buildRequestBody({ ...config, jsonSchema: false }, { prompt: "p" }, { responseSchema });
  assert.deepEqual(switchedOff.response_format, { type: "json_object" });
  const noSchema = buildRequestBody(config, { prompt: "p" });
  assert.deepEqual(noSchema.response_format, { type: "json_object" });
  const noJsonMode = buildRequestBody({ ...config, jsonMode: false }, { prompt: "p" });
  assert.equal(Object.hasOwn(noJsonMode, "response_format"), false);
});

test("Schema 形状不对时直接报错，不静默退回 json_object", () => {
  assert.throws(() => buildRequestBody(config, { prompt: "p" }, { responseSchema: { name: "", schema: {} } }), TypeError);
  assert.throws(() => buildRequestBody(config, { prompt: "p" }, { responseSchema: { name: "x" } }), TypeError);
});

test("generateJson 把 responseSchema 一路传到请求体", async (t) => {
  let body;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    body = JSON.parse(options.body);
    return sseResponse({ content: '{"a":"x"}' });
  });
  const result = await new MimoClient(config).generateJson({ prompt: "p", strictJson: true, responseSchema });
  assert.deepEqual(result, { a: "x" });
  assert.equal(body.response_format.type, "json_schema");
  assert.equal(body.response_format.json_schema.strict, true);
  assert.equal(body.stream, true);
});

test("接口拒绝 Schema 时如实报错，只发一次请求", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests += 1;
    return new Response(JSON.stringify({ error: { message: "Invalid request parameters" } }), { status: 400 });
  });
  await assert.rejects(() => new MimoClient(config).generateJson({ prompt: "p", strictJson: true, responseSchema }));
  assert.equal(requests, 1);
});

test("千问与 DeepSeek 收到 responseSchema 时忽略它，照旧发 json_object", async (t) => {
  const bodies = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const body = JSON.parse(options.body);
    bodies.push(body);
    if (body.stream) return sseResponse({ content: '{"a":"x"}' });
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"a":"x"}' }, finish_reason: "stop" }] }), { status: 200 });
  });
  await new QwenClient({ baseUrl: "https://qwen.invalid/v1", apiKey: "k", model: "qwen3.7-max", jsonMode: true, maxCompletionTokens: 1000 })
    .generateJson({ prompt: "返回 json", strictJson: true, responseSchema });
  await new DeepSeekClient({ baseUrl: "https://deepseek.invalid", apiKey: "k", model: "deepseek-v4-flash", jsonMode: true, maxCompletionTokens: 1000 })
    .generateJson({ prompt: "返回 json", strictJson: true, responseSchema });
  assert.equal(bodies.length, 2);
  for (const body of bodies) {
    assert.deepEqual(body.response_format, { type: "json_object" });
    assert.equal(JSON.stringify(body).includes("json_schema"), false);
  }
});
