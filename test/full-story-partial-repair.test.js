import test from "node:test";
import assert from "node:assert/strict";
import {
  fullStoryPartialRepairPrompt,
  mergeFullStoryPartialRepair,
  planFullStoryPartialRepair
} from "../src/full-story-partial-repair.js";
import { mockFullStory } from "../src/mock.js";
import { OutputContractError, ensureOutputContract } from "../src/validation.js";

const context = {
  creatorProfile: {
    fixedCharacter: "阿岚，社区修理师",
    vertical: "社区维修",
    constraints: "60 秒内"
  },
  variant: {
    id: "V1",
    title: "最后一格电",
    characterSetup: {
      protagonist: "阿岚，社区修理师",
      careRecipient: "铃木奶奶",
      helper: "夜班便利店员"
    },
    newTask: "修好旧收音机",
    emotionalMedium: "一台旧收音机",
    environmentPressure: "暴雨停电",
    endingRitual: "铃木奶奶按下播放键"
  },
  visualGuardrails: {
    fixedCharacterBoundary: {
      characterName: "阿岚",
      boundaryDigest: `sha256:${"a".repeat(64)}`,
      requiredTraits: []
    }
  }
};

function malformedStory() {
  const story = mockFullStory(context);
  story.title = "UNRELATED_TITLE_SENTINEL";
  story.beatSheet[0].storyAction = "UNRELATED_BEAT_SENTINEL";
  story.sceneScript[5].shootingNotes = "UNRELATED_SCENE_SENTINEL";
  delete story.characterBible.protagonist.name;
  return story;
}

function ambiguousMalformedStory() {
  const story = mockFullStory(context);
  story.characterBible.protagonist["困倦时狼耳微微耷拉"] = "";
  story.characterBible.protagonist["感激时用力抱紧物品并发出长长的"] = "";
  const beat = story.beatSheet[4];
  delete beat.emotion;
  delete beat.dramaticFunction;
  delete beat.retainedValueFromBrief;
  beat["村民们迅速从四面八方赶来并搭起油布棚"] = "";
  beat["感动、温暖、强烈的归属感与安全感"] = "";
  beat["天气突变催化全村集体行动"] = "";
  story.sceneScript[2]["脱背心和盖背心的动作要格外轻柔"] = "";
  return story;
}

function repairPlan(story) {
  const error = outputContractError(story);
  return planFullStoryPartialRepair(story, error, context);
}

function outputContractError(story) {
  let error;
  try {
    ensureOutputContract(story, "fullStory");
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof OutputContractError);
  return error;
}

function repairableProtagonistStory() {
  const story = mockFullStory(context);
  delete story.characterBible.protagonist.name;
  return story;
}

function validProtagonistEnvelope(story, plan) {
  const replacement = structuredClone(story.characterBible.protagonist);
  replacement.name = context.visualGuardrails.fixedCharacterBoundary.characterName;
  return {
    schemaVersion: plan.schemaVersion,
    baseDigest: plan.baseDigest,
    repairs: [{
      repairId: plan.targets[0].repairId,
      replacement
    }]
  };
}

function validEnvelope(story, plan) {
  return validProtagonistEnvelope(story, plan);
}

test("真实混合键值颠倒错误因字段语义目的地不唯一而 fail closed", () => {
  const story = ambiguousMalformedStory();
  assert.equal(repairPlan(story), null);
});

test("签发 fixedCharacterBoundary 可唯一恢复 protagonist.name", () => {
  const story = malformedStory();
  const plan = repairPlan(story);
  assert.deepEqual(
    plan.targets.map((target) => target.path),
    ["/characterBible/protagonist"]
  );
  const prompt = fullStoryPartialRepairPrompt(plan);
  assert.match(prompt, /FULL_STORY_SUBTREE_REPAIR_V1/u);
  assert.match(prompt, /expectedFields/u);
  assert.match(prompt, /"name":"阿岚"/u);
  assert.doesNotMatch(prompt, /UNRELATED_TITLE_SENTINEL|UNRELATED_BEAT_SENTINEL|UNRELATED_SCENE_SENTINEL/u);
  assert.doesNotMatch(prompt, /selectedVariantId.*title.*oneLinePremise.*targetDurationSeconds/us);
});

test("局部计划只接受 code、RFC6901 Pointer 与 reason 完全一致的诊断", () => {
  const story = malformedStory();
  const error = outputContractError(story);
  const original = error.details.find((detail) => (
    detail.code === "FULL_STORY_SCHEMA_REQUIRED"
    && detail.path === "/characterBible/protagonist/name"
  ));
  assert.ok(original);

  const missingReason = { ...original };
  delete missingReason.reason;
  assert.equal(
    planFullStoryPartialRepair(
      story,
      new OutputContractError("缺少 reason", [missingReason]),
      context
    ),
    null
  );

  assert.equal(
    planFullStoryPartialRepair(
      story,
      new OutputContractError("reason 与 code 不一致", [{
        ...original,
        reason: "包含未定义字段"
      }]),
      context
    ),
    null
  );

  assert.equal(
    planFullStoryPartialRepair(
      story,
      new OutputContractError("两个 Pointer 冲突", [{
        ...original,
        jsonPointer: "/title"
      }]),
      context
    ),
    null
  );

  const matchingPlan = planFullStoryPartialRepair(
    story,
    new OutputContractError("两个 Pointer 一致", [{
      ...original,
      jsonPointer: original.path
    }]),
    context
  );
  assert.ok(matchingPlan);
  assert.equal(matchingPlan.targets[0].diagnostics[0].path, original.path);
});

test("诊断 code、Pointer、reason 必须是原始字符串，不能用数组类型混淆", () => {
  const story = malformedStory();
  const error = outputContractError(story);
  const original = error.details.find((detail) => (
    detail.code === "FULL_STORY_SCHEMA_REQUIRED"
    && detail.path === "/characterBible/protagonist/name"
  ));
  assert.ok(original);

  for (const field of ["code", "path", "reason"]) {
    const forged = { ...original, [field]: [original[field]] };
    assert.equal(
      planFullStoryPartialRepair(
        story,
        new OutputContractError(`数组伪造 ${field}`, [forged]),
        context
      ),
      null
    );
  }

  assert.equal(
    planFullStoryPartialRepair(
      story,
      new OutputContractError("数组伪造 jsonPointer", [{
        ...original,
        jsonPointer: [original.path]
      }]),
      context
    ),
    null
  );
});

test("诊断必须是一次性读取的纯数据对象，拒绝类实例、继承字段与 getter", () => {
  const story = malformedStory();
  const error = outputContractError(story);
  const original = error.details.find((detail) => (
    detail.code === "FULL_STORY_SCHEMA_REQUIRED"
    && detail.path === "/characterBible/protagonist/name"
  ));
  assert.ok(original);

  class Diagnostic {
    constructor() {
      Object.assign(this, original);
    }
  }
  const dateDiagnostic = new Date();
  Object.assign(dateDiagnostic, original);
  const inheritedPointer = Object.assign(
    Object.create({ jsonPointer: "/title" }),
    original
  );
  const getterDiagnostic = {};
  for (const field of ["code", "path", "reason"]) {
    Object.defineProperty(getterDiagnostic, field, {
      enumerable: true,
      get() {
        return original[field];
      }
    });
  }

  for (const forged of [
    new Diagnostic(),
    dateDiagnostic,
    inheritedPointer,
    getterDiagnostic
  ]) {
    assert.equal(
      planFullStoryPartialRepair(
        story,
        new OutputContractError("非纯数据诊断", [forged]),
        context
      ),
      null
    );
  }
});

test("诊断只接受真实验证器的精确可枚举 data-property 集合", () => {
  const story = malformedStory();
  const error = outputContractError(story);
  const original = error.details.find((detail) => (
    detail.code === "FULL_STORY_SCHEMA_REQUIRED"
    && detail.path === "/characterBible/protagonist/name"
  ));
  assert.ok(original);

  const extraGetter = { ...original };
  Object.defineProperty(extraGetter, "extra", {
    enumerable: true,
    get() {
      return "伪造";
    }
  });
  const extraObject = { ...original, extra: { hidden: true } };
  const nonEnumerable = {};
  for (const [field, value] of Object.entries(original)) {
    Object.defineProperty(nonEnumerable, field, { value, enumerable: false });
  }
  const symbolField = { ...original, [Symbol("extra")]: "伪造" };
  const wrongKeyword = { ...original, keyword: "type" };
  const paddedReason = { ...original, reason: ` ${original.reason} ` };

  for (const forged of [
    extraGetter,
    extraObject,
    nonEnumerable,
    symbolField,
    wrongKeyword,
    paddedReason
  ]) {
    assert.equal(
      planFullStoryPartialRepair(
        story,
        new OutputContractError("非精确诊断", [forged]),
        context
      ),
      null
    );
  }
});

test("诊断和 details 容器都拒绝 Proxy、索引 getter、稀疏项与额外属性", () => {
  const story = malformedStory();
  const error = outputContractError(story);
  const original = error.details.find((detail) => (
    detail.code === "FULL_STORY_SCHEMA_REQUIRED"
    && detail.path === "/characterBible/protagonist/name"
  ));
  assert.ok(original);

  const proxyDiagnostic = new Proxy({ ...original }, {});
  const accessorDetails = [];
  Object.defineProperty(accessorDetails, "0", {
    enumerable: true,
    get() {
      return original;
    }
  });
  accessorDetails.length = 1;
  const sparseDetails = new Array(1);
  const extraDetails = [original];
  extraDetails.extra = true;
  const proxyDetails = new Proxy([original], {});
  class DiagnosticList extends Array {}
  const subclassDetails = new DiagnosticList(original);
  const customPrototypeDetails = [original];
  Object.setPrototypeOf(customPrototypeDetails, {});

  for (const details of [
    [proxyDiagnostic],
    accessorDetails,
    sparseDetails,
    extraDetails,
    proxyDetails,
    subclassDetails,
    customPrototypeDetails
  ]) {
    assert.equal(
      planFullStoryPartialRepair(
        story,
        new OutputContractError("非纯数据 details", details),
        context
      ),
      null
    );
  }
});

test("错误容器必须是真实 OutputContractError 的自有 details data property", () => {
  const story = malformedStory();
  const validError = outputContractError(story);
  const originalDetails = validError.details;

  const accessorError = new OutputContractError("getter details");
  Object.defineProperty(accessorError, "details", {
    configurable: true,
    get() {
      return originalDetails;
    }
  });
  const inheritedError = Object.create(validError);
  const proxyError = new Proxy(validError, {});

  for (const forged of [accessorError, inheritedError, proxyError, { details: originalDetails }]) {
    assert.equal(planFullStoryPartialRepair(story, forged, context), null);
  }
});

test("局部修复原子合并且未命中子树逐字保留", () => {
  const story = malformedStory();
  const frozen = structuredClone(story);
  const plan = repairPlan(story);
  const merged = mergeFullStoryPartialRepair(story, validEnvelope(story, plan), plan, context);
  assert.doesNotThrow(() => ensureOutputContract(merged, "fullStory"));
  assert.deepEqual(story, frozen);
  assert.equal(merged.title, "UNRELATED_TITLE_SENTINEL");
  assert.equal(merged.beatSheet[0].storyAction, "UNRELATED_BEAT_SENTINEL");
  assert.equal(merged.sceneScript[5].shootingNotes, "UNRELATED_SCENE_SENTINEL");
  assert.equal(merged.characterBible.protagonist.name, "阿岚");
});

test("局部修复协议拒绝遗漏、越权、乱序和危险路径且不污染原型", () => {
  const story = malformedStory();
  const frozen = structuredClone(story);
  const plan = repairPlan(story);
  const base = validEnvelope(story, plan);
  const cases = [
    { ...base, repairs: base.repairs.slice(1) },
    { ...base, extra: true },
    { ...base, repairs: base.repairs.map((item, index) => index ? item : { ...item, path: "/title" }) },
    { ...base, repairs: base.repairs.map((item, index) => index ? item : { ...item, op: "replace" }) },
    { ...base, repairs: [base.repairs[0], { ...base.repairs[1], repairId: "R1" }, ...base.repairs.slice(2)] },
    { ...base, repairs: [base.repairs[1], base.repairs[0], ...base.repairs.slice(2)] },
    { ...base, baseDigest: "0".repeat(64) }
  ];
  for (const envelope of cases) {
    assert.throws(() => mergeFullStoryPartialRepair(story, envelope, plan, context), OutputContractError);
    assert.deepEqual(story, frozen);
    assert.equal(({}).polluted, undefined);
  }
});

test("局部修复拒绝改变目标子树内未命中的合法字段", () => {
  const story = malformedStory();
  const plan = repairPlan(story);
  const envelope = validEnvelope(story, plan);
  envelope.repairs[0].replacement.identity = "完全不同的身份";
  assert.throws(
    () => mergeFullStoryPartialRepair(story, envelope, plan, context),
    /越权改变未命中字段 identity/u
  );
});

test("未知正文没有字段级权威时不签计划，签发姓名也不能被替换成其他身份", () => {
  const ambiguous = mockFullStory(context);
  ambiguous.characterBible.protagonist["白色长发，蓝色眼睛"] = "";
  assert.equal(repairPlan(ambiguous), null);

  const story = malformedStory();
  const plan = repairPlan(story);
  const rewritten = structuredClone(story.characterBible.protagonist);
  rewritten.name = "陌生人";
  assert.throws(() => mergeFullStoryPartialRepair(story, {
    schemaVersion: plan.schemaVersion,
    baseDigest: plan.baseDigest,
    repairs: [{ repairId: "R1", replacement: rewritten }]
  }, plan, context), /必须逐字等于签发权威值/u);
});

test("顶层未知字段、整项丢失与危险 Pointer 不进入局部修复", () => {
  const story = mockFullStory(context);
  story.schemaVersion = "full-story/v1";
  let error;
  try {
    ensureOutputContract(story, "fullStory");
  } catch (caught) {
    error = caught;
  }
  assert.equal(planFullStoryPartialRepair(story, error, context), null);

  const missingItem = mockFullStory(context);
  missingItem.sceneScript[2] = null;
  try {
    ensureOutputContract(missingItem, "fullStory");
  } catch (caught) {
    error = caught;
  }
  assert.equal(planFullStoryPartialRepair(missingItem, error, context), null);

  const dangerous = new OutputContractError("危险路径", [{
    code: "FULL_STORY_SCENE_STRING_REQUIRED",
    path: "fullStory.sceneScript[2].location",
    jsonPointer: "/sceneScript/2/__proto__/polluted",
    reason: "测试"
  }]);
  assert.equal(planFullStoryPartialRepair(mockFullStory(context), dangerous, context), null);
  assert.equal(({}).polluted, undefined);
});

test("无可信结构化路径或数组级错误不会伪造局部修复", () => {
  const story = mockFullStory(context);
  assert.equal(planFullStoryPartialRepair(story, new OutputContractError("语义错误"), context), null);
  const short = { ...story, beatSheet: story.beatSheet.slice(0, 5) };
  let error;
  try {
    ensureOutputContract(short, "fullStory");
  } catch (caught) {
    error = caught;
  }
  assert.equal(planFullStoryPartialRepair(short, error, context), null);
});

test("只有 fixedCharacterBoundary 可唯一决定的 protagonist.name 允许补写", async (t) => {
  const cases = [
    {
      name: "protagonist.name required",
      mutate(story) {
        delete story.characterBible.protagonist.name;
      },
      expectedPath: "/characterBible/protagonist/name",
      repairable: true
    },
    {
      name: "protagonist.name type",
      mutate(story) {
        story.characterBible.protagonist.name = 42;
      },
      expectedPath: "/characterBible/protagonist/name",
      repairable: true
    },
    {
      name: "protagonist.name empty",
      mutate(story) {
        story.characterBible.protagonist.name = "";
      },
      expectedPath: "/characterBible/protagonist/name",
      repairable: true
    },
    {
      name: "careRecipient.nameOrLabel",
      mutate(story) {
        delete story.characterBible.careRecipient.nameOrLabel;
      },
      expectedPath: "/characterBible/careRecipient/nameOrLabel"
    },
    {
      name: "helpers[0].nameOrLabel",
      mutate(story) {
        delete story.characterBible.helpers[0].nameOrLabel;
      },
      expectedPath: "/characterBible/helpers/0/nameOrLabel"
    }
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, () => {
      const story = mockFullStory(context);
      scenario.mutate(story);
      const error = outputContractError(story);
      assert.ok(error.details.some((detail) => detail.path === scenario.expectedPath));
      const plan = planFullStoryPartialRepair(story, error, context);
      if (scenario.repairable) {
        assert.ok(plan);
        assert.deepEqual(plan.targets[0].expectedFields, { name: "阿岚" });
      } else {
        assert.equal(plan, null);
      }
    });
  }
});

test("Scene Contract 的跨字段角色冲突不得通过局部修复猜测出镜事实", () => {
  const story = mockFullStory(context);
  const scene = story.sceneScript[0];
  scene.characters = [story.characterBible.helpers[0].nameOrLabel];
  // visibleAction 与 dialogue 都仍明确指向主角；服务端只能证明字段互相
  // 冲突，不能据此决定删除正文角色还是把角色加入 characters。
  const error = outputContractError(story);
  assert.ok(error.details.some((detail) => detail.code === "FULL_STORY_SCENE_VISUAL_CHARACTER_MISSING"));
  assert.ok(error.details.some((detail) => detail.code === "FULL_STORY_SCENE_DIALOGUE_SPEAKER_MISSING"));
  assert.equal(planFullStoryPartialRepair(story, error, context), null);
});

test("缺失剧情字段且没有未知正文迁移来源时不得让模型补写新剧情", async (t) => {
  for (const field of ["storyAction", "emotion"]) {
    await t.test(field, () => {
      const story = mockFullStory(context);
      delete story.beatSheet[4][field];
      const error = outputContractError(story);
      assert.ok(error.details.some((detail) => (
        detail.code === "FULL_STORY_SCHEMA_REQUIRED"
        && detail.path === `/beatSheet/4/${field}`
      )));
      assert.equal(
        Object.keys(story.beatSheet[4]).some((key) => ![
          "beat",
          "timeRange",
          "storyAction",
          "emotion",
          "dramaticFunction",
          "retainedValueFromBrief"
        ].includes(key)),
        false,
        `候选中没有可迁移到 ${field} 的未知正文`
      );
      assert.equal(planFullStoryPartialRepair(story, error, context), null);
    });
  }
});

test("只有服务端本次签发的 repair plan 实例可以合并，伪造或 structuredClone 均拒绝", () => {
  const story = repairableProtagonistStory();
  const frozen = structuredClone(story);
  const plan = repairPlan(story);
  const envelope = validProtagonistEnvelope(story, plan);
  const plans = [
    structuredClone(plan),
    { ...structuredClone(plan) }
  ];

  for (const unissuedPlan of plans) {
    assert.throws(
      () => mergeFullStoryPartialRepair(story, envelope, unissuedPlan, context),
      OutputContractError
    );
    assert.deepEqual(story, frozen);
  }
});

test("repair plan 签发后上游权威变化必须拒绝合并", () => {
  const story = repairableProtagonistStory();
  const frozen = structuredClone(story);
  const plan = repairPlan(story);
  const envelope = validProtagonistEnvelope(story, plan);
  const changedContext = structuredClone(context);
  changedContext.variant.id = "V2";

  assert.throws(
    () => mergeFullStoryPartialRepair(story, envelope, plan, changedContext),
    /权威上下文已经失效/u
  );
  assert.deepEqual(story, frozen);
});

test("Variant ID 不变但剧情任务变化时旧 repair plan 必须失效", () => {
  const story = repairableProtagonistStory();
  const frozen = structuredClone(story);
  const plan = repairPlan(story);
  const envelope = validProtagonistEnvelope(story, plan);
  const changedContext = structuredClone(context);
  assert.equal(changedContext.variant.id, context.variant.id);
  changedContext.variant.newTask = "把旧收音机改造成全新的广播设备";

  assert.throws(
    () => mergeFullStoryPartialRepair(story, envelope, plan, changedContext),
    /权威上下文已经失效/u
  );
  assert.deepEqual(story, frozen);
});

test("固定角色边界摘要或特征变化时旧 repair plan 必须失效", async (t) => {
  const authorityContext = structuredClone(context);
  authorityContext.visualGuardrails = {
    fixedCharacterBoundary: {
      characterName: "阿岚",
      boundaryDigest: `sha256:${"a".repeat(64)}`,
      requiredTraits: [{
        canonicalName: "深蓝色工作服",
        terms: ["深蓝工作服"]
      }]
    }
  };

  const cases = [
    {
      name: "boundaryDigest",
      mutate(nextContext) {
        nextContext.visualGuardrails.fixedCharacterBoundary.boundaryDigest = `sha256:${"b".repeat(64)}`;
      }
    },
    {
      name: "requiredTraits",
      mutate(nextContext) {
        nextContext.visualGuardrails.fixedCharacterBoundary.requiredTraits[0].terms.push("藏蓝维修制服");
      }
    }
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, () => {
      const story = repairableProtagonistStory();
      const frozen = structuredClone(story);
      const error = outputContractError(story);
      const plan = planFullStoryPartialRepair(story, error, authorityContext);
      assert.ok(plan);
      const envelope = validProtagonistEnvelope(story, plan);
      const changedContext = structuredClone(authorityContext);
      scenario.mutate(changedContext);

      assert.throws(
        () => mergeFullStoryPartialRepair(story, envelope, plan, changedContext),
        /权威上下文已经失效/u
      );
      assert.deepEqual(story, frozen);
    });
  }
});
