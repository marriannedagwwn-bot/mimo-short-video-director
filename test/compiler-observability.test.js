import test from "node:test";
import assert from "node:assert/strict";
import {
  ApiRequestError,
  createApiRequestError
} from "../public/compiler-observability.js";

// 编译器诊断面板（Static Frame / Character Feature Compiler）已于 2026-10-11 随编译器一并删除；
// ApiRequestError 对其余错误的行为不变：HTTP 状态、stage、category、metadata 照旧保留。
test("API error preserves HTTP status, stage, category and metadata", () => {
  const metadata = {
    storyboard: { providerCalls: 2, calls: [{ stage: "storyboardDesign", providerCalls: 2, rejections: [] }] }
  };
  const error = createApiRequestError({
    error: "自主分镜校验失败",
    stage: "animationPlan",
    category: "output-contract",
    metadata
  }, 502);

  assert.ok(error instanceof ApiRequestError);
  assert.equal(error.message, "自主分镜校验失败");
  assert.equal(error.status, 502);
  assert.equal(error.stage, "animationPlan");
  assert.equal(error.category, "output-contract");
  assert.equal(error.metadata, metadata);
});

test("generic API errors keep the existing short detail message behavior", () => {
  const error = createApiRequestError({
    error: "图片生成失败",
    detail: "上游暂时不可用"
  }, 502);

  assert.equal(error.message, "图片生成失败：上游暂时不可用");
  assert.equal(error.status, 502);
  assert.equal(error.stage, "");
  assert.equal(error.metadata, null);
});

test("API error 保留服务端已脱敏的稳定 diagnostics 供 Production manifest 落盘", () => {
  const details = [{
    code: "DIRECT_SHOT_SCENE_TIME_RANGE_INVALID",
    jsonPointer: "/sceneScript/1/timeRange",
    reason: "timeRange 无法解析"
  }];
  const error = createApiRequestError({
    error: "模型输出未通过校验",
    category: "output-contract",
    code: "OUTPUT_CONTRACT_INVALID",
    details
  }, 502);

  assert.equal(error.code, "OUTPUT_CONTRACT_INVALID");
  assert.equal(error.category, "output-contract");
  assert.equal(error.details, details);
});

// 2026-08-30：kimi-k3 被网关以 HTTP 400 拒绝，唯一说明白原因的那句
// 「Parameter 'temperature'=0.3 is not supported for kimi-k3 model.」
// 被展示层丢掉了——providerErrorText 只渲染 title 与 guidance，而 ModelResponseError
// 分支的响应体没有 detail 字段可回退，于是用户屏幕上只剩三句同义的「请求不合法」。
// 按状态码兜底命中时 guidance 只能给通用建议，原文是唯一可执行的信息。
test("按 httpStatus 兜底命中时仍然展示供应商原文", () => {
  const error = createApiRequestError({
    error: "Qwen 请求失败（400）",
    category: "provider",
    code: "MODEL_RESPONSE_ERROR",
    providerError: {
      provider: "Qwen",
      code: "",
      httpStatus: 400,
      matchedBy: "httpStatus",
      title: "请求不合法",
      guidance: "检查请求参数是否符合该供应商的接口要求。",
      retryable: false,
      providerMessage: "Parameter 'temperature'=0.3 is not supported for kimi-k3 model."
    }
  }, 502, "");
  assert.match(error.message, /请求不合法（Qwen HTTP 400）/u);
  assert.match(error.message, /供应商原文：Parameter 'temperature'=0\.3 is not supported for kimi-k3 model\./u);
});

test("没有供应商原文时文案不变，不留空的「供应商原文：」尾巴", () => {
  const error = createApiRequestError({
    error: "Qwen 请求失败（400）",
    providerError: {
      provider: "Qwen",
      httpStatus: 400,
      matchedBy: "httpStatus",
      title: "请求不合法",
      guidance: "检查请求参数是否符合该供应商的接口要求。",
      providerMessage: ""
    }
  }, 502, "");
  assert.doesNotMatch(error.message, /供应商原文/u);
  assert.match(error.message, /检查请求参数是否符合该供应商的接口要求。$/u);
});
