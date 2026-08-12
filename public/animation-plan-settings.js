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

export function animationPlanRuntimeSummary(plan = {}) {
  const shots = Array.isArray(plan?.shotPlan) ? plan.shotPlan : [];
  const target = Number(plan?.productionStrategy?.targetRuntimeSeconds);
  const targetSeconds = Number.isFinite(target) && target > 0 ? target : null;
  if (!shots.length) {
    return {
      valid: false,
      plannedSeconds: null,
      targetSeconds,
      deltaSeconds: null,
      reason: "镜头计划为空"
    };
  }

  const durations = shots.map((shot) => Number(shot?.durationSeconds));
  if (durations.some((duration) => !Number.isFinite(duration) || duration <= 0)) {
    return {
      valid: false,
      plannedSeconds: null,
      targetSeconds,
      deltaSeconds: null,
      reason: "镜头时长数据不完整"
    };
  }

  const plannedSeconds = durations.reduce((total, duration) => total + duration, 0);
  return {
    valid: true,
    plannedSeconds,
    targetSeconds,
    deltaSeconds: targetSeconds === null ? null : plannedSeconds - targetSeconds,
    reason: ""
  };
}
