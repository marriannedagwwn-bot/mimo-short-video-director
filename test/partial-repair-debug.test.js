import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PartialRepairDebugWriter } from "../src/partial-repair-debug.js";

function idFactory(prefix = "debug-id") {
  let index = 0;
  return () => `${prefix}-${++index}`;
}

function repairPlan() {
  return {
    schemaVersion: "artifact_partial_repair/1.0",
    artifactType: "animationFoundation",
    adapterId: "animation_foundation/fixed_character_reference/1.0",
    baseDigest: "base-digest",
    authorityDigest: "authority-digest",
    authority: {
      fixedCharacterBoundary: {
        characterName: "小白子",
        boundarySignature: "SECRET_BOUNDARY_SIGNATURE"
      },
      referenceImageDataUrl: "data:image/png;base64,SECRET_IMAGE_BYTES"
    },
    targets: [{
      repairId: "R1",
      path: "/characterReferencePrompts/0",
      targetLabel: "固定角色小白子",
      currentDigest: "target-digest",
      currentValue: {
        characterName: "小白子",
        appearancePrompt: "Q版2.5头身狼耳少女"
      },
      diagnostics: [{
        code: "ANIMATION_FIXED_CHARACTER_REQUIRED_TRAITS_MISSING",
        reason: "缺少狼娘形象"
      }],
      mutablePointers: ["/characterReferencePrompts/0/consistencyTags"],
      repairInstruction: "只追加签发事实",
      modelContext: { mutableFields: ["consistencyTags"] }
    }],
    completeCandidate: "FULL_ARTIFACT_SENTINEL"
  };
}

test("局部纠错 debug 按触发、响应和结果分阶段原子落盘并脱敏", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "partial-repair-debug-"));
  try {
    const writer = new PartialRepairDebugWriter({
      outputRoot: temporaryRoot,
      now: () => new Date("2026-08-14T08:00:00.000Z"),
      idFactory: idFactory()
    });
    const session = await writer.begin({
      stage: "animationFoundation",
      provider: "Qwen",
      model: "qwen-test",
      variantId: "V4",
      originalError: Object.assign(new Error("缺少狼娘形象"), {
        code: "OUTPUT_CONTRACT_INVALID",
        details: [{ path: "characterReferencePrompts[0]", reason: "缺少狼娘形象" }]
      }),
      repairPlan: repairPlan(),
      repairPrompt: "Bearer TOP_SECRET_TOKEN\n{\"boundarySignature\":\"SECRET_BOUNDARY_SIGNATURE\",\"dataUrl\":\"data:image/png;base64,SECRET_IMAGE_BYTES\"}"
    });

    const directories = await fs.readdir(temporaryRoot);
    assert.equal(directories.length, 1);
    const sessionDirectory = path.join(temporaryRoot, directories[0]);
    assert.deepEqual((await fs.readdir(sessionDirectory)).sort(), [
      "01-trigger.json",
      "02-repair-prompt.txt"
    ]);
    const trigger = JSON.parse(await fs.readFile(path.join(sessionDirectory, "01-trigger.json"), "utf8"));
    assert.equal(trigger.status, "triggered");
    assert.equal(trigger.stage, "animationFoundation");
    assert.equal(trigger.variantId, "V4");
    assert.equal(
      trigger.repairPlan.targets[0].currentValue.appearancePrompt,
      "Q版2.5头身狼耳少女"
    );
    assert.equal(trigger.repairPlan.authority.fixedCharacterBoundary.boundarySignature, "[REDACTED]");

    await writer.recordResponse(session, {
      schemaVersion: "artifact_partial_repair/1.0",
      baseDigest: "base-digest",
      repairs: [{
        repairId: "R1",
        replacement: {
          characterName: "小白子",
          appearancePrompt: "Q版2.5头身狼耳少女",
          consistencyTags: ["狼耳", "狼娘形象"],
          unauthorizedDump: "COMPLETE_PLAN_OUTSIDE_TARGET"
        },
        wholePlan: "COMPLETE_PLAN_OUTSIDE_TARGET"
      }],
      dump: "FULL_ARTIFACT_SENTINEL"
    });
    await writer.recordResult(session, { status: "repaired" });

    const filenames = (await fs.readdir(sessionDirectory)).sort();
    assert.deepEqual(filenames, [
      "01-trigger.json",
      "02-repair-prompt.txt",
      "03-model-response.json",
      "04-result.json"
    ]);
    assert.equal(filenames.some((name) => name.includes(".tmp-")), false);
    const response = JSON.parse(await fs.readFile(path.join(sessionDirectory, "03-model-response.json"), "utf8"));
    assert.equal(response.repairs[0].replacement.fields.appearancePrompt, "Q版2.5头身狼耳少女");
    assert.deepEqual(response.repairs[0].replacement.fields.consistencyTags, ["狼耳", "狼娘形象"]);
    assert.deepEqual(response.repairs[0].replacement.extraKeys, ["unauthorizedDump"]);
    assert.deepEqual(response.extraKeys, ["dump"]);
    const result = JSON.parse(await fs.readFile(path.join(sessionDirectory, "04-result.json"), "utf8"));
    assert.equal(result.status, "repaired");

    const combined = (await Promise.all(filenames.map((name) => (
      fs.readFile(path.join(sessionDirectory, name), "utf8")
    )))).join("\n");
    assert.doesNotMatch(combined, /TOP_SECRET_TOKEN|SECRET_BOUNDARY_SIGNATURE|SECRET_IMAGE_BYTES/u);
    assert.doesNotMatch(combined, /FULL_ARTIFACT_SENTINEL|COMPLETE_PLAN_OUTSIDE_TARGET/u);
    assert.match(combined, /\[REDACTED\]/u);
    assert.equal((await fs.stat(sessionDirectory)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(path.join(sessionDirectory, "01-trigger.json"))).mode & 0o777, 0o600);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("相同时刻的并发局部纠错使用独立目录且拒绝结果保留原始业务错误", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "partial-repair-debug-concurrent-"));
  try {
    const writer = new PartialRepairDebugWriter({
      outputRoot: temporaryRoot,
      now: () => new Date("2026-08-14T08:00:00.000Z"),
      idFactory: idFactory("concurrent")
    });
    const [left, right] = await Promise.all([
      writer.begin({
        stage: "fullStory",
        originalError: new Error("左侧错误"),
        repairPlan: repairPlan(),
        repairPrompt: "左侧局部 prompt"
      }),
      writer.begin({
        stage: "animationShotPrompt",
        originalError: new Error("右侧错误"),
        repairPlan: repairPlan(),
        repairPrompt: "右侧局部 prompt"
      })
    ]);
    await Promise.all([
      writer.recordResult(left, { status: "rejected", error: new Error("左侧拒绝原因") }),
      writer.recordResult(right, { status: "rejected", error: new Error("右侧拒绝原因") })
    ]);
    const directories = (await fs.readdir(temporaryRoot)).sort();
    assert.equal(directories.length, 2);
    assert.notEqual(directories[0], directories[1]);
    const results = await Promise.all(directories.map(async (directory) => (
      JSON.parse(await fs.readFile(path.join(temporaryRoot, directory, "04-result.json"), "utf8"))
    )));
    assert.deepEqual(results.map((result) => result.error.message).sort(), [
      "右侧拒绝原因",
      "左侧拒绝原因"
    ]);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("错误类型的响应与 replacement 只记录形状和摘要，不落盘完整 Artifact", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "partial-repair-debug-malformed-"));
  try {
    const writer = new PartialRepairDebugWriter({
      outputRoot: temporaryRoot,
      idFactory: idFactory("malformed")
    });
    const topLevelSession = await writer.begin({
      stage: "animationFoundation",
      originalError: new Error("错误响应形状"),
      repairPlan: repairPlan(),
      repairPrompt: "局部 prompt"
    });
    await writer.recordResponse(topLevelSession, [
      "FULL_ARTIFACT_LEAK_SENTINEL",
      { shotPlan: [{ sceneScript: "FULL_ARTIFACT_LEAK_SENTINEL" }] }
    ]);

    const replacementSession = await writer.begin({
      stage: "animationShotPrompt",
      originalError: new Error("错误 replacement 形状"),
      repairPlan: {
        ...repairPlan(),
        targets: [{
          ...repairPlan().targets[0],
          currentValue: "integrated_multimodal_description: signed prompt"
        }]
      },
      repairPrompt: "局部 prompt"
    });
    await writer.recordResponse(replacementSession, {
      schemaVersion: "artifact_partial_repair/1.0",
      baseDigest: "base-digest",
      repairs: [{
        repairId: "R1",
        replacement: {
          shotPlan: [{ sceneScript: "FULL_ARTIFACT_LEAK_SENTINEL" }]
        }
      }]
    });

    const stringReplacementSession = await writer.begin({
      stage: "animationShotPrompt",
      originalError: new Error("字符串包装完整 Artifact"),
      repairPlan: {
        ...repairPlan(),
        targets: [{
          ...repairPlan().targets[0],
          currentValue: "integrated_multimodal_description: signed prompt"
        }]
      },
      repairPrompt: "局部 prompt"
    });
    await writer.recordResponse(stringReplacementSession, {
      schemaVersion: "artifact_partial_repair/1.0",
      baseDigest: "base-digest",
      repairs: [{
        repairId: "R1",
        replacement: JSON.stringify({
          shotPlan: [{ sceneScript: "STRING_FULL_ARTIFACT_LEAK_SENTINEL" }]
        })
      }]
    });

    const nestedStringSession = await writer.begin({
      stage: "animationShotPrompt",
      originalError: new Error("多重字符串包装完整 Artifact"),
      repairPlan: {
        ...repairPlan(),
        targets: [{
          ...repairPlan().targets[0],
          currentValue: "integrated_multimodal_description: signed prompt"
        }]
      },
      repairPrompt: "局部 prompt"
    });
    await writer.recordResponse(nestedStringSession, {
      schemaVersion: "artifact_partial_repair/1.0",
      baseDigest: "base-digest",
      repairs: [{
        repairId: "R1",
        replacement: JSON.stringify(JSON.stringify({
          shotPlan: [{ sceneScript: "DOUBLE_STRING_FULL_ARTIFACT_LEAK_SENTINEL" }]
        }))
      }]
    });

    const directories = (await fs.readdir(temporaryRoot)).sort();
    assert.equal(directories.length, 4);
    const responses = await Promise.all(directories.map(async (directory) => (
      fs.readFile(path.join(temporaryRoot, directory, "03-model-response.json"), "utf8")
    )));
    assert.equal(responses.some((response) => response.includes("FULL_ARTIFACT_LEAK_SENTINEL")), false);
    assert.equal(responses.some((response) => response.includes("STRING_FULL_ARTIFACT_LEAK_SENTINEL")), false);
    assert.equal(responses.some((response) => response.includes("DOUBLE_STRING_FULL_ARTIFACT_LEAK_SENTINEL")), false);
    assert.ok(responses.every((response) => /responseDigest|valueOmitted/u.test(response)));
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("超大 JSON debug 文件严格受 maxFileBytes 硬上限约束", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "partial-repair-debug-bounded-"));
  try {
    const maxFileBytes = 4096;
    const writer = new PartialRepairDebugWriter({
      outputRoot: temporaryRoot,
      maxFileBytes,
      idFactory: idFactory("bounded")
    });
    const plan = repairPlan();
    plan.targets[0].currentValue.appearancePrompt = `${"\\\"".repeat(20_000)}超长字段`;
    await writer.begin({
      stage: "animationFoundation",
      originalError: new Error("超长错误"),
      repairPlan: plan,
      repairPrompt: "超长局部 prompt"
    });
    const [directory] = await fs.readdir(temporaryRoot);
    const triggerPath = path.join(temporaryRoot, directory, "01-trigger.json");
    assert.ok((await fs.stat(triggerPath)).size <= maxFileBytes);
    const trigger = JSON.parse(await fs.readFile(triggerPath, "utf8"));
    assert.equal(trigger.truncated, true);
    assert.equal(typeof trigger.sha256, "string");
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("debug 目录不可写时只告警，不抛出文件系统错误覆盖业务结果", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "partial-repair-debug-blocked-"));
  try {
    const blockedRoot = path.join(temporaryRoot, "not-a-directory");
    await fs.writeFile(blockedRoot, "blocked", "utf8");
    const warnings = [];
    const writer = new PartialRepairDebugWriter({
      outputRoot: blockedRoot,
      warningSink: (message) => warnings.push(message),
      idFactory: idFactory("blocked")
    });
    const session = await writer.begin({
      stage: "fullStory",
      originalError: new Error("原始业务错误"),
      repairPlan: repairPlan(),
      repairPrompt: "局部 prompt"
    });
    await assert.doesNotReject(() => writer.recordResponse(session, { repairs: [] }));
    await assert.doesNotReject(() => writer.recordResult(session, {
      status: "rejected",
      error: new Error("原始业务错误")
    }));
    assert.ok(warnings.length >= 1);
    assert.match(warnings[0], /partial-repair-debug/u);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});
