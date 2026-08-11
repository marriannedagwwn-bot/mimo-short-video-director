import test from "node:test";
import assert from "node:assert/strict";
import { AttemptStore } from "../src/attempt-store.js";
import { ModelResponseError } from "../src/mimo-client.js";
import {
  AttemptRecord,
  ModelPipelineError,
  ValidationDiagnostic
} from "../src/model-errors.js";
import {
  sanitizeErrorForLog,
  serializeServerError
} from "../src/server-error.js";
import { InputError, OutputContractError } from "../src/validation.js";
import { ProductionStateError } from "../src/production-lineage.js";

test("ValidationDiagnostic normalizes the stable public shape", () => {
  const diagnostic = new ValidationDiagnostic({
    code: "FULL_STORY_INVALID",
    path: "/sceneScript/0",
    message: "场次无效",
    severity: "warning",
    source: "scene-contract",
    metadata: {
      sceneId: "S1",
      raw: "不得暴露",
      prompt: "不得暴露"
    }
  });

  assert.deepEqual(JSON.parse(JSON.stringify(diagnostic)), {
    code: "FULL_STORY_INVALID",
    path: "/sceneScript/0",
    message: "场次无效",
    severity: "warning",
    source: "scene-contract",
    metadata: { sceneId: "S1" }
  });
  assert.ok(Object.isFrozen(diagnostic));
});

test("AttemptRecord never serializes raw provider output", () => {
  const record = new AttemptRecord({
    attemptId: "attempt-1",
    provider: "MiMo",
    stage: "fullStory",
    rawOutputRef: "raw-1",
    rawOutputBytes: 123,
    storedRawOutputBytes: 100,
    rawOutputTruncated: true,
    metadata: {
      requestId: "req-1",
      rawResponse: "secret",
      authorization: "Bearer secret"
    }
  });
  const serialized = JSON.stringify(record);

  assert.match(serialized, /raw-1/u);
  assert.match(serialized, /req-1/u);
  assert.doesNotMatch(serialized, /secret|rawResponse|authorization/u);
});

test("ModelPipelineError retains typed diagnostics, attempts and cause without exposing cause", () => {
  const cause = new Error("internal cause");
  const error = new ModelPipelineError("模型输出校验失败", {
    category: "schema",
    code: "FULL_STORY_SCHEMA_INVALID",
    origin: "model",
    httpStatus: 502,
    retryable: true,
    diagnostics: [{
      code: "REQUIRED",
      path: "/title",
      reason: "缺少 title"
    }],
    attempts: [{ attemptId: "attempt-1", status: "failed" }],
    cause
  });

  assert.equal(error.cause, cause);
  assert.equal(error.diagnostics[0].message, "缺少 title");
  assert.ok(error.attempts[0] instanceof AttemptRecord);
  assert.deepEqual(JSON.parse(JSON.stringify(error)), {
    name: "ModelPipelineError",
    message: "模型输出校验失败",
    category: "schema",
    code: "FULL_STORY_SCHEMA_INVALID",
    origin: "model",
    httpStatus: 502,
    retryable: true,
    diagnostics: [{
      code: "REQUIRED",
      path: "/title",
      message: "缺少 title",
      severity: "error",
      source: "validation"
    }],
    attempts: [{
      attemptId: "attempt-1",
      operationId: "",
      stage: "",
      provider: "",
      model: "",
      reason: "",
      startedAt: "",
      finishedAt: "",
      durationMs: 0,
      status: "failed",
      category: "unknown",
      code: "",
      finishReason: "",
      retryable: false,
      rawOutputRef: "",
      rawOutputBytes: 0,
      storedRawOutputBytes: 0,
      rawOutputTruncated: false
    }]
  });
});

test("server serializer preserves error:string and hides ModelResponseError raw output", () => {
  let id = 0;
  const store = new AttemptStore({
    idFactory: () => `id-${id += 1}`
  });
  const serialized = serializeServerError(
    new ModelResponseError("MiMo 返回了无法解析的响应包", "{\"apiKey\":\"secret\"}", 502),
    { attemptStore: store }
  );

  assert.equal(serialized.status, 502);
  assert.equal(serialized.body.error, "MiMo 返回了无法解析的响应包");
  assert.equal(typeof serialized.body.error, "string");
  assert.equal(serialized.body.code, "MODEL_RESPONSE_ERROR");
  assert.equal(serialized.body.attempts.length, 1);
  assert.ok(serialized.body.attempts[0].rawOutputRef);
  assert.doesNotMatch(JSON.stringify(serialized.body), /apiKey|secret/u);
  assert.equal(
    store.getRawOutput(serialized.body.attempts[0].rawOutputRef),
    "{\"apiKey\":\"secret\"}"
  );
});

test("server serializer keeps legacy status/message semantics while adding observability", async (t) => {
  await t.test("InputError remains 400", () => {
    const serialized = serializeServerError(new InputError("输入错误", [{ path: "body" }]));
    assert.equal(serialized.status, 400);
    assert.equal(serialized.body.error, "输入错误");
    assert.equal(serialized.body.code, "INPUT_INVALID");
  });

  await t.test("ProductionStateError preserves conflict status and safe lineage details", () => {
    const serialized = serializeServerError(new ProductionStateError("旧请求已失效", {
      code: "ARTIFACT_REVISION_CONFLICT",
      httpStatus: 409,
      details: [{ artifactId: "fullStory:V1", expectedRevision: "r1", actualRevision: "r2" }]
    }));
    assert.equal(serialized.status, 409);
    assert.equal(serialized.body.category, "production-state");
    assert.equal(serialized.body.code, "ARTIFACT_REVISION_CONFLICT");
    assert.deepEqual(serialized.body.details, [{
      artifactId: "fullStory:V1",
      expectedRevision: "r1",
      actualRevision: "r2"
    }]);
  });

  await t.test("OutputContractError remains 502 with the compatibility prefix", () => {
    const serialized = serializeServerError(new OutputContractError("缺少字段"));
    assert.equal(serialized.status, 502);
    assert.equal(serialized.body.error, "模型输出不完整：缺少字段");
    assert.equal(serialized.body.code, "OUTPUT_CONTRACT_INVALID");
  });

  await t.test("ModelPipelineError uses its declared status and error string", () => {
    const serialized = serializeServerError(new ModelPipelineError("调用受限", {
      category: "transport",
      code: "RATE_LIMITED",
      origin: "provider",
      httpStatus: 503,
      retryable: true
    }));
    assert.equal(serialized.status, 503);
    assert.equal(serialized.body.error, "调用受限");
    assert.equal(serialized.body.retryable, true);
  });
});

test("ordinary log projection excludes raw response fields", () => {
  const log = sanitizeErrorForLog({
    name: "ProviderError",
    message: "上游失败",
    code: "UPSTREAM_FAILED",
    raw: "secret raw response",
    prompt: "secret prompt",
    apiKey: "secret key"
  });

  assert.deepEqual(log, {
    name: "ProviderError",
    message: "上游失败",
    code: "UPSTREAM_FAILED"
  });
  assert.doesNotMatch(JSON.stringify(log), /secret/u);
});
