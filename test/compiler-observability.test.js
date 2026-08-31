import test from "node:test";
import assert from "node:assert/strict";
import {
  ApiRequestError,
  collectCompilerDiagnostics,
  compilerFailureStage,
  createApiRequestError,
  renderCompilerFailureDetails
} from "../public/compiler-observability.js";

test("API error preserves HTTP and compiler observability fields", () => {
  const metadata = {
    diagnostics: [{
      errorCode: "NO_STATIC_EVIDENCE_IN_SOURCE",
      targetId: "compile-target-0"
    }]
  };
  const error = createApiRequestError({
    error: "静态帧编译失败",
    detail: "不应拼接的原始响应",
    stage: "staticFrameCompiler",
    category: "candidate",
    metadata
  }, 502);

  assert.ok(error instanceof ApiRequestError);
  assert.equal(error.message, "静态帧编译失败");
  assert.equal(error.status, 502);
  assert.equal(error.stage, "staticFrameCompiler");
  assert.equal(error.category, "candidate");
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

test("compiler stage is inferred from Character Feature error names", () => {
  assert.equal(compilerFailureStage({
    name: "CharacterFeatureCompilerProtocolError"
  }), "characterFeatureCompiler");
  assert.equal(compilerFailureStage({
    name: "StaticFrameCompilerCandidateError"
  }), "staticFrameCompiler");
  assert.equal(compilerFailureStage({ name: "Error" }), "");
});

test("diagnostic projection retains approved fields without traversing sensitive payloads", () => {
  const diagnostics = collectCompilerDiagnostics({
    protocolAttempts: [{
      repairMode: "evidence_reselection",
      diagnostics: [{
        errorCode: "EVIDENCE_SELECTION_INCOMPLETE",
        targetId: "compile-target-1",
        patchIndex: 0,
        path: "shotPlan[0].endFrame.characters[0].pose",
        field: "pose",
        requiredDimensionCount: 2,
        availableDimensions: ["limbs", "body"],
        detectedDimensions: ["limbs"],
        recognizedFeatures: [{
          featureId: "character-wolf.wolf_tail",
          matchedSpanId: "span-run-4",
          hasStaticState: false,
          sourcePath: "secret.source.path",
          raw: "原始尾巴文本"
        }],
        unselectedCandidateEvidence: [{
          segmentId: "seg-run-8",
          spanId: "span-run-9",
          sourcePath: "secret.source.path",
          start: 1,
          end: 10
        }],
        prompt: "secret prompt",
        apiKey: "secret key"
      }]
    }],
    rawResponse: {
      errorCode: "MUST_NOT_BE_VISITED"
    }
  });

  const serialized = JSON.stringify(diagnostics);
  assert.match(serialized, /EVIDENCE_SELECTION_INCOMPLETE/u);
  assert.match(serialized, /compile-target-1/u);
  assert.match(serialized, /character-wolf\.wolf_tail/u);
  assert.match(serialized, /seg-run-8/u);
  assert.doesNotMatch(serialized, /secret prompt|secret key|secret\.source\.path|原始尾巴文本|MUST_NOT_BE_VISITED/u);
});

test("compiler failure renderer escapes values and omits prompts, raw responses and offsets", () => {
  const error = createApiRequestError({
    error: "编译失败 <script>alert(1)</script>",
    stage: "staticFrameCompiler",
    category: "candidate",
    metadata: {
      repairMode: "evidence_reselection",
      skipReason: "EVIDENCE_RESELECTION_EXHAUSTED",
      diagnostics: [{
        errorCode: "NO_VALID_GROUNDED_COMBINATION",
        targetId: "compile-target-0",
        path: "shotPlan[0].endFrame.characters[0].pose",
        requiredDimensionCount: 2,
        availableDimensions: ["limbs", "<img src=x onerror=alert(1)>"],
        detectedDimensions: ["limbs"],
        recognizedFeatures: [{ featureId: "character-wolf.wolf_tail" }],
        unselectedCandidateCount: 3,
        sourcePath: "fullStory.secret",
        utf16Start: 3,
        utf16End: 9,
        prompt: "DO NOT SHOW",
        raw: "DO NOT SHOW RAW",
        apiKey: "DO NOT SHOW KEY"
      }]
    }
  }, 502);

  const html = renderCompilerFailureDetails(error);
  assert.match(html, /Static Frame Compiler/u);
  assert.match(html, /NO_VALID_GROUNDED_COMBINATION/u);
  assert.match(html, /compile-target-0/u);
  assert.match(html, /requiredDimensionCount/u);
  assert.match(html, /character-wolf\.wolf_tail/u);
  assert.match(html, /evidence_reselection/u);
  assert.match(html, /EVIDENCE_RESELECTION_EXHAUSTED/u);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/u);
  assert.doesNotMatch(html, /<script>|<img src=x|fullStory\.secret|DO NOT SHOW|utf16Start|utf16End/u);
});

test("non-compiler failures do not render a compiler panel", () => {
  const error = createApiRequestError({
    error: "普通错误",
    category: "provider",
    metadata: { errorCode: "UPSTREAM_ERROR" }
  }, 502);

  assert.equal(renderCompilerFailureDetails(error), "");
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
