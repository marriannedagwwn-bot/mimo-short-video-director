const NEGATIVE_PROMPT_TARGETS = new Set(["image", "video"]);
const NEGATIVE_PROMPT_APPLIES_TO = new Set(["image", "video", "both"]);
const NEGATIVE_PROMPT_PRIORITIES = new Set(["high", "medium", "low"]);
const NEGATIVE_PROMPT_REASON_CODES = new Set([
  "explicit_identity_conflict",
  "shot_object_confusion",
  "shot_interaction_failure",
  "temporal_consistency_failure",
  "reference_leak",
  "proven_provider_failure"
]);

export function negativePromptEntriesForTarget(shot = {}, target = "image") {
  const normalizedTarget = normalizeTarget(target);
  const values = shot?.negativePrompts?.[normalizedTarget];
  if (!Array.isArray(values)) return [];

  const seen = new Set();
  const entries = [];
  for (const value of values) {
    const entry = normalizeNegativePromptEntry(value, normalizedTarget);
    if (!entry || entry.enabled === false || seen.has(entry.text)) continue;
    seen.add(entry.text);
    entries.push(entry);
  }
  return entries;
}

export function compileShotNegativePrompt(shot = {}, target = "image") {
  const normalizedTarget = normalizeTarget(target);
  const negativePromptEntries = negativePromptEntriesForTarget(shot, normalizedTarget);
  return {
    target: normalizedTarget,
    negativePromptEntries,
    compiledNegativePrompt: negativePromptEntries.map((entry) => entry.text).join("；")
  };
}

export function normalizeNegativePromptEntry(value, target = "image") {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (Object.hasOwn(value, "enabled") && typeof value.enabled !== "boolean") return null;
  const text = String(value.text || "").trim();
  const appliesTo = String(value.appliesTo || "").trim().toLowerCase();
  const reasonCode = String(value.reasonCode || "").trim();
  const priority = String(value.priority || "").trim().toLowerCase();
  const triggerEvidence = normalizeTriggerEvidence(value.triggerEvidence);
  const normalizedTarget = normalizeTarget(target);
  if (!text || !NEGATIVE_PROMPT_APPLIES_TO.has(appliesTo)) return null;
  if (appliesTo !== normalizedTarget && appliesTo !== "both") return null;
  if (!triggerEvidence || !NEGATIVE_PROMPT_REASON_CODES.has(reasonCode) || !NEGATIVE_PROMPT_PRIORITIES.has(priority)) return null;
  return {
    ...value,
    text,
    appliesTo,
    triggerEvidence,
    reasonCode,
    priority,
    ...(Object.hasOwn(value, "enabled") ? { enabled: value.enabled } : {})
  };
}

function normalizeTarget(value) {
  const target = String(value || "").trim().toLowerCase();
  return NEGATIVE_PROMPT_TARGETS.has(target) ? target : "image";
}

function normalizeTriggerEvidence(value) {
  // Render negatives must remain traceable to a concrete source path.  A bare
  // string is a legacy shape and must not enter a provider queue.
  if (typeof value === "string") return null;
  if (Array.isArray(value)) {
    const items = value.map(normalizeTriggerEvidenceItem).filter(Boolean);
    return items.length ? items : null;
  }
  const item = normalizeTriggerEvidenceItem(value);
  if (item) return [item];
  return null;
}

function normalizeTriggerEvidenceItem(value) {
  if (typeof value === "string") return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const sourcePath = String(value.sourcePath || "").trim();
  const evidence = String(value.evidence || "").trim();
  if (!sourcePath || !evidence) return null;
  return { ...value, sourcePath, evidence };
}
