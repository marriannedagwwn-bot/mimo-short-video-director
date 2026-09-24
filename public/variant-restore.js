function currentArtifactEntries(latestArtifacts = {}) {
  if (!latestArtifacts || typeof latestArtifacts !== "object" || Array.isArray(latestArtifacts)) return [];
  return Object.entries(latestArtifacts)
    .map(([artifactId, entry], index) => ({ artifactId, entry, index }))
    .filter(({ entry }) => entry?.lineage?.status === "current")
    .sort((left, right) => {
      const byCreatedAt = String(left.entry.lineage.createdAt || "")
        .localeCompare(String(right.entry.lineage.createdAt || ""));
      return byCreatedAt || left.index - right.index;
    });
}

function artifactVariantId(artifactId, entry, prefix, contentField) {
  if (!String(artifactId).startsWith(prefix)) return "";
  const id = String(artifactId).slice(prefix.length).trim();
  if (!id) return "";
  const contentId = String(entry?.content?.[contentField] || "").trim();
  return contentId === id ? id : "";
}

/**
 * 恢复最近一次有服务端 current Artifact 支撑的候选选择。
 *
 * 已完成的 Full Story / Animation Plan 比一次未完成的选择尝试更强；两者中按
 * createdAt 取最新项。只有没有任何 current 下游结果时，才读取现有的
 * variant:<id> selectedVariant Artifact。themeVariants 的数组顺序从不代表选择。
 */
export function resolveRestoredVariantId(latestArtifacts = {}) {
  const entries = currentArtifactEntries(latestArtifacts);
  const reversed = [...entries].reverse();
  for (const { artifactId, entry } of reversed) {
    const planId = artifactVariantId(artifactId, entry, "animationPlan:", "selectedVariantId");
    if (planId) return planId;
    const storyId = artifactVariantId(artifactId, entry, "fullStory:", "selectedVariantId");
    if (storyId) return storyId;
  }
  for (const { artifactId, entry } of reversed) {
    const selectedId = artifactVariantId(artifactId, entry, "variant:", "id");
    if (selectedId) return selectedId;
  }
  return null;
}

/**
 * 从已验证的导入包解析候选。只接受包内的显式 selectedVariant，或由已有
 * Full Story / Animation Plan 的 selectedVariantId 反查；绝不把 variants[0]
 * 当作用户选择。
 */
export function resolveImportedVariant(payload = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const explicit = payload.selectedVariant || payload.variant || payload.output?.selectedVariant || null;
  if (explicit?.id) return explicit;

  const variants = Array.isArray(payload.themeVariants?.variants)
    ? payload.themeVariants.variants
    : Array.isArray(payload.output?.themeVariants?.variants)
      ? payload.output.themeVariants.variants
      : [];
  const fullStory = payload.fullStory || payload.output?.fullStory || null;
  const animationPlan = payload.animationPlan || payload.output?.animationPlan || null;
  const id = String(fullStory?.selectedVariantId || animationPlan?.selectedVariantId || "").trim();
  if (!id) return null;

  return variants.find((item) => String(item?.id || "") === id) || {
    id,
    title: fullStory?.title || animationPlan?.title || id,
    characterSetup: { protagonist: payload.creatorProfile?.fixedCharacter || "" }
  };
}
