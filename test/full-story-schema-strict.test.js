import test from "node:test";
import assert from "node:assert/strict";
import { mockBrief, mockFullStory } from "../src/mock.js";
import { serializeServerError } from "../src/server-error.js";
import { OutputContractError, ensureOutputContract } from "../src/validation.js";
import { WorkflowService } from "../src/workflow.js";

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
    () => workflow.createAnimationPlanWithMetadata({
      ...context,
      creativeBrief,
      fullStory: story
    }),
    (error) => error instanceof OutputContractError
      && error.details.some((detail) => detail.path === "/sceneScript/2/dialogue/0/line")
  );
  assert.equal(providerCalls, 0);
});
