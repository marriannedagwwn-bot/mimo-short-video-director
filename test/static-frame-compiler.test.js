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
  buildStaticFrameCompilerPrompt,
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
  gaze,
  handPropState = "双手未持道具",
  actionState = ""
} = {}) {
  return {
    shotPlan: [{
      shotId: "shot-1",
      startFrame: {
        characters: [{
          name,
          characterId,
          ...(pose === undefined ? {} : { pose }),
          ...(bodyOrientation === undefined ? {} : { bodyOrientation }),
          ...(gaze === undefined ? {} : { gaze }),
          ...(handPropState === undefined ? {} : { handPropState }),
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
    model: "qwen-static-frame-organizer",
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
  const catalog = buildStaticFrameSourceCatalog(candidate, targets, { runId });
  const audit = auditStaticFrameSourceCatalog(catalog, targets, {
    characterFeatureProfile
  });
  return {
    candidate,
    targets,
    catalog,
    audit,
    characterFeatureProfile
  };
}

function targetFor(context, field, {
  characterIndex = 0,
  frameKind = "startFrame"
} = {}) {
  const target = [...context.targets.values()].find((entry) => (
    entry.field === field
    && entry.characterIndex === characterIndex
    && entry.frameKind === frameKind
  ));
  assert.ok(target, `找不到 target：${field}/${frameKind}/character[${characterIndex}]`);
  return target;
}

function spansForTarget(context, target, {
  sourceField = target.field,
  unit = null,
  text = null
} = {}) {
  return [...context.catalog.spans.values()].filter((span) => (
    span.targetId === target.targetId
    && span.field === sourceField
    && (unit === null || span.unit === unit)
    && (text === null || span.text === text)
    && context.audit.candidateSpanIdsByTarget.get(target.targetId)?.has(span.spanId)
  ));
}

function spanByUnit(context, target, {
  sourceField = target.field,
  unit,
  text = null,
  occurrence = 0
} = {}) {
  const matches = spansForTarget(context, target, {
    sourceField,
    unit,
    text
  });
  assert.ok(matches[occurrence], `找不到 ${unit} span：${sourceField}/${JSON.stringify(text)}`);
  return matches[occurrence];
}

function sourceSpan(context, target, options = {}) {
  return spanByUnit(context, target, { ...options, unit: "source" });
}

function clauseSpan(context, target, options = {}) {
  return spanByUnit(context, target, { ...options, unit: "clause" });
}

function selectionForSpans(spans, category, featureId = null) {
  assert.ok(Array.isArray(spans) && spans.length > 0);
  assert.ok(spans.every((span) => span.segmentId === spans[0].segmentId));
  return {
    segmentId: spans[0].segmentId,
    spanIds: spans.map((span) => span.spanId),
    category,
    featureId
  };
}

function selectionForSpan(span, category, featureId = null) {
  return selectionForSpans([span], category, featureId);
}

function defaultSelection(context, target) {
  const sourceField = target.field === "pose"
    ? spansForTarget(context, target, { sourceField: "pose", unit: "source" }).length > 0
      ? "pose"
      : spansForTarget(context, target, { sourceField: "bodyOrientation", unit: "source" }).length > 0
        ? "bodyOrientation"
        : "gaze"
    : "handPropState";
  const span = sourceSpan(context, target, { sourceField });
  return selectionForSpan(
    span,
    target.field === "pose" ? "pose_body" : "hand_prop_state"
  );
}

function organizationEnvelope(context, {
  targetIds = [...context.targets.keys()],
  selectionsByTarget = new Map(),
  repairMode = null
} = {}) {
  const envelope = {
    targets: targetIds.map((targetId) => {
      const target = context.targets.get(targetId);
      assert.ok(target, `未知 targetId：${targetId}`);
      return {
        targetId,
        evidenceSelections: selectionsByTarget.has(targetId)
          ? selectionsByTarget.get(targetId)
          : [defaultSelection(context, target)]
      };
    })
  };
  if (repairMode) envelope.repairMode = repairMode;
  return envelope;
}

function normalizeAndReview(context, target, selections, {
  attempt = 1,
  repairMode = null
} = {}) {
  const normalizedTargets = validateStaticFrameEvidenceEnvelope({
    ...(repairMode ? { repairMode } : {}),
    targets: [{
      targetId: target.targetId,
      evidenceSelections: selections
    }]
  }, {
    expectedTargetIds: [target.targetId],
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
  }).get(target.targetId);
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

test("v3 只组织 pose 与 handPropState；所有非空字段也进入 AI，actionState 留给独立审核", async () => {
  const candidate = animationCandidate({
    pose: "躯干保持直立",
    handPropState: "双手未持道具",
    actionState: "角色想起远方的朋友"
  });
  const context = groundingContext(candidate);
  assert.deepEqual(
    [...context.targets.values()].map((target) => target.field),
    ["pose", "handPropState"]
  );
  assert.ok([...context.targets.values()].every(
    (target) => target.reasonCode === "field_semantic_organization"
  ));

  let calls = 0;
  const result = await compileStaticFrames(compilerOptions(candidate, {
    async generateJson() {
      calls += 1;
      return organizationEnvelope(context);
    }
  }));

  assert.equal(calls, 1);
  assert.equal(result.metadata.noOp, true);
  assert.equal(result.metadata.targetCount, 2);
  assert.deepEqual(result.compiledCandidate, candidate);
});

test("只有 actionState、没有可组织字段时才确定性 no-op", async () => {
  const candidate = animationCandidate({ actionState: "角色脸上露出惊讶表情" });
  delete candidate.shotPlan[0].startFrame.characters[0].pose;
  delete candidate.shotPlan[0].startFrame.characters[0].handPropState;
  let calls = 0;
  const result = await compileStaticFrames({
    candidate,
    client: {
      async generateJson() {
        calls += 1;
        throw new Error("不应调用");
      }
    },
    runId: "run-action-state-only"
  });

  assert.equal(calls, 0);
  assert.equal(result.metadata.noOp, true);
  assert.equal(result.metadata.skipReason, "NO_ORGANIZABLE_TARGET");
});

test("v3 prompt 把中文文字声明为非穷尽示例，而不是服务端关键词表", () => {
  const candidate = animationCandidate({
    pose: "左肩倚着门框",
    handPropState: "右手持蒲扇",
    actionState: "ACTION_STATE_SENTINEL"
  });
  const context = groundingContext(candidate, { runId: "run-prompt" });
  const prompt = buildStaticFrameCompilerPrompt(candidate, context.targets, {
    runId: "run-prompt"
  });
  const strictSkeleton = {
    targets: [...context.targets.keys()].map((targetId) => ({
      targetId,
      evidenceSelections: []
    }))
  };

  assert.match(prompt, /STATIC_FRAME_FIELD_ORGANIZATION_V3/u);
  assert.match(prompt, new RegExp(`本次必须输出 ${context.targets.size} 个 targets`, "u"));
  assert.ok(prompt.includes(JSON.stringify(strictSkeleton, null, 2)));
  assert.match(prompt, /targetId 数组必须与上方固定顺序逐项完全一致/u);
  assert.match(prompt, /每个 target 只选择“最小充分证据”/u);
  assert.match(prompt, /第一个字符必须是 \{，最后一个字符必须是 \}/u);
  assert.match(prompt, /输出紧凑 JSON/u);
  assert.match(prompt, /参考文字均为非穷尽示例，不是关键词表/u);
  assert.match(prompt, /禁止按 includes\/命中与否机械分类/u);
  assert.match(prompt, /pose_body_contact/u);
  assert.match(prompt, /hand_prop_state/u);
  assert.match(prompt, /抱着相册、持蒲扇、未持道具/u);
  assert.match(prompt, /"category":"pose_body","featureId":null/u);
  assert.doesNotMatch(prompt, /ACTION_STATE_SENTINEL/u);
});

test("Catalog 签发完整 source、clause 与 Intl.Segmenter word 原文 span，不做中文语义预审", () => {
  const candidate = animationCandidate({
    pose: "后背贴着竹篱笆",
    handPropState: "指尖捻着绣花针"
  });
  const context = groundingContext(candidate);
  const poseTarget = targetFor(context, "pose");
  const handTarget = targetFor(context, "handPropState");

  assert.equal(sourceSpan(context, poseTarget).text, "后背贴着竹篱笆");
  assert.equal(sourceSpan(context, handTarget).text, "指尖捻着绣花针");
  assert.equal(clauseSpan(context, poseTarget).text, "后背贴着竹篱笆");
  assert.equal(clauseSpan(context, handTarget).text, "指尖捻着绣花针");
  assert.ok(spansForTarget(context, poseTarget, { unit: "word" }).length > 0);
  assert.ok(spansForTarget(context, handTarget, { unit: "word" }).length > 0);
  assert.equal(context.audit.rejectionBySpanId.size, 0);
});

test("Field Organizer selection 全层 exact schema，并锁定 category、featureId 与签发 ID", () => {
  const context = groundingContext(animationCandidate());
  const poseTarget = targetFor(context, "pose");
  const poseSpan = sourceSpan(context, poseTarget);
  const safe = selectionForSpan(poseSpan, "pose_body");

  assert.throws(
    () => validateStaticFrameEvidenceEnvelope({
      targets: [{
        targetId: poseTarget.targetId,
        evidenceSelections: [{ ...safe, text: "模型不得回传文本" }]
      }]
    }, {
      expectedTargetIds: [poseTarget.targetId],
      audit: context.audit
    }),
    /只能包含 segmentId、spanIds、category、featureId/u
  );

  assert.throws(
    () => validateStaticFrameEvidenceEnvelope({
      targets: [{
        targetId: poseTarget.targetId,
        evidenceSelections: [{
          ...safe,
          spanIds: ["span-run-other-forged"]
        }]
      }]
    }, {
      expectedTargetIds: [poseTarget.targetId],
      audit: context.audit
    }),
    /非法、跨 segment、跨 target、过期或未经授权/u
  );

  assert.throws(
    () => validateStaticFrameEvidenceEnvelope({
      targets: [{
        targetId: poseTarget.targetId,
        evidenceSelections: [{ ...safe, category: "hand_prop_state" }]
      }]
    }, {
      expectedTargetIds: [poseTarget.targetId],
      audit: context.audit
    }),
    /category 与目标字段职责不兼容/u
  );

  assert.throws(
    () => validateStaticFrameEvidenceEnvelope({
      targets: [{
        targetId: poseTarget.targetId,
        evidenceSelections: [{ ...safe, featureId: "forged.feature" }]
      }]
    }, {
      expectedTargetIds: [poseTarget.targetId],
      audit: context.audit
    }),
    /非 character feature 类别中必须为 null/u
  );

  assert.throws(
    () => validateStaticFrameEvidenceEnvelope({
      targets: [{
        targetId: poseTarget.targetId,
        evidenceSelections: [{
          ...safe,
          category: "pose_character_feature",
          featureId: null
        }]
      }]
    }, {
      expectedTargetIds: [poseTarget.targetId],
      audit: context.audit
    }),
    /featureId 必须引用冻结 Character Feature/u
  );
});

test("非枚举道具由 AI 标注 hand_prop_state 后均可通过，不再依赖本地道具词表", async (t) => {
  const cases = [
    "双手抱着相册",
    "右手持蒲扇",
    "右手持木瓢",
    "双手托着热红薯",
    "指尖捻着绣花针"
  ];

  for (const handPropState of cases) {
    await t.test(handPropState, async () => {
      const candidate = animationCandidate({ handPropState });
      const context = groundingContext(candidate);
      const result = await compileStaticFrames(compilerOptions(candidate, {
        async generateJson() {
          return organizationEnvelope(context);
        }
      }));

      assert.equal(
        result.compiledCandidate.shotPlan[0].startFrame.characters[0].handPropState,
        handPropState
      );
      assert.equal(result.metadata.protocolCallCount, 1);
      const handMetadata = result.metadata.attempts[0].targets.find((entry) => (
        entry.targetId === targetFor(context, "handPropState").targetId
      ));
      assert.deepEqual(handMetadata.safeDimensions, ["handPropState"]);
    });
  }
});

test("非枚举环境支撑由 AI 标注 pose_body_contact 后均可通过", async (t) => {
  const cases = [
    "左肩倚着门框",
    "双手撑在灶台边缘",
    "后背贴着竹篱笆"
  ];

  for (const pose of cases) {
    await t.test(pose, async () => {
      const candidate = animationCandidate({ pose });
      const context = groundingContext(candidate);
      const poseTarget = targetFor(context, "pose");
      const selectionsByTarget = new Map([[
        poseTarget.targetId,
        [selectionForSpan(sourceSpan(context, poseTarget), "pose_body_contact")]
      ]]);
      const result = await compileStaticFrames(compilerOptions(candidate, {
        async generateJson() {
          return organizationEnvelope(context, { selectionsByTarget });
        }
      }));

      assert.equal(
        result.compiledCandidate.shotPlan[0].startFrame.characters[0].pose,
        pose
      );
      const poseMetadata = result.metadata.attempts[0].targets.find((entry) => (
        entry.targetId === poseTarget.targetId
      ));
      assert.deepEqual(poseMetadata.safeDimensions, ["bodyContact"]);
    });
  }
});

test("AI category 决定字段维度，服务端不再从同一段中文推断 body/limbs/orientation/bodyContact", () => {
  const categories = [
    ["pose_body", "body"],
    ["pose_limbs", "limbs"],
    ["pose_orientation", "orientation"],
    ["pose_body_contact", "bodyContact"]
  ];
  const context = groundingContext(animationCandidate({
    pose: "这是一段服务端不应自行分类的原文"
  }));
  const target = targetFor(context, "pose");
  const span = sourceSpan(context, target);

  for (const [category, expectedDimension] of categories) {
    const review = normalizeAndReview(
      context,
      target,
      [selectionForSpan(span, category)]
    );
    assert.equal(review.slots.length, 1);
    assert.equal(review.slots[0].category, category);
    assert.equal(review.slots[0].primaryDimensionKey, expectedDimension);
    assert.equal(review.slots[0].groundedText, span.text);
  }
});

test("多 span 只能删除原文中间成分，无法让模型返回或创造新文字", () => {
  const candidate = animationCandidate({
    handPropState: "随后双手正在抱着相册"
  });
  const original = structuredClone(candidate);
  const context = groundingContext(candidate);
  const target = targetFor(context, "handPropState");
  const segment = [...context.catalog.segments.values()].find((entry) => (
    entry.targetId === target.targetId && entry.field === "handPropState"
  ));
  assert.ok(segment);
  const selectedWords = segment.spanIds
    .map((spanId) => context.catalog.spans.get(spanId))
    .filter((span) => span.unit === "word")
    .filter((span) => !["随后", "正在"].includes(span.text));
  const review = normalizeAndReview(
    context,
    target,
    [selectionForSpans(selectedWords, "hand_prop_state")]
  );
  const result = enumerateGroundedPatchCombinations(target, review, {
    candidate
  });

  assert.equal(result.patch.value, "双手抱着相册");
  assert.deepEqual(candidate, original);
  assert.ok(result.patch.visibleFacts.every((fact) => (
    fact.split("").every((character) => segment.displayText.includes(character))
  )));
});

test("两种 AI 显式 pose category 可确定性组合，顺序仍由原文 span 锁定", () => {
  const candidate = animationCandidate({
    pose: "躯干前倾，双手垂在身侧"
  });
  const context = groundingContext(candidate);
  const target = targetFor(context, "pose");
  const body = clauseSpan(context, target, { text: "躯干前倾" });
  const limbs = clauseSpan(context, target, { text: "双手垂在身侧" });
  const review = normalizeAndReview(context, target, [
    selectionForSpan(limbs, "pose_limbs"),
    selectionForSpan(body, "pose_body")
  ]);
  const result = enumerateGroundedPatchCombinations(target, review, {
    candidate
  });

  assert.equal(review.requiredDimensionCount, 2);
  assert.deepEqual(
    result.search.map((entry) => entry.stateSlotIds.length),
    [1, 1, 2]
  );
  assert.deepEqual(result.patch.visibleFacts, ["躯干前倾", "双手垂在身侧"]);
  assert.equal(result.patch.value, "躯干前倾，双手垂在身侧");
});

test("Character Feature 必须绑定同一 target 的冻结 featureId，且原文必须含冻结 term", () => {
  const profile = wolfFeatureProfile();
  const candidate = animationCandidate({ pose: "狼尾垂在身后" });
  const context = groundingContext(candidate, {
    characterFeatureProfile: profile
  });
  const target = targetFor(context, "pose");
  const span = sourceSpan(context, target);
  const valid = normalizeAndReview(context, target, [
    selectionForSpan(
      span,
      "pose_character_feature",
      "character-xiaobaizi.wolf_tail"
    )
  ]);
  assert.equal(valid.slots.length, 1);
  assert.equal(
    valid.slots[0].primaryDimensionKey,
    "characterFeature:character-xiaobaizi.wolf_tail"
  );

  const forged = normalizeAndReview(context, target, [
    selectionForSpan(span, "pose_character_feature", "character-other.wolf_tail")
  ]);
  assert.equal(forged.slots.length, 0);
  assert.deepEqual(
    forged.rejectedSelections.map((entry) => entry.reason),
    ["UNBOUND_CHARACTER_FEATURE"]
  );

  const absentTermContext = groundingContext(animationCandidate({ pose: "躯干保持直立" }), {
    characterFeatureProfile: profile,
    runId: "run-feature-term-absent"
  });
  const absentTarget = targetFor(absentTermContext, "pose");
  const absent = normalizeAndReview(absentTermContext, absentTarget, [
    selectionForSpan(
      sourceSpan(absentTermContext, absentTarget),
      "pose_character_feature",
      "character-xiaobaizi.wolf_tail"
    )
  ]);
  assert.equal(absent.slots.length, 0);
  assert.equal(absent.rejectedSelections[0].reason, "UNBOUND_CHARACTER_FEATURE");
});

test("冻结 feature 不能从另一角色的 profile 借给当前 target", () => {
  const context = groundingContext(animationCandidate({ pose: "狼尾垂在身后" }), {
    characterFeatureProfile: wolfFeatureProfile("character-other")
  });
  const target = targetFor(context, "pose");
  const review = normalizeAndReview(context, target, [
    selectionForSpan(
      sourceSpan(context, target),
      "pose_character_feature",
      "character-other.wolf_tail"
    )
  ]);

  assert.equal(review.slots.length, 0);
  assert.equal(review.rejectedSelections[0].reason, "UNBOUND_CHARACTER_FEATURE");
});

test("Catalog 使用当前画面全部角色名，拒绝跨角色原文证据", () => {
  const candidate = animationCandidate({
    pose: "小黑站在门边，小白子保持直立"
  });
  candidate.shotPlan[0].startFrame.characters.push({
    name: "小黑",
    characterId: "character-xiaohei",
    pose: "身体保持站立",
    handPropState: "双手未持道具",
    actionState: ""
  });
  const context = groundingContext(candidate, { runId: "run-cross-character" });
  const target = targetFor(context, "pose", { characterIndex: 0 });
  const crossCharacterSpans = [...context.catalog.spans.values()].filter((span) => (
    span.targetId === target.targetId && span.text.includes("小黑")
  ));

  assert.ok(crossCharacterSpans.length > 0);
  crossCharacterSpans.forEach((span) => {
    assert.equal(
      context.audit.candidateSpanIdsByTarget.get(target.targetId).has(span.spanId),
      false
    );
    assert.equal(
      context.audit.rejectionBySpanId.get(span.spanId),
      "AMBIGUOUS_OR_CROSS_CHARACTER_EVIDENCE"
    );
  });
});

test("非法首次 envelope 只允许一次 envelope_repair，修复后仍使用首次签发 ID", async () => {
  const candidate = animationCandidate({
    pose: "左肩倚着门框",
    handPropState: "右手持木瓢"
  });
  const context = groundingContext(candidate);
  const requests = [];
  const client = {
    async generateJson(request) {
      requests.push(request);
      if (requests.length === 1) {
        return {
          ...organizationEnvelope(context),
          visibleFacts: ["禁止的额外字段"]
        };
      }
      return organizationEnvelope(context, { repairMode: "envelope_repair" });
    }
  };

  const { compiledCandidate, metadata } = await compileStaticFrames(
    compilerOptions(candidate, client)
  );

  assert.equal(requests.length, 2);
  assert.match(requests[1].prompt, /STATIC_FRAME_ORGANIZER_ENVELOPE_REPAIR_V3/u);
  const strictRepairSkeleton = {
    repairMode: "envelope_repair",
    targets: [...context.targets.keys()].map((targetId) => ({
      targetId,
      evidenceSelections: []
    }))
  };
  assert.match(
    requests[1].prompt,
    new RegExp(`本次必须输出 ${context.targets.size} 个 targets`, "u")
  );
  assert.ok(requests[1].prompt.includes(JSON.stringify(strictRepairSkeleton, null, 2)));
  assert.equal(metadata.repairMode, "envelope_repair");
  assert.equal(metadata.protocolCallCount, 2);
  assert.equal(metadata.finalResult, "accepted");
  assert.deepEqual(compiledCandidate, candidate);
});

test("两次 envelope 均非法时终止为 protocol，不能伪装成 candidate 错误", async () => {
  const candidate = animationCandidate();
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

test("首次漏选 target 只进行一次 field_reorganization，attempt-2 独立替代并成功", async () => {
  const candidate = animationCandidate({
    pose: "后背贴着竹篱笆",
    handPropState: "双手托着热红薯"
  });
  const context = groundingContext(candidate);
  const handTarget = targetFor(context, "handPropState");
  const firstSelections = new Map([[handTarget.targetId, []]]);
  const requests = [];
  const client = {
    async generateJson(request) {
      requests.push(request);
      if (requests.length === 1) {
        return organizationEnvelope(context, {
          selectionsByTarget: firstSelections
        });
      }
      return organizationEnvelope(context, {
        targetIds: [handTarget.targetId],
        repairMode: "evidence_reselection"
      });
    }
  };

  const { compiledCandidate, metadata } = await compileStaticFrames(
    compilerOptions(candidate, client)
  );

  assert.equal(requests.length, 2);
  assert.match(requests[1].prompt, /STATIC_FRAME_FIELD_REORGANIZATION_V3/u);
  assert.equal(metadata.repairMode, "evidence_reselection");
  assert.equal(metadata.attempts.length, 2);
  assert.equal(metadata.attempts[0].targets.find(
    (entry) => entry.targetId === handTarget.targetId
  ).selectedValidatedEvidenceCount, 0);
  assert.equal(metadata.attempts[1].targets[0].selectedValidatedEvidenceCount, 1);
  assert.deepEqual(compiledCandidate, candidate);
});

test("field_reorganization 后仍无 grounded selection 时返回 EVIDENCE_RESELECTION_EXHAUSTED，且无第三次", async () => {
  const candidate = animationCandidate();
  const context = groundingContext(candidate);
  let calls = 0;
  const emptySelections = new Map(
    [...context.targets.keys()].map((targetId) => [targetId, []])
  );
  const client = {
    async generateJson() {
      calls += 1;
      return organizationEnvelope(context, {
        selectionsByTarget: emptySelections,
        ...(calls === 2 ? { repairMode: "evidence_reselection" } : {})
      });
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

test("空 handPropState 没有可签发原文时，结构性返回 NO_STATIC_EVIDENCE_IN_SOURCE 且跳过 AI", async () => {
  const candidate = animationCandidate({ handPropState: "" });
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

test("candidate-level 错误码保持为可交给 Animation Batch Retry 的三类", () => {
  assert.deepEqual(STATIC_FRAME_CANDIDATE_ERROR_CODES, [
    "NO_STATIC_EVIDENCE_IN_SOURCE",
    "NO_VALID_GROUNDED_COMBINATION",
    "EVIDENCE_RESELECTION_EXHAUSTED"
  ]);
});

test("单次 protocol attempt 只进行一次瞬态 transport retry", async () => {
  const candidate = animationCandidate({
    pose: "左肩倚着门框",
    handPropState: "指尖捻着绣花针"
  });
  const context = groundingContext(candidate);
  let calls = 0;
  const client = {
    async generateJson() {
      calls += 1;
      if (calls === 1) {
        const error = new Error("connection reset");
        error.code = "ECONNRESET";
        throw error;
      }
      return organizationEnvelope(context);
    }
  };

  const { metadata } = await compileStaticFrames(compilerOptions(candidate, client));

  assert.equal(calls, 2);
  assert.equal(metadata.protocolCallCount, 1);
  assert.equal(metadata.requestCount, 2);
  assert.equal(metadata.protocolAttempts[0].transportAttempts.length, 2);
  assert.equal(metadata.repairMode, null);
});

test("provider/transport 最终错误保持非 candidate，不能触发内容恢复语义", async () => {
  const candidate = animationCandidate();
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
