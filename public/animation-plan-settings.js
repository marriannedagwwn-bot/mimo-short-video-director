export const ANIMATION_PLAN_ASPECT_RATIOS = Object.freeze(["9:16", "16:9"]);

export function isAnimationPlanAspectRatio(value) {
  return ANIMATION_PLAN_ASPECT_RATIOS.includes(String(value || "").trim());
}

export function normalizeAnimationPlanAspectRatio(value, fallback = "9:16") {
  const normalized = String(value || "").trim();
  if (isAnimationPlanAspectRatio(normalized)) return normalized;
  const normalizedFallback = String(fallback || "").trim();
  return isAnimationPlanAspectRatio(normalizedFallback) ? normalizedFallback : "9:16";
}

// 有意保留：「已有 Plan 就地切换画幅」的契约实现。当前页面不暴露这条路径（要换画幅只能重新生成），
// 这个函数与它的单元测试留着，随时可以重新接回 UI。
export function withAnimationPlanAspectRatio(plan, value) {
  const ratio = String(value || "").trim();
  if (!isAnimationPlanAspectRatio(ratio)) {
    throw new RangeError(`targetAspectRatio 只允许 ${ANIMATION_PLAN_ASPECT_RATIOS.join(" 或 ")}`);
  }
  const updated = structuredClone(plan || {});
  updated.productionStrategy = {
    ...(updated.productionStrategy || {}),
    targetAspectRatio: ratio
  };
  return updated;
}
