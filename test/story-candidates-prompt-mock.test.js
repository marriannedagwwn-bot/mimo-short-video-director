import test from "node:test";
import assert from "node:assert/strict";
import { mockVariants } from "../src/mock.js";
import { briefPrompt, fullStoryPrompt, variantsPrompt } from "../src/prompts.js";
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
      storyEngine: { desire: "SENTINEL_SOURCE_STORY_ENGINE", turningMechanism: "SENTINEL_TURNING_MECHANISM" },
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
  // 原措辞把「环境变化或道具状态变化」与「可见动作」并列，模型可以三条全写静物。
  // 实测《画不圆的太阳》的 visualPotential 是「铅笔擦纸变薄的质感、爪印痕迹、
  // 画作并置」——没有一个人的动作，展开后六场全是桌前微表情，下游加什么约束都救不回来。
  assert.match(prompt, /\*\*至少一条必须是固定主角本人的身体动作\*\*/u);
  assert.match(prompt, /不看脸只看轮廓就能认出她在做什么/u);
  assert.match(prompt, /\*\*三条全写成质感、痕迹、光影、并置这类画面状态是不合格的\*\*/u);
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
  // 那条规则原文在教模型怎么处理 mustRetain / samePlotDriver / sameBeatValue /
  // creativeDistancePolicy，而这四个字段**根本不下发**——指令悬空。现在只提实际会收到的东西，
  // 并明确告诉模型那四个字段不在本阶段，免得它去找。
  assert.match(prompt, /只提取其中的角色关系价值与情绪兑现强度/u);
  assert.match(prompt, /不会下发到本阶段/u);
  assert.match(prompt, /不要去找它们/u);
  assert.match(prompt, /creativeBrief 抽象保真投影/u);
  assert.match(prompt, /SENTINEL_ABSTRACT_DRAMATIC_VALUE/u);
  // storyEngine 与 reusableHighValueBeats[].beat 都**不下发**。
  //
  // 2026-09-09 试过下发（只取 turningMechanism 一个键，外加七项 taxonomy 的存在性布尔值），
  // 三个包 12 个候选真实回放后回退，因为它没达到目标且新增两个失败模式：
  //   - 任务型措辞 3/12 → 6/12（翻倍，而这正是当初要打掉的「单向帮助」框架）
  //   - 与原片动作稿的逐字照抄 0/12 → 1/12（最长连续命中 4 字 → 15 字）
  //     其中一个包的简报明写「送达任务【原片没有】」，新候选仍写出「帮村长运送南瓜」
  //
  // 三条纠缠的成因当时分不开：①有的包 turningMechanism 本身就是任务框架
  //（「主角主动采取防护措施继续参与活动」），注入它等于推模型往任务写；
  // ②同一份提示词下方已有一条「storyEngine/beat 不进入正向投影、不能复现或补写」，
  // 上下自相矛盾；③唯一那条照抄落在 turningMechanism 写得最具体的包上。
  //
  // 更上游的事实：storyEngine 五个子字段在 briefPrompt 里**一条说明都没有**、零校验器、
  // 改动前零消费者。要再试之前先解决那个，别直接把这两条断言翻过来。
  assert.doesNotMatch(prompt, /SENTINEL_TURNING_MECHANISM/u);
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
  // 这两条曾锁住一句与拍号方案矛盾的旧文本（「先后必须是 关键选择拍 < 高潮拍 < 最后一拍，
  // 且之间至少隔一拍」），改拍号时漏改而断言恰好让它活了下来。现在两者都是建议，
  // 硬校验只剩 keyChoiceBeat < climaxBeat，断言反过来锁住「不得再出现硬性措辞」。
  assert.doesNotMatch(prompt, /先后必须是「关键选择拍 < 高潮拍 < 最后一拍」/u);
  assert.doesNotMatch(prompt, /且关键选择拍与高潮拍之间至少隔一拍/u);
  assert.match(prompt, /建议在关键选择拍与高潮拍之间留一拍/u);
  assert.match(prompt, /选择直接引发高潮也成立，不强制/u);
  assert.match(prompt, /高潮拍必须同时包含固定主角亲自完成的决定性动作和它造成的可见结果/u);
  assert.match(prompt, /不能把配角自己的选择或行动冒充成主角高潮/u);
  assert.match(prompt, /猫耳、猫娘称谓或猫系拟声词不自动授权猫爪、猫尾、超常嗅觉、超常听觉/u);
  assert.match(prompt, /highValueBeatMapping 恰好使用 2 个完整对象/u);
  // 四轮真实回放里三次栽在这里：模型把 newExpression 的键名写成 action。
  // 该字段的说明本身就要求「复制某个 action 里的原文」，输出结构样例又只给空字符串占位，
  // 两处都在给 action 这个键名加权，因此需要一句显式否定把键名和取值来源分开。
  assert.match(prompt, /每个对象的键固定且只有四个：briefBeat、newExpression、retainedValue、failureSignal/u);
  assert.match(prompt, /\*\*绝不能把 newExpression 写成 action\*\*/u);
  assert.match(prompt, /action 是 storyOutline 里的键名，不是这里的键名/u);
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

// 实测连续两批 4/4 的 logline 都提前泄露了兑现结果，keyDialogueDirections
// 则 3/4 出现「配角替观众总结主角弧线」——后者的对白质量约束此前只写进了
// Full Story，候选阶段完全没有覆盖。
test("候选提示词覆盖 logline 泄露与台词解说两个实测缺口", () => {
  const prompt = variantsPrompt({
    count: 4,
    creatorProfile,
    creativeBrief: { contentType: "治愈短片", targetAudience: "家庭观众", coreEmotion: "温暖" },
    referenceAnalysis: {},
    visualGuardrails: {}
  });
  assert.match(prompt, /logline 最容易违反这条/u);
  assert.match(prompt, /logline 只写到「主角面临什么选择」为止就停下/u);
  assert.match(prompt, /如果他能说出结尾发生了什么，就是泄露了/u);
  assert.match(prompt, /这些台词方向同样受对白质量约束/u);
  assert.match(prompt, /不得让配角替观众总结主角的性格或成长/u);
  assert.match(prompt, /那是把人物弧线用台词讲出来/u);
});

// 剧情时长目标传进候选阶段（2026-09-05）。起因：用户选「与原片对齐 · 65 秒」却
// 拿到 95 秒成片——候选 storyOutline 的 estimatedSeconds 合计就是 95，Full Story
// 逐位照抄。此前候选阶段完全收不到时长目标，模型只能凭空估。
test("传入目标时长时，候选提示词写明合计窗口与它对成片长度的决定作用", () => {
  const prompt = variantsPrompt({
    count: 4,
    creatorProfile,
    creativeBrief: {},
    referenceAnalysis: {},
    visualGuardrails: {},
    targetDurationSeconds: 65
  });

  assert.match(prompt, /本片目标时长约 65 秒/u);
  assert.match(prompt, /estimatedSeconds 合计必须落在 55-75 秒内/u);
  assert.match(prompt, /这个合计会直接决定成片长度/u);
  // 拍数自由度不能被时长目标顺手收紧——5–7 拍是既有的结构分化手段
  assert.match(prompt, /拍数仍然自由（5–7 拍）/u);
});

test("不传目标时长时，候选提示词与历史逐字一致", () => {
  // 这条是防回归的关键：新增段落必须整段省略，而不是写成「未指定」之类的占位。
  // 同 §2.10 对 Full Story 立的规矩，否则会静默改变所有旧调用方的提示词。
  const base = {
    count: 4,
    creatorProfile,
    creativeBrief: {},
    referenceAnalysis: {},
    visualGuardrails: {}
  };
  const without = variantsPrompt(base);
  const with65 = variantsPrompt({ ...base, targetDurationSeconds: 65 });

  assert.doesNotMatch(without, /目标时长/u);
  assert.doesNotMatch(without, /estimatedSeconds 合计/u);
  // 删掉新增的那一行之后，两份提示词必须逐字相等
  assert.equal(with65.replace(/\n- 本片目标时长约 65 秒：[^\n]*/u, ""), without);
});

test("非法或缺失的目标时长不产生时长文案，也不抛错", () => {
  for (const bad of [0, -1, null, NaN, "abc"]) {
    const prompt = variantsPrompt({
      count: 4,
      creatorProfile,
      creativeBrief: {},
      referenceAnalysis: {},
      visualGuardrails: {},
      targetDurationSeconds: bad
    });
    assert.doesNotMatch(prompt, /本片目标时长/u, String(bad));
  }
});

test("mock 候选的 estimatedSeconds 跟随目标，不传时保持历史值", () => {
  const base = { count: 2, creatorProfile };
  const total = (input) => mockVariants(input).variants[0]
    .storyOutline.reduce((sum, beat) => sum + beat.estimatedSeconds, 0);

  assert.equal(total(base), 44, "不传目标时逐字保持历史值，不引入新行为");
  assert.equal(total({ ...base, targetDurationSeconds: 65 }), 65);
  assert.equal(total({ ...base, targetDurationSeconds: 45 }), 45);
  assert.equal(total({ ...base, targetDurationSeconds: 90 }), 90);
  // 每拍至少 1 秒，余数逐秒给靠前的拍（做法同 direct_shot 长场次均分）
  const short = mockVariants({ ...base, targetDurationSeconds: 20 }).variants[0].storyOutline;
  assert.ok(short.every((beat) => beat.estimatedSeconds >= 1));
  assert.equal(short.reduce((sum, beat) => sum + beat.estimatedSeconds, 0), 20);
});

test("候选取得原片动作与对白证据，来源机制不再混入正向保真投影", () => {
  const input = {
    count: 4, creatorProfile,
    creativeBrief: {
      emotionStructure: [{ stage: "收尾", function: "SOURCE_REWARD_TRANSFER", targetEmotion: "温暖", intensity: 80 }],
      reusableHighValueBeats: [{ dramaticValue: "SOURCE_VALUE_REFERENCE", mustRetain: "DO_NOT_PROJECT_MUST_RETAIN" }]
    },
    referenceAnalysis: {
      characters: [{ nameOrLabel: "原片人物", traits: ["SOURCE_COSTUME"] }],
      observedFacts: [{ factType: "visible_action", observation: "SOURCE_OBSERVED_ACTION" }],
      groundingSeal: { signature: "DO_NOT_PROJECT_ANALYSIS_SEAL" }
    },
    sourceScriptReconstruction: {
      scenes: [{
        sceneId: "S1", timeRange: "00:00-00:10", characters: ["原片人物"],
        visibleActions: ["SOURCE_BODY_ACTION"], dialogueGist: "SOURCE_SPOKEN_RESPONSE", keyProps: ["SOURCE_PROP"],
        dramaticFunction: "DO_NOT_PROJECT_SCENE_INTERPRETATION", shotDesign: [{ camera: "DO_NOT_PROJECT_CAMERA" }]
      }],
      groundingSeal: { signature: "DO_NOT_PROJECT_RECONSTRUCTION_SEAL" }
    },
    visualGuardrails: {}
  };
  const before = structuredClone(input);
  const prompt = variantsPrompt(input);
  const projectionLine = prompt.split("\n").find((line) => line.startsWith("creativeBrief 抽象保真投影"));
  const projection = JSON.parse(projectionLine.slice(projectionLine.indexOf("：") + 1));
  assert.deepEqual(projection.emotionStructure, [{ stage: "收尾", targetEmotion: "温暖", intensity: 80 }]);
  assert.equal(projection.reusableDramaticValues, undefined);
  for (const fact of ["SOURCE_COSTUME", "SOURCE_OBSERVED_ACTION", "SOURCE_BODY_ACTION", "SOURCE_SPOKEN_RESPONSE", "SOURCE_PROP"]) {
    assert.ok(prompt.includes(fact), `${fact} 必须实际进入模型提示词`);
  }
  assert.match(prompt, /原片价值解释（只供提炼，不是本片事件要求）：.*SOURCE_VALUE_REFERENCE/u);
  assert.doesNotMatch(prompt, /SOURCE_REWARD_TRANSFER|DO_NOT_PROJECT_/u);
  assert.deepEqual(input, before, "只改变提示词投影，不改原片或 Brief Artifact");
});

test("角色边界投影不夹带上游阶段的剧情指令，角色事实和对白规则仍逐字保留", () => {
  const userProfile = { ...creatorProfile, constraints: "KEEP_USER_SPEECH_RULE" };
  const visualGuardrails = {
    fixedCharacterBoundary: { characterName: "小白子", requiredTraits: [{ canonicalName: "KEEP_SIGNED_IDENTITY" }] },
    allowedPositiveTraits: ["KEEP_POSITIVE_TRAIT"], positivePromptBoundary: ["KEEP_CHARACTER_BOUNDARY"],
    dialogueRules: [{ text: "KEEP_USER_SPEECH_RULE", triggerEvidence: [{ sourcePath: "creatorProfile.constraints", evidence: "KEEP_USER_SPEECH_RULE" }] }],
    stageInstructions: {
      themeVariants: "DO_NOT_FORWARD_TASK_REWARD_TRANSFER",
      fullStory: "DO_NOT_FORWARD_DOWNSTREAM_STORY_TEMPLATE",
      animationPlan: "DO_NOT_FORWARD_CAMERA_INSTRUCTIONS"
    }
  };
  const before = structuredClone(visualGuardrails);
  const prompt = variantsPrompt({ count:4, creatorProfile: userProfile, creativeBrief:{}, visualGuardrails });
  for (const value of ["KEEP_SIGNED_IDENTITY", "KEEP_POSITIVE_TRAIT", "KEEP_CHARACTER_BOUNDARY", "KEEP_USER_SPEECH_RULE"]) {
    assert.ok(prompt.includes(value), value);
  }
  assert.doesNotMatch(prompt, /DO_NOT_FORWARD_/u);
  const boundaryLine = prompt.split("\n").find((line) => line.startsWith("固定角色正向边界与用户台词规则："));
  const projection = JSON.parse(boundaryLine.slice("固定角色正向边界与用户台词规则：".length));
  assert.deepEqual(projection.stageInstructions, {});
  assert.deepEqual(visualGuardrails, before, "不能改写已签发的角色边界 Artifact");
  const downstream = fullStoryPrompt({ creatorProfile: userProfile, creativeBrief:{}, visualGuardrails });
  assert.doesNotMatch(downstream, /DO_NOT_FORWARD_/u);
  assert.match(downstream, /KEEP_SIGNED_IDENTITY/u);
  assert.match(downstream, /KEEP_USER_SPEECH_RULE/u);
});

test("newTask 与 environmentPressure 是必填字段，提示词不得再说任务与天气空间「可以整个不设」", async () => {
  // 2026-09-23：MiMo 开思考时 4 个候选里 3 个把 newTask 写成空字符串被 schema 拦下。
  // 提示词一边说「任务、天气/空间……也可以整个不设」「生活型没有非做不可的任务」，
  // 一边 schema 要求这两个字段非空、全文没有一句定义，模型照字面执行就留空了。
  const prompt = variantsPrompt({ count: 4, creatorProfile, creativeBrief: {}, referenceAnalysis: {}, visualGuardrails: {} });
  const optionalRule = prompt.split("\n").find((line) => line.includes("也可以整个不设"));
  assert.ok(optionalRule, "可选构件那句总则仍在");
  const optionalList = optionalRule.split("也可以整个不设")[0];
  assert.doesNotMatch(optionalList, /任务|天气|空间/u);
  assert.match(optionalRule, /newTask、environmentPressure 两个字段必填/u);
  assert.match(prompt, /没有非做不可的任务（这时 newTask 写她参与的那件事/u);
  assert.match(prompt, /- newTask：必填，一句话写主角在本片里做的、或参与的那件具体的事。dramatic 写她要完成的目标；slice_of_life 写她参与的那件正在发生的事，不需要是非完成不可的任务。不得输出空字符串。/u);
  assert.match(prompt, /- environmentPressure：必填，[^\n]*没有外部压力时，写这件事发生时的时间、天气或空间状态。不得输出空字符串。/u);

  // 命题定向修订按同一口径改写这两个字段，不能再把 newTask 读成「非完成不可的任务」。
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/prompts.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /newTask（这个故事的任务是什么）/u);
  assert.match(source, /- newTask（主角在这个故事里做或参与的那件事；生活型写她参与了什么/u);
});
