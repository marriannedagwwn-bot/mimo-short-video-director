export function buildVideoGenerationQueue(pack = {}) {
  const plan = pack.animationPlan || {};
  const strategy = plan.productionStrategy || {};
  const visual = plan.visualBible || {};
  const selectedVariant = pack.selectedVariant || {};
  const generatedAt = pack.exportedAt || new Date().toISOString();
  const aspectRatio = strategy.targetAspectRatio || "9:16";
  const queue = {
    version: "1.0",
    generatedAt,
    providerMode: "provider_agnostic",
    selectedVariantId: selectedVariant.id || plan.selectedVariantId || "",
    title: plan.title || pack.fullStory?.title || selectedVariant.title || "首尾帧动画生产队列",
    common: {
      aspectRatio,
      targetRuntimeSeconds: strategy.targetRuntimeSeconds || pack.fullStory?.targetDurationSeconds || 60,
      recommendedShotDurationSeconds: strategy.recommendedShotDurationSeconds || { min: 3, max: 6 },
      visualStyle: visual.animationStyle || visual.overallStyle || "",
      cameraLanguage: visual.cameraLanguage || "",
      characterConsistencyRules: visual.characterConsistencyRules || [],
      negativeVisualRules: visual.negativeVisualRules || []
    },
    jobs: []
  };

  for (const [index, character] of (plan.characterReferencePrompts || []).entries()) {
    queue.jobs.push({
      taskId: `REF-${String(index + 1).padStart(2, "0")}`,
      type: "reference_image",
      inputType: "text_to_image",
      outputKey: `references.${slug(character.characterName || `character_${index + 1}`)}`,
      prompt: character.appearancePrompt || "",
      negativePrompt: joinList(character.forbiddenChanges),
      consistencyTags: character.consistencyTags || [],
      acceptanceCriteria: [`${character.characterName || "角色"}外观与身份一致`, "可作为后续首尾帧生成的角色参考"]
    });
  }

  for (const [index, asset] of (plan.assetPrompts || []).entries()) {
    queue.jobs.push({
      taskId: `ASSET-${String(index + 1).padStart(2, "0")}`,
      type: "asset_image",
      inputType: "text_to_image",
      outputKey: `assets.${slug(asset.assetName || `asset_${index + 1}`)}`,
      prompt: asset.imagePrompt || "",
      negativePrompt: asset.avoidSimilarityNote || "",
      consistencyTags: asset.consistencyTags || [],
      acceptanceCriteria: [`${asset.assetName || "资产"}外观清楚`, "道具或场景能在后续镜头中保持一致"]
    });
  }

  for (const shot of plan.shotPlan || []) {
    const shotId = shot.shotId || `SHOT-${String(queue.jobs.length + 1).padStart(2, "0")}`;
    const startOutput = `frames.${shotId}.start`;
    const endOutput = `frames.${shotId}.end`;
    const videoOutput = `videos.${shotId}`;
    const sharedShot = {
      shotId,
      sourceSceneId: shot.sourceSceneId || "",
      durationSeconds: Number(shot.durationSeconds) || 4,
      aspectRatio,
      storyPurpose: shot.storyPurpose || "",
      emotionalTarget: shot.emotionalTarget || "",
      continuityNotes: shot.continuityNotes || ""
    };

    queue.jobs.push({
      taskId: `${shotId}-START`,
      type: "start_frame_image",
      inputType: "text_to_image",
      outputKey: startOutput,
      ...sharedShot,
      prompt: shot.startFramePrompt || "",
      negativePrompt: shot.negativePrompt || "",
      requiredInputs: collectReferenceKeys(queue),
      acceptanceCriteria: ["首帧角色、服装、地点、构图、光线和道具清楚", ...(shot.acceptanceCriteria || [])]
    });

    queue.jobs.push({
      taskId: `${shotId}-END`,
      type: "end_frame_image",
      inputType: "text_to_image",
      outputKey: endOutput,
      ...sharedShot,
      prompt: shot.endFramePrompt || "",
      negativePrompt: shot.negativePrompt || "",
      requiredInputs: collectReferenceKeys(queue),
      acceptanceCriteria: ["尾帧与首帧形成明确动作终点", ...(shot.acceptanceCriteria || [])]
    });

    queue.jobs.push({
      taskId: `${shotId}-VIDEO`,
      type: "first_last_frame_video",
      inputType: "image_pair_to_video",
      outputKey: videoOutput,
      ...sharedShot,
      prompt: shot.videoPrompt || "",
      negativePrompt: shot.negativePrompt || "",
      requiredInputs: [startOutput, endOutput],
      cameraMotion: shot.cameraMotion || "",
      characterAction: shot.characterAction || "",
      dialogueOrSubtitle: shot.dialogueOrSubtitle || "",
      soundDesign: shot.soundDesign || "",
      acceptanceCriteria: shot.acceptanceCriteria || []
    });

    queue.jobs.push({
      taskId: `${shotId}-QA`,
      type: "quality_check",
      inputType: "video_review",
      outputKey: `reviews.${shotId}`,
      ...sharedShot,
      requiredInputs: [videoOutput],
      prompt: `检查 ${shotId} 是否符合角色一致性、首尾帧因果、动作目标、情绪目标和可剪辑性。`,
      negativePrompt: "",
      acceptanceCriteria: [...(shot.acceptanceCriteria || []), "没有角色漂移、服装漂移、场景跳变或肢体严重变形"]
    });
  }

  return queue;
}

export function formatQueueJsonl(queue = {}) {
  return (queue.jobs || []).map((job) => JSON.stringify(job)).join("\n");
}

function collectReferenceKeys(queue) {
  return (queue.jobs || [])
    .filter((job) => job.type === "reference_image" || job.type === "asset_image")
    .map((job) => job.outputKey);
}

function joinList(value) {
  if (Array.isArray(value)) return value.join("；");
  return String(value || "");
}

function slug(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^\p{L}\p{N}_-]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40) || "item";
}
