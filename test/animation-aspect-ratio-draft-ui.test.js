import test from "node:test";
import assert from "node:assert/strict";
import { loadAppUi, uiFixture } from "./helpers/app-ui-harness.js";

// 画幅取值优先级「该变体草稿 → 该变体已签发 Plan → 全局默认」（CLAUDE.md §2.5）。草稿在生成、
// 刷新恢复、导入测试包时都写成该 Plan 锁入的画幅；Plan 因上游改动作废、从页面状态里删掉之后，
// 同一页面内重新生成仍沿用它，而不是悄悄改用面板上的全局默认。

function recordingFetch() {
  const requests = [];
  const fetch = async (path, options = {}) => {
    requests.push({ path, body: options.body ? JSON.parse(options.body) : null });
    return { ok: false, status: 500, json: async () => ({ ok: false, error: "UI 测试桩：不放行这个请求" }) };
  };
  return { fetch, requests };
}

const current = (artifactId, content) => ({
  content,
  lineage: { artifactId, status: "current", revision: `${artifactId.replace(/:/gu, "-")}-r1`, contentDigest: "e".repeat(64), dependencies: [], createdAt: "2026-10-11T00:00:00.000Z" }
});

test("Plan 作废后同一页面内重新生成分镜：沿用该变体草稿（原 Plan 的画幅），不改用全局默认", async () => {
  const { fetch, requests } = recordingFetch();
  const app = await loadAppUi({ fetch, story: true });
  const fixture = uiFixture({ story: true, plan: true });
  const plan = structuredClone(fixture.animationPlan);
  plan.productionStrategy.targetAspectRatio = "9:16";
  app.state.animationAspectRatioDefault = "9:16";
  app.restoreRunArtifacts({
    themeVariants: current("themeVariants", fixture.themeVariants),
    "fullStory:V2": current("fullStory:V2", fixture.fullStory),
    "animationPlan:V2": current("animationPlan:V2", plan)
  }, { selectedVariantId: "V2" });
  assert.equal(app.state.animationAspectRatioDrafts.V2, "9:16");

  // 用户把面板上的全局默认改成 16:9，随后上游改动让 Plan 作废（作废只从 animationPlans 里删掉它）。
  app.state.animationAspectRatioDefault = "16:9";
  delete app.state.animationPlans.V2;
  app.state.entryMode = "story";
  app.state.storyMode = "characterOnly";
  app.state.production.artifacts["variant:V2"] = current("variant:V2").lineage;
  await app.generateAnimationPlan({ force: true });
  const created = requests.find((request) => request.path === "/api/tasks/create");
  assert.ok(created, "应当发出生成分镜的任务请求");
  assert.equal(created.body.input.targetAspectRatio, "9:16");

  // 换 Run（清空页面状态）后草稿一起清掉，没有 Plan 时用全局默认。
  app.resetDirectorClientState();
  assert.equal(Object.keys(app.state.animationAspectRatioDrafts).length, 0);
});
