const allowedComponents = [
  ["送达任务", "保留“必须把某物送到某人手中”的目标压力，改写物品、接收者和阻碍。"],
  ["旅途结构", "保留空间推进带来的关系升温，改写路线、交通方式与停靠事件。"],
  ["情感媒介", "使用新的日常物件承载情绪，不沿用原片独特道具组合。"],
  ["获得帮助", "保留陌生人或同伴援助的情绪回报，改写帮助者身份与帮助方式。"],
  ["被关爱对象", "保留显性需求与隐性需求的双层设计，重建人物关系与具体处境。"],
  ["天气或空间推动情绪", "继续让环境形成外部阻力和氛围，但采用新的场景调度。"],
  ["生活化或仪式化结尾", "保留小动作收束情绪的方式，重新设计结尾动作和道具。"]
];

export function mockAnalysis(input) {
  const duration = Math.max(1, Math.round(input.metadata?.duration || 45));
  return {
    contentPositioning: {
      format: "人物关系驱动的情绪短故事",
      genre: "生活流暖心剧情",
      contentPromise: "通过一项具体任务，看见普通关系里的善意与牵挂",
      platformFit: "适合竖屏信息流，以明确任务钩子和情绪回报促成完播"
    },
    targetAudience: {
      primary: "关注日常关系、家庭情感与普通人互助的泛生活受众",
      psychologicalNeeds: ["情绪代偿", "善意确认", "关系共鸣"],
      watchingContext: "碎片时间观看，需要前 3 秒建立任务悬念"
    },
    storySynopsis: "主角带着一项与关爱对象有关的任务出发，在环境阻力和他人帮助中推进，最终用一个克制的生活动作完成情绪兑现。",
    characters: [
      { nameOrLabel: "主角", role: "行动承担者", traits: ["克制", "有责任感"], relationshipToProtagonist: "本人", evidence: ["F1", "F2"] },
      { nameOrLabel: "被关爱对象", role: "任务的情绪指向", traits: ["需求未完全说出口"], relationshipToProtagonist: "重要关系人", evidence: ["F7", "F8"] }
    ],
    protagonistIdentity: { occupation: "画面证据不足，待确认", socialRole: "照料者/承诺履行者", currentSituation: "正在完成一项有时间或空间压力的任务", evidence: ["F1", "F3"] },
    careRecipient: { identity: "重要关系人", explicitNeed: "收到任务所指向的物品或服务", implicitNeed: "被记得、被认真对待", relationship: "亲密或长期关系", evidence: ["F7", "F8"] },
    dialogueStyle: { tone: "生活化、克制", sentencePattern: "短句为主", informationDensity: "低解释、高潜台词", subtext: "关心主要通过行动表达" },
    shotRhythm: { openingHookSeconds: 3, averagePerceivedPace: "中快转中慢", rhythmDescription: "开场快速交代目标，中段用阻力加速，结尾停顿留出情绪回味", shotPatterns: ["任务物特写", "移动中景", "反应近景", "结尾静态停留"] },
    emotionCurve: [
      { phase: "钩子", timeRange: "00:00-00:03", emotion: "好奇", intensity: 48, trigger: "任务与时间压力被建立", evidence: ["F1"] },
      { phase: "推进", timeRange: `00:03-${time(duration * 0.58)}`, emotion: "担心", intensity: 70, trigger: "环境阻力与关系信息逐步出现", evidence: ["F2", "F3", "F4"] },
      { phase: "转折", timeRange: `${time(duration * 0.58)}-${time(duration * 0.82)}`, emotion: "温暖", intensity: 82, trigger: "获得帮助或理解", evidence: ["F5", "F6"] },
      { phase: "兑现", timeRange: `${time(duration * 0.82)}-${time(duration)}`, emotion: "释然", intensity: 90, trigger: "生活化动作回应隐性需求", evidence: ["F7", "F8"] }
    ],
    retentionDrivers: [
      { driver: "任务悬念", viewerQuestion: "他能否及时完成？", payoff: "任务完成同时揭示真正情感目的", evidence: ["F1", "F8"] },
      { driver: "关系延迟揭示", viewerQuestion: "他为何如此坚持？", payoff: "被关爱对象的隐性需求被看见", evidence: ["F3", "F7"] }
    ],
    whyWatchToEnd: "观众同时等待任务结果与关系真相，结尾小动作提供可感知但不过度煽情的回报。",
    analysisConfidence: 62,
    uncertainties: [{ field: "原声对白与准确职业", reason: "演示模式仅依据采样画面结构生成，未进行音频转写", neededEvidence: "接入 MiMo-VL 并补充字幕或转写文本" }]
  };
}

export function mockReconstruction(input) {
  const duration = Math.max(20, Math.round(input.metadata?.duration || 45));
  const a = time(duration * 0.2), b = time(duration * 0.58), c = time(duration * 0.82), end = time(duration);
  return {
    scenes: [
      { sceneId: "S1", timeRange: `00:00-${a}`, location: "出发点", characters: ["主角"], visibleActions: ["确认任务物", "迅速出发"], dialogueGist: "以一句简短信息交代必须完成的事", shotDesign: [{ shotSize: "特写转中景", camera: "快速切换", visibleContent: "任务物与主角行动" }], emotionNode: "目标建立", dramaticFunction: "钩子：给出任务和期限", turningPoint: "主角选择立即行动", keyProps: ["任务物"], sourceEvidence: ["F1", "F2"], confidence: 64 },
      { sceneId: "S2", timeRange: `${a}-${b}`, location: "途中空间", characters: ["主角"], visibleActions: ["赶路", "遇到外部阻力", "保护任务物"], dialogueGist: "对白稀少，以动作体现坚持", shotDesign: [{ shotSize: "全景与移动中景", camera: "跟拍", visibleContent: "人物与环境的对抗" }], emotionNode: "压力上升", dramaticFunction: "增加完成任务的成本", turningPoint: "原方案失效", keyProps: ["任务物", "交通或防护物"], sourceEvidence: ["F3", "F4"], confidence: 58 },
      { sceneId: "S3", timeRange: `${b}-${c}`, location: "临时停靠点", characters: ["主角", "帮助者"], visibleActions: ["陌生人察觉困难", "提供具体帮助", "主角继续前进"], dialogueGist: "帮助者少问原因，直接提供可执行帮助", shotDesign: [{ shotSize: "双人中景转反应近景", camera: "节奏放缓", visibleContent: "帮助发生与情绪变化" }], emotionNode: "善意转折", dramaticFunction: "将外部阻力转化为情绪回报", turningPoint: "主角获得继续完成任务的条件", keyProps: ["新的帮助工具"], sourceEvidence: ["F5", "F6"], confidence: 55 },
      { sceneId: "S4", timeRange: `${c}-${end}`, location: "到达点", characters: ["主角", "被关爱对象"], visibleActions: ["完成送达或照料", "用日常小动作收尾"], dialogueGist: "不直接解释付出，以一句普通回应压住情绪", shotDesign: [{ shotSize: "近景与物件特写", camera: "固定停留", visibleContent: "接收动作和关系反应" }], emotionNode: "情绪兑现", dramaticFunction: "让显性任务回应隐性需求", turningPoint: "观众理解任务真正意义", keyProps: ["重新设计的情感媒介"], sourceEvidence: ["F7", "F8"], confidence: 61 }
    ],
    coreEventSequence: [
      { order: 1, event: "接到或确认任务", causalRole: "建立观看问题", sceneRefs: ["S1"] },
      { order: 2, event: "途中受阻", causalRole: "提高付出成本", sceneRefs: ["S2"] },
      { order: 3, event: "获得帮助", causalRole: "提供善意转折", sceneRefs: ["S3"] },
      { order: 4, event: "抵达并完成生活化仪式", causalRole: "兑现关系情绪", sceneRefs: ["S4"] }
    ],
    relationshipPattern: "一方不善表达但用行动承担，另一方的真实需求在结尾才被观众理解。",
    endingAction: { action: "以重新设计的日常照料动作结束", emotionalMeaning: "完成的不是物品交付，而是对关系的确认", evidence: ["F8"] },
    turningPoints: [
      { sceneRef: "S2", from: "任务看似顺利", to: "原方案失效", trigger: "环境阻力" },
      { sceneRef: "S3", from: "独自承担", to: "获得善意支持", trigger: "帮助者主动介入" }
    ],
    uncertainties: [{ timeRange: `00:00-${end}`, unknown: "精确对白、未采样动作与场景边界", safeAssumption: "只复原画面可支持的剧作功能，不将细节视为事实" }]
  };
}

export function mockBrief(input) {
  const fixed = input.creatorProfile?.fixedCharacter || "固定主角";
  const vertical = input.creatorProfile?.vertical || "泛生活赛道";
  return {
    contentType: "任务驱动的关系情绪短故事",
    targetAudience: input.referenceAnalysis?.targetAudience?.primary || "泛生活情感受众",
    coreEmotion: "从担心到被普通人的善意与克制关心打动",
    storyEngine: { desire: "主角必须完成一项指向重要关系人的具体任务", obstacle: "时间、天气或空间让简单任务变得困难", escalation: "任务成本持续增加并暴露主角的在意", turningMechanism: "帮助者通过观察行动而非听取解释介入", payoff: "显性任务完成，同时回应被关爱对象未说出口的需要" },
    emotionStructure: [
      { stage: "任务钩子", function: "建立结果问题", targetEmotion: "好奇", intensity: 45 },
      { stage: "成本升级", function: "证明关系重量", targetEmotion: "担心", intensity: 72 },
      { stage: "善意介入", function: "提供社会情绪回报", targetEmotion: "温暖", intensity: 84 },
      { stage: "日常兑现", function: "把任务变成关系确认", targetEmotion: "释然", intensity: 92 }
    ],
    roleAndOccupationMapping: [
      { sourceFunction: "承担任务并推动行动", newRole: fixed, newOccupationOrIdentity: `${vertical}中的可信日常身份`, mappingLogic: "职业必须自然地产生任务、工具与行动能力" },
      { sourceFunction: "承载隐性情感需求", newRole: "与固定角色有稳定关系的人", newOccupationOrIdentity: "由选题决定", mappingLogic: "关系应能让克制照料成立" },
      { sourceFunction: "在低谷提供转折", newRole: "赛道内可自然出现的帮助者", newOccupationOrIdentity: "场景原生角色", mappingLogic: "帮助方式应具体且不喧宾夺主" }
    ],
    reusableHighValueBeats: [
      { beat: "任务物首次出现并绑定期限", dramaticValue: "3 秒内建立观看问题", mustRetain: "明确目标与未完成代价", adaptableSurface: ["物品", "期限来源", "出发地点"], sourceSceneRefs: ["S1"] },
      { beat: "主角优先保护任务而不是自己", dramaticValue: "用选择证明关系重量", mustRetain: "产生可见成本", adaptableSurface: ["阻力", "保护动作", "损失"], sourceSceneRefs: ["S2"] },
      { beat: "帮助者看懂但不追问", dramaticValue: "提供善意和尊严双重回报", mustRetain: "帮助必须解决具体障碍", adaptableSurface: ["帮助者", "工具", "发生地点"], sourceSceneRefs: ["S3"] },
      { beat: "小动作揭示真正需求", dramaticValue: "将显性任务翻译为隐性关爱", mustRetain: "克制收束而非解释主题", adaptableSurface: ["结尾动作", "道具", "最后一句话"], sourceSceneRefs: ["S4"] }
    ],
    controlledRewriteVariables: [
      { variable: "人物与职业", sourceValue: "原片人物关系", allowedDirections: [fixed, `${vertical}原生职业`], mustChange: true, reason: "适配固定角色并避免人物复制" },
      { variable: "具体任务", sourceValue: "原片送达/照料事项", allowedDirections: ["修复", "交接", "陪伴", "补救"], mustChange: true, reason: "保留任务引擎但重建事件" },
      { variable: "道具与阻力", sourceValue: "原片具体物件和环境", allowedDirections: ["赛道工具", "新的天气压力", "新的空间规则"], mustChange: true, reason: "形成新的可识别表达" },
      { variable: "对白与镜头", sourceValue: "原片台词和镜头排列", allowedDirections: ["角色口癖", "新的信息揭示顺序", "新的调度"], mustChange: true, reason: "避免逐句逐镜对应" }
    ],
    protectedExpressions: [
      { expressionType: "具体对白", sourceExpression: "原片可识别台词原句", prohibition: "不得逐句或近义逐句复写", safeAlternativePrinciple: "从角色身份与当下动作重新生成潜台词" },
      { expressionType: "独特视听组合", sourceExpression: "罕见道具、动作、机位连续对应", prohibition: "不得复刻连续镜头组合", safeAlternativePrinciple: "保留剧作功能，重做场景调度与视觉焦点" }
    ],
    minimumTransformationRules: [
      { dimension: "人物", minimumChange: "主配角身份、关系呈现和行为习惯均重新设计", acceptanceCheck: "无法仅替换姓名还原原片人物" },
      { dimension: "任务", minimumChange: "任务对象、完成方式与失败代价至少改变两项", acceptanceCheck: "新任务由垂直赛道自然产生" },
      { dimension: "细节表达", minimumChange: "关键道具、具体阻力、对白和结尾动作全部重做", acceptanceCheck: "不存在逐句或逐镜对应" },
      { dimension: "价值保真", minimumChange: "不改变高价值桥段的剧作功能", acceptanceCheck: "每个新桥段能映射回其情绪与叙事价值" }
    ],
    allowedNarrativeComponents: allowedComponents.map(([component, howToReuseSafely]) => ({ component, howToReuseSafely })),
    nonNegotiableExperience: { samePositioning: "仍是生活关系中的任务型情绪故事", sameAudience: "仍服务需要关系共鸣和善意确认的受众", sameEmotion: "仍经历好奇—担心—温暖—释然", samePlotDriver: "仍由必须完成的具体任务驱动", sameBeatValue: "仍包含成本证明、获得帮助与日常兑现" },
    creativeDistancePolicy: "结构与体验保持高保真；人物、事件、台词、道具和视听表达保持明确原创。"
  };
}

export function mockVariants(input) {
  const count = Math.max(1, Math.min(6, Number(input.count) || 3));
  const fixed = input.creatorProfile?.fixedCharacter || "固定主角";
  const vertical = input.creatorProfile?.vertical || "生活记录";
  const seeds = [
    { title: "最后一格电", task: "在闭店前修复并送回一件承载回忆的旧设备", medium: "一段未导出的旧录音", pressure: "暴雨导致街区停电", helper: "夜班便利店员借出移动电源", ending: "老人把修好的设备放回空着的餐位旁，按下播放键" },
    { title: "错过的那班车", task: "把临时改好的工具交给即将返乡的学徒", medium: "工具柄内侧刻下的一句交代", pressure: "末班车提前且道路封控", helper: "收摊摊主用三轮车带主角穿过旧街", ending: "学徒上车前习惯性地把工具擦净，再递回一块旧抹布" },
    { title: "今天也要开门", task: "赶在清晨营业前恢复一家小店的关键设备", medium: "贴在设备背后的手写营业日期", pressure: "凌晨低温与配件不匹配", helper: "早餐店老板翻出多年前留下的通用零件", ending: "卷帘门升起，被照料对象照常先为主角留下一份早餐" },
    { title: "雨停之前", task: "把重新制作的纪念物送到一场小型告别仪式", medium: "被水浸过又重新描好的图案", pressure: "连续降雨与临时改址", helper: "公交司机在安全范围内提醒一条近路", ending: "所有人没有讲话，只把纪念物摆正并擦去雨滴" },
    { title: "多出来的一份", task: "补做一份临时缺失的物品送给不愿麻烦别人的新人", medium: "与团队其他人相同的名字标记", pressure: "活动即将开始且材料用尽", helper: "隔壁同行分享最后一小份材料", ending: "新人默默把自己的那份与大家摆在同一排" },
    { title: "灯亮以后", task: "修复一盏被当作约定信号的旧灯", medium: "灯罩内的一张褪色便签", pressure: "山路起雾且备用灯芯损坏", helper: "巡夜保安提供一段废旧铜线", ending: "远处窗口亮起另一盏灯，主角关掉手电站了一会儿" }
  ];
  return { variants: seeds.slice(0, count).map((seed, index) => ({
    id: `V${index + 1}`,
    title: seed.title,
    oneLineHook: `只剩最后一次机会，${fixed}必须完成：${seed.task}。`,
    logline: `${fixed}在${seed.pressure}的条件下执行一项看似普通的任务，途中获得克制的帮助，最终发现对方真正需要的是“没有被落下”。`,
    verticalFit: `任务、工具与解决方式均从${vertical}的真实工作细节产生，固定角色的能力直接推动剧情。`,
    characterSetup: { protagonist: fixed, careRecipient: "一位不愿直接表达需求的重要关系人", helper: seed.helper },
    newTask: seed.task,
    emotionalMedium: seed.medium,
    environmentPressure: seed.pressure,
    storyOutline: [
      { beat: 1, phase: "钩子", action: "任务物出问题，明确最后期限", emotion: "紧迫", dramaticFunction: "建立结果问题", estimatedSeconds: 4 },
      { beat: 2, phase: "推进", action: "常规方案失效，主角付出额外成本保护任务", emotion: "担心", dramaticFunction: "证明关系重量", estimatedSeconds: 14 },
      { beat: 3, phase: "转折", action: `${seed.helper}看出困境并提供具体帮助`, emotion: "温暖", dramaticFunction: "获得帮助但保留人物尊严", estimatedSeconds: 12 },
      { beat: 4, phase: "兑现", action: seed.ending, emotion: "释然", dramaticFunction: "用日常仪式回应隐性需求", estimatedSeconds: 10 }
    ],
    highValueBeatMapping: [
      { briefBeat: "任务与期限", newExpression: seed.task, retainedValue: "快速建立观看问题" },
      { briefBeat: "外部帮助", newExpression: seed.helper, retainedValue: "普通人善意成为情绪转折" },
      { briefBeat: "仪式化结尾", newExpression: seed.ending, retainedValue: "通过动作而非说教完成情绪兑现" }
    ],
    keyDialogueDirections: ["主角不解释自己的辛苦", "帮助者只确认需要什么", "结尾不直接说谢谢或我爱你"],
    endingRitual: seed.ending,
    transformationProof: { changedCharacters: `人物映射为${fixed}及${vertical}原生关系`, changedTask: seed.task, changedDetailsAndProps: `${seed.medium}与${seed.pressure}`, changedDialogue: "按新职业口吻重写，禁止复用原句", changedVisualExpression: "围绕新工具、空间和动作重新设计镜头" },
    experienceFidelity: { positioning: "生活关系型情绪故事", audience: "保留对善意与关系共鸣敏感的受众", emotion: "好奇—担心—温暖—释然", plotDriver: "有期限的具体任务", highValueBeats: "成本证明、获得帮助、动作兑现" },
    originalityRiskCheck: { riskLevel: "low", possibleSimilarity: "保留任务旅途和帮助转折等通用结构", mitigation: "人物、任务、媒介、阻力、帮助方式和结尾动作均为新设计" }
  })) };
}

function time(seconds) {
  const value = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}
