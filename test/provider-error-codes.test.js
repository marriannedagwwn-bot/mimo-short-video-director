import test from "node:test";
import assert from "node:assert/strict";
import {
  describeProviderError,
  extractProviderErrorSignal,
  normalizeProviderName,
  providerErrorDisplayText
} from "../src/provider-error-codes.js";
import { serializeServerError } from "../src/server-error.js";
import { ShotVideoProviderError } from "../src/shot-video-generator.js";
import { ModelResponseError } from "../src/mimo-client.js";

// worker 把 HTTP 失败拼成 `HTTP 402 Payment Required: {json}`，
// 文本客户端直接给原始 body。两种形状都必须能取到码。
test("从带传输前缀的字符串和裸 JSON 里都能取出错误码", () => {
  const withPrefix = extractProviderErrorSignal(
    'HTTP 402 Payment Required: {"type":"error","error":{"type":"insufficient_balance_error",'
    + '"message":"insufficient balance (1008)","http_code":"402"},"request_id":"06da3523"}'
  );
  assert.equal(withPrefix.code, "insufficient_balance_error");
  // v2 把内部数字码塞在消息尾巴的括号里，也要一并取出来。
  assert.equal(withPrefix.embeddedCode, "1008");
  assert.equal(withPrefix.requestId, "06da3523");
  assert.equal(withPrefix.httpStatus, 402);

  const bare = extractProviderErrorSignal('{"code":"AccountOverdueError","message":"overdue"}');
  assert.equal(bare.code, "AccountOverdueError");

  // MiniMax 旧接口的 base_resp 形状。
  const baseResp = extractProviderErrorSignal('{"base_resp":{"status_code":1008,"status_msg":"balance"}}');
  assert.equal(baseResp.code, "1008");

  // 认不出来时返回全空，绝不编造。
  assert.equal(extractProviderErrorSignal("完全不是 JSON").code, "");
  assert.equal(extractProviderErrorSignal(null).code, "");
});

test("各供应商的官方错误码翻译成可执行提示", () => {
  const cases = [
    ["MiniMax", 'HTTP 402 : {"error":{"type":"insufficient_balance_error","message":"insufficient balance (1008)"}}', "账户余额不足", false],
    ["MiniMax", 'HTTP 429 : {"error":{"type":"rate_limit_error","message":"rate limit (1002)"}}', "请求频率超限", true],
    ["MiniMax", '{"base_resp":{"status_code":1004,"status_msg":"x"}}', "鉴权失败：Token 不匹配", false],
    ["Seedance", 'HTTP 403 : {"error":{"code":"AccountOverdueError"}}', "火山引擎账号欠费", false],
    ["Seedance", 'HTTP 429 : {"error":{"code":"ServerOverloaded"}}', "火山方舟服务资源紧张", true],
    ["Jimeng", 'HTTP 400 : {"error":{"code":"InvalidParameter"}}', "请求包含非法参数", false],
    ["Kling", 'HTTP 429 : {"code":1101,"message":"arrears"}', "可灵账户欠费", false],
    ["Kling", 'HTTP 429 : {"code":1303}', "并发或 QPS 超限", true],
    ["Qwen", '{"code":"InvalidApiKey"}', "API Key 填写错误", false],
    ["Qwen", '{"error":{"code":"Throttling.RateQuota"}}', "调用频率超限（RPM/TPM）", true]
  ];
  for (const [provider, payload, title, retryable] of cases) {
    const described = describeProviderError({ provider, payload });
    assert.ok(described, `${provider} ${payload} 应该能匹配到官方码`);
    assert.equal(described.title, title);
    assert.equal(described.retryable, retryable, `${title} 的可重试性必须跟随官方文档`);
    assert.ok(described.guidance, "每条提示都必须给出下一步动作");
    assert.ok(described.docUrl.startsWith("https://"), "必须能回溯到官方文档");
  }
});

test("没有专属码时按 HTTP 状态兜底，标签如实标明依据", () => {
  // DeepSeek 官方就是按 HTTP 状态定义错误的。
  const deepseek = describeProviderError({
    provider: "DeepSeek",
    httpStatus: 402,
    payload: '{"error":{"message":"Insufficient Balance","code":"invalid_request_error"}}'
  });
  assert.equal(deepseek.title, "DeepSeek 账户余额不足");
  assert.equal(deepseek.matchedBy, "httpStatus");
  // 命中依据是状态码，就不能把响应体里那个无关的 code 显示成来源。
  assert.match(providerErrorDisplayText(deepseek), /DeepSeek HTTP 402/u);
  assert.doesNotMatch(providerErrorDisplayText(deepseek), /invalid_request_error/u);

  // MiMo 未公开独立码表，走 OpenAI 兼容兜底。
  const mimo = describeProviderError({ provider: "MiMo", httpStatus: 401, payload: "{}" });
  assert.equal(mimo.title, "鉴权失败");
  assert.equal(mimo.matchedBy, "httpStatus");
});

test("匹配不到就返回 null，不许编一句安慰话", () => {
  // 未知的错误类型 + 未知的 HTTP 状态。
  assert.equal(describeProviderError({
    provider: "MiniMax",
    payload: 'HTTP 418 : {"error":{"type":"teapot_error"}}'
  }), null);
  // 完全不是 JSON、也没有 HTTP 前缀。
  assert.equal(describeProviderError({ provider: "Seedance", payload: "连接被重置" }), null);
  // 供应商都认不出来。
  assert.equal(describeProviderError({ provider: "某个没接过的厂商", httpStatus: 402, payload: "{}" }), null);
  assert.equal(providerErrorDisplayText(null), "");
});

test("供应商别名归一，未知名字不猜", () => {
  assert.equal(normalizeProviderName("minimax"), "MiniMax");
  assert.equal(normalizeProviderName("MiniMax-H3"), "MiniMax");
  assert.equal(normalizeProviderName("ark"), "Seedance");
  assert.equal(normalizeProviderName("可灵"), "Kling");
  assert.equal(normalizeProviderName("dashscope"), "Qwen");
  assert.equal(normalizeProviderName("  "), "");
  assert.equal(normalizeProviderName("openai"), "");
});

test("视频错误出口带上 providerError，且供应商原文逐字保留在 detail 里", () => {
  const raw = 'HTTP 402 Payment Required: {"type":"error","error":{"type":"insufficient_balance_error",'
    + '"message":"insufficient balance (1008)","http_code":"402"},"request_id":"06da3523"}';
  const error = new ShotVideoProviderError(raw);
  error.provider = "MiniMax";

  const { status, body } = serializeServerError(error);

  assert.equal(status, 502);
  assert.equal(body.error, "视频生成服务调用失败");
  // 只增不减：原文一个字都不能少。
  assert.equal(body.detail, raw);
  assert.equal(body.providerError.title, "账户余额不足");
  assert.equal(body.providerError.provider, "MiniMax");
  assert.equal(body.providerError.requestId, "06da3523");
  // 402 按官方文档不可重试。
  assert.equal(body.retryable, false);
});

test("认不出供应商时视频出口维持既有行为，不产出解释", () => {
  const error = new ShotVideoProviderError("HTTP 500 : 供应商挂了");
  const { body } = serializeServerError(error);
  assert.equal(body.providerError, null);
  assert.equal(body.detail, "HTTP 500 : 供应商挂了");
  assert.equal(body.retryable, false);
});

test("文本模型错误出口按 provider 元数据查表", () => {
  const error = new ModelResponseError(
    "Qwen 请求失败（429）",
    '{"code":"Throttling.RateQuota","message":"rate limit"}',
    429,
    { provider: "Qwen", code: "MODEL_HTTP_ERROR" }
  );
  const { body } = serializeServerError(error);
  assert.equal(body.providerError.title, "调用频率超限（RPM/TPM）");
  // 官方把限流列为可重试，retryable 必须跟着文档走。
  assert.equal(body.retryable, true);
  assert.equal(body.error, "Qwen 请求失败（429）");
});
