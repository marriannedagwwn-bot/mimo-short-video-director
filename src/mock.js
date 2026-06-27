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
    uncertainties: [{ field: "原声对白与准确职业", reason: "演示模式仅依据采样画面结构生成，未进行音频转写", neededEvidence: "接入 MiMo 并补充字幕或转写文本" }]
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

export function mockVisualGuardrails(input) {
  const fixed = input.creatorProfile?.fixedCharacter || "固定主角";
  const fixedName = fixed.split(/[，,；;、。\n\r（(]/u)[0]?.trim() || fixed;
  const hasWolfTail = /狼尾|狼尾巴|有[^，,。；;\n]{0,6}尾巴/u.test(fixed);
  const hasCatTail = /猫尾|猫尾巴/u.test(fixed);
  const allowedBodyFeatures = [
    /狼耳/u.test(fixed) ? "狼耳" : "",
    /猫耳|猫娘/u.test(fixed) ? "猫娘风格参考" : "",
    hasWolfTail ? "狼尾巴" : "",
    hasCatTail ? "猫尾巴" : ""
  ].filter(Boolean);
  const forbiddenPositiveTraits = [
    hasWolfTail ? { term: "猫尾", reason: "固定角色明确为狼尾巴，不能替换成猫尾。", severity: "block" } : null,
    hasWolfTail ? { term: "猫尾巴", reason: "固定角色明确为狼尾巴，不能替换成猫尾巴。", severity: "block" } : null,
    !/爪|肉垫/u.test(fixed) ? { term: "爪子", reason: "固定角色未声明爪子，不能从兽耳或猫娘风格自动推导。", severity: "block" } : null,
    !/兽爪/u.test(fixed) ? { term: "兽爪", reason: "固定角色未声明兽爪。", severity: "block" } : null,
    !/肉垫/u.test(fixed) ? { term: "肉垫", reason: "固定角色未声明肉垫。", severity: "block" } : null
  ].filter(Boolean);
  return {
    fixedCharacterBoundary: {
      characterName: fixedName,
      identityLock: `主角始终为${fixed}`,
      allowedIdentity: fixed,
      allowedAppearance: allowedBodyFeatures.length ? `允许使用：${allowedBodyFeatures.join("、")}` : "只使用固定角色文本明写的人物外观。",
      allowedBodyFeatures,
      styleNotes: fixed.includes("猫娘") ? "猫娘只作为萌系/二次元风格参考，不自动等于猫尾、猫爪或肉垫。" : "不自动扩展未声明动物化身体特征。",
      explicitUserPresets: fixed.split(/[，,；;、。\n\r]/u).map((item) => item.trim()).filter(Boolean),
      doNotInfer: "不要把原片动物服、玩偶外壳或类比词扩展成固定角色没有明写的身体部位。"
    },
    allowedPositiveTraits: [
      { term: fixedName, scope: "identity", reason: "固定角色姓名必须锁定。" },
      ...allowedBodyFeatures.map((term) => ({ term, scope: "bodyFeature", reason: "来自用户固定角色预设或安全风格说明。" }))
    ],
    forbiddenPositiveTraits,
    sourceSurfaceExpressions: [
      { term: "企鹅", source: "creativeBrief", reason: "原片表面身份只能提炼剧作功能，不能映射给固定角色。", mustAvoid: true },
      { term: "企鹅服", source: "creativeBrief", reason: "原片服装拟态属于具体表面表达。", mustAvoid: true },
      { term: "企鹅快递员", source: "modelRisk", reason: "模型容易把原片表面职业外壳套给固定角色。", mustAvoid: true }
    ],
    commonNegativePrompt: [
      "不要企鹅、企鹅服、企鹅快递员、玩偶服、动物外壳",
      ...forbiddenPositiveTraits.map((item) => `不要${item.term}`)
    ],
    stageInstructions: {
      themeVariants: "主题变体只写固定角色允许身份和外观，不把负面词写成新设定。",
      fullStory: "完整剧情不得把负面词写入主角身份、动作、道具或剧情正向内容。",
      animationPlan: "动画生产包阶段不使用 visualGuardrails 做 AI 检测，只保留结构校验。"
    },
    rationale: "先由固定角色文本确定允许项，再把原片表面表达和未声明联想项放入通用负面提示词。",
    uncertainties: []
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

export function mockFullStory(input) {
  const variant = input.variant || {};
  const fixed = input.creatorProfile?.fixedCharacter || variant.characterSetup?.protagonist || "固定主角";
  const fixedName = fixed.split(/[，,；;、。\n\r（(]/u)[0]?.trim() || fixed;
  const title = variant.title || "雨后的那件小事";
  const careRecipient = variant.characterSetup?.careRecipient || "一位不愿麻烦别人的重要关系人";
  const helper = variant.characterSetup?.helper || "路过的热心帮手";
  const task = variant.newTask || "把承载心意的东西及时送到";
  const medium = variant.emotionalMedium || "一件带有生活痕迹的小物件";
  const pressure = variant.environmentPressure || "天气和路程同时制造压力";
  const ending = variant.endingRitual || "两人没有多说话，只把物件摆正，安静地笑了一下";
  const speechRule = input.creatorProfile?.constraints?.includes("嗷") ? "主角只用“嗷”“嗷呜”和动作表达情绪，信息由他人回应与画面动作补足。" : "主角短句、少解释，重点用动作表达关心。";

  return {
    selectedVariantId: variant.id || "V1",
    title,
    oneLinePremise: `${fixedName}必须完成“${task}”，途中被${pressure}逼到失手边缘，最终用${medium}回应${careRecipient}真正没有说出口的需要。`,
    targetDurationSeconds: 60,
    shootingSynopsis: `${fixedName}接下一个看似普通的任务：${task}。路上，${pressure}让任务成本不断增加，${fixedName}先保护任务物，再解决自己。最低谷时，${helper}看懂了情况，给出一个不追问的帮助。抵达后，${fixedName}没有解释辛苦，而是完成一个生活化动作：${ending}。观众最终理解，这个任务真正送达的是“我记得你”。`,
    characterBible: {
      protagonist: {
        name: fixedName,
        identity: fixed,
        traits: ["主动承担", "懂事", "行动先于解释"],
        speechRules: speechRule,
        signatureBehaviors: ["先确认任务物是否完好", "遇到困难先护住别人托付的东西", "开心时用很小的动作回应"]
      },
      careRecipient: {
        nameOrLabel: careRecipient,
        identity: "被主角认真对待的人",
        explicitNeed: task,
        implicitNeed: "确认自己没有被落下，也不必把需要说得很重",
        relationshipToProtagonist: "日常里有稳定牵挂的人"
      },
      helpers: [{ nameOrLabel: helper, functionInStory: "在压力最高处提供具体帮助", relationshipToProtagonist: "临时相遇的善意角色", helpingAction: "不追问原因，只补上完成任务缺失的条件" }]
    },
    beatSheet: [
      { beat: 1, timeRange: "00:00-00:05", storyAction: `${fixedName}发现任务必须马上完成，先把${medium}护在怀里。`, emotion: "紧迫", dramaticFunction: "建立任务钩子", retainedValueFromBrief: "任务物首次出现并绑定期限" },
      { beat: 2, timeRange: "00:05-00:14", storyAction: `${fixedName}按原计划出发，但${pressure}让路线变得不稳定。`, emotion: "担心", dramaticFunction: "外部阻力出现", retainedValueFromBrief: "旅途结构推动情绪" },
      { beat: 3, timeRange: "00:14-00:25", storyAction: `任务物差点受损，${fixedName}先护住它，自己变得更狼狈。`, emotion: "揪心", dramaticFunction: "用成本证明关系重量", retainedValueFromBrief: "主角优先保护任务而不是自己" },
      { beat: 4, timeRange: "00:25-00:38", storyAction: `${helper}看懂困境，给出一个小但关键的帮助。`, emotion: "温暖", dramaticFunction: "善意转折", retainedValueFromBrief: "帮助者看懂但不追问" },
      { beat: 5, timeRange: "00:38-00:51", storyAction: `${fixedName}赶到${careRecipient}面前，却没有急着解释路上的困难。`, emotion: "克制", dramaticFunction: "关系真相延迟揭示", retainedValueFromBrief: "显性任务连接隐性需求" },
      { beat: 6, timeRange: "00:51-01:00", storyAction: ending, emotion: "释然", dramaticFunction: "生活化仪式收束", retainedValueFromBrief: "小动作揭示真正需求" }
    ],
    sceneScript: [
      {
        sceneId: "S1",
        timeRange: "00:00-00:05",
        location: "出发点",
        characters: [fixedName],
        visibleAction: `${fixedName}确认${medium}，听到任务期限后立刻把它收好。`,
        dialogue: [{ speaker: fixedName, line: input.creatorProfile?.constraints?.includes("嗷") ? "嗷呜。" : "我现在去。", deliveryOrSubtext: "不解释，只接住任务。" }],
        shotAndSound: "任务物特写切到主角反应近景，环境声压低。",
        emotionNode: "任务启动",
        dramaticFunction: "3 秒内建立观众问题",
        shootingNotes: "让任务物被观众看清，但不要拍成原片同款道具。"
      },
      {
        sceneId: "S2",
        timeRange: "00:05-00:14",
        location: "途中第一段空间",
        characters: [fixedName],
        visibleAction: `${pressure}出现，${fixedName}调整路线，反复确认任务物没有受损。`,
        dialogue: [],
        shotAndSound: "手持跟拍与脚步声增强紧张感。",
        emotionNode: "压力上升",
        dramaticFunction: "把简单任务变难",
        shootingNotes: "重点拍新空间规则，不复刻原片移动路径。"
      },
      {
        sceneId: "S3",
        timeRange: "00:14-00:25",
        location: "临时受阻点",
        characters: [fixedName],
        visibleAction: `任务物差点被影响，${fixedName}用身体和动作护住它，自己耽误了时间。`,
        dialogue: [{ speaker: fixedName, line: input.creatorProfile?.constraints?.includes("嗷") ? "嗷！" : "没事，东西没坏。", deliveryOrSubtext: "先关心任务而不是自己。" }],
        shotAndSound: "近景捕捉手部动作，声音短促停顿。",
        emotionNode: "成本证明",
        dramaticFunction: "让观众相信这件事对主角重要",
        shootingNotes: "动作要生活化，避免夸张英雄化。"
      },
      {
        sceneId: "S4",
        timeRange: "00:25-00:38",
        location: "临时避让处",
        characters: [fixedName, helper],
        visibleAction: `${helper}没有问太多，只递出解决眼前问题的工具或线索。${fixedName}点头，继续出发。`,
        dialogue: [
          { speaker: helper, line: "你要的是这个吧？拿去，来得及。", deliveryOrSubtext: "帮助具体，不消费主角困境。" },
          { speaker: fixedName, line: input.creatorProfile?.constraints?.includes("嗷") ? "嗷呜！" : "谢谢。", deliveryOrSubtext: "短促但真诚。" }
        ],
        shotAndSound: "双人中景停半秒，节奏从急促转暖。",
        emotionNode: "善意介入",
        dramaticFunction: "把外部阻力转成情绪回报",
        shootingNotes: "帮助方式必须来自当前垂直赛道，不要像便利桥段。"
      },
      {
        sceneId: "S5",
        timeRange: "00:38-00:51",
        location: "到达点门口",
        characters: [fixedName, careRecipient],
        visibleAction: `${fixedName}把${medium}递出，${careRecipient}第一反应不是看物品，而是看主角是否还好。`,
        dialogue: [{ speaker: careRecipient, line: "你怎么还真来了。", deliveryOrSubtext: "表面责备，实际被认真对待。" }],
        shotAndSound: "门口逆光近景，留出沉默。",
        emotionNode: "关系揭示",
        dramaticFunction: "显性任务触发隐性情绪",
        shootingNotes: "不要解释过多，用眼神和接物动作交代关系。"
      },
      {
        sceneId: "S6",
        timeRange: "00:51-01:00",
        location: "到达点内部或门口",
        characters: [fixedName, careRecipient],
        visibleAction: ending,
        dialogue: [{ speaker: fixedName, line: input.creatorProfile?.constraints?.includes("嗷") ? "嗷呜。" : "放这儿就好。", deliveryOrSubtext: "把付出压进普通动作里。" }],
        shotAndSound: "静态近景收尾，保留环境声和一个动作特写。",
        emotionNode: "释然",
        dramaticFunction: "用生活仪式完成情绪兑现",
        shootingNotes: "结尾动作要可复拍、低成本、清楚表达关系。"
      }
    ],
    keyProps: [
      { prop: medium, storyFunction: "承载显性任务和隐性情绪", visualUse: "开场、受阻、结尾三次出现", avoidSimilarityNote: "使用新物件、新材质和新摆放方式" },
      { prop: "帮助工具", storyFunction: "让善意转折具体可见", visualUse: "帮助者递出或指出", avoidSimilarityNote: "由垂直赛道自然产生" }
    ],
    shootingPlan: [
      { unit: "出发点", setup: "任务物特写加主角近景", mustCapture: "期限和主角立刻行动", practicalNote: "一处室内或村口即可完成" },
      { unit: "途中空间", setup: "移动中景、手部护物特写", mustCapture: "环境压力和主角选择", practicalNote: "选择可控空间，避免复杂调度" },
      { unit: "结尾点", setup: "固定机位加动作特写", mustCapture: "被关爱对象的反应和结尾仪式", practicalNote: "用自然光或单灯即可" }
    ],
    dialogueStyleGuide: {
      overallTone: "生活化、短句、少解释",
      protagonistSpeechRule: speechRule,
      supportingCharactersSpeechRule: "帮助者不煽情，被关爱对象不直接说教。",
      forbiddenDialoguePatterns: ["解释主题的大段独白", "复用原片台词", "把辛苦直接说破"]
    },
    retentionPlan: [
      { moment: "开场任务", viewerQuestion: "为什么必须现在完成？", payoff: "结尾揭示隐性需要", approxTime: "00:00" },
      { moment: "任务受阻", viewerQuestion: "还来得及吗？", payoff: "帮助者提供转折", approxTime: "00:14" },
      { moment: "抵达沉默", viewerQuestion: "对方真正需要什么？", payoff: "生活仪式回答", approxTime: "00:51" }
    ],
    experienceFidelity: {
      positioning: "仍是任务驱动的温情生活短故事",
      audience: "仍服务需要关系共鸣和善意确认的受众",
      emotion: "好奇—担心—温暖—释然",
      plotDriver: "必须完成的具体任务推动",
      highValueBeats: "任务期限、成本证明、获得帮助、生活化结尾全部保留"
    },
    transformationProof: {
      changedCharacters: `主角锁定为${fixed}，被关爱对象和帮助者按新主题重设`,
      changedTask: task,
      changedDetailsAndProps: `${medium}、${pressure}与帮助工具均为新表达`,
      changedDialogue: "按固定角色说话规则重写，避免复用原句",
      changedVisualExpression: "以新空间、新动作和新道具组织镜头"
    },
    continuityAndSafetyCheck: {
      fixedCharacterLocked: `主角始终为${fixedName}`,
      verticalFit: `任务和帮助方式来自${input.creatorProfile?.vertical || "当前赛道"}`,
      sourceSurfaceAvoided: "不继承原片服装、动物拟态、外壳职业或独特动作",
      protectedExpressionsAvoided: "仅保留剧作功能，不复用具体表达",
      shootableWithinConstraints: input.creatorProfile?.constraints || "默认 60 秒、少场景、低成本可拍"
    },
    uncertainties: []
  };
}

export function mockAnimationPlan(input) {
  const variant = input.variant || {};
  const fullStory = input.fullStory || {};
  const fixed = input.creatorProfile?.fixedCharacter || fullStory.characterBible?.protagonist?.identity || variant.characterSetup?.protagonist || "固定主角";
  const fixedName = fixed.split(/[，,；;、。\n\r（(]/u)[0]?.trim() || fixed;
  const title = fullStory.title || variant.title || "可动画化短片";
  const targetRuntime = Number(fullStory.targetDurationSeconds) || 60;
  const protagonistIdentity = fullStory.characterBible?.protagonist?.identity || fixed;
  const careRecipient = fullStory.characterBible?.careRecipient?.nameOrLabel || variant.characterSetup?.careRecipient || "被关爱对象";
  const protagonistPrompt = `${fixedName}，人类儿童形象，${protagonistIdentity}，圆润可爱的 2.5D 动画造型，干净朴素的日常衣服，表情活泼但懂事，动作小而认真，始终保持同一发型、同一服装、同一年龄感。`;
  const sceneScript = Array.isArray(fullStory.sceneScript) && fullStory.sceneScript.length ? fullStory.sceneScript : [
    { sceneId: "S1", timeRange: "00:00-00:05", location: "出发点", visibleAction: `${fixedName}确认任务物后出发。`, emotionNode: "任务启动", dramaticFunction: "建立任务" },
    { sceneId: "S2", timeRange: "00:05-00:14", location: "途中", visibleAction: `${fixedName}在环境压力中保护任务物。`, emotionNode: "压力上升", dramaticFunction: "增加成本" },
    { sceneId: "S3", timeRange: "00:14-00:25", location: "受阻点", visibleAction: `${fixedName}差点失手但护住任务物。`, emotionNode: "担心", dramaticFunction: "证明在意" },
    { sceneId: "S4", timeRange: "00:25-00:38", location: "临时停靠点", visibleAction: "帮助者递出关键工具。", emotionNode: "温暖", dramaticFunction: "善意转折" },
    { sceneId: "S5", timeRange: "00:38-00:51", location: "到达点", visibleAction: `${fixedName}把任务物交给${careRecipient}。`, emotionNode: "克制", dramaticFunction: "关系揭示" },
    { sceneId: "S6", timeRange: "00:51-01:00", location: "结尾空间", visibleAction: "两人完成生活化结尾动作。", emotionNode: "释然", dramaticFunction: "情绪兑现" }
  ];
  const shotPlan = sceneScript.flatMap((scene, index) => {
    const baseId = index + 1;
    const location = scene.location || "生活化场景";
    const action = scene.visibleAction || `${fixedName}继续完成任务。`;
    const emotion = scene.emotionNode || "克制温暖";
    const first = {
      shotId: `A${String(baseId).padStart(2, "0")}`,
      sourceSceneId: scene.sceneId || `S${baseId}`,
      durationSeconds: baseId === 1 ? 4 : 5,
      storyPurpose: scene.dramaticFunction || "推进任务和情绪",
      emotionalTarget: emotion,
      startFramePrompt: `竖屏 9:16，温暖治愈 2.5D 动画。${protagonistPrompt}${fixedName}位于${location}，画面开始时刚准备执行动作：${action}，中近景构图，柔和自然光，关键道具清晰但不夸张。`,
      endFramePrompt: `竖屏 9:16，保持同一 2.5D 动画风格和同一角色设定。${fixedName}完成这一镜头的动作节点，身体姿态从紧张转为更坚定，${location}环境保持连续，关键道具位置与上一帧逻辑一致。`,
      videoPrompt: `从首帧过渡到尾帧：${fixedName}只完成一个主要动作，节奏自然，镜头轻微跟随或推进，保持角色脸型、服装、年龄感和道具不变，不新增无关角色，不改变场景。`,
      cameraMotion: baseId <= 2 ? "轻微跟拍，保持稳定竖屏构图" : baseId === sceneScript.length ? "静态近景，保留情绪停顿" : "缓慢推进到动作细节",
      characterAction: action,
      dialogueOrSubtitle: Array.isArray(scene.dialogue) && scene.dialogue.length ? scene.dialogue.map((item) => `${item.speaker}：${item.line}`).join(" / ") : "无对白或短字幕，靠动作推进",
      soundDesign: scene.shotAndSound || "轻环境声，动作音效克制",
      continuityNotes: `承接 ${scene.sceneId || `S${baseId}`}，保持${fixedName}外观、道具和情绪递进连续。`,
      negativePrompt: "不要改变主角年龄、服装、脸型；不要新增动物拟态、玩偶感、夸张服装；不要跳切到无关场景；不要出现多余手指或畸形肢体。",
      acceptanceCriteria: [
        `${fixedName}身份和外观稳定`,
        "首帧与尾帧动作因果清楚",
        "镜头只完成一个主要动作",
        "道具和场景没有漂移"
      ]
    };
    if (index === 0 || index === sceneScript.length - 1) return [first];
    return [first];
  });

  return {
    selectedVariantId: variant.id || fullStory.selectedVariantId || "V1",
    title: `${title} · 首尾帧动画生产包`,
    productionStrategy: {
      format: "first_last_frame_video",
      targetAspectRatio: "9:16",
      targetRuntimeSeconds: targetRuntime,
      recommendedShotDurationSeconds: { min: 3, max: 6 },
      generationOrder: ["生成角色参考图", "生成关键道具参考图", "逐镜生成首帧", "逐镜生成尾帧", "用首尾帧生成短视频", "质检并挑选候选", "剪辑、配音、字幕和音效"],
      whyThisWorkflow: "首尾帧把每个镜头的起点和终点锁住，降低角色漂移和动作失控风险。"
    },
    visualBible: {
      overallStyle: "治愈生活流短片，细节干净，情绪克制，不夸张煽情。",
      animationStyle: "2.5D 动画，轻微手绘质感，角色圆润可爱，动作真实但带一点童话感。",
      colorPalette: ["暖米色", "雨后青灰", "低饱和橙色", "柔和绿色"],
      lighting: "自然散射光，情绪低点偏冷，帮助和结尾逐步转暖。",
      worldRules: ["村庄/生活空间真实可信", "道具比例稳定", "角色不突然换装", "天气变化服务情绪，不抢戏"],
      cameraLanguage: "竖屏近中景为主，少量跟拍，关键情绪用静态停顿。",
      characterConsistencyRules: [`${fixedName}始终是同一名人类儿童`, "同一发型、同一衣服、同一身高比例", "表情变化克制，动作先于语言"],
      negativeVisualRules: ["不要动物化主角", "不要玩偶服或夸张拟态", "不要让道具变形或漂移", "不要电影大片式过度运镜"]
    },
    characterReferencePrompts: [
      {
        characterName: fixedName,
        storyRole: "主角 / 任务执行者 / 善意连接者",
        identity: protagonistIdentity,
        appearancePrompt: protagonistPrompt,
        consistencyTags: [fixedName, "人类儿童", "朴素日常衣服", "活泼懂事", "同一发型", "同一年龄感"],
        forbiddenChanges: ["不能改名", "不能变成动物或玩偶", "不能更换年龄段", "不能更换核心服装"]
      },
      {
        characterName: careRecipient,
        storyRole: "被关爱对象",
        identity: fullStory.characterBible?.careRecipient?.identity || "被主角认真对待的人",
        appearancePrompt: `${careRecipient}，生活化动画角色，表情克制，有被记得时的微小松动，服装朴素，和${fixedName}处在同一个温暖现实世界。`,
        consistencyTags: [careRecipient, "生活化", "克制温情"],
        forbiddenChanges: ["不要过度煽情", "不要突然年轻化或卡通夸张"]
      }
    ],
    assetPrompts: (fullStory.keyProps || []).slice(0, 4).map((item, index) => ({
      assetName: item.prop || `关键道具${index + 1}`,
      storyFunction: item.storyFunction || "承载任务和情绪",
      imagePrompt: `竖屏动画道具参考图，${item.prop || `关键道具${index + 1}`}，生活化、低饱和、手感真实，适合${fixedName}拿在手中，能在开场、受阻和结尾保持同一外观。`,
      consistencyTags: [item.prop || `道具${index + 1}`, "低饱和", "同一外观", "生活化"],
      avoidSimilarityNote: "只服务新剧情道具功能，不复刻参考片具体道具组合。"
    })),
    shotPlan,
    editPlan: {
      sequenceRhythm: "前 5 秒建立任务，10–35 秒用连续小阻力制造担心，35–48 秒让帮助出现，最后 12 秒放慢给情绪回味。",
      transitions: ["动作方向匹配剪辑", "道具特写转场", "环境声过门", "结尾静态停顿"],
      subtitlePlan: "字幕只补充必要信息，主角台词短；如果角色只用拟声表达，字幕用括号解释动作意图。",
      musicAndSfx: "轻钢琴或木吉他底色，雨声/脚步/递物声要清楚，帮助出现时音乐变暖但不煽情。",
      hookAndEndingNotes: "开场必须让观众知道任务和期限；结尾保留 1 秒无对白停顿。"
    },
    generationChecklist: [
      { check: "角色一致性", passCriteria: `${fixedName}每个镜头都是同一名人类儿童，脸、发型、服装、年龄感一致。` },
      { check: "首尾帧因果", passCriteria: "首帧和尾帧之间只发生一个清楚动作，不跳剧情。" },
      { check: "情绪曲线", passCriteria: "镜头情绪按紧迫、担心、温暖、释然推进。" },
      { check: "可剪辑性", passCriteria: "每个镜头 3–6 秒，动作结束点可作为剪辑点。" },
      { check: "表达原创", passCriteria: "不复用参考片具体人物、台词、道具组合和镜头连续设计。" }
    ],
    modelAgnosticNotes: [
      "如果视频模型支持首尾帧，先分别生成首帧和尾帧，再用同一镜头的 videoPrompt 生成短视频。",
      "如果视频模型只支持图生视频，优先用 startFramePrompt 生成视频，再用 endFramePrompt 做结果验收。",
      "每个镜头至少生成 2 个候选，优先选择角色稳定而不是动作最复杂的版本。"
    ],
    continuityAndSafetyCheck: {
      fixedCharacterLocked: `动画主角始终锁定为${fixedName}`,
      positivePromptsAvoidSourceSurface: "正向提示词只写新人设、新场景和新道具，不继承参考片表面身份。",
      firstLastFrameContinuity: "每个镜头都给出首帧、尾帧、运动和验收标准。",
      shotDurationControlled: "所有镜头按 3–6 秒短镜头设计。",
      readyForVideoGeneration: "可以进入角色参考图、道具参考图、首尾帧和短视频候选生成。"
    },
    uncertainties: []
  };
}

function time(seconds) {
  const value = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}
