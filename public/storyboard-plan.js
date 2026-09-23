export const STORYBOARD_PLAN_VERSION = "4.0";
export const SHOT_VIDEO_PROMPT_VERSION = "shot_video_prompt/1.0";
export function isStoryboardPlan(plan) { return plan?.promptSchemaVersion === STORYBOARD_PLAN_VERSION; }

// Read-only compatibility projection for existing media adapters. These strings
// are never saved back into the Plan or treated as a second creative source.
export function storyboardShotForVideo(shot) {
  if (!Array.isArray(shot?.beats)) return shot;
  return { ...shot,
    sourceSceneId: shot.sourceSceneIds.join("、"),
    characterAction: shot.beats.map(beat => beat.visibleAction).join("\n"),
    cameraMotion: shot.beats.map(beat => beat.camera).join("\n"),
    dialogueOrSubtitle: shot.beats.flatMap(beat => beat.dialogue.map(line => `${line.speaker}：${line.text}`)).join("\n"),
    soundDesign: shot.beats.map(beat => beat.soundDesign).join("\n"),
    continuityNotes: `${shot.transitionIn.description}\n${shot.continuityOut}`
  };
}

export function storyboardPromptArtifactId(variantId, shotId) {
  return `shotVideoPrompt:${variantId}:${shotId}`;
}

export function storyboardPromptMatches(value, {planDigest, provider, model, textProvider, textModel} = {}) {
  return value?.schemaVersion === SHOT_VIDEO_PROMPT_VERSION && value.planDigest === planDigest
    && value.target?.provider === provider && value.target?.model === model
    && value.writer?.provider === textProvider && value.writer?.model === textModel;
}

export function storyboardUsesPreviousFrames(shot) {
  return shot?.transitionIn?.type === "continuous";
}
