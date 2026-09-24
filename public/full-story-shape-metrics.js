// Full Story 的形状指标：只统计结构化字段，不做任何语义判断。
//
// 起因是一次真实成片：六场戏里三场同一个客厅、同样三个角色并排，四句对白
// 有三句出自奶奶之口——这些在 Full Story 生成的那一刻就能算出来，但当时没有
// 任何地方显示，直到六个镜头都生成完才被察觉。
//
// 这里**只做能确定性判定的两类**：
//   - 画面配置重复：地点与主角在场与否都是结构化字段，数重复是纯算术
//   - 说话者分布：dialogue[].speaker 是结构化字段，统计占比也是算术
// 「这场有没有阻力」「这句是不是解说」需要语义判断，不在此处裁决，
// 只留在 Prompt 与人工评分里。
//
// 这些指标**不是校验器**：六场同一个地点不违法，只是通常更弱。
// 全部只用于展示，不抛错、不阻断、不改变任何 Artifact。
//
// 地点维度是**双侧**的：过于集中（同机位同布景）和过碎（逐镜换景，
// 对逐镜 AI 视频意味着环境连续性、道具数量与角色比例都更容易漂）都会提示。

// 阈值按 75 份历史 Full Story 的实际分布标定，目标是让提示稀有到值得看。
//
// repeatedConfigShare 定在 0.8（六场里五场）：配置键改成「地点 + 主角在不在场」后
// 分布整体上移，实测命中 16/75（21%）。旧键 + 2/3 阈值只命中 10%，但那是**漏报**
// 而非更准——它把「同一张桌子前拍六场、只是配角进出画面」判成了不重复。
//
// **同地点占比不作为独立提示项**：中位数就是 0.50——六十秒短片集中在一两个地点
// 是这个赛道的常态。按 0.5 标会命中 60%，那种提示等于噪声。该数字仍然计算并展示。
// 主角是否在场已经隐含了大部分地点信息，不需要第二条规则。
export const SHAPE_METRIC_THRESHOLDS = Object.freeze({
  repeatedConfigShare: 0.8,
  topSpeakerShare: 0.9,
  minDialogueLines: 4,
  // 地点密度的另一侧：过碎和过于集中都是问题，此前只提示后者。
  // 按时长归一化而不是数地点个数——5 个地点在 60 秒里正常（43% 的历史故事
  // 有 5 个以上地点，中位数就是 4），塞进 44 秒就偏碎。
  // 每 10 秒地点数：中位 0.67、p90 1.00、最大 1.17。取 1.1 命中 2/76（3%）；
  // 取 1.0 会命中 21%，那是常态不是异常。
  locationsPerTenSeconds: 1.1
});

function sceneList(fullStory) {
  const scenes = fullStory?.sceneScript;
  return Array.isArray(scenes) ? scenes.filter((scene) => scene && typeof scene === "object") : [];
}

// 画面配置 = 地点 + 主角在不在场。
//
// 曾经用「地点 + 完整出镜角色集合」，实测有个可以被刷掉的漏洞：同一份故事
// 只要把配角从两场里移出画面，同配置数就从 4/6 掉到 3/6，指标由「标记」变成
// 「不标记」，而六场戏依然全在同一张桌子前、同一个机位——画面根本没变。
//
// 配角来去不改变机位与布景，主角离场才是真的换了一个画面，所以只看主角在不在。
// 代价是命中率从 10% 升到约 21%：旧定义是在系统性少数，不是更准。
function configKey(scene, protagonistName = "") {
  const characters = Array.isArray(scene.characters) ? scene.characters : [];
  const name = String(protagonistName || "").trim();
  const hasProtagonist = name
    ? characters.some((item) => String(item || "").includes(name))
    : characters.length > 0;
  return JSON.stringify([String(scene.location || "").trim(), hasProtagonist]);
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

  const rawDuration = Number(fullStory?.targetDurationSeconds);
  const durationSeconds = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : 0;
  const protagonistName = String(fullStory?.characterBible?.protagonist?.name || "").trim();
  const configs = countTop(scenes.map((scene) => configKey(scene, protagonistName)));
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
    silentScenes,
    durationSeconds,
    locationsPerTenSeconds: durationSeconds > 0 ? (locations.distinct / durationSeconds) * 10 : 0
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
      detail: `有 ${m.repeatedConfigScenes} 场戏发生在同一地点且主角在场情况相同，全片只有 ${m.distinctConfigs} 种画面配置（${m.distinctLocations} 个地点）。同机位同布景，剪辑出来会偏单调。`
    });
  }
  if (m.durationSeconds > 0 && m.locationsPerTenSeconds >= thresholds.locationsPerTenSeconds) {
    out.push({
      code: "FRAGMENTED_LOCATIONS",
      label: `${m.durationSeconds} 秒里换了 ${m.distinctLocations} 个地点`,
      detail: `平均每 10 秒换 ${m.locationsPerTenSeconds.toFixed(1)} 个地点。逐镜生成时，环境连续性、道具数量与角色比例都更容易在镜头之间漂移，剪出来容易变成一组漂亮片段而不是连续故事。`
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
