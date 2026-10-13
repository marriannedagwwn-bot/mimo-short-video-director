export const STORYBOARD_PLAN_VERSION = "4.0";
export const SHOT_VIDEO_PROMPT_VERSION = "shot_video_prompt/1.0";
export function isStoryboardPlan(plan) { return plan?.promptSchemaVersion === STORYBOARD_PLAN_VERSION; }

// 2026-10-11 起只支持 4.0。旧 2.0（首尾帧）/ 3.0（direct_shot）Plan 只会出现在
// 旧 Run 或旧导出包里：照实报出版本，由调用方明确拒绝或提示重新生成，
// 不得当成 4.0 读取，也不得静默丢弃。
export const ANIMATION_PLAN_VERSION_UNSUPPORTED = "ANIMATION_PLAN_VERSION_UNSUPPORTED";
export function legacyAnimationPlanVersion(plan) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return null;
  if (isStoryboardPlan(plan)) return null;
  const version = typeof plan.promptSchemaVersion === "string" ? plan.promptSchemaVersion.trim() : "";
  return version || "unversioned";
}
export function legacyAnimationPlanMessage(version) {
  const label = version === "unversioned" ? "无版本号的旧版" : `旧版 ${version} `;
  return `这是${label}分镜，已不再支持（只支持 ${STORYBOARD_PLAN_VERSION} 自主分镜）。请重新生成分镜。`;
}

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
// 画外说话者不在 characters 里）。生成视频时页面按这组名字挑角色参考图（shot-reference-images.js
// 的 shotRelatedCharacterReferences 直接调用它），素材清单再用这个名字把图对到角色；单镜提示词
// 必须原样写出这组名字（shotVideoPromptViolations），否则清单里的图对不上画面里的人。
export function storyboardShotCharacterNames(shot) {
  const beats = Array.isArray(shot?.beats) ? shot.beats : [];
  return [...new Set(beats.flatMap(beat => (Array.isArray(beat?.characters) ? beat.characters : [])))];
}
