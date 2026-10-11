// 最小合法 4.0 自主分镜夹具：一个角色、一场、一个片段，能过 ensureStoryboardPlan 全量校验
// （test/legacy-animation-plan-guards.test.js 锁住这一点）。2026-10-11 起提交口、测试包封装与导入都只收 4.0，
// 原来拿旧 3.0 / 2.0 Plan 当下游数据的测试改用它。它不与任何真实剧情逐字对应，只是合法的 4.0 形状。
export function minimalStoryboardPlan({
  selectedVariantId = "V1",
  title = "雨天的纸箱",
  sceneId = "S1",
  characterName = "阿岚",
  durationSeconds = 10
} = {}) {
  return {
    promptSchemaVersion: "4.0",
    selectedVariantId,
    title,
    productionStrategy: {
      format: "storyboard_video",
      targetAspectRatio: "16:9",
      targetRuntimeSeconds: durationSeconds,
      backgroundMusicMode: "none",
      visualStyle: "治愈",
      characterExpressionRules: "",
      sourceSceneIds: [sceneId],
      characterNames: [characterName]
    },
    viewingIntent: `${characterName}在雨里把纸箱护进屋檐下。`,
    visualDesign: {
      characters: [{ name: characterName, appearance: "", designedDetails: [] }],
      locations: [{ name: "屋檐下", sourceSceneIds: [sceneId], layout: "窄屋檐下靠墙", lighting: "阴天自然光" }],
      props: []
    },
    adaptations: [],
    blockedIssues: [],
    shotPlan: [{
      shotId: "A01",
      sourceSceneIds: [sceneId],
      durationSeconds,
      storyPurpose: `建立${characterName}护住纸箱`,
      emotionalTarget: "专注",
      transitionIn: { type: "start", description: "开场" },
      beats: [{
        startSeconds: 0,
        endSeconds: durationSeconds,
        sourceSceneIds: [sceneId],
        location: "屋檐下",
        characters: [characterName],
        framing: "中景",
        camera: "固定机位",
        visibleAction: `${characterName}把湿了一角的纸箱抱进屋檐下。`,
        dialogue: [],
        soundDesign: "雨声"
      }],
      continuityOut: `纸箱放在${characterName}脚边。`,
      acceptanceCriteria: ["纸箱始终在画面里"]
    }],
    characterReferencePrompts: [{
      characterName,
      storyRole: "主角",
      identity: "社区修理师",
      appearancePrompt: `${characterName}，社区修理师`,
      consistencyTags: [],
      forbiddenChanges: []
    }],
    characterRegistry: {
      protagonist: {
        name: characterName,
        identity: "社区修理师",
        traits: ["细心"],
        speechRules: "话少",
        signatureBehaviors: ["先护住手里的东西"]
      },
      supportingCharacters: []
    },
    editorial: { initialReview: null, repairs: [], finalReview: null, guidance: [] }
  };
}
