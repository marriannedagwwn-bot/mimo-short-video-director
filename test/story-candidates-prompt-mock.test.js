import test from "node:test";
import assert from "node:assert/strict";
import { mockVariants } from "../src/mock.js";
import { briefPrompt, variantsPrompt } from "../src/prompts.js";
import { ensureOutputContract, ensureThemeVariantsMatchProfile } from "../src/validation.js";

const creatorProfile = Object.freeze({
  fixedCharacter: "小白子，q版狼耳少女，村里的热心帮手",
  vertical: "治愈/温情/日常",
  constraints: ""
});

test("Creative Brief Prompt keeps strong fidelity fields at the dramatic-value layer", () => {
  const prompt = briefPrompt({
    creatorProfile,
    referenceAnalysis: {},
    sourceScriptReconstruction: {}
  });

  assert.match(prompt, /mustRetain 只能写不可替代的剧作价值/u);
  assert.match(prompt, /samePlotDriver 只描述抽象因果驱动力/u);
  assert.match(prompt, /sameBeatValue 只列可独立迁移的剧作价值/u);
  assert.match(prompt, /creativeDistancePolicy 必须明确/u);
  assert.match(prompt, /具体任务、角色、奖励、道具、事件顺序和结尾形式均可重新组合/u);
  assert.match(prompt, /把奖励转赠奶奶、小红花、家庭聚餐、家庭温暖结尾/u);
  assert.match(prompt, /只有 creatorProfile\.fixedCharacter、creatorProfile\.vertical 或 creatorProfile\.constraints 明确要求/u);
  assert.match(prompt, /allowedNarrativeComponents 只记录原片是否存在某类通用构件/u);
  assert.match(prompt, /必须保留角色关系价值和情绪兑现强度/u);
  assert.match(prompt, /坏例：mustRetain 写成“完成送达后获得小红花，把小红花转赠奶奶，再以家庭聚餐收尾”/u);
  assert.match(prompt, /奖励价值的好例/u);
  assert.match(prompt, /不要求物质奖励/u);
  assert.match(prompt, /关系变化、新信息、任务后果、自我认识或外部反馈/u);
  assert.match(prompt, /关系兑现的好例/u);
  assert.match(prompt, /重要关系对象之间可见的关系变化/u);
  assert.match(prompt, /不要求赠送物品/u);
  assert.match(prompt, /不预设单向变双向、和解、团聚或任何唯一关系模板/u);
  assert.match(prompt, /来源故事的具体因果链、任务、奖励、转赠、结尾形式与事件顺序默认不是不可协商体验/u);
  assert.doesNotMatch(prompt, /改编必须保留[^\n]*同类剧情驱动力/u);
});

test("Variants Prompt replaces the disposable beat conflict and declares only candidate-level additions", () => {
  const prompt = variantsPrompt({
    count: 4,
    creatorProfile,
    creativeBrief: {
      contentType: "治愈短片",
      targetAudience: "家庭观众",
      coreEmotion: "温暖",
      storyEngine: { desire: "SENTINEL_SOURCE_STORY_ENGINE" },
      reusableHighValueBeats: [{
        beat: "SENTINEL_SOURCE_BEAT",
        dramaticValue: "SENTINEL_ABSTRACT_DRAMATIC_VALUE",
        mustRetain: "SENTINEL_CONCRETE_MUST_RETAIN",
        adaptableSurface: ["SENTINEL_SOURCE_PROP"]
      }],
      nonNegotiableExperience: {
        samePositioning: "治愈定位",
        sameAudience: "家庭观众",
        sameEmotion: "温暖",
        samePlotDriver: "SENTINEL_CONCRETE_PLOT_DRIVER",
        sameBeatValue: "SENTINEL_CONCRETE_BEAT_VALUE"
      },
      creativeDistancePolicy: "SENTINEL_CONCRETE_DISTANCE_POLICY"
    },
    referenceAnalysis: {},
    visualGuardrails: {}
  });

  assert.doesNotMatch(prompt, /beat 不推进主线|删掉它故事依然完整/u);
  assert.match(prompt, /主要承担角色性格或人物关系质感/u);
  assert.match(prompt, /仍必须改变关系状态、情绪状态、信息状态或后续选择条件/u);
  assert.match(prompt, /删除后必须使角色弧线、关系推进、情绪积累或后续因果至少损失一项/u);
  assert.match(prompt, /4 个候选的结构签名必须两两不同/u);
  assert.match(prompt, /签名由 dramaticFunction 序列、keyChoice、climax 和 emotionalPayoff 共同组成/u);

  // keyChoice/climax/emotionalPayoff 已改为服务端派生，不再作为 JSON 键出现在输出结构里。
  for (const field of ["keyChoiceBeat", "climaxBeat", "novelty", "visualPotential"]) {
    assert.match(prompt, new RegExp(`"${field}"`, "u"));
  }
  assert.match(prompt, /只写候选级摘要，不展开 Full Story/u);
  assert.match(prompt, /不写分场、镜头或 shotPlan/u);
  assert.match(prompt, /用八个维度比较候选/u);
  for (const dimension of [
    "protagonist desire",
    "obstacle source",
    "key choice type",
    "consequence",
    "climax mechanism",
    "emotional payoff form",
    "relationship change",
    "ending state"
  ]) {
    assert.match(prompt, new RegExp(dimension, "u"));
  }
  assert.match(prompt, /任意两个候选之间至少有三个维度发生根本差异/u);
  assert.match(prompt, /只替换地点、天气、NPC、运送物、奖励物、结尾活动/u);
  assert.match(prompt, /都只是表面替换，不计入三个维度/u);
  assert.match(prompt, /生成 4 个候选时，全组至少使用 3 种不同的高潮机制和 3 种不同的情绪兑现形式/u);
  assert.match(prompt, /全组最多一个候选可以采用这条三段完整组合/u);
  assert.match(prompt, /帮助或送达 → 获得外部奖励/u);
  assert.match(prompt, /无论其后采用家庭聚餐、家庭温暖场面还是其他结尾，都计入同一组合/u);
  assert.match(prompt, /“分享一部分”“共同使用奖励”“把奖励带回重要关系人身边”同样属于奖励回流/u);
  assert.match(prompt, /限制的是完整因果组合在候选集中的重复，不是关键词黑名单/u);
  assert.match(prompt, /老人、雨、礼物、帮助、送达都可以/u);
  assert.match(prompt, /按剧作功能判断，不按亲属称谓或字段位置逃逸/u);
  assert.match(prompt, /只允许 V1 使用一次，V2–V4 必须使用不同因果引擎/u);
  assert.match(prompt, /至少 2 个候选的 protagonist desire 不能是完成帮助、捐赠、运送、取物或限时到达/u);
  assert.match(prompt, /至少 3 个 emotionalPayoff 必须由关系、信息、选择后果、自我认识或后续行动本身兑现/u);
  assert.match(prompt, /每个 experienceFidelity\.plotDriver 必须描述当前候选自己独有的因果驱动力/u);
  assert.match(prompt, /做八项内部自检/u);
  assert.match(prompt, /keyChoiceBeat 指向的那一拍，action 是否确实写的是主角亲自作出的关键选择/u);
  assert.match(prompt, /keyChoice 产生的 consequence 是否实际推动后续 climax/u);
  assert.match(prompt, /climaxBeat 指向的那一拍，是否同时包含固定主角亲自完成的决定性动作/u);
  assert.match(prompt, /配角可以协助、阻拦或回应，但不能替主角作出最终决定、完成解决动作或独占可见结果/u);
  assert.match(prompt, /高潮 Beat 的 dramaticFunction 是否明确承担高潮与结果改变/u);
  assert.match(prompt, /最后一拍是否把可见的关系、情绪、信息或后续行动状态写进 action/u);
  assert.match(prompt, /前文已经建立的行动、信息和关系变化合法到达/u);
  assert.match(prompt, /已经送出、损坏、遗失或随角色离开的物品/u);
  assert.match(prompt, /同一人物、物品、环境和行动媒介不得同时处于两个地点或两个互斥状态/u);
  assert.match(prompt, /环境状态改变和行动媒介切换，都必须在对应 Beat 明写/u);
  assert.match(prompt, /远方收件人不能已拿着同一件物品/u);
  assert.match(prompt, /结尾新出现的角色.*同行、明确邀请、可见到达或时间跳转依据/u);
  assert.match(prompt, /首次失败后又在另一地点被找到，必须写明线索、寻找或移动动作/u);
  assert.match(prompt, /endingRitual 不得引入兑现 Beat 中没有的人物、物品或动作/u);
  assert.match(prompt, /novelty 是否来自新目标、新因果结构、新选择代价、高潮机制或关系表达/u);
  assert.match(prompt, /而不只是天气、道具、地点或 NPC 的替换/u);
  assert.match(prompt, /输入的 creativeBrief 可能来自旧版本/u);
  assert.match(prompt, /只提取对应 dramaticValue、角色关系价值和情绪兑现强度/u);
  assert.match(prompt, /creativeBrief 抽象保真投影/u);
  assert.match(prompt, /SENTINEL_ABSTRACT_DRAMATIC_VALUE/u);
  assert.doesNotMatch(prompt, /SENTINEL_SOURCE_STORY_ENGINE/u);
  assert.doesNotMatch(prompt, /SENTINEL_SOURCE_BEAT/u);
  assert.doesNotMatch(prompt, /SENTINEL_CONCRETE_MUST_RETAIN/u);
  assert.doesNotMatch(prompt, /SENTINEL_SOURCE_PROP/u);
  assert.doesNotMatch(prompt, /SENTINEL_CONCRETE_PLOT_DRIVER/u);
  assert.doesNotMatch(prompt, /SENTINEL_CONCRETE_BEAT_VALUE/u);
  assert.doesNotMatch(prompt, /SENTINEL_CONCRETE_DISTANCE_POLICY/u);
  assert.match(prompt, /先在内部完成 storyOutline，并把它作为本候选唯一剧情事实源/u);
  // 三个字段改由服务端按拍号派生：要求模型逐字重复长句实测不可靠
  // （多次 0/12，加强措辞后仍有 2/12 与 9/12），失败模式是模型改写而非复制。
  assert.match(prompt, /\*\*不要输出 keyChoice、climax、emotionalPayoff 这三个字段。\*\*/u);
  assert.match(prompt, /keyChoiceBeat 填关键选择发生在第几拍，climaxBeat 填高潮发生在第几拍/u);
  assert.match(prompt, /emotionalPayoff 固定取最后一拍，不需要拍号/u);
  assert.match(prompt, /这三处剧情只需要写一遍，就写在 storyOutline 的 action 里/u);
  // 规则冲突已消除：前置准备可以自然留在拍里，不再与「顶层不得含准备」打架。
  assert.match(prompt, /前置准备、时间标记、地点交代都可以自然留在对应拍的 action 中/u);
  assert.match(prompt, /keyChoiceBeat < climaxBeat（这条会被服务端硬校验）/u);
  // 「高潮早于最后一拍」降级为建议：实测模型反复产出「五拍、高潮收尾」的合法结构。
  assert.match(prompt, /也可以把 climaxBeat 指向最后一拍/u);
  assert.doesNotMatch(prompt, /逐字等于/u);
  assert.doesNotMatch(prompt, /服务端会逐字校验/u);
  // 输出结构样例里不得再出现这三个字符串字段
  assert.doesNotMatch(prompt, /"keyChoice":""/u);
  assert.doesNotMatch(prompt, /"climax":""/u);
  assert.doesNotMatch(prompt, /"emotionalPayoff":""/u);
  assert.match(prompt, /"keyChoiceBeat":2, "climaxBeat":5/u);
  assert.match(prompt, /A=主角完成帮助、送达或类似服务任务/u);
  assert.match(prompt, /A、B、C 同时为真的候选总数必须 ≤1/u);
  assert.match(prompt, /该布尔矩阵只用于内部自检，不得出现在 JSON 中/u);
  assert.match(prompt, /顶层只能有 variants/u);
  assert.match(prompt, /数组必须恰好包含 4 个完整对象/u);
  assert.match(prompt, /每个 storyOutline 使用 5 到 7 个连续编号 Beat/u);
  assert.match(prompt, /拍数本身就是一种合法的结构分化/u);
  // 相位词表从“必须照用”反转成“禁止照用”：固定六拍是候选彼此雷同的结构性原因。
  assert.match(prompt, /禁止套用“钩子、障碍、关键选择、后果、高潮、兑现”这套固定词表/u);
  assert.doesNotMatch(prompt, /phase 依次固定为/u);
  assert.match(prompt, /不得让 4 个候选共用同一串 phase/u);
  assert.doesNotMatch(prompt, /不再固定拍号/u);
  assert.match(prompt, /关键选择拍 < 高潮拍 < 最后一拍/u);
  assert.match(prompt, /关键选择拍与高潮拍之间至少隔一拍/u);
  assert.match(prompt, /高潮拍必须同时包含固定主角亲自完成的决定性动作和它造成的可见结果/u);
  assert.match(prompt, /不能把配角自己的选择或行动冒充成主角高潮/u);
  assert.match(prompt, /猫耳、猫娘称谓或猫系拟声词不自动授权猫爪、猫尾、超常嗅觉、超常听觉/u);
  assert.match(prompt, /highValueBeatMapping 恰好使用 2 个完整对象/u);
  assert.match(prompt, /newExpression 必须逐字复制本候选 storyOutline 某个 action 中的一段连续原文/u);
  assert.match(prompt, /高潮拍不得首次引入决定性人物、物品、地点、线索或能力/u);
  assert.match(prompt, /关键选择拍与高潮拍之间那一拍必须产生高潮实际使用的具体信息、物理状态、机会或代价/u);
  assert.match(prompt, /keyDialogueDirections 使用 2–3 个非空纯字符串/u);
  assert.match(prompt, /绝不能输出 \{character,direction\} 对象/u);
  assert.match(prompt, /所有必填字段都必须出现并保持输出结构展示的精确类型/u);
  // 可选叙事构件：这四个字段曾是 Schema 必填位，强制每个候选都长成
  // “主角＋被关爱对象＋帮助者＋情感信物＋仪式结尾”，是候选彼此雷同的根因之一。
  assert.match(prompt, /careRecipient 与 helper 在 characterSetup 对象\*\*内\*\*/u);
  assert.match(prompt, /emotionalMedium 与 endingRitual 在候选\*\*顶层\*\*，与 newTask、environmentPressure 平级/u);
  assert.match(prompt, /characterSetup 对象内除 protagonist、careRecipient、helper 外不得出现任何其他键/u);
  assert.match(prompt, /不需要就整个键省略，不要输出空字符串/u);
  assert.match(prompt, /省略它们不降低候选质量，也不算结构缺陷/u);
  assert.match(prompt, /最多 2 个可以同时写出 careRecipient 与 helper/u);
  assert.match(prompt, /protagonist 仍然必填/u);
  // 输出结构样例不得再把可选键当成必填空位展示，否则模型会照着填。
  assert.doesNotMatch(prompt, /"characterSetup":\{"protagonist":"", "careRecipient"/u);
  assert.doesNotMatch(prompt, /"keyDialogueDirections":\[\], "endingRitual":""/u);
  assert.doesNotMatch(prompt, /"characterBible"\s*:/u);
  assert.doesNotMatch(prompt, /"sceneScript"\s*:/u);
  assert.doesNotMatch(prompt, /"shotPlan"\s*:/u);
});

test("Demo Mock emits strict Story Candidates with distinct structural signatures", () => {
  const value = mockVariants({ creatorProfile, count: 4 });
  assert.doesNotThrow(() => ensureOutputContract(value, "themeVariants"));
  assert.doesNotThrow(() => ensureThemeVariantsMatchProfile(value, creatorProfile));

  const signatures = value.variants.map((candidate) => JSON.stringify({
    dramaticFunctions: candidate.storyOutline.map((beat) => beat.dramaticFunction.trim()),
    keyChoice: candidate.keyChoice.trim(),
    climax: candidate.climax.trim(),
    emotionalPayoff: candidate.emotionalPayoff.trim()
  }));
  assert.ok(new Set(signatures).size >= 2);
});
