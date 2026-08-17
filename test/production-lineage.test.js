import test from "node:test";
import assert from "node:assert/strict";
import {
  contentDigest,
  createMediaNamespace,
  packageDigest,
  signPackageDigest,
  verifyPackageSignature
} from "../src/production-lineage.js";
import {
  beginArtifactRequest,
  emptyProductionState,
  isArtifactRequestCurrent,
  planProductionContext,
  productionRequestHeaders
} from "../public/production-lineage-client.js";

test("contentDigest ignores object key order but detects content changes", () => {
  assert.equal(
    contentDigest({ id: "V1", nested: { b: 2, a: 1 } }),
    contentDigest({ nested: { a: 1, b: 2 }, id: "V1" })
  );
  assert.notEqual(
    contentDigest({ id: "V1", title: "旧主题" }),
    contentDigest({ id: "V1", title: "新主题" })
  );
});
test("package digest and HMAC reject tampering", () => {
  const key = Buffer.alloc(48, 7);
  const value = { packageType: "test", nested: { value: 1 } };
  const digest = packageDigest(value);
  const signature = signPackageDigest(digest, key);
  assert.equal(verifyPackageSignature(digest, signature, key), true);
  assert.equal(verifyPackageSignature(packageDigest({ ...value, nested: { value: 2 } }), signature, key), false);
});

test("media namespace binds project, run, plan revision and plan digest", () => {
  const planDigest = contentDigest({ selectedVariantId: "V1", shotPlan: [] });
  assert.equal(
    createMediaNamespace({
      projectId: "project-a",
      runId: "run-a",
      planRevision: "animationPlan-V1-r2",
      planDigest
    }),
    `project-a/run-a/animationPlan-V1-r2-${planDigest.slice(0, 16)}`
  );
});

test("browser request guard rejects an older response for the same artifact", () => {
  const production = emptyProductionState();
  production.projectId = "project-a";
  production.runId = "run-a";
  production.artifacts["fullStory:V1"] = {
    artifactId: "fullStory:V1",
    revision: "fullStory-V1-r3",
    status: "stale"
  };
  const first = beginArtifactRequest(production, "fullStory:V1", "request-1");
  const second = beginArtifactRequest(production, "fullStory:V1", "request-2");
  assert.equal(first.expectedCurrentRevision, "fullStory-V1-r3");
  assert.equal(isArtifactRequestCurrent(production, first), false);
  assert.equal(isArtifactRequestCurrent(production, second), true);
});

test("production request token uses sidecar headers instead of entering the business body", () => {
  assert.deepEqual(productionRequestHeaders({
    projectId: "project-a",
    runId: "run-a",
    artifactId: "fullStory:V2",
    requestId: "request-a",
    expectedCurrentRevision: "fullStory-V2-r1"
  }), {
    "x-mimo-project-id": "project-a",
    "x-mimo-run-id": "run-a",
    "x-mimo-artifact-id": "fullStory:V2",
    "x-mimo-production-request-id": "request-a",
    "x-mimo-expected-current-revision": "fullStory-V2-r1"
  });
  assert.deepEqual(productionRequestHeaders({ model: "qwen3.7-max" }), {});
});

test("plan production context is available only for a current namespaced plan", () => {
  const production = emptyProductionState();
  production.projectId = "project-a";
  production.runId = "run-a";
  production.artifacts["animationPlan:V1"] = {
    artifactId: "animationPlan:V1",
    revision: "animationPlan-V1-r1",
    contentDigest: "a".repeat(64),
    status: "current",
    mediaNamespace: "project-a/run-a/animationPlan-V1-r1-aaaaaaaaaaaaaaaa"
  };
  assert.deepEqual(planProductionContext(production, "animationPlan:V1"), {
    projectId: "project-a",
    runId: "run-a",
    planArtifactId: "animationPlan:V1",
    planRevision: "animationPlan-V1-r1",
    planDigest: "a".repeat(64),
    mediaNamespace: "project-a/run-a/animationPlan-V1-r1-aaaaaaaaaaaaaaaa"
  });
  production.artifacts["animationPlan:V1"].status = "stale";
  assert.equal(planProductionContext(production, "animationPlan:V1"), null);
});
