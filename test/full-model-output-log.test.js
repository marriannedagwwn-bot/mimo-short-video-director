import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  FullModelOutputLogWriter,
  MODEL_OUTPUT_LOG_SCOPES,
  resolvePrivateModelOutputLogRoot
} from "../src/full-model-output-log.js";

test("Full Story 全量模型输出日志默认禁用且不创建目录", async () => {
  const writer = new FullModelOutputLogWriter();
  assert.equal(writer.enabled, false);
  assert.equal(await writer.recordAttempt({ content: "完整输出" }), null);
});

test("配置位于 public 或经符号链接落入 public 时保持禁用", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "full-model-output-root-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const servedRoot = path.join(workspace, "public");
  await fs.mkdir(servedRoot);
  const warnings = [];
  assert.equal(await resolvePrivateModelOutputLogRoot({
    workspaceRoot: workspace,
    configuredValue: "public/full-story",
    servedRoot,
    onWarning: (message) => warnings.push(message)
  }), "");
  assert.equal(await resolvePrivateModelOutputLogRoot({
    workspaceRoot: workspace,
    configuredValue: ".",
    servedRoot,
    onWarning: (message) => warnings.push(message)
  }), "");
  const linkedRoot = path.join(workspace, "linked-public");
  let symlinkSupported = true;
  try {
    await fs.symlink(servedRoot, linkedRoot);
  } catch (error) {
    if (process.platform !== "win32" || !["EPERM", "EACCES"].includes(error?.code)) throw error;
    symlinkSupported = false;
    t.diagnostic("Windows 当前权限不允许创建目录符号链接，跳过符号链接逃逸检查");
  }
  if (symlinkSupported) {
    assert.equal(await resolvePrivateModelOutputLogRoot({
      workspaceRoot: workspace,
      configuredValue: "linked-public/full-story",
      servedRoot,
      onWarning: (message) => warnings.push(message)
    }), "");
  }
  if (process.platform === "darwin" || process.platform === "win32") {
    assert.equal(await resolvePrivateModelOutputLogRoot({
      workspaceRoot: workspace,
      configuredValue: "PUBLIC/full-story",
      servedRoot,
      onWarning: (message) => warnings.push(message)
    }), "");
  }
  const caseInsensitiveWarningCount = process.platform === "darwin" || process.platform === "win32" ? 1 : 0;
  assert.equal(warnings.length, 2 + Number(symlinkSupported) + caseInsensitiveWarningCount);
});

test("完整保存模型 content、不截断，并按 Production request 隔离", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "full-model-output-log-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const content = `${"剧情正文😀".repeat(55_000)}\n木质摇椅、白色毯子、橘子、米色雨伞`;
  const writer = new FullModelOutputLogWriter({
    outputRoot: root,
    gitCommit: "0123456789abcdef0123456789abcdef01234567",
    buildId: "test-build-1",
    now: () => new Date("2026-08-14T10:00:00.000Z"),
    idFactory: (() => {
      let index = 0;
      return () => `id-${index += 1}`;
    })()
  });
  const result = await writer.recordAttempt({
    context: {
      verified: true,
      projectId: "project-1",
      runId: "run-1",
      artifactId: "fullStory:V2",
      productionRequestId: "request-1",
      variantId: "V2"
    },
    operationId: "operation:1",
    attemptId: "attempt:1",
    callIndex: 0,
    stage: "fullStoryBeatScenePostpass",
    reason: "primary",
    status: "failed",
    category: "output-contract",
    code: "OUTPUT_CONTRACT_INVALID",
    provider: "Qwen",
    model: "qwen3.7-max",
    providerRequestId: "provider-request-1",
    finishReason: "stop",
    usage: { total_tokens: 123, apiKey: "MUST_NOT_BE_LOGGED" },
    content,
    prompt: "MUST_NOT_BE_LOGGED",
    authorization: "Bearer MUST_NOT_BE_LOGGED"
  });

  assert.ok(result?.metadataPath);
  assert.equal(await fs.readFile(result.outputPath, "utf8"), content);
  const metadataText = await fs.readFile(result.metadataPath, "utf8");
  const metadata = JSON.parse(metadataText);
  assert.equal(metadata.production.productionRequestId, "request-1");
  assert.equal(metadata.gitCommit, "0123456789abcdef0123456789abcdef01234567");
  assert.equal(metadata.buildId, "test-build-1");
  assert.equal(metadata.attempt.stage, "fullStoryBeatScenePostpass");
  assert.equal(metadata.attempt.phase, "primary");
  assert.equal(metadata.attempt.validationStatus, "failed");
  assert.equal(metadata.provider.providerRequestId, "provider-request-1");
  assert.equal(metadata.output.bytes, Buffer.byteLength(content, "utf8"));
  assert.equal(
    metadata.output.sha256,
    createHash("sha256").update(content, "utf8").digest("hex")
  );
  assert.doesNotMatch(metadataText, /MUST_NOT_BE_LOGGED/u);
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(path.dirname(result.metadataPath))).mode & 0o777, 0o700);
    assert.equal((await fs.stat(result.metadataPath)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(result.outputPath)).mode & 0o777, 0o600);
  }
  assert.deepEqual((await fs.readdir(path.dirname(result.metadataPath))).sort(), [
    "metadata.json",
    "model-output.txt"
  ]);
});

test("Production 长标识使用有界摘要目录并在 metadata 保留完整身份", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "full-model-output-bounded-path-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const context = {
    verified: true,
    projectId: "project-5f8f4cad-6f27-49f9-958f-ae4847757ed8",
    runId: "run-b9c43cac-a9d6-4061-9f1f-a7d4fc9ea392",
    artifactId: "fullStory:V1",
    productionRequestId: "request-c3ea3eae-4831-4bf0-b087-ac77e79045b8",
    variantId: "V1"
  };
  const operationId = "operation:199da5ae-45ab-4b08-98e3-cec16809917e";
  const writer = new FullModelOutputLogWriter({ outputRoot: root });
  const result = await writer.recordAttempt({
    context,
    operationId,
    callIndex: 0,
    content: "完整但未通过校验的模型输出"
  });

  const relativePath = path.relative(root, result.metadataPath);
  assert.ok(relativePath.length < 150, `日志相对路径仍过长：${relativePath.length}`);
  assert.doesNotMatch(relativePath, /5f8f4cad|b9c43cac|c3ea3eae|199da5ae/u);
  const metadata = JSON.parse(await fs.readFile(result.metadataPath, "utf8"));
  assert.deepEqual(metadata.production, context);
  assert.equal(metadata.attempt.operationId, operationId);
});

test("同一 operation/callIndex 的并发观测使用独立 attempt 目录且不覆盖", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "full-model-output-concurrent-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const writer = new FullModelOutputLogWriter({ outputRoot: root });
  const common = {
    context: { variantId: "V2" },
    operationId: "operation:same",
    attemptId: "attempt:same",
    callIndex: 0,
    status: "failed"
  };
  const [first, second] = await Promise.all([
    writer.recordAttempt({ ...common, content: "CONTENT_A" }),
    writer.recordAttempt({ ...common, content: "CONTENT_B" })
  ]);
  assert.notEqual(first.metadataPath, second.metadataPath);
  assert.deepEqual(new Set([
    await fs.readFile(first.outputPath, "utf8"),
    await fs.readFile(second.outputPath, "utf8")
  ]), new Set(["CONTENT_A", "CONTENT_B"]));
});

// 2026-10-05 回归：浏览器 Run 内 unbound 日志的 op 目录本身就有 252 字符，attempt 目录一过 ~248
// 字符 fs.mkdtemp 就在 Windows 上失败，上层目录全建好、文件一个没写，一次 742 秒分析的原文全丢。
// 这里把 outputRoot 加深到同等深度，要求 content 与 metadata 照常落盘、不产生告警。
test("浏览器 Run 深度下 attempt 路径超过 260 字符仍照常写出 content 与 metadata", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "full-model-output-deep-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let outputRoot = root;
  for (let index = 0; outputRoot.length < 200; index += 1) {
    outputRoot = path.join(outputRoot, `run-segment-${String(index).padStart(2, "0")}-abcdefghij`);
  }
  const warnings = [];
  const writer = new FullModelOutputLogWriter({
    outputRoot,
    scope: MODEL_OUTPUT_LOG_SCOPES.ANALYSIS,
    onWarning: (message) => warnings.push(message)
  });
  const result = await writer.recordAttempt({
    context: {},
    operationId: "operation:deep-analysis",
    callIndex: 0,
    status: "failed",
    code: "MODEL_OUTPUT_TRUNCATED",
    content: "超长路径下也必须留下的模型原文"
  });
  assert.deepEqual(warnings, []);
  assert.ok(result, "深路径下 recordAttempt 不应 fail-open 放弃");
  assert.ok(path.dirname(result.metadataPath).length > 260, `attempt 目录应超过 260 字符，实际 ${path.dirname(result.metadataPath).length}`);
  assert.equal(await fs.readFile(result.outputPath, "utf8"), "超长路径下也必须留下的模型原文");
  const metadata = JSON.parse(await fs.readFile(result.metadataPath, "utf8"));
  assert.equal(metadata.attempt.code, "MODEL_OUTPUT_TRUNCATED");
  assert.match(path.basename(path.dirname(result.metadataPath)), /^attempt-01-[A-Za-z0-9]{6}$/u);
});

test("Animation Plan writer 固定 scope，并拒绝把 Full Story trace 冒充为可信动画日志", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "animation-model-output-scope-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const writer = new FullModelOutputLogWriter({
    outputRoot: root,
    scope: MODEL_OUTPUT_LOG_SCOPES.ANIMATION_PLAN
  });
  const result = await writer.recordAttempt({
    context: {
      verified: true,
      projectId: "project-a",
      runId: "run-a",
      artifactId: "fullStory:V2",
      productionRequestId: "request-a",
      variantId: "V2"
    },
    phase: "animation-shot-batch",
    sequence: 2,
    batchIndex: 0,
    contentPresent: true,
    content: ""
  });
  const metadata = JSON.parse(await fs.readFile(result.metadataPath, "utf8"));
  assert.equal(metadata.scope, "animationPlan");
  assert.equal(metadata.production.verified, false);
  assert.equal(metadata.attempt.phase, "animation-shot-batch");
  assert.equal(metadata.attempt.sequence, 2);
  assert.equal(metadata.attempt.batchIndex, 0);
  assert.equal(metadata.output.present, true);
  assert.equal(await fs.readFile(result.outputPath, "utf8"), "");
});

test("没有模型 content 时只记录 attempt metadata，不伪造输出文件", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "full-model-output-empty-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const writer = new FullModelOutputLogWriter({ outputRoot: root });
  const result = await writer.recordAttempt({
    context: { variantId: "V2" },
    operationId: "operation:empty",
    callIndex: 0,
    status: "failed",
    code: "MODEL_TIMEOUT",
    contentPresent: false
  });
  const metadata = JSON.parse(await fs.readFile(result.metadataPath, "utf8"));
  assert.equal(metadata.output.present, false);
  assert.equal(result.outputPath, "");
  assert.deepEqual(await fs.readdir(path.dirname(result.metadataPath)), ["metadata.json"]);
});

test("日志目录不可写时 fail-open 并只产生脱敏告警", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "full-model-output-fail-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fileInsteadOfDirectory = path.join(root, "not-a-directory");
  await fs.writeFile(fileInsteadOfDirectory, "occupied");
  const warnings = [];
  const writer = new FullModelOutputLogWriter({
    outputRoot: fileInsteadOfDirectory,
    onWarning: (message) => warnings.push(message)
  });
  assert.equal(await writer.recordAttempt({ content: "PRIVATE_MODEL_OUTPUT" }), null);
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(warnings[0], /PRIVATE_MODEL_OUTPUT/u);
});


// 2026-09-07：最后一个（连同已删除的分镜终审、定向修订）是 2026-09-04 之后新增的阶段，此前一个都没注册 writer，
// 于是终审失败时模型原文永久丢失、只能靠反推。scope 取值必须逐字等于 stage 名——
// writer map 按 scope 建、按 stage 查，对不上就静默不写，是最难发现的那种失效。
test("阶段模型输出日志接受八个工作流 scope，非法 scope 仍拒绝", () => {
  for (const scope of [
    MODEL_OUTPUT_LOG_SCOPES.ANALYSIS,
    MODEL_OUTPUT_LOG_SCOPES.RECONSTRUCTION,
    MODEL_OUTPUT_LOG_SCOPES.BRIEF,
    MODEL_OUTPUT_LOG_SCOPES.VARIANTS,
    MODEL_OUTPUT_LOG_SCOPES.VISUAL_GUARDRAILS,
    MODEL_OUTPUT_LOG_SCOPES.CHARACTER_REFERENCE,
    MODEL_OUTPUT_LOG_SCOPES.STORY_CANDIDATE_REVIEW,
    MODEL_OUTPUT_LOG_SCOPES.STORY_QUALITY_REVIEW
  ]) {
    const writer = new FullModelOutputLogWriter({ scope, outputRoot: "" });
    assert.equal(writer.scope, scope);
    // 没有配置 outputRoot 就是完全关闭，不创建任何目录。
    assert.equal(writer.enabled, false);
  }
  assert.throws(() => new FullModelOutputLogWriter({ scope: "notAStage" }), TypeError);
  // 分镜终审与定向修订已随旧 3.0 分镜删除（2026-10-11），它们的 scope 一并去掉，按非法 scope 拒绝。
  for (const scope of ["animationPlanReview", "animationPlanRevision"]) {
    assert.throws(() => new FullModelOutputLogWriter({ scope }), TypeError, scope);
  }
});

// 这三个 scope 的取值就是 workflow 里的 stage 字符串。写错一个字母不会报错，
// 只会让那个阶段永远查不到 writer——正是本次要修的失效模式，所以逐字锁住。
// 另两个（animationPlanReview / animationPlanRevision）已随旧 3.0 分镜删除（2026-10-11）。
test("新 scope 的取值逐字等于 stage 名", () => {
  assert.equal(MODEL_OUTPUT_LOG_SCOPES.STORY_QUALITY_REVIEW, "storyQualityReview");
  assert.equal(Object.hasOwn(MODEL_OUTPUT_LOG_SCOPES, "ANIMATION_PLAN_REVIEW"), false);
  assert.equal(Object.hasOwn(MODEL_OUTPUT_LOG_SCOPES, "ANIMATION_PLAN_REVISION"), false);
});
