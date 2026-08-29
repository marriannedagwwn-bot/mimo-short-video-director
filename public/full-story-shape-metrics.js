// Full Story 的形状指标：只统计结构化字段，不做任何语义判断。
//
// 起因是一次真实成片：六场戏里三场同一个客厅、同样三个角色并排，四句对白
// 有三句出自奶奶之口——这些在 Full Story 生成的那一刻就能算出来，但当时没有
// 任何地方显示，直到六个镜头都生成完才被察觉。
//
// 这里**只做能确定性判定的两类**：
//   - 画面配置重复：location 与 characters 都是结构化字段，数重复是纯算术
//   - 说话者分布：dialogue[].speaker 是结构化字段，统计占比也是算术
// 「这场有没有阻力」「这句是不是解说」需要语义判断，不在此处裁决，
// 只留在 Prompt 与人工评分里。
//
// 这些指标**不是校验器**：六场同一个地点不违法，只是通常更弱。
// 全部只用于展示，不抛错、不阻断、不改变任何 Artifact。

// 阈值按 68 份历史 Full Story 的实际分布标定，目标是让提示稀有到值得看：
//
//                中位   p75   p90   最大
//   同配置占比    0.33  0.50  0.67  1.00
//   主说话者占比  0.63  0.75  0.89  1.00
//
// 取 p90 附近，命中率 10%（7/68），标出来的都是真问题：两份六场全部同配置、
// 三份全片台词出自同一人。
//
// **同地点占比不作为提示项**：它的中位数就是 0.50——六十秒短片集中在一两个
// 地点是这个赛道的常态，不是缺陷。按 0.5 标会命中 60%，那种提示等于噪声，
// 会把真正异常的那 10% 淹掉。该数字仍然计算并展示，只是不触发提示。
export const SHAPE_METRIC_THRESHOLDS = Object.freeze({
  repeatedConfigShare: 0.67,
  topSpeakerShare: 0.9,
  minDialogueLines: 4
});

function sceneList(fullStory) {
  const scenes = fullStory?.sceneScript;
  return Array.isArray(scenes) ? scenes.filter((scene) => scene && typeof scene === "object") : [];
}

// 画面配置 = 地点 + 出镜角色集合。两场戏地点相同但出镜的人不同，
// 剪出来是两个画面，不算重复；地点和人都相同才算。
function configKey(scene) {
  const characters = Array.isArray(scene.characters) ? scene.characters : [];
  return JSON.stringify([
    String(scene.location || "").trim(),
    [...characters].map((name) => String(name || "").trim()).sort()
  ]);
}

function countTop(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  let top = null;
  let max = 0;
  for (const [value, n] of counts) {
    if (n > max) { max = n; top = value; }
  }
  return { top, max, distinct: counts.size };
}

export function fullStoryShapeMetrics(fullStory) {
  const scenes = sceneList(fullStory);
  if (!scenes.length) return null;

  const configs = countTop(scenes.map(configKey));
  const locations = countTop(scenes.map((scene) => String(scene.location || "").trim()));

  const lines = scenes.flatMap((scene) => (Array.isArray(scene.dialogue) ? scene.dialogue : []))
    .filter((line) => line && typeof line === "object");
  const speakers = countTop(lines.map((line) => String(line.speaker || "").trim()));
  const silentScenes = scenes.filter((scene) => !(Array.isArray(scene.dialogue) && scene.dialogue.length)).length;

  return {
    sceneCount: scenes.length,
    repeatedConfigScenes: configs.max,
    distinctConfigs: configs.distinct,
    repeatedLocationScenes: locations.max,
    repeatedLocation: locations.top || "",
    distinctLocations: locations.distinct,
    dialogueLines: lines.length,
    topSpeaker: speakers.top || "",
    topSpeakerLines: speakers.max,
    topSpeakerShare: lines.length ? speakers.max / lines.length : 0,
    silentScenes
  };
}

// 返回需要提示的项。空数组表示这份 Full Story 在可确定性判定的形状上没有异常，
// 不代表故事好——阻力、解说、情绪这些都不在这里衡量。
export function fullStoryShapeWarnings(fullStory, thresholds = SHAPE_METRIC_THRESHOLDS) {
  const m = fullStoryShapeMetrics(fullStory);
  if (!m) return [];
  const out = [];

  if (m.sceneCount && m.repeatedConfigScenes / m.sceneCount >= thresholds.repeatedConfigShare) {
    out.push({
      code: "REPEATED_SCENE_CONFIG",
      label: `${m.repeatedConfigScenes}/${m.sceneCount} 场画面配置相同`,
      detail: `有 ${m.repeatedConfigScenes} 场戏的地点与出镜角色完全一致，全片只有 ${m.distinctConfigs} 种画面配置。剪辑出来会偏单调。`
    });
  }
  if (m.dialogueLines >= thresholds.minDialogueLines && m.topSpeakerShare >= thresholds.topSpeakerShare) {
    out.push({
      code: "DOMINANT_SPEAKER",
      label: `${Math.round(m.topSpeakerShare * 100)}% 台词出自「${m.topSpeaker}」`,
      detail: `全片 ${m.dialogueLines} 句台词里 ${m.topSpeakerLines} 句是「${m.topSpeaker}」说的。台词过度集中在一个角色身上，通常意味着由他替观众解说冲突与主题。`
    });
  }
  return out;
}
