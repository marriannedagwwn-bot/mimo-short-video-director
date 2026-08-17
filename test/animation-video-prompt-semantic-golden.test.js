import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  animationVideoPromptSemanticAuditCatalogPayload,
  createAnimationVideoPromptSemanticAuditCatalog,
  deriveAnimationVideoPromptSemanticAuditOverall,
  validateAnimationVideoPromptSemanticAuditResponse
} from "../src/animation-video-prompt-semantic-audit.js";
import { animationVideoPromptRewriteSemanticAuditPrompt } from "../src/prompts.js";

const fixture = JSON.parse(readFileSync(
  new URL("./fixtures/animation-plan/h3-semantic-audit-20260815.json", import.meta.url),
  "utf8"
));

const shotFactFields = [
  "sourceSceneId",
  "sceneId",
  "durationSeconds",
  "storyPurpose",
  "emotionalTarget",
  "cameraMotion",
  "characterAction",
  "dialogueOrSubtitle",
  "soundDesign",
  "continuityNotes",
  "acceptanceCriteria"
];

function authorityFact(shotId, field, tier, value) {
  return {
    authorityFactId: `${shotId}:authority:${field}`,
    tier,
    field,
    value: structuredClone(value ?? null)
  };
}

function catalogForCase(replayCase) {
  const sourceScenes = new Map(
    fixture.authority.sourceScenes.map((scene) => [scene.sceneId, scene])
  );
  const catalogInput = {
    shots: replayCase.shots.map((shot) => {
      const scene = sourceScenes.get(shot.sourceSceneId);
      assert.ok(scene, `fixture 必须包含 ${shot.sourceSceneId}`);
      const authorityFacts = [
        authorityFact(shot.shotId, "fixedCharacterBoundary", "fixed_character", fixture.authority.fixedCharacterBoundary),
        authorityFact(shot.shotId, "fullStory.scene.characters", "full_story", scene.characters),
        authorityFact(shot.shotId, "fullStory.scene.location", "full_story", scene.location),
        authorityFact(shot.shotId, "fullStory.scene.visibleAction", "full_story", scene.visibleAction),
        authorityFact(shot.shotId, "fullStory.scene.dialogue", "full_story", scene.dialogue),
        authorityFact(shot.shotId, "fullStory.scene.shotAndSound", "full_story", scene.shotAndSound),
        authorityFact(shot.shotId, "foundation.visualBible", "foundation", replayCase.foundationLocks.visualBible),
        authorityFact(shot.shotId, "foundation.characterReferencePrompts", "foundation", replayCase.foundationLocks.characterReferencePrompts),
        authorityFact(shot.shotId, "foundation.sceneReferencePrompts", "foundation", replayCase.foundationLocks.sceneReferencePrompts),
        authorityFact(shot.shotId, "foundation.assetPrompts", "foundation", replayCase.foundationLocks.assetPrompts),
        ...shotFactFields.map((field) => (
          authorityFact(shot.shotId, `exactShot.${field}`, "exact_shot", shot[field])
        ))
      ];
      const candidateFields = shotFactFields.map((field) => ({
        candidateFieldId: `${shot.shotId}:candidate:${field}`,
        layer: "shot_facts",
        field,
        value: structuredClone(shot[field] ?? null)
      }));
      candidateFields.push({
        candidateFieldId: `${shot.shotId}:candidate:videoPrompt`,
        layer: "video_prompt",
        field: "videoPrompt",
        value: shot.videoPrompt
      });
      return { shotId: shot.shotId, authorityFacts, candidateFields };
    })
  };
  return createAnimationVideoPromptSemanticAuditCatalog(catalogInput, {
    candidate: { shotPlan: structuredClone(replayCase.shots) }
  });
}

function passResult(shotId) {
  return {
    shotId,
    shotFactsVerdict: "pass",
    videoPromptVerdict: "pass",
    issues: []
  };
}

function issue({ shotId, layer, field, category, relation, authorityField,
  authorityExcerpt, candidateExcerpt, productionImpact }) {
  return {
    layer,
    field,
    category,
    relation,
    authorityFactId: `${shotId}:authority:${authorityField}`,
    candidateFieldId: `${shotId}:candidate:${field}`,
    authorityExcerpt,
    candidateExcerpt,
    productionImpact
  };
}

test("两轮真实 H3 回放把 assetPrompts 作为完整权威输入，并明确排除旧审计的措辞误报", () => {
  assert.equal(fixture.schemaVersion, "h3-semantic-audit-replay-fixture/1.0");
  assert.equal(fixture.cases.length, 2);
  for (const replayCase of fixture.cases) {
    const catalog = catalogForCase(replayCase);
    const payload = animationVideoPromptSemanticAuditCatalogPayload(catalog);
    const assetFact = payload.shots[0].authorityFacts.find(
      (fact) => fact.field === "foundation.assetPrompts"
    );
    assert.deepEqual(assetFact.value, replayCase.foundationLocks.assetPrompts);
    const prompt = animationVideoPromptRewriteSemanticAuditPrompt({
      auditMode: "initial",
      targetProfile: { profileId: "minimax_h3" },
      semanticAuditPayload: payload
    });
    assert.match(prompt, /Foundation assetPrompts 已锁定的颜色、材质和纹理是合法视觉细化/u);
    assert.match(prompt, /没有重复已表达动作/u);
    assert.match(prompt, /不需另写 end time/u);
    assert.ok(
      prompt.includes(replayCase.foundationLocks.assetPrompts[1].imagePrompt),
      "审计 Prompt 必须携带真实野花资产锁，而不是只给 Full Story 泛称"
    );
  }

  assert.deepEqual(
    fixture.cases[0].expectedMaterialOutcome.legacyIssueAssessments.map(
      (entry) => entry.expectedDisposition
    ),
    ["pass", "pass", "pass", "retain_reclassified"]
  );
  assert.deepEqual(
    fixture.cases[1].expectedMaterialOutcome.legacyIssueAssessments.map(
      (entry) => entry.expectedDisposition
    ),
    ["pass", "retain", "retain", "pass", "pass_replaced"]
  );
});

test("第一轮真实回放只保留 A06 未授权出镜，并在 shot_facts 层停止低层 Prompt 修复", () => {
  const replayCase = fixture.cases[0];
  const catalog = catalogForCase(replayCase);
  const response = {
    schemaVersion: "animation_video_prompt_semantic_audit/2.0",
    shots: replayCase.shots.map((shot) => {
      if (shot.shotId !== "A06") return passResult(shot.shotId);
      return {
        shotId: "A06",
        shotFactsVerdict: "fail",
        videoPromptVerdict: "not_evaluated",
        issues: [issue({
          shotId: "A06",
          layer: "shot_facts",
          field: "continuityNotes",
          category: "cast",
          relation: "extra_visible_cast_added",
          authorityField: "fullStory.scene.characters",
          authorityExcerpt: "小白子",
          candidateExcerpt: "三人可能已放下叶片",
          productionImpact: "S6 只签发小白子出镜，结构化连续性却保留三位未授权村民"
        })]
      };
    })
  };

  const audit = validateAnimationVideoPromptSemanticAuditResponse(response, catalog);
  const overall = deriveAnimationVideoPromptSemanticAuditOverall(audit);
  assert.deepEqual(overall.shotFactsFailedShotIds, ["A06"]);
  assert.deepEqual(overall.videoPromptFailedShotIds, []);
  assert.deepEqual(overall.repairableVideoPromptShotIds, []);
});

test("第二轮真实回放保留 A01 摄影错位，同时把 A06 结构化角色冲突置于 Prompt 之上", () => {
  const replayCase = fixture.cases[1];
  const catalog = catalogForCase(replayCase);
  const response = {
    schemaVersion: "animation_video_prompt_semantic_audit/2.0",
    shots: replayCase.shots.map((shot) => {
      if (shot.shotId === "A01") {
        return {
          shotId: "A01",
          shotFactsVerdict: "pass",
          videoPromptVerdict: "fail",
          issues: [issue({
            shotId: "A01",
            layer: "video_prompt",
            field: "videoPrompt",
            category: "camera",
            relation: "camera_beat_changed_or_reordered",
            authorityField: "exactShot.cameraMotion",
            authorityExcerpt: "硬切至面部特写捕捉自豪表情与老爷爷摸头互动（4-5s）",
            candidateExcerpt: "At 00:04.000, the camera cuts to a close-up",
            productionImpact: "最终特写只保留小白子表情，未在签发摄影 beat 中呈现摸头互动"
          })]
        };
      }
      if (shot.shotId === "A06") {
        return {
          shotId: "A06",
          shotFactsVerdict: "fail",
          videoPromptVerdict: "not_evaluated",
          issues: [issue({
            shotId: "A06",
            layer: "shot_facts",
            field: "characterAction",
            category: "cast",
            relation: "extra_visible_cast_added",
            authorityField: "fullStory.scene.characters",
            authorityExcerpt: "小白子",
            candidateExcerpt: "结尾远处三人放下芭蕉叶微笑注视",
            productionImpact: "结构化镜头动作已加入 Full Story S6 未授权出镜的三位村民"
          })]
        };
      }
      return passResult(shot.shotId);
    })
  };

  const audit = validateAnimationVideoPromptSemanticAuditResponse(response, catalog);
  const overall = deriveAnimationVideoPromptSemanticAuditOverall(audit);
  assert.deepEqual(overall.videoPromptFailedShotIds, ["A01"]);
  assert.deepEqual(overall.shotFactsFailedShotIds, ["A06"]);
  assert.deepEqual(overall.repairableVideoPromptShotIds, ["A01"]);
  assert.equal(overall.verdict, "fail");
});
