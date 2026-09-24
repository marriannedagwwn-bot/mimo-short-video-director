import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveImportedVariant,
  resolveRestoredVariantId
} from "../public/variant-restore.js";

function artifact(artifactId, content, {
  status = "current",
  createdAt = "2026-08-27T00:00:00.000Z"
} = {}) {
  return {
    lineage: { artifactId, status, createdAt },
    content
  };
}

test("只有 Theme Variants 且没有明确选择记录时保持 null", () => {
  const latestArtifacts = {
    themeVariants: artifact("themeVariants", {
      variants: [{ id: "V1" }, { id: "V2" }]
    })
  };

  assert.equal(resolveRestoredVariantId(latestArtifacts), null);
});

test("恢复最新 current Full Story 或 Animation Plan 对应的候选", () => {
  const latestArtifacts = {
    "animationPlan:V1": artifact("animationPlan:V1", {
      selectedVariantId: "V1"
    }, { createdAt: "2026-08-27T00:01:00.000Z" }),
    "fullStory:V2": artifact("fullStory:V2", {
      selectedVariantId: "V2"
    }, { createdAt: "2026-08-27T00:02:00.000Z" })
  };

  assert.equal(resolveRestoredVariantId(latestArtifacts), "V2");
});

test("没有 current Story 或 Plan 时可恢复 current selectedVariant Artifact", () => {
  const latestArtifacts = {
    themeVariants: artifact("themeVariants", { variants: [{ id: "V1" }, { id: "V2" }] }),
    "variant:V1": artifact("variant:V1", { id: "V1" }, {
      createdAt: "2026-08-27T00:01:00.000Z"
    }),
    "variant:V2": artifact("variant:V2", { id: "V2" }, {
      createdAt: "2026-08-27T00:02:00.000Z"
    })
  };

  assert.equal(resolveRestoredVariantId(latestArtifacts), "V2");
});

test("current Story/Plan 优先于较新的未完成候选选择", () => {
  const latestArtifacts = {
    "fullStory:V1": artifact("fullStory:V1", { selectedVariantId: "V1" }, {
      createdAt: "2026-08-27T00:01:00.000Z"
    }),
    "variant:V2": artifact("variant:V2", { id: "V2" }, {
      createdAt: "2026-08-27T00:02:00.000Z"
    })
  };

  assert.equal(resolveRestoredVariantId(latestArtifacts), "V1");
});

test("stale 或内容 ID 与 Artifact ID 不一致的记录不能恢复选择", () => {
  const latestArtifacts = {
    "animationPlan:V1": artifact("animationPlan:V1", { selectedVariantId: "V1" }, {
      status: "stale"
    }),
    "fullStory:V2": artifact("fullStory:V2", { selectedVariantId: "V1" }),
    "variant:V3": artifact("variant:V3", { id: "V2" })
  };

  assert.equal(resolveRestoredVariantId(latestArtifacts), null);
});

test("导入优先使用显式 selectedVariant", () => {
  const selectedVariant = { id: "V2", title: "明确选择" };
  assert.equal(resolveImportedVariant({
    selectedVariant,
    themeVariants: { variants: [{ id: "V1" }, selectedVariant] },
    fullStory: { selectedVariantId: "V1" }
  }), selectedVariant);
});

test("导入可由 Full Story 的 selectedVariantId 反查完整候选", () => {
  const variant = { id: "V2", title: "候选二" };
  assert.equal(resolveImportedVariant({
    themeVariants: { variants: [{ id: "V1" }, variant] },
    fullStory: { selectedVariantId: "V2", title: "完整剧情" }
  }), variant);
});

test("导入只有 Theme Variants 时不得静默选择 variants[0]", () => {
  assert.equal(resolveImportedVariant({
    themeVariants: { variants: [{ id: "V1" }, { id: "V2" }] }
  }), null);
});

test("旧导入包仅有下游 selectedVariantId 时保留最小兼容投影", () => {
  assert.deepEqual(resolveImportedVariant({
    creatorProfile: { fixedCharacter: "小白子，狼耳少女" },
    fullStory: { selectedVariantId: "V9", title: "旧包剧情" }
  }), {
    id: "V9",
    title: "旧包剧情",
    characterSetup: { protagonist: "小白子，狼耳少女" }
  });
});
