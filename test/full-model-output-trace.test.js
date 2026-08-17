import test from "node:test";
import assert from "node:assert/strict";
import { productionRequestHeaders } from "../public/production-lineage-client.js";
import {
  resolveAnimationPlanModelOutputTrace,
  resolveFullStoryModelOutputTrace
} from "../src/full-model-output-trace.js";

test("只把与 current running stage 完全匹配的 Full Story trace 标为可信", async () => {
  const headers = productionRequestHeaders({
    projectId: "project-a",
    runId: "run-a",
    artifactId: "fullStory:V2",
    requestId: "request-a",
    expectedCurrentRevision: "fullStory-V2-r1"
  });
  const calls = [];
  const result = await resolveFullStoryModelOutputTrace({
    headers,
    variantId: "V2",
    loadRun: async (input) => {
      calls.push(input);
      return {
        stages: {
          "fullStory:V2": { status: "running", requestId: "request-a" }
        },
        latestArtifacts: {
          "fullStory:V2": { lineage: { revision: "fullStory-V2-r1" } }
        }
      };
    }
  });
  assert.equal(result.warning, "");
  assert.deepEqual(result.context, {
    verified: true,
    projectId: "project-a",
    runId: "run-a",
    artifactId: "fullStory:V2",
    productionRequestId: "request-a",
    variantId: "V2"
  });
  assert.deepEqual(calls, [{ projectId: "project-a", runId: "run-a", includeContent: false }]);
});

test("伪造、过期或错 Variant 的 trace 只能成为未绑定日志，不能冒充 Production lineage", async () => {
  for (const token of [
    {
      projectId: "project-a",
      runId: "run-a",
      artifactId: "fullStory:V1",
      requestId: "request-a"
    },
    {
      projectId: "project-a",
      runId: "run-a",
      artifactId: "fullStory:V2",
      requestId: "stale-request"
    }
  ]) {
    const result = await resolveFullStoryModelOutputTrace({
      headers: productionRequestHeaders(token),
      variantId: "V2",
      loadRun: async () => ({
        stages: {
          "fullStory:V2": { status: "running", requestId: "request-a" }
        },
        latestArtifacts: {}
      })
    });
    assert.equal(result.context.verified, false);
    assert.equal(result.context.projectId, "");
    assert.match(result.warning, /未绑定 Production Run/u);
  }
});

test("直接 API 调用没有 trace header 时仍可生成，但日志明确为 unbound", async () => {
  const result = await resolveFullStoryModelOutputTrace({
    headers: {},
    variantId: "V2",
    loadRun: async () => assert.fail("无 header 时不应读取任意 Run")
  });
  assert.equal(result.warning, "");
  assert.deepEqual(result.context, {
    verified: false,
    projectId: "",
    runId: "",
    artifactId: "",
    productionRequestId: "",
    variantId: "V2"
  });
});

test("Animation Plan trace 只信任当前 running 的 exact Variant 与 revision", async () => {
  const headers = productionRequestHeaders({
    projectId: "project-animation",
    runId: "run-animation",
    artifactId: "animationPlan:V2",
    requestId: "request-animation",
    expectedCurrentRevision: "animationPlan-V2-r3"
  });
  const result = await resolveAnimationPlanModelOutputTrace({
    headers,
    variantId: "V2",
    loadRun: async () => ({
      stages: {
        "animationPlan:V2": { status: "running", requestId: "request-animation" }
      },
      latestArtifacts: {
        "animationPlan:V2": { lineage: { revision: "animationPlan-V2-r3" } }
      }
    })
  });
  assert.equal(result.warning, "");
  assert.deepEqual(result.context, {
    verified: true,
    projectId: "project-animation",
    runId: "run-animation",
    artifactId: "animationPlan:V2",
    productionRequestId: "request-animation",
    variantId: "V2"
  });
});

test("Animation Plan trace 的错 Artifact、旧请求或旧 revision 只能记为 unbound", async () => {
  const cases = [
    {
      artifactId: "fullStory:V2",
      requestId: "request-animation",
      expectedCurrentRevision: "animationPlan-V2-r3"
    },
    {
      artifactId: "animationPlan:V2",
      requestId: "stale-request",
      expectedCurrentRevision: "animationPlan-V2-r3"
    },
    {
      artifactId: "animationPlan:V2",
      requestId: "request-animation",
      expectedCurrentRevision: "animationPlan-V2-r2"
    }
  ];
  for (const item of cases) {
    const result = await resolveAnimationPlanModelOutputTrace({
      headers: productionRequestHeaders({
        projectId: "project-animation",
        runId: "run-animation",
        ...item
      }),
      variantId: "V2",
      loadRun: async () => ({
        stages: {
          "animationPlan:V2": { status: "running", requestId: "request-animation" }
        },
        latestArtifacts: {
          "animationPlan:V2": { lineage: { revision: "animationPlan-V2-r3" } }
        }
      })
    });
    assert.equal(result.context.verified, false);
    assert.match(result.warning, /Animation Plan 模型输出日志未绑定 Production Run/u);
  }
});
