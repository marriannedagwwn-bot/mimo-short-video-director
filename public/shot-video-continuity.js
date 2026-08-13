export const SHOT_VIDEO_CONTINUITY_NONE = "none";
export const SHOT_VIDEO_CONTINUITY_PREVIOUS_SHOT_FRAMES = "previous_shot_frames";

export function shotVideoArtifactIdFor(variantId, shotId) {
  return `shotVideo:${String(variantId || "")}:${String(shotId || "")}`;
}

export function shotVideoResultKey(variantId, shotId) {
  return `${String(variantId || "")}:${String(shotId || "")}`;
}

export function shotFrameResultKey(variantId, shotId, frameKind) {
  return `${String(variantId || "")}:${String(shotId || "")}:${frameKind === "end" ? "end" : "start"}`;
}

export function mediaFilenameSegment(value) {
  return String(value || "item")
    .trim()
    .replace(/\s+/gu, "_")
    .replace(/[^\p{L}\p{N}_-]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 60) || "item";
}

export function dropStaleMediaResults(mediaState = {}, artifactIdValue = "") {
  const artifactId = String(artifactIdValue || "");
  const videoResults = mediaState.shotVideoResults || {};
  const frameResults = mediaState.shotFrameResults || {};
  if (artifactId.startsWith("animationPlan:")) {
    const prefix = `${artifactId.slice("animationPlan:".length)}:`;
    for (const key of Object.keys(videoResults)) if (key.startsWith(prefix)) delete videoResults[key];
    for (const key of Object.keys(frameResults)) if (key.startsWith(prefix)) delete frameResults[key];
    return;
  }
  const parts = artifactId.split(":");
  if (parts[0] === "shotVideo" && parts.length >= 3) {
    delete videoResults[shotVideoResultKey(parts[1], parts.slice(2).join(":"))];
  } else if (parts[0] === "shotFrame" && parts.length >= 4) {
    delete frameResults[shotFrameResultKey(parts[1], parts.slice(2, -1).join(":"), parts.at(-1))];
  }
}

export function previousShotInPlan(plan = {}, currentShotId = "") {
  const shots = Array.isArray(plan.shotPlan) ? plan.shotPlan : [];
  const matches = shots
    .map((shot, index) => ({ shot, index }))
    .filter(({ shot }) => String(shot?.shotId || "") === String(currentShotId || ""));
  if (matches.length !== 1) return null;
  return matches[0].index > 0 ? shots[matches[0].index - 1] : null;
}

export function selectedShotVideoCandidate(stateItem = {}) {
  if (stateItem?.status !== "ready") return null;
  const result = stateItem.result || {};
  const videos = Array.isArray(result.videos) && result.videos.length
    ? result.videos
    : result.outputUrl || result.url
      ? [result]
      : [];
  const selectedIndex = Number(stateItem.selectedIndex ?? result.selectedIndex ?? 0);
  if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || !videos[selectedIndex]) return null;
  const selected = videos[selectedIndex];
  const outputUrl = String(selected.outputUrl || selected.url || "").trim();
  return outputUrl ? { ...selected, outputUrl, selectedIndex } : null;
}

export function estimateOneFpsFrameCount(durationSeconds) {
  const duration = Number(durationSeconds);
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return Math.max(1, Math.round(duration));
}
