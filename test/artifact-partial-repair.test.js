import test from "node:test";
import assert from "node:assert/strict";
import {
  ARTIFACT_PARTIAL_REPAIR_SCHEMA_VERSION,
  artifactPartialRepairPrompt,
  artifactPartialRepairPromptPayload,
  canonicalArtifactRepairPointer,
  createArtifactPartialRepairPlan,
  mergeArtifactPartialRepair,
  readArtifactRepairPointer
} from "../src/artifact-partial-repair.js";
import { OutputContractError } from "../src/validation.js";

function animationCandidate() {
  return {
    selectedVariantId: "V1",
    productionStrategy: {
      format: "direct_shot_video",
      videoPromptProfile: {
        profileId: "minimax_h3",
        guideVersion: "80365054"
      }
    },
    shotPlan: [
      {
        shotId: "A01",
        durationSeconds: 5,
        videoPrompt: "integrated_multimodal_description:\n[Shot 1] A girl approaches the mailbox.",
        characterAction: "小白子跑向信箱并投入通知",
        soundDesign: "脚步声与纸张摩擦声",
        acceptanceCriteria: ["通知进入信箱"]
      },
      {
        shotId: "A02",
        durationSeconds: 5,
        videoPrompt: "UNRELATED_SECOND_SHOT_SENTINEL",
        characterAction: "村民走出院门",
        soundDesign: "环境声",
        acceptanceCriteria: ["村民离开院门"]
      }
    ],
    unrelated: "UNRELATED_TOP_LEVEL_SENTINEL"
  };
}

function h3Diagnostic() {
  return {
    code: "MINIMAX_H3_BASE_SECTIONS_INVALID",
    path: "/shotPlan/0/videoPrompt",
    reason: "必须严格按三个 H3 section 各出现一次"
  };
}

function h3Sections(value) {
  return [
    "integrated_multimodal_description:",
    "overall_soundscape:",
    "non_diegetic_music:"
  ].every((heading) => value.includes(heading));
}

function h3Adapter(overrides = {}) {
  return {
    id: "animation-plan.h3-video-prompt/1.0",
    selectTargets: ({ candidate, diagnostics }) => diagnostics.map((diagnostic) => ({
      path: diagnostic.path,
      mutablePointers: [diagnostic.path],
      diagnostics: [diagnostic],
      repairInstruction: "保留镜头事实，只补齐并规范 H3 三段标题与对应内容。",
      targetLabel: candidate.shotPlan[0].shotId,
      modelContext: {
        durationSeconds: candidate.shotPlan[0].durationSeconds,
        characterAction: candidate.shotPlan[0].characterAction,
        soundDesign: candidate.shotPlan[0].soundDesign
      }
    })),
    buildAuthority: ({ candidate }) => ({
      profileId: candidate.productionStrategy.videoPromptProfile.profileId,
      guideVersion: candidate.productionStrategy.videoPromptProfile.guideVersion
    }),
    authorizeReplacement: ({ replacement }) => h3Sections(replacement),
    validateMerged: ({ candidate }) => {
      if (!h3Sections(candidate.shotPlan[0].videoPrompt)) {
        throw new OutputContractError("A01 H3 Prompt 仍不完整");
      }
      return candidate;
    },
    ...overrides
  };
}

function repairPlan(candidate, adapter = h3Adapter()) {
  return createArtifactPartialRepairPlan({
    artifactType: "animationPlan",
    candidate,
    diagnostics: [h3Diagnostic()],
    adapter,
    context: { operationId: "OP1" }
  });
}

function validPrompt() {
  return [
    "integrated_multimodal_description:",
    "[Shot 1] A girl approaches the mailbox and inserts a rolled notice.",
    "overall_soundscape:",
    "Footsteps, paper friction, and soft rural ambience.",
    "non_diegetic_music:",
    "Gentle acoustic music resolves softly."
  ].join("\n");
}

function validEnvelope(plan, replacement = validPrompt()) {
  return {
    schemaVersion: ARTIFACT_PARTIAL_REPAIR_SCHEMA_VERSION,
    baseDigest: plan.baseDigest,
    repairs: [{ repairId: "R1", replacement }]
  };
}

test("H3 段落错误只暴露目标与最小权威上下文并可原子纠正", () => {
  const candidate = animationCandidate();
  const frozen = structuredClone(candidate);
  let validatorCalls = 0;
  const adapter = h3Adapter({
    validateMerged: ({ candidate: merged }) => {
      validatorCalls += 1;
      assert.ok(h3Sections(merged.shotPlan[0].videoPrompt));
      return merged;
    }
  });
  const plan = repairPlan(candidate, adapter);

  assert.equal(plan.schemaVersion, ARTIFACT_PARTIAL_REPAIR_SCHEMA_VERSION);
  assert.equal(plan.targets.length, 1);
  assert.equal(plan.targets[0].repairId, "R1");
  assert.equal(plan.targets[0].path, "/shotPlan/0/videoPrompt");
  assert.deepEqual(plan.targets[0].mutablePointers, ["/shotPlan/0/videoPrompt"]);
  assert.equal(plan.authority.profileId, "minimax_h3");

  const payload = artifactPartialRepairPromptPayload(plan);
  const serializedPayload = JSON.stringify(payload);
  assert.match(serializedPayload, /MINIMAX_H3_BASE_SECTIONS_INVALID/u);
  assert.match(serializedPayload, /小白子跑向信箱并投入通知/u);
  assert.doesNotMatch(serializedPayload, /UNRELATED_SECOND_SHOT_SENTINEL/u);
  assert.doesNotMatch(serializedPayload, /UNRELATED_TOP_LEVEL_SENTINEL/u);
  assert.equal(Object.prototype.hasOwnProperty.call(payload.targets[0], "path"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(payload.targets[0], "mutablePointers"), false);

  const prompt = artifactPartialRepairPrompt(plan);
  assert.match(prompt, /不得包含 path、op、reason/u);
  assert.doesNotMatch(prompt, /UNRELATED_SECOND_SHOT_SENTINEL|UNRELATED_TOP_LEVEL_SENTINEL/u);

  const merged = mergeArtifactPartialRepair({
    candidate,
    envelope: validEnvelope(plan),
    plan,
    adapter,
    context: { operationId: "OP1" }
  });
  assert.equal(merged.shotPlan[0].videoPrompt, validPrompt());
  assert.deepEqual(merged.shotPlan[1], candidate.shotPlan[1]);
  assert.equal(merged.unrelated, "UNRELATED_TOP_LEVEL_SENTINEL");
  assert.deepEqual(candidate, frozen);
  assert.equal(validatorCalls, 1);
});

test("响应协议拒绝 path、op、额外字段、错误 repairId、乱序和候选摘要漂移", () => {
  const candidate = animationCandidate();
  const adapter = h3Adapter();
  const plan = repairPlan(candidate, adapter);
  const valid = validEnvelope(plan);
  const cases = [
    { ...valid, path: "/shotPlan/0/videoPrompt" },
    { ...valid, repairs: [{ ...valid.repairs[0], path: "/shotPlan/0/videoPrompt" }] },
    { ...valid, repairs: [{ ...valid.repairs[0], op: "replace" }] },
    { ...valid, repairs: [{ ...valid.repairs[0], reason: "fixed" }] },
    { ...valid, repairs: [{ ...valid.repairs[0], repairId: "R2" }] },
    { ...valid, repairs: [] },
    { ...valid, baseDigest: "0".repeat(64) },
    { ...valid, schemaVersion: "artifact_partial_repair/2.0" }
  ];
  for (const envelope of cases) {
    assert.throws(() => mergeArtifactPartialRepair({ candidate, envelope, plan, adapter }), OutputContractError);
  }

  const twoShotAdapter = h3Adapter({
    selectTargets: ({ diagnostics }) => diagnostics.map((diagnostic, index) => ({
      path: `/shotPlan/${index}/videoPrompt`,
      mutablePointers: [`/shotPlan/${index}/videoPrompt`],
      diagnostics: [diagnostic],
      repairInstruction: "修复当前 H3 Prompt。"
    })),
    authorizeReplacement: () => true,
    validateMerged: () => true
  });
  const twoPlan = createArtifactPartialRepairPlan({
    artifactType: "animationPlan",
    candidate,
    diagnostics: [h3Diagnostic(), { ...h3Diagnostic(), path: "/shotPlan/1/videoPrompt" }],
    adapter: twoShotAdapter
  });
  assert.throws(() => mergeArtifactPartialRepair({
    candidate,
    plan: twoPlan,
    adapter: twoShotAdapter,
    envelope: {
      schemaVersion: ARTIFACT_PARTIAL_REPAIR_SCHEMA_VERSION,
      baseDigest: twoPlan.baseDigest,
      repairs: [
        { repairId: "R2", replacement: validPrompt() },
        { repairId: "R1", replacement: validPrompt() }
      ]
    }
  }), /repairId 必须等于 R1/u);
});

test("目标为对象时只允许 mutablePointers 内字段变化", () => {
  const candidate = animationCandidate();
  const adapter = h3Adapter({
    selectTargets: ({ diagnostics }) => [{
      path: "/shotPlan/0",
      mutablePointers: ["/shotPlan/0/videoPrompt"],
      diagnostics,
      repairInstruction: "只修复 videoPrompt，其他镜头字段逐字保留。"
    }],
    authorizeReplacement: () => true,
    validateMerged: ({ candidate: merged }) => h3Sections(merged.shotPlan[0].videoPrompt)
  });
  const plan = repairPlan(candidate, adapter);
  const replacement = structuredClone(candidate.shotPlan[0]);
  replacement.videoPrompt = validPrompt();
  replacement.durationSeconds = 6;

  assert.throws(() => mergeArtifactPartialRepair({
    candidate,
    plan,
    adapter,
    envelope: validEnvelope(plan, replacement)
  }), /越权改变未授权路径 \/shotPlan\/0\/durationSeconds/u);
  assert.equal(candidate.shotPlan[0].durationSeconds, 5);

  replacement.durationSeconds = 5;
  const merged = mergeArtifactPartialRepair({
    candidate,
    plan,
    adapter,
    envelope: validEnvelope(plan, replacement)
  });
  assert.equal(merged.shotPlan[0].videoPrompt, validPrompt());
  assert.equal(merged.shotPlan[0].durationSeconds, 5);
});

test("专用授权、权威复验或完整 validator 失败均不修改原候选", () => {
  const candidate = animationCandidate();
  const frozen = structuredClone(candidate);
  const rejectingAdapter = h3Adapter({ authorizeReplacement: () => false });
  const rejectingPlan = repairPlan(candidate, rejectingAdapter);
  assert.throws(() => mergeArtifactPartialRepair({
    candidate,
    envelope: validEnvelope(rejectingPlan),
    plan: rejectingPlan,
    adapter: rejectingAdapter
  }), /未通过专用授权/u);
  assert.deepEqual(candidate, frozen);

  for (const missingApproval of [undefined, "yes", 1]) {
    const incompleteApprovalAdapter = h3Adapter({
      authorizeReplacement: () => missingApproval
    });
    const incompleteApprovalPlan = repairPlan(candidate, incompleteApprovalAdapter);
    assert.throws(() => mergeArtifactPartialRepair({
      candidate,
      envelope: validEnvelope(incompleteApprovalPlan),
      plan: incompleteApprovalPlan,
      adapter: incompleteApprovalAdapter
    }), /replacement 未通过专用授权/u);
  }

  const missingValidatorReturn = h3Adapter({ validateMerged: () => undefined });
  const missingValidatorPlan = repairPlan(candidate, missingValidatorReturn);
  assert.throws(() => mergeArtifactPartialRepair({
    candidate,
    envelope: validEnvelope(missingValidatorPlan),
    plan: missingValidatorPlan,
    adapter: missingValidatorReturn
  }), /必须显式返回 true 或等值候选/u);

  const rejectingIssuedValidator = h3Adapter({ validateMerged: () => false });
  const rejectingIssuedPlan = repairPlan(candidate, rejectingIssuedValidator);
  assert.throws(() => mergeArtifactPartialRepair({
    candidate,
    envelope: validEnvelope(rejectingIssuedPlan),
    plan: rejectingIssuedPlan,
    adapter: rejectingIssuedValidator,
    validateMerged: () => true
  }), /必须显式返回 true 或等值候选/u);

  const staleAuthorityAdapter = h3Adapter({ validateAuthority: () => false });
  const stalePlan = repairPlan(candidate, staleAuthorityAdapter);
  assert.throws(() => mergeArtifactPartialRepair({
    candidate,
    envelope: validEnvelope(stalePlan),
    plan: stalePlan,
    adapter: staleAuthorityAdapter
  }), /权威上下文已经失效/u);
  assert.deepEqual(candidate, frozen);

  const invalidAdapter = h3Adapter({
    authorizeReplacement: () => true,
    validateMerged: () => {
      throw new OutputContractError("完整 H3 校验失败");
    }
  });
  const invalidPlan = repairPlan(candidate, invalidAdapter);
  assert.throws(() => mergeArtifactPartialRepair({
    candidate,
    envelope: validEnvelope(invalidPlan),
    plan: invalidPlan,
    adapter: invalidAdapter
  }), /完整 H3 校验失败/u);
  assert.deepEqual(candidate, frozen);

  const mutatingValidator = h3Adapter({
    validateMerged: ({ candidate: merged }) => {
      merged.unrelated = "MUTATED_BY_VALIDATOR";
      return merged;
    }
  });
  const mutatingPlan = repairPlan(candidate, mutatingValidator);
  assert.throws(() => mergeArtifactPartialRepair({
    candidate,
    envelope: validEnvelope(mutatingPlan),
    plan: mutatingPlan,
    adapter: mutatingValidator
  }), /validator 必须只读/u);
  assert.deepEqual(candidate, frozen);
});

test("危险 Pointer、危险 replacement 字段和重叠目标都被拒绝且不污染原型", () => {
  const candidate = animationCandidate();
  const dangerousPaths = [
    "/shotPlan/0/__proto__/polluted",
    "/shotPlan/0/constructor/prototype/polluted",
    "/shotPlan/0/~2invalid",
    "/"
  ];
  for (const path of dangerousPaths) {
    const adapter = h3Adapter({
      selectTargets: ({ diagnostics }) => [{
        path,
        mutablePointers: [path],
        diagnostics,
        repairInstruction: "测试危险路径。"
      }]
    });
    assert.throws(() => repairPlan(candidate, adapter), OutputContractError);
    assert.equal(({}).polluted, undefined);
  }

  const adapter = h3Adapter();
  const plan = repairPlan(candidate, adapter);
  const dangerousReplacement = JSON.parse('{"__proto__":{"polluted":true}}');
  assert.throws(() => mergeArtifactPartialRepair({
    candidate,
    plan,
    adapter,
    envelope: validEnvelope(plan, dangerousReplacement)
  }), /危险字段 __proto__/u);
  assert.equal(({}).polluted, undefined);

  const overlapAdapter = h3Adapter({
    selectTargets: ({ diagnostics }) => [{
      path: "/shotPlan/0",
      mutablePointers: ["/shotPlan/0/videoPrompt"],
      diagnostics,
      repairInstruction: "修复镜头对象。"
    }, {
      path: "/shotPlan/0/videoPrompt",
      mutablePointers: ["/shotPlan/0/videoPrompt"],
      diagnostics,
      repairInstruction: "修复提示词。"
    }]
  });
  assert.throws(() => repairPlan(candidate, overlapAdapter), /不能重复或重叠/u);
});

test("计划只接受当前进程签发对象且 adapter 不可替换", () => {
  const candidate = animationCandidate();
  const adapter = h3Adapter();
  const plan = repairPlan(candidate, adapter);
  assert.throws(() => artifactPartialRepairPromptPayload(structuredClone(plan)), /不是当前服务端签发对象/u);
  assert.throws(() => mergeArtifactPartialRepair({
    candidate,
    envelope: validEnvelope(plan),
    plan,
    adapter: h3Adapter({ id: "animation-plan.other/1.0" })
  }), /adapter 与服务端签发计划不匹配/u);
  assert.throws(() => mergeArtifactPartialRepair({
    candidate,
    envelope: validEnvelope(plan),
    plan,
    adapter: h3Adapter({
      id: adapter.id,
      authorizeReplacement: () => true,
      validateMerged: () => true
    })
  }), /adapter 与服务端签发计划不匹配/u);

  const mutableAdapter = h3Adapter();
  const mutationPlan = repairPlan(candidate, mutableAdapter);
  mutableAdapter.authorizeReplacement = () => true;
  mutableAdapter.validateMerged = () => true;
  assert.throws(() => mergeArtifactPartialRepair({
    candidate,
    envelope: validEnvelope(mutationPlan, "evil drift"),
    plan: mutationPlan,
    adapter: mutableAdapter
  }), /未通过专用授权/u);
});

test("JSON Pointer helper 规范化转义并拒绝根路径和危险 token", () => {
  assert.equal(canonicalArtifactRepairPointer("/a~1b/c~0d"), "/a~1b/c~0d");
  assert.deepEqual(
    readArtifactRepairPointer({ "a/b": { "c~d": 3 } }, "/a~1b/c~0d"),
    { found: true, value: 3 }
  );
  assert.throws(() => canonicalArtifactRepairPointer(""), OutputContractError);
  assert.throws(() => canonicalArtifactRepairPointer("/"), OutputContractError);
  assert.throws(() => canonicalArtifactRepairPointer("/__proto__/x"), OutputContractError);
  assert.throws(() => canonicalArtifactRepairPointer("/a/~2"), OutputContractError);
});

test("没有可安全定位目标时返回 null，adapter 必须提供完整 validator", () => {
  const candidate = animationCandidate();
  assert.equal(createArtifactPartialRepairPlan({
    artifactType: "animationPlan",
    candidate,
    diagnostics: [h3Diagnostic()],
    adapter: h3Adapter({ selectTargets: () => null })
  }), null);
  assert.throws(() => createArtifactPartialRepairPlan({
    artifactType: "animationPlan",
    candidate,
    diagnostics: [h3Diagnostic()],
    adapter: {
      id: "missing-validator/1.0",
      selectTargets: () => []
    }
  }), /validateMerged 必须是函数/u);
});
