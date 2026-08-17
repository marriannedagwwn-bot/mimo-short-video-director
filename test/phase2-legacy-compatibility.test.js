import test from "node:test";
import assert from "node:assert/strict";
import { getConfig } from "../src/config.js";
import {
  CAST_PROPOSAL_API_PATH,
  handleCastApiRequest
} from "../src/cast-api.js";
import { CastPipelineDisabledError } from "../src/cast-errors.js";
import { CastOrchestrationService } from "../src/cast-orchestration.js";
import { FULL_STORY_BEAT_SCENE_POSTPASS_SCHEMA_VERSION } from "../src/full-story-beat-scene-postpass.js";
import { mockBrief, mockFullStory, mockReconstruction } from "../src/mock.js";
import {
  groundingContextDigest,
  sealReconstruction
} from "../src/reconstruction-grounding.js";
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

function groundedUpstream(workflow) {
  const transcript = "00:00-00:01 输入素材中的可确认动作";
  const metadata = { duration: 1, width: 1080, height: 1920 };
  const reconstruction = mockReconstruction({ metadata, transcript, frames: [] });
  return {
    referenceAnalysis: {},
    sourceScriptReconstruction: sealReconstruction(
      reconstruction,
      workflow.groundingKey,
      groundingContextDigest({ transcript, metadata, frames: [], video: null })
    )
  };
}

test("Phase 2 feature flag 默认关闭且只能显式启用", () => {
  const keys = [
    "FULL_STORY_V2_PIPELINE_ENABLED",
    "FULL_STORY_V2_ENVIRONMENT",
    "FULL_STORY_V2_AUDIENCE",
    "FULL_STORY_V2_CAST_CONFIRMATION_TTL_MS",
    "NODE_ENV"
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    assert.deepEqual(getConfig().fullStoryV2Pipeline, {
      enabled: false,
      environment: "development",
      audience: "full-story-v2",
      castConfirmationTtlMs: 30 * 60 * 1_000
    });

    process.env.FULL_STORY_V2_PIPELINE_ENABLED = "true";
    process.env.FULL_STORY_V2_ENVIRONMENT = "staging";
    process.env.FULL_STORY_V2_AUDIENCE = "cast-staging";
    process.env.FULL_STORY_V2_CAST_CONFIRMATION_TTL_MS = "3600000";
    assert.deepEqual(getConfig().fullStoryV2Pipeline, {
      enabled: true,
      environment: "staging",
      audience: "cast-staging",
      castConfirmationTtlMs: 60 * 60 * 1_000
    });
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test("当前 legacy Full Story 正常路径使用同一 provider 完成生成与 postpass，且成功 wire shape 不变", async () => {
  let providerCalls = 0;
  const providerRequests = [];
  const expectedStory = mockFullStory({
    ...context,
    referenceAnalysis: {},
    sourceScriptReconstruction: {}
  });
  const passPostpass = {
    schemaVersion: FULL_STORY_BEAT_SCENE_POSTPASS_SCHEMA_VERSION,
    status: "pass",
    reviews: expectedStory.beatSheet.map((beat, beatIndex) => ({
      beatIndex,
      beat: beat.beat,
      sceneIds: [expectedStory.sceneScript[beatIndex].sceneId],
      verdict: "pass",
      issueCode: "none",
      beatEvidence: "",
      sceneEvidence: "",
      nextStateEvidence: "",
      reason: "",
      completionId: ""
    })),
    completions: []
  };
  const workflow = new WorkflowService({
    storyClient: {
      async generateJson(request) {
        providerCalls += 1;
        providerRequests.push(request);
        if (request.prompt.includes(FULL_STORY_BEAT_SCENE_POSTPASS_SCHEMA_VERSION)) {
          return structuredClone(passPostpass);
        }
        return structuredClone(expectedStory);
      }
    }
  });
  const creativeBrief = mockBrief({
    ...context,
    referenceAnalysis: {},
    sourceScriptReconstruction: {}
  });

  const result = await workflow.createFullStory(withGlobalCharacterBoundary(workflow, {
    ...context,
    ...groundedUpstream(workflow),
    creativeBrief
  }));

  assert.equal(providerCalls, 2);
  assert.equal(providerRequests.length, 2);
  assert.equal(providerRequests[0].model, providerRequests[1].model);
  assert.match(providerRequests[1].prompt, /待审完整 Full Story JSON（这是本次唯一业务输入）/u);
  assert.deepEqual(result, expectedStory);
  assert.deepEqual(Object.keys(result), Object.keys(expectedStory));
});

test("Phase 3 能力没有提前出现在 Cast Registry/API 或 legacy Story 中", () => {
  const forbiddenPhase3Terms = [
    "presences",
    "evidence",
    "evidenceSpan",
    "auditor",
    "repair",
    "storyDigest",
    "planDigest",
    "receipt"
  ];
  const service = new CastOrchestrationService();
  const castOutcome = service.begin({
    castProposal: {
      roles: [{
        proposalRef: "cast-proposal-1",
        entityClass: "anonymous-extra",
        identityMode: "anonymous",
        proposedDisplayName: "路人",
        proposedAliases: [],
        scopePolicy: "scene-limited",
        maxSceneCount: 1,
        narrativeImportance: "ambient",
        relationshipMode: "none",
        dialoguePolicy: "none",
        shotEmphasis: "background",
        continuityRequired: false,
        requiresReferenceAsset: false,
        sceneHint: "背景路人"
      }]
    },
    declarations: [],
    storyContext: { variantId: "V1" }
  });
  const legacyStory = mockFullStory({
    ...context,
    referenceAnalysis: {},
    sourceScriptReconstruction: {}
  });
  const serialized = JSON.stringify({ castOutcome, legacyStory }).toLowerCase();

  for (const term of forbiddenPhase3Terms) {
    assert.equal(serialized.includes(`"${term.toLowerCase()}"`), false, term);
  }
  assert.throws(
    () => handleCastApiRequest({
      path: CAST_PROPOSAL_API_PATH,
      body: {},
      service
    }),
    CastPipelineDisabledError
  );
});
