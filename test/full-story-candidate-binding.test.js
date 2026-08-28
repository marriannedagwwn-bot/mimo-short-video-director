import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assertFullStoryCandidateBindingCurrent,
  resolveFullStoryCandidateBinding
} from "../src/full-story-candidate-binding.js";
import { ProductionStateStore } from "../src/production-state-store.js";
import { lineageRef } from "../src/production-lineage.js";
import { productionRequestHeaders } from "../public/production-lineage-client.js";
import { ensureStoryCandidateContract } from "../src/validation.js";

const baseCandidate = Object.freeze({
  id: "V1",
  title: "旧钟表的最后一程",
  oneLineHook: "她必须在闭馆前送回修好的旧钟。",
  logline: "修表师阿岚带着旧钟穿过停电街区，让一段等待重新走动。",
  verticalFit: "社区修理中的生活情感故事",
  characterSetup: {
    protagonist: "阿岚，社区修理师",
    careRecipient: "等待旧钟的老人",
    helper: "停电街区的邻居"
  },
  newTask: "在闭馆前送回修好的旧钟",
  emotionalMedium: "旧钟重新响起的报时声",
  environmentPressure: "街区停电且道路封闭",
  storyOutline: [
    { beat: 1, phase: "受命", action: "阿岚接过修好的旧钟并承诺闭馆前送达", emotion: "郑重", dramaticFunction: "建立目标与时限", estimatedSeconds: 8 },
    { beat: 2, phase: "抉择", action: "阿岚放弃近路，先帮助受困邻居再绕行", emotion: "犹豫", dramaticFunction: "主角亲自作出关键选择", estimatedSeconds: 8 },
    { beat: 3, phase: "后果", action: "绕行耗尽了余量，闭馆时间只剩最后几分钟", emotion: "紧张", dramaticFunction: "选择造成的直接后果，使高潮成为可能", estimatedSeconds: 8 },
    { beat: 4, phase: "高潮", action: "闭馆铃响前，她靠手摇发条让旧钟重新报时", emotion: "紧张", dramaticFunction: "主角亲手完成决定性动作并产生可见结果", estimatedSeconds: 8 },
    { beat: 5, phase: "兑现", action: "老人听见熟悉报时声，终于放下多年的等待", emotion: "释然", dramaticFunction: "把积累的关系与情绪转化为可见状态变化", estimatedSeconds: 8 }
  ],
  highValueBeatMapping: [],
  keyDialogueDirections: [],
  endingRitual: "老人和阿岚一起给旧钟上弦",
  transformationProof: {
    changedCharacters: "改为社区修理师与等待旧钟的老人",
    changedTask: "改为送回修好的旧钟",
    changedDetailsAndProps: "改为手摇灯、发条与钟摆",
    changedDialogue: "围绕守时承诺重新设计",
    changedVisualExpression: "以停电街区和机械运动组织画面"
  },
  experienceFidelity: {
    positioning: "生活情感短片",
    audience: "喜欢温暖社区故事的观众",
    emotion: "从焦急到释然",
    plotDriver: "限时送达与沿途选择",
    highValueBeats: "承诺、受阻、主动选择、兑现"
  },
  originalityRiskCheck: {
    riskLevel: "low",
    possibleSimilarity: "保留限时送达的抽象驱动力",
    mitigation: "人物、任务、道具、场景和高潮均采用新表达"
  },
  keyChoiceBeat: 2,
  climaxBeat: 4,
  keyChoice: "阿岚放弃近路，先帮助受困邻居再绕行",
  climax: "闭馆铃响前，她靠手摇发条让旧钟重新报时",
  emotionalPayoff: "老人听见熟悉报时声，终于放下多年的等待",
  novelty: "用机械报时承载跨代记忆",
  visualPotential: "黑暗街区中的手摇灯与钟摆形成连续视觉动作"
});

async function withBoundRun(operation) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "mimo-full-story-candidate-binding-"));
  let nextId = 0;
  const store = new ProductionStateStore({
    rootDir,
    idFactory: () => `binding-${++nextId}`
  });
  try {
    const run = await store.createRun({ projectId: "project-binding" });
    const candidate = await store.commitArtifact({
      projectId: run.projectId,
      runId: run.runId,
      artifactId: "variant:V1",
      artifactType: "selectedVariant",
      content: structuredClone(baseCandidate),
      dependencies: [],
      requestId: "select-v1",
      expectedCurrentRevision: null
    });
    await store.recordStage({
      projectId: run.projectId,
      runId: run.runId,
      stageId: "fullStory:V1",
      status: "running",
      requestId: "generate-story-v1"
    });
    const token = {
      projectId: run.projectId,
      runId: run.runId,
      artifactId: "fullStory:V1",
      requestId: "generate-story-v1",
      expectedCurrentRevision: null
    };
    await operation({
      store,
      run,
      candidate,
      headers: productionRequestHeaders(token),
      body: {
        variant: structuredClone(baseCandidate),
        candidateBinding: lineageRef(candidate.lineage),
        creatorProfile: { fixedCharacter: "阿岚", vertical: "社区修理" }
      },
      loadRun: (input) => store.loadRun(input),
      validateCandidate: (value) => ensureStoryCandidateContract(value, {
        path: "selectedCandidate"
      })
    });
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
}

test("Full Story binding resolves only the current exact Candidate and strips sidecar metadata", async () => {
  await withBoundRun(async ({ headers, body, loadRun }) => {
    const validatedCandidates = [];
    const resolved = await resolveFullStoryCandidateBinding({
      headers,
      body,
      loadRun,
      validateCandidate(candidate) {
        validatedCandidates.push(structuredClone(candidate));
        return candidate;
      }
    });

    assert.deepEqual(resolved.input.variant, baseCandidate);
    assert.notEqual(resolved.input.variant, body.variant);
    assert.equal(Object.hasOwn(resolved.input, "candidateBinding"), false);
    assert.deepEqual(validatedCandidates, [baseCandidate]);
    assert.equal(resolved.context.candidateBinding.artifactId, "variant:V1");
    await assert.doesNotReject(() => assertFullStoryCandidateBindingCurrent(resolved, {
      loadRun,
      validateCandidate: (candidate) => candidate
    }));
  });
});

test("same Variant ID cannot hide title/newTask/keyChoice/climax changes from the bound digest", async () => {
  await withBoundRun(async ({ headers, body, loadRun, validateCandidate }) => {
    const mutations = {
      title: "同 ID 的新标题",
      newTask: "同 ID 的新任务",
      keyChoice: "同 ID 的新选择",
      climax: "同 ID 的新高潮"
    };
    for (const [field, replacement] of Object.entries(mutations)) {
      const changedBody = structuredClone(body);
      changedBody.variant[field] = replacement;
      await assert.rejects(
        resolveFullStoryCandidateBinding({
          headers,
          body: changedBody,
          loadRun,
          validateCandidate
        }),
        (error) => error?.code === "FULL_STORY_CANDIDATE_CONTENT_MISMATCH",
        `${field} 变化必须让旧 binding 失效`
      );
    }
  });
});

test("Candidate artifactId, revision and contentDigest must all match the current server lineage", async () => {
  await withBoundRun(async ({ headers, body, loadRun, validateCandidate }) => {
    const cases = [
      {
        mutate(binding) { binding.artifactId = "variant:V2"; },
        code: "FULL_STORY_CANDIDATE_BINDING_MISMATCH"
      },
      {
        mutate(binding) { binding.revision = "variant-V1-r999"; },
        code: "FULL_STORY_CANDIDATE_STALE"
      },
      {
        mutate(binding) { binding.contentDigest = "b".repeat(64); },
        code: "FULL_STORY_CANDIDATE_STALE"
      }
    ];
    for (const item of cases) {
      const changedBody = structuredClone(body);
      item.mutate(changedBody.candidateBinding);
      await assert.rejects(
        resolveFullStoryCandidateBinding({
          headers,
          body: changedBody,
          loadRun,
          validateCandidate
        }),
        (error) => error?.code === item.code
      );
    }
  });
});

test("a Candidate revision change during model work is rejected by the post-call recheck", async () => {
  await withBoundRun(async ({ store, run, candidate, headers, body, loadRun, validateCandidate }) => {
    const resolved = await resolveFullStoryCandidateBinding({
      headers,
      body,
      loadRun,
      validateCandidate
    });
    await store.commitArtifact({
      projectId: run.projectId,
      runId: run.runId,
      artifactId: "variant:V1",
      artifactType: "selectedVariant",
      content: { ...structuredClone(baseCandidate), keyChoice: "改走另一条路线" },
      dependencies: [],
      requestId: "reselect-v1",
      expectedCurrentRevision: candidate.lineage.revision
    });

    await assert.rejects(
      assertFullStoryCandidateBindingCurrent(resolved, { loadRun, validateCandidate }),
      (error) => error?.code === "FULL_STORY_CANDIDATE_STALE"
    );
  });
});

test("missing headers or binding fail closed before any Run is loaded", async () => {
  await withBoundRun(async ({ headers, body, validateCandidate }) => {
    let loadCalls = 0;
    const loadRun = async () => {
      loadCalls += 1;
      throw new Error("must not load an unaddressed run");
    };
    await assert.rejects(
      resolveFullStoryCandidateBinding({ headers: {}, body, loadRun, validateCandidate }),
      (error) => error?.code === "FULL_STORY_CANDIDATE_BINDING_REQUIRED"
    );
    const withoutBinding = structuredClone(body);
    delete withoutBinding.candidateBinding;
    await assert.rejects(
      resolveFullStoryCandidateBinding({ headers, body: withoutBinding, loadRun, validateCandidate }),
      (error) => error?.code === "FULL_STORY_CANDIDATE_BINDING_REQUIRED"
    );
    assert.equal(loadCalls, 0);
  });
});

test("running Full Story target, request ID and expected target revision are exact", async () => {
  await withBoundRun(async ({ store, run, candidate, body, loadRun, validateCandidate }) => {
    const story = await store.commitArtifact({
      projectId: run.projectId,
      runId: run.runId,
      artifactId: "fullStory:V1",
      artifactType: "fullStory",
      content: { selectedVariantId: "V1", title: "旧 Story" },
      dependencies: [lineageRef(candidate.lineage)],
      requestId: "old-story",
      expectedCurrentRevision: null
    });
    await store.recordStage({
      projectId: run.projectId,
      runId: run.runId,
      stageId: "fullStory:V1",
      status: "running",
      requestId: "generate-story-v1-current"
    });
    const validHeaders = productionRequestHeaders({
      projectId: run.projectId,
      runId: run.runId,
      artifactId: "fullStory:V1",
      requestId: "generate-story-v1-current",
      expectedCurrentRevision: story.lineage.revision
    });
    await assert.doesNotReject(() => resolveFullStoryCandidateBinding({
      headers: validHeaders,
      body,
      loadRun,
      validateCandidate
    }));

    const cases = [
      {
        token: {
          projectId: run.projectId,
          runId: run.runId,
          artifactId: "fullStory:V2",
          requestId: "generate-story-v1-current",
          expectedCurrentRevision: story.lineage.revision
        },
        code: "FULL_STORY_REQUEST_TARGET_MISMATCH"
      },
      {
        token: {
          projectId: run.projectId,
          runId: run.runId,
          artifactId: "fullStory:V1",
          requestId: "stale-request",
          expectedCurrentRevision: story.lineage.revision
        },
        code: "FULL_STORY_REQUEST_STALE"
      },
      {
        token: {
          projectId: run.projectId,
          runId: run.runId,
          artifactId: "fullStory:V1",
          requestId: "generate-story-v1-current",
          expectedCurrentRevision: "fullStory-V1-r999"
        },
        code: "FULL_STORY_REQUEST_REVISION_CONFLICT"
      }
    ];
    for (const item of cases) {
      await assert.rejects(
        resolveFullStoryCandidateBinding({
          headers: productionRequestHeaders(item.token),
          body,
          loadRun,
          validateCandidate
        }),
        (error) => error?.code === item.code
      );
    }
  });
});

test("the authoritative stored Candidate must pass the injected single-candidate strict contract", async () => {
  await withBoundRun(async ({ headers, body, loadRun }) => {
    await assert.rejects(
      resolveFullStoryCandidateBinding({
        headers,
        body,
        loadRun,
        validateCandidate() {
          const error = new Error("keyChoice 缺失");
          error.details = [{
            code: "STORY_CANDIDATE_REQUIRED",
            jsonPointer: "/keyChoice",
            reason: "keyChoice 必须是非空字符串"
          }];
          throw error;
        }
      }),
      (error) => (
        error?.code === "FULL_STORY_CANDIDATE_CONTRACT_INVALID"
        && error.details?.[0]?.jsonPointer === "/keyChoice"
      )
    );
  });
});
