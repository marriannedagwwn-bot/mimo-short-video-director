import test from "node:test";
import assert from "node:assert/strict";
import { ModelResponseError } from "../src/mimo-client.js";
import {
  STATIC_FRAME_CANDIDATE_ERROR_CODES,
  StaticFrameCompilerCandidateError,
  StaticFrameCompilerProtocolError,
  StaticFrameCompilerTransportError,
  auditStaticFrameSourceCatalog,
  buildStaticFrameCompileTargets,
  buildStaticFrameSourceCatalog,
  compileStaticFrames,
  enumerateGroundedPatchCombinations,
  reviewSelectedStaticFrameEvidence,
  validateStaticFrameEvidenceEnvelope
} from "../src/static-frame-compiler.js";

function animationCandidate({
  name = "小白子",
  characterId = "character-xiaobaizi",
  pose = "躯干保持直立",
  bodyOrientation,
  handPropState = "双手自然垂在身体两侧，无道具",
  actionState = ""
} = {}) {
  return {
    shotPlan: [{
      shotId: "shot-1",
      startFrame: {
        characters: [{
          name,
          characterId,
          pose,
          ...(bodyOrientation === undefined ? {} : { bodyOrientation }),
          handPropState,
          actionState
        }]
      },
      endFrame: { characters: [] },
      motion: {}
    }]
  };
}

function compilerOptions(candidate, client, overrides = {}) {
  return {
    candidate,
    client,
    provider: "Qwen",
    model: "qwen-static-frame-compiler",
    maxCompletionTokens: 4096,
    timeoutMs: 300_000,
    runId: "run-test",
    ...overrides
  };
}

function groundingContext(candidate, {
  runId = "run-test",
  characterFeatureProfile = null
} = {}) {
  const targets = buildStaticFrameCompileTargets(candidate, { runId });
  const catalog = buildStaticFrameSourceCatalog(candidate, targets, {
    runId,
    characterFeatureProfile
  });
  const audit = auditStaticFrameSourceCatalog(catalog, targets, {
    characterFeatureProfile
  });
  const targetId = [...targets.keys()][0];
  return {
    candidate,
    targetId,
    target: targets.get(targetId),
    targets,
    catalog,
    audit,
    characterFeatureProfile
  };
}

function candidateSpan(context, text, occurrence = 0) {
  const matches = [...context.catalog.spans.values()].filter((span) => (
    span.targetId === context.targetId
    && span.text === text
    && context.audit.candidateSpanIdsByTarget.get(context.targetId)?.has(span.spanId)
  ));
  assert.ok(matches[occurrence], `找不到已授权 candidate span：${JSON.stringify(text)}`);
  return matches[occurrence];
}

function selectionForSpan(span) {
  return {
    segmentId: span.segmentId,
    spanIds: [span.spanId]
  };
}

function selectionForSpans(...spans) {
  assert.ok(spans.length > 0);
  assert.ok(spans.every((span) => span.segmentId === spans[0].segmentId));
  return {
    segmentId: spans[0].segmentId,
    spanIds: spans.map((span) => span.spanId)
  };
}

function initialEnvelope(context, selections) {
  return {
    targets: [{
      targetId: context.targetId,
      evidenceSelections: selections
    }]
  };
}

function repairEnvelope(context, repairMode, selections) {
  return {
    repairMode,
    targets: [{
      targetId: context.targetId,
      evidenceSelections: selections
    }]
  };
}

function normalizeAndReview(context, selections, {
  attempt = 1,
  repairMode = null
} = {}) {
  const response = repairMode
    ? repairEnvelope(context, repairMode, selections)
    : initialEnvelope(context, selections);
  const normalizedTargets = validateStaticFrameEvidenceEnvelope(response, {
    expectedTargetIds: [context.targetId],
    audit: context.audit,
    repairMode,
    requireRepairMode: Boolean(repairMode)
  });
  return reviewSelectedStaticFrameEvidence({
    normalizedTargets,
    targets: context.targets,
    audit: context.audit,
    characterFeatureProfile: context.characterFeatureProfile,
    attempt
  }).get(context.targetId);
}

function wolfFeatureProfile(characterId = "character-xiaobaizi") {
  return {
    characters: [{
      characterId,
      features: [{
        featureId: `${characterId}.wolf_tail`,
        suggestedFeatureKey: "wolf_tail",
        terms: ["狼尾", "尾巴"],
        evidenceLevel: "inferred"
      }]
    }]
  };
}

test("无真实违规 target 时确定性 no-op，完全不调用模型且不要求模型配置", async () => {
  const candidate = animationCandidate({
    pose: "躯干保持直立",
    handPropState: "双手垂在身体两侧",
    actionState: ""
  });
  let calls = 0;
  const client = {
    async generateJson() {
      calls += 1;
      throw new Error("不应调用");
    }
  };

  const result = await compileStaticFrames({
    candidate,
    client,
    runId: "run-noop"
  });

  assert.equal(calls, 0);
  assert.deepEqual(result.compiledCandidate, candidate);
  assert.equal(result.metadata.noOp, true);
  assert.equal(result.metadata.skipReason, "NO_VIOLATING_TARGET");
  assert.equal(result.metadata.protocolCallCount, 0);
  assert.equal(result.metadata.requestCount, 0);
});

test("空 pose 属于真实违规 target，只能由已签发的相邻静态证据补齐", async () => {
  const candidate = animationCandidate({
    pose: "",
    bodyOrientation: "身体朝向门口"
  });
  const context = groundingContext(candidate);
  const orientation = candidateSpan(context, "身体朝向门口");
  const client = {
    async generateJson() {
      return initialEnvelope(context, [selectionForSpan(orientation)]);
    }
  };

  const result = await compileStaticFrames(compilerOptions(candidate, client));

  assert.equal(context.target.reasonCode, "static_frame_required");
  assert.equal(result.compiledCandidate.shotPlan[0].startFrame.characters[0].pose, "身体朝向门口");
  assert.equal(result.metadata.protocolCallCount, 1);
});

test("Evidence Selection 所有层级执行 exact schema，非法/跨范围 ID 属于 protocol", () => {
  const context = groundingContext(animationCandidate({
    pose: "小白子准备转身，躯干前倾"
  }));
  const safe = candidateSpan(context, "躯干前倾");

  assert.throws(
    () => validateStaticFrameEvidenceEnvelope({
      targets: [{
        targetId: context.targetId,
        evidenceSelections: [{
          segmentId: safe.segmentId,
          spanIds: [safe.spanId],
          text: "模型不得回传文本"
        }]
      }]
    }, {
      expectedTargetIds: [context.targetId],
      audit: context.audit
    }),
    (error) => {
      assert.equal(error.category, "protocol");
      assert.match(error.message, /只能包含 segmentId、spanIds/u);
      return true;
    }
  );

  assert.throws(
    () => validateStaticFrameEvidenceEnvelope(initialEnvelope(context, [{
      segmentId: safe.segmentId,
      spanIds: ["span-run-other-forged"]
    }]), {
      expectedTargetIds: [context.targetId],
      audit: context.audit
    }),
    (error) => {
      assert.equal(error.category, "protocol");
      assert.match(error.message, /非法、跨 segment、跨 target、过期或未经授权/u);
      return true;
    }
  );
});

test("非法首次 envelope 只允许一次 envelope_repair，修复后使用原始已签发 ID", async () => {
  const candidate = animationCandidate({
    pose: "小白子准备转身，躯干前倾"
  });
  const context = groundingContext(candidate);
  const safe = candidateSpan(context, "躯干前倾");
  const requests = [];
  const client = {
    async generateJson(request) {
      requests.push(request);
      if (requests.length === 1) {
        return {
          targets: [{
            targetId: context.targetId,
            evidenceSelections: [selectionForSpan(safe)]
          }],
          visibleFacts: ["禁止的额外字段"]
        };
      }
      return repairEnvelope(context, "envelope_repair", [selectionForSpan(safe)]);
    }
  };

  const { compiledCandidate, metadata } = await compileStaticFrames(
    compilerOptions(candidate, client)
  );

  assert.equal(requests.length, 2);
  assert.match(requests[1].prompt, /STATIC_FRAME_ENVELOPE_REPAIR_V2/u);
  assert.match(requests[1].prompt, new RegExp(safe.spanId, "u"));
  assert.equal(metadata.repairMode, "envelope_repair");
  assert.equal(metadata.protocolCallCount, 2);
  assert.equal(metadata.finalResult, "accepted");
  assert.equal(compiledCandidate.shotPlan[0].startFrame.characters[0].pose, "躯干前倾");
});

test("两次 envelope 均非法时终止为 protocol，不能伪装为 candidate-level 错误", async () => {
  const candidate = animationCandidate({
    pose: "小白子准备转身，躯干前倾"
  });
  let calls = 0;
  const client = {
    async generateJson() {
      calls += 1;
      return { targets: "not-an-array" };
    }
  };

  await assert.rejects(
    () => compileStaticFrames(compilerOptions(candidate, client)),
    (error) => {
      assert.ok(error instanceof StaticFrameCompilerProtocolError);
      assert.equal(error.category, "protocol");
      assert.equal(error.candidateLevel, undefined);
      assert.equal(error.metadata.errorCode, "PROTOCOL_ENVELOPE_INVALID");
      assert.equal(error.metadata.protocolCallCount, 2);
      return true;
    }
  );
  assert.equal(calls, 2);
});

test("envelope repair 后仍有未选 candidate 时不得误报 NO_STATIC_EVIDENCE_IN_SOURCE", async () => {
  const profile = wolfFeatureProfile();
  const candidate = animationCandidate({
    pose: "小白子准备观察，狼尾，双手自然下垂"
  });
  const context = groundingContext(candidate, {
    characterFeatureProfile: profile
  });
  const tailOnly = candidateSpan(context, "狼尾");
  let calls = 0;
  const client = {
    async generateJson() {
      calls += 1;
      if (calls === 1) return { targets: [] };
      return repairEnvelope(
        context,
        "envelope_repair",
        [selectionForSpan(tailOnly)]
      );
    }
  };

  await assert.rejects(
    () => compileStaticFrames(compilerOptions(candidate, client, {
      characterFeatureProfile: profile
    })),
    (error) => {
      assert.ok(error instanceof StaticFrameCompilerCandidateError);
      assert.equal(error.errorCode, "EVIDENCE_RESELECTION_EXHAUSTED");
      assert.notEqual(error.errorCode, "NO_STATIC_EVIDENCE_IN_SOURCE");
      return true;
    }
  );
  assert.equal(calls, 2);
});

test("Candidate Audit 不为未选择 candidate 生成 dimension 或 state slot", () => {
  const context = groundingContext(animationCandidate({
    pose: "小白子准备转身，躯干前倾，双手自然下垂"
  }));
  const body = candidateSpan(context, "躯干前倾");
  const review = normalizeAndReview(context, [selectionForSpan(body)]);

  assert.ok(context.audit.countForTarget(context.targetId) > 1);
  assert.equal(review.slots.length, 1);
  assert.equal(review.slots[0].primaryDimensionKey, "body");
  assert.ok(review.unselectedCandidateSpanIds.length > 0);
  assert.ok(review.unselectedCandidateSpanIds.every((spanId) => (
    !review.slots.some((slot) => slot.sourceSpanIds.includes(spanId))
  )));
  for (const spanId of review.unselectedCandidateSpanIds) {
    assert.equal(Object.hasOwn(context.catalog.spans.get(spanId), "primaryDimensionKey"), false);
  }
});

test("只有 selectedValidatedEvidence 能生成 slot，审核拒绝的已选 span 也不能生成", () => {
  const context = groundingContext(animationCandidate({
    pose: "小白子准备转身，躯干，双手自然下垂"
  }));
  const unsafeAnchor = candidateSpan(context, "躯干");
  const safeLimbs = candidateSpan(context, "双手自然下垂");
  const review = normalizeAndReview(context, [
    selectionForSpan(unsafeAnchor),
    selectionForSpan(safeLimbs)
  ]);

  assert.equal(review.selectedSpanIds.length, 2);
  assert.equal(review.selectedValidatedEvidence, 1);
  assert.equal(review.slots.length, 1);
  assert.deepEqual(review.slots[0].sourceSpanIds, [safeLimbs.spanId]);
  assert.deepEqual(review.rejectedSelections, [{
    selectionIndex: 0,
    reason: "NO_SAFE_PRIMARY_DIMENSION"
  }]);
});

test("requiredDimensionCount 仅按当前 attempt 的安全 slot 池计算，少选不会强制补第二维", () => {
  const context = groundingContext(animationCandidate({
    pose: "小白子准备转身，躯干前倾，双手自然下垂"
  }));
  const body = candidateSpan(context, "躯干前倾");
  const limbs = candidateSpan(context, "双手自然下垂");

  const oneDimension = normalizeAndReview(context, [selectionForSpan(body)], {
    attempt: 1
  });
  assert.equal(oneDimension.requiredDimensionCount, 1);
  assert.deepEqual(
    [...new Set(oneDimension.slots.map((slot) => slot.primaryDimensionKey))],
    ["body"]
  );

  const twoDimensions = normalizeAndReview(context, [
    selectionForSpan(body),
    selectionForSpan(limbs)
  ], { attempt: 1 });
  assert.equal(twoDimensions.requiredDimensionCount, 2);

  const attemptTwo = normalizeAndReview(context, [selectionForSpan(limbs)], {
    attempt: 2,
    repairMode: "evidence_reselection"
  });
  assert.equal(attemptTwo.requiredDimensionCount, 1);
  assert.equal(attemptTwo.slots[0].stateSlotId.startsWith("state-slot-a2-"), true);
  assert.equal(attemptTwo.slots.some((slot) => slot.sourceSpanIds.includes(body.spanId)), false);
});

test("动态角色 feature 精确命中优先于 body，且必须唯一绑定当前角色", () => {
  const candidate = animationCandidate({
    pose: "小白子准备保持姿势，狼尾垂在身体后侧"
  });
  const boundProfile = wolfFeatureProfile();
  const bound = groundingContext(candidate, {
    characterFeatureProfile: boundProfile
  });
  const boundState = candidateSpan(bound, "狼尾垂在身体后侧");
  const boundReview = normalizeAndReview(bound, [selectionForSpan(boundState)]);
  assert.equal(
    boundReview.slots[0].primaryDimensionKey,
    "characterFeature:character-xiaobaizi.wolf_tail"
  );

  const wrongRole = groundingContext(candidate, {
    characterFeatureProfile: wolfFeatureProfile("character-other")
  });
  const wrongRoleState = candidateSpan(wrongRole, "狼尾垂在身体后侧");
  const wrongRoleReview = normalizeAndReview(wrongRole, [selectionForSpan(wrongRoleState)]);
  assert.equal(wrongRoleReview.slots.length, 0);
  assert.equal(
    wrongRoleReview.rejectedSelections[0].reason,
    "NO_SAFE_PRIMARY_DIMENSION"
  );
});

test("wing 等特殊身体词不属于固定 limbs 枚举，只有冻结动态 feature 才能计数", () => {
  const candidate = animationCandidate({
    pose: "小白子准备调整，翅膀展开"
  });
  const withoutProfile = groundingContext(candidate);
  const unprofiledWing = candidateSpan(withoutProfile, "翅膀展开");
  const unprofiledReview = normalizeAndReview(
    withoutProfile,
    [selectionForSpan(unprofiledWing)]
  );
  assert.equal(unprofiledReview.slots.length, 0);

  const wingProfile = {
    characters: [{
      characterId: "character-xiaobaizi",
      features: [{
        featureId: "character-xiaobaizi.wing",
        suggestedFeatureKey: "wing",
        terms: ["翅膀"],
        evidenceLevel: "explicit"
      }]
    }]
  };
  const withProfile = groundingContext(candidate, {
    characterFeatureProfile: wingProfile
  });
  const profiledWing = candidateSpan(withProfile, "翅膀展开");
  const profiledReview = normalizeAndReview(
    withProfile,
    [selectionForSpan(profiledWing)]
  );
  assert.equal(
    profiledReview.slots[0].primaryDimensionKey,
    "characterFeature:character-xiaobaizi.wing"
  );
});

test("同一 selection 不得把角色 feature term 与另一身体主体的状态拼成新事实", () => {
  const profile = wolfFeatureProfile();
  const context = groundingContext(animationCandidate({
    pose: "尾巴正在摆动，双手放在身体右侧"
  }), {
    characterFeatureProfile: profile
  });
  const tail = candidateSpan(context, "尾巴");
  const hands = candidateSpan(context, "双手放在身体右侧");
  const review = normalizeAndReview(context, [{
    segmentId: tail.segmentId,
    spanIds: [tail.spanId, hands.spanId]
  }]);

  assert.equal(review.slots.length, 0);
  assert.deepEqual(
    review.rejectedSelections.map((selection) => selection.reason),
    ["NON_DELETION_GAP_BETWEEN_SPANS"]
  );
});

test("Candidate Audit 使用当前画面全部角色名，不能把无违规 target 的其他角色事实绑定给当前角色", () => {
  const candidate = animationCandidate({
    pose: "小黑站立，小白子担心"
  });
  candidate.shotPlan[0].startFrame.characters.push({
    name: "小黑",
    characterId: "character-xiaohei",
    pose: "身体站立",
    handPropState: "双手自然垂在身体两侧，无道具",
    actionState: ""
  });
  const context = groundingContext(candidate);
  const crossCharacterSpans = [...context.catalog.spans.values()].filter((span) => (
    span.targetId === context.targetId && span.text.includes("小黑")
  ));

  assert.ok(crossCharacterSpans.length > 0);
  crossCharacterSpans.forEach((span) => {
    assert.equal(
      context.audit.candidateSpanIdsByTarget.get(context.targetId).has(span.spanId),
      false
    );
    assert.equal(
      context.audit.rejectionBySpanId.get(span.spanId),
      "AMBIGUOUS_OR_CROSS_CHARACTER_EVIDENCE"
    );
  });
});

test("服务端可从心理前缀后签发精确静态后缀，不需要模型改写原文", () => {
  const context = groundingContext(animationCandidate({
    pose: "小白子担心地双手自然下垂"
  }));
  const groundedSuffix = candidateSpan(context, "双手自然下垂");
  const review = normalizeAndReview(context, [selectionForSpan(groundedSuffix)]);

  assert.equal(review.slots.length, 1);
  assert.equal(review.slots[0].groundedText, "双手自然下垂");
  assert.equal(review.slots[0].primaryDimensionKey, "limbs");
});

test("句中过程词通过前后两个精确 span 删除式整理，不把空间参照误计为 body", () => {
  const profile = wolfFeatureProfile();
  const tailContext = groundingContext(animationCandidate({
    pose: "尾巴随后停在身体右侧"
  }), {
    runId: "run-inline-tail-process",
    characterFeatureProfile: profile
  });
  const tail = candidateSpan(tailContext, "尾巴");
  const tailState = candidateSpan(tailContext, "停在身体右侧");
  const suffixOnly = normalizeAndReview(
    tailContext,
    [selectionForSpan(tailState)]
  );
  assert.equal(suffixOnly.slots.length, 0);
  assert.equal(suffixOnly.rejectedSelections[0].reason, "NO_SAFE_PRIMARY_DIMENSION");

  const tailReview = normalizeAndReview(
    tailContext,
    [selectionForSpans(tail, tailState)]
  );
  assert.equal(tailReview.slots.length, 1);
  assert.equal(
    tailReview.slots[0].primaryDimensionKey,
    "characterFeature:character-xiaobaizi.wolf_tail"
  );
  assert.equal(tailReview.slots[0].groundedText, "尾巴停在身体右侧");

  const limbsContext = groundingContext(animationCandidate({
    pose: "双手随后自然下垂"
  }), { runId: "run-inline-limbs-process" });
  const hands = candidateSpan(limbsContext, "双手");
  const handState = candidateSpan(limbsContext, "自然下垂");
  const limbsReview = normalizeAndReview(
    limbsContext,
    [selectionForSpans(hands, handState)]
  );
  assert.equal(limbsReview.slots.length, 1);
  assert.equal(limbsReview.slots[0].primaryDimensionKey, "limbs");
  assert.equal(limbsReview.slots[0].groundedText, "双手自然下垂");
});

test("handPropState 接受静态手—道具状态，但绝不把它计为 bodyContact", () => {
  const context = groundingContext(animationCandidate({
    handPropState: "双手随后握住盒子"
  }), { runId: "run-static-hand-prop" });
  const hands = candidateSpan(context, "双手");
  const heldProp = candidateSpan(context, "握住盒子");
  const review = normalizeAndReview(
    context,
    [selectionForSpans(hands, heldProp)]
  );

  assert.equal(review.slots.length, 1);
  assert.equal(review.slots[0].primaryDimensionKey, "limbs");
  assert.equal(review.slots[0].groundedText, "双手握住盒子");
  assert.notEqual(review.slots[0].primaryDimensionKey, "bodyContact");
});

test("bodyContact 仅计算环境支撑；handPropState 和手—道具关系均不计 bodyContact", () => {
  const poseContext = groundingContext(animationCandidate({
    pose: "小白子准备支撑身体，双手按在地面"
  }), { runId: "run-body-contact" });
  const groundContact = candidateSpan(poseContext, "双手按在地面");
  const poseReview = normalizeAndReview(poseContext, [selectionForSpan(groundContact)]);
  assert.equal(poseReview.slots[0].primaryDimensionKey, "bodyContact");

  const handPropContext = groundingContext(animationCandidate({
    pose: "躯干保持直立",
    handPropState: "双手随后移动，双手按在地面"
  }), { runId: "run-hand-prop" });
  const handPropGround = [...handPropContext.catalog.spans.values()].find((span) => (
    span.targetId === handPropContext.targetId
    && span.text === "双手按在地面"
  ));
  assert.ok(handPropGround);
  assert.equal(
    handPropContext.audit.candidateSpanIdsByTarget
      .get(handPropContext.targetId)
      ?.has(handPropGround.spanId),
    false
  );
  assert.equal(
    handPropContext.audit.rejectionBySpanId.get(handPropGround.spanId),
    "HAND_PROP_BODY_CONTACT_EXCLUDED"
  );

  const propRelationContext = groundingContext(animationCandidate({
    pose: "小白子准备调整动作，双手按在盒盖"
  }), { runId: "run-prop-relation" });
  const propContact = candidateSpan(propRelationContext, "双手按在盒盖");
  const propReview = normalizeAndReview(
    propRelationContext,
    [selectionForSpan(propContact)]
  );
  assert.equal(propReview.slots[0].primaryDimensionKey, "limbs");
});

test("组合搜索先单 slot 后双 slot，并按原文顺序确定性选择首个满足维度数的组合", () => {
  const context = groundingContext(animationCandidate({
    pose: "小白子准备转身，躯干前倾，双手自然下垂"
  }));
  const body = candidateSpan(context, "躯干前倾");
  const limbs = candidateSpan(context, "双手自然下垂");
  const review = normalizeAndReview(context, [
    selectionForSpan(limbs),
    selectionForSpan(body)
  ]);
  const result = enumerateGroundedPatchCombinations(context.target, review, {
    candidate: context.candidate
  });

  assert.equal(review.requiredDimensionCount, 2);
  assert.equal(result.search.length, 3);
  assert.deepEqual(
    result.search.map((entry) => entry.stateSlotIds.length),
    [1, 1, 2]
  );
  assert.deepEqual(
    result.search.map((entry) => entry.accepted),
    [false, false, true]
  );
  assert.ok(result.search.every(
    (entry) => entry.validationScope === "target-scoped-applied-candidate"
  ));
  assert.deepEqual(result.patch.visibleFacts, ["躯干前倾", "双手自然下垂"]);
  assert.equal(result.patch.value, "躯干前倾，双手自然下垂");
});

test("target-scoped 完整复检拒绝首个互斥组合后继续选择下一组合", () => {
  const context = groundingContext(animationCandidate({
    pose: "小白子准备调整姿态，身体面向门口同时背对窗户，身体面向窗户"
  }), { runId: "run-target-validation" });
  const contradictory = candidateSpan(context, "身体面向门口同时背对窗户");
  const safe = candidateSpan(context, "身体面向窗户");
  const review = normalizeAndReview(context, [
    selectionForSpan(contradictory),
    selectionForSpan(safe)
  ]);
  const result = enumerateGroundedPatchCombinations(context.target, review, {
    candidate: context.candidate
  });

  assert.equal(review.requiredDimensionCount, 1);
  assert.equal(result.search[0].rejection, "MUTUALLY_EXCLUSIVE_STATE");
  assert.equal(result.search[1].accepted, true);
  assert.equal(result.patch.value, "身体面向窗户");
});

test("首次选择不完整时仅进行一次 evidence_reselection，attempt-2 独立替代并成功", async () => {
  const candidate = animationCandidate({
    pose: "小白子准备转身，躯干，双手自然下垂"
  });
  const context = groundingContext(candidate);
  const unsafe = candidateSpan(context, "躯干");
  const safe = candidateSpan(context, "双手自然下垂");
  const requests = [];
  const client = {
    async generateJson(request) {
      requests.push(request);
      if (requests.length === 1) {
        return initialEnvelope(context, [selectionForSpan(unsafe)]);
      }
      return repairEnvelope(
        context,
        "evidence_reselection",
        [selectionForSpan(safe)]
      );
    }
  };

  const { compiledCandidate, metadata } = await compileStaticFrames(
    compilerOptions(candidate, client)
  );

  assert.equal(requests.length, 2);
  assert.match(requests[1].prompt, /STATIC_FRAME_EVIDENCE_RESELECTION_V2/u);
  assert.equal(metadata.repairMode, "evidence_reselection");
  assert.equal(metadata.attempts.length, 2);
  assert.equal(metadata.attempts[0].targets[0].requiredDimensionCount, 0);
  assert.equal(metadata.attempts[1].targets[0].requiredDimensionCount, 1);
  assert.equal(
    metadata.attempts[1].targets[0].stateSlots
      .some((slot) => slot.sourceSpanIds.includes(unsafe.spanId)),
    false
  );
  assert.equal(compiledCandidate.shotPlan[0].startFrame.characters[0].pose, "双手自然下垂");
});

test("evidence_reselection 仍无安全组合时返回 EVIDENCE_RESELECTION_EXHAUSTED 且不允许第三次", async () => {
  const candidate = animationCandidate({
    pose: "准备凝固，躯干，双手"
  });
  const context = groundingContext(candidate);
  const firstUnsafe = candidateSpan(context, "凝固");
  const secondUnsafe = candidateSpan(context, "躯干");
  let calls = 0;
  const client = {
    async generateJson() {
      calls += 1;
      if (calls === 1) {
        return initialEnvelope(context, [selectionForSpan(firstUnsafe)]);
      }
      return repairEnvelope(
        context,
        "evidence_reselection",
        [selectionForSpan(secondUnsafe)]
      );
    }
  };

  await assert.rejects(
    () => compileStaticFrames(compilerOptions(candidate, client)),
    (error) => {
      assert.ok(error instanceof StaticFrameCompilerCandidateError);
      assert.equal(error.errorCode, "EVIDENCE_RESELECTION_EXHAUSTED");
      assert.equal(error.category, "candidate");
      assert.equal(error.candidateLevel, true);
      assert.equal(error.status, 422);
      assert.equal(error.metadata.protocolCallCount, 2);
      return true;
    }
  );
  assert.equal(calls, 2);
});

test("Catalog 没有授权 candidate 时返回 NO_STATIC_EVIDENCE_IN_SOURCE 且跳过模型", async () => {
  const candidate = animationCandidate({
    pose: "小白子准备打开门"
  });
  let calls = 0;
  const client = {
    async generateJson() {
      calls += 1;
      return {};
    }
  };

  await assert.rejects(
    () => compileStaticFrames(compilerOptions(candidate, client)),
    (error) => {
      assert.ok(error instanceof StaticFrameCompilerCandidateError);
      assert.equal(error.errorCode, "NO_STATIC_EVIDENCE_IN_SOURCE");
      assert.equal(error.metadata.skipReason, "CATALOG_HAS_NO_AUTHORIZED_CANDIDATE");
      assert.equal(error.metadata.protocolCallCount, 0);
      return true;
    }
  );
  assert.equal(calls, 0);
});

test("安全 slots 存在但合法组合全部失败且无未选 candidate 时返回 NO_VALID_GROUNDED_COMBINATION", async () => {
  const profile = wolfFeatureProfile();
  const candidate = animationCandidate({
    pose: "小白子准备观察，狼尾张开，双手闭合"
  });
  const context = groundingContext(candidate, {
    runId: "run-test",
    characterFeatureProfile: profile
  });
  const everyCandidate = [...context.audit.candidateSpanIdsByTarget.get(context.targetId)]
    .map((spanId) => selectionForSpan(context.catalog.spans.get(spanId)));
  let calls = 0;
  const client = {
    async generateJson() {
      calls += 1;
      return initialEnvelope(context, everyCandidate);
    }
  };

  await assert.rejects(
    () => compileStaticFrames(compilerOptions(candidate, client, {
      characterFeatureProfile: profile
    })),
    (error) => {
      assert.ok(error instanceof StaticFrameCompilerCandidateError);
      assert.equal(error.errorCode, "NO_VALID_GROUNDED_COMBINATION");
      assert.equal(error.metadata.protocolCallCount, 1);
      assert.equal(error.metadata.attempts[0].targets[0].requiredDimensionCount, 2);
      assert.equal(error.metadata.attempts[0].targets[0].stateSlots.length, 2);
      return true;
    }
  );
  assert.equal(calls, 1);
});

test("candidate-level 错误码集合只包含可交给 Animation Batch Retry 的三类", () => {
  assert.deepEqual(STATIC_FRAME_CANDIDATE_ERROR_CODES, [
    "NO_STATIC_EVIDENCE_IN_SOURCE",
    "NO_VALID_GROUNDED_COMBINATION",
    "EVIDENCE_RESELECTION_EXHAUSTED"
  ]);
});

test("单次 protocol attempt 只进行一次瞬态 transport retry，成功后不消费第二协议模式", async () => {
  const candidate = animationCandidate({
    pose: "小白子准备转身，躯干前倾"
  });
  const context = groundingContext(candidate);
  const safe = candidateSpan(context, "躯干前倾");
  let calls = 0;
  const client = {
    async generateJson() {
      calls += 1;
      if (calls === 1) {
        const error = new Error("connection reset");
        error.code = "ECONNRESET";
        throw error;
      }
      return initialEnvelope(context, [selectionForSpan(safe)]);
    }
  };

  const { metadata } = await compileStaticFrames(compilerOptions(candidate, client));

  assert.equal(calls, 2);
  assert.equal(metadata.protocolCallCount, 1);
  assert.equal(metadata.requestCount, 2);
  assert.equal(metadata.protocolAttempts[0].transportAttempts.length, 2);
  assert.equal(metadata.repairMode, null);
});

test("provider/transport 最终错误保持非 candidate，不能触发候选内容恢复语义", async () => {
  const candidate = animationCandidate({
    pose: "小白子准备转身，躯干前倾"
  });
  let calls = 0;
  const client = {
    async generateJson() {
      calls += 1;
      throw new ModelResponseError("provider overloaded", "", 503);
    }
  };

  await assert.rejects(
    () => compileStaticFrames(compilerOptions(candidate, client)),
    (error) => {
      assert.ok(error instanceof StaticFrameCompilerTransportError);
      assert.equal(error.category, "provider");
      assert.equal(error.classification, "provider");
      assert.equal(error.candidateLevel, undefined);
      assert.equal(error.metadata.protocolCallCount, 1);
      assert.equal(error.metadata.requestCount, 2);
      return true;
    }
  );
  assert.equal(calls, 2);
});
