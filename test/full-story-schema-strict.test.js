import test from "node:test";
import assert from "node:assert/strict";
import { mockBrief, mockFullStory } from "../src/mock.js";
import { serializeServerError } from "../src/server-error.js";
import { OutputContractError, ensureOutputContract } from "../src/validation.js";
import { WorkflowService } from "../src/workflow.js";
import { withGlobalCharacterBoundary } from "./helpers/global-character-boundary.js";

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
  }
};

function validStory() {
  return mockFullStory(context);
}

// 从 characterBible 注销一个角色时，必须同时把他从场次里撤下来。
// 只删登记、留着人在画面里，那不是「没有被照料对象的故事」，而是一个跨场复现却
// 无人登记的角色——FULL_STORY_SCENE_CHARACTER_NOT_REGISTERED 正是为这种不一致而设。
// 这两条测试要证的是 schema 允许省略这个角色位，不是允许故事自相矛盾。
function withoutCharacter(story, name) {
  story.sceneScript.forEach((scene) => {
    scene.characters = scene.characters.filter((character) => character !== name);
    scene.visibleAction = scene.visibleAction.split(name).join("邻居");
    scene.shotAndSound = scene.shotAndSound.split(name).join("邻居");
    scene.dialogue = scene.dialogue.filter((line) => line.speaker !== name);
  });
  return story;
}

test("internal legacy Full Story schema accepts the current canonical shape", () => {
  assert.equal(ensureOutputContract(validStory(), "fullStory").selectedVariantId, "V1");
});

test("internal legacy Full Story schema rejects missing, null, wrong-type and unknown fields recursively", () => {
  const cases = [
    {
      mutate(story) { delete story.characterBible.protagonist.identity; },
      code: "FULL_STORY_SCHEMA_REQUIRED",
      path: "/characterBible/protagonist/identity"
    },
    {
      mutate(story) { story.characterBible.careRecipient.implicitNeed = null; },
      code: "FULL_STORY_SCHEMA_TYPE",
      path: "/characterBible/careRecipient/implicitNeed"
    },
    {
      mutate(story) { story.sceneScript[0].dialogue = {}; },
      code: "FULL_STORY_SCHEMA_TYPE",
      path: "/sceneScript/0/dialogue"
    },
    {
      mutate(story) { story.sceneScript[0].unexpectedProjection = "not canonical"; },
      code: "FULL_STORY_SCHEMA_UNKNOWN_FIELD",
      path: "/sceneScript/0/unexpectedProjection"
    },
    {
      mutate(story) { story.schemaVersion = "full-story/v1"; },
      code: "FULL_STORY_SCHEMA_UNKNOWN_FIELD",
      path: "/schemaVersion"
    }
  ];

  for (const fixture of cases) {
    const story = validStory();
    fixture.mutate(story);
    assert.throws(
      () => ensureOutputContract(story, "fullStory"),
      (error) => error instanceof OutputContractError
        && error.details.some((detail) => (
          detail.code === fixture.code && detail.path === fixture.path
        ))
    );
  }
});

test("strict schema diagnostics aggregate stable JSON Pointer paths without exposing the internal schema id", () => {
  const story = validStory();
  story.title = null;
  story.beatSheet[0] = null;
  story.sceneScript[1].characters = null;
  story.keyProps[0].extra = true;

  let caught;
  try {
    ensureOutputContract(story, "fullStory");
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof OutputContractError);
  assert.deepEqual(
    caught.details.map(({ code, path }) => ({ code, path })),
    [
      { code: "FULL_STORY_SCHEMA_TYPE", path: "/title" },
      { code: "FULL_STORY_SCHEMA_TYPE", path: "/beatSheet/0" },
      { code: "FULL_STORY_SCHEMA_TYPE", path: "/sceneScript/1/characters" },
      { code: "FULL_STORY_SCHEMA_UNKNOWN_FIELD", path: "/keyProps/0/extra" }
    ]
  );
  const serialized = serializeServerError(caught);
  assert.equal(serialized.status, 502);
  assert.doesNotMatch(JSON.stringify(serialized.body), /legacy-full-story-strict|full-story\/v1/u);
});

test("Animation entry applies the same strict Full Story validator before any downstream provider call", async () => {
  const story = validStory();
  story.sceneScript[2].dialogue[0].line = null;
  const creativeBrief = mockBrief({
    ...context,
    referenceAnalysis: {},
    sourceScriptReconstruction: {}
  });
  let providerCalls = 0;
  const workflow = new WorkflowService({
    client: {
      async generateJson() {
        providerCalls += 1;
        throw new Error("downstream provider must not run");
      }
    },
    staticFrameCompilerProvider: "MiMo",
    staticFrameCompilerModel: "test-model"
  });

  await assert.rejects(
    () => workflow.createAnimationPlanWithMetadata(withGlobalCharacterBoundary(workflow, {
      ...context,
      creativeBrief,
      fullStory: story
    })),
    (error) => error instanceof OutputContractError
      && error.details.some((detail) => detail.path === "/sceneScript/2/dialogue/0/line")
  );
  assert.equal(providerCalls, 0);
});

// characterBible.careRecipient 曾是 required，等于要求每部片都必须有一个被照料对象。
// 候选阶段放开了这个角色位，如果 Full Story 仍强制它，模板只是被推迟一个阶段重新长回来。
test("Full Story 没有被照料对象时省略 careRecipient 仍然合法", () => {
  const value = withoutCharacter(validStory(), "铃木奶奶");
  delete value.characterBible.careRecipient;
  assert.equal(ensureOutputContract(value, "fullStory"), value);
});

test("没有帮助者时 helpers 输出空数组仍然合法", () => {
  const value = withoutCharacter(validStory(), "铃木奶奶");
  for (const helper of value.characterBible.helpers) withoutCharacter(value, helper.nameOrLabel);
  delete value.characterBible.careRecipient;
  value.characterBible.helpers = [];
  assert.equal(ensureOutputContract(value, "fullStory"), value);
});

test("careRecipient 一旦输出，五个子字段仍必须齐全", () => {
  const value = validStory();
  delete value.characterBible.careRecipient.implicitNeed;
  assert.throws(() => ensureOutputContract(value, "fullStory"), OutputContractError);

  const empty = validStory();
  empty.characterBible.careRecipient = {};
  assert.throws(() => ensureOutputContract(empty, "fullStory"), OutputContractError);
});

test("protagonist 与 helpers 仍然必填，放开 careRecipient 不得波及其余角色契约", () => {
  const noProtagonist = validStory();
  delete noProtagonist.characterBible.protagonist;
  assert.throws(() => ensureOutputContract(noProtagonist, "fullStory"), OutputContractError);

  const noHelpers = validStory();
  delete noHelpers.characterBible.helpers;
  assert.throws(() => ensureOutputContract(noHelpers, "fullStory"), OutputContractError);
});
