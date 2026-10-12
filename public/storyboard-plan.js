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

// 4.0 片段的出镜角色：全部 beat 的 characters 按第一次出现的顺序去重（只认画面里的人，
// 画外说话者不在 characters 里）。生成视频时按这组名字挑角色参考图（shot-reference-images.js
// 的 4.0 分支，测试锁住两边选出同一批人），素材清单再用这个名字把图对到角色；单镜提示词
// 必须原样写出这组名字（shotVideoPromptViolations），否则清单里的图对不上画面里的人。
export function storyboardShotCharacterNames(shot) {
  const beats = Array.isArray(shot?.beats) ? shot.beats : [];
  return [...new Set(beats.flatMap(beat => (Array.isArray(beat?.characters) ? beat.characters : [])))];
}
