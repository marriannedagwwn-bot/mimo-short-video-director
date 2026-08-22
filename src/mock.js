import {
  ANIMATION_DIRECT_PROMPT_SCHEMA_VERSION,
  ANIMATION_DIRECT_SHOT_MODE,
  BACKGROUND_MUSIC_NONE,
  CREATIVE_BRIEF_ALLOWED_NARRATIVE_COMPONENTS,
  NO_BACKGROUND_MUSIC_SENTENCE,
  normalizeBackgroundMusicMode
} from "./validation.js";
import { resolveVideoPromptProfile } from "../public/video-prompt-profiles.js";

// 每条【原片有】都必须用「」引用 mockReconstruction 中真实存在的逐字原文，
// 否则 mock 自己就违反了 allowedNarrativeComponents 的存在性判定契约。
const allowedComponentGuidance = [
  "【原片有】「完成送达或照料」。保留把某物交到某人手中的目标压力，改写物品、接收者和阻碍。",
  "【原片有】「途中受阻」。保留空间推进带来的关系升温，改写路线、交通方式与停靠事件。",
  "【原片有】「任务物」。按当前剧情需要选择日常物件承载情绪；来源物件不是禁词，也不得因来源存在而机械注入。",
  "【原片有】「提供具体帮助」。保留陌生人或同伴援助的情绪回报，改写帮助者身份与帮助方式。",
  "【原片有】「让显性任务回应隐性需求」。保留显性需求与隐性需求的双层设计，重建人物关系与具体处境。",
  "【原片有】「遇到外部阻力」。继续让环境形成外部阻力和氛围，但采用新的场景调度。",
  "【原片有】「用日常小动作收尾」。保留小动作收束情绪的方式，重新设计结尾动作和道具。"
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
    observedFacts: (input.frames || []).map((frame, index, items) => ({
      factType: "visible_state",
      observation: `采样画面 F${index + 1} 记录了 ${time(frame.timestamp)} 时刻的可见状态`,
      importance: index === 0 || index === items.length - 1 ? "core" : "supporting",
      evidenceRefs: [{ source: "frame", frameNumber: index + 1 }]
    })),
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
    allowedNarrativeComponents: CREATIVE_BRIEF_ALLOWED_NARRATIVE_COMPONENTS.map(
      (component, index) => ({ component, howToReuseSafely: allowedComponentGuidance[index] })
    ),
    nonNegotiableExperience: { samePositioning: "仍是生活关系中的任务型情绪故事", sameAudience: "仍服务需要关系共鸣和善意确认的受众", sameEmotion: "仍经历好奇—担心—温暖—释然", samePlotDriver: "仍由必须完成的具体任务驱动", sameBeatValue: "仍包含成本证明、获得帮助与日常兑现" },
    creativeDistancePolicy: "结构与体验保持高保真；人物、事件、台词、道具和视听表达保持明确原创。"
  };
}

export function mockVisualGuardrails(input) {
  const fixed = input.creatorProfile?.fixedCharacter || "固定主角";
  const fixedName = fixed.split(/[，,；;、。\n\r（(]/u)[0]?.trim() || fixed;
  const evidence = [{ sourcePath: "creatorProfile.fixedCharacter", evidence: fixed }];
  const sourceSimilarityRules = [];
  const dialogueRules = [];
  for (const [index, item] of (input.creativeBrief?.protectedExpressions || []).entries()) {
    const sourceExpression = String(item?.sourceExpression || "").trim();
    if (!sourceExpression) continue;
    const triggerEvidence = [{
      sourcePath: `creativeBrief.protectedExpressions[${index}].sourceExpression`,
      evidence: sourceExpression
    }];
    if (/台词|对白|口癖|拟声/u.test(String(item?.expressionType || ""))) continue;
    sourceSimilarityRules.push({
      text: `记录原片表面表达“${sourceExpression}”；仅在实际使用原片视觉参考时用于 reference_leak 风险判断，不构成正向内容禁词。`,
      sourceExpression,
      triggerEvidence,
      appliesWhenReferenceUsed: true
    });
  }
  const constraints = String(input.creatorProfile?.constraints || "").trim();
  if (constraints && /台词|对白|说话|说|口癖|拟声|表达|句子|语气|发声|行为|动作/u.test(constraints)) {
    dialogueRules.push({
      text: constraints,
      triggerEvidence: [{ sourcePath: "creatorProfile.constraints", evidence: constraints }]
    });
  }
  return {
    fixedCharacterBoundary: {
      schemaVersion: "2.0",
      characterName: fixedName,
      canonicalDescription: fixed,
      bodyForm: "演示模式只锁定用户完整原文，不执行本地关键词推断。",
      requiredTraits: [{
        canonicalName: fixedName,
        terms: [fixedName],
        scope: "identity",
        evidenceLevel: "explicit",
        triggerEvidence: evidence,
        reason: "演示模式没有模型调用，只锁定可确定的固定角色名称；完整语义边界需要视觉模型生成。"
      }],
      allowedTraits: [],
      forbiddenTraits: [],
      unresolvedConflicts: []
    },
    allowedPositiveTraits: [],
    positivePromptBoundary: [],
    sourceSimilarityRules,
    dialogueRules,
    stageInstructions: {
      themeVariants: "按 positivePromptBoundary 审查固定角色；sourceSimilarityRules 不是正向内容禁词。",
      fullStory: "服从固定角色边界和用户明确 dialogueRules；来源表面表达允许按剧情使用，不得机械注入。",
      animationPlan: "结合当前镜头动作、道具、参考输入和真实失败记录，逐镜生成可为空的图片/视频 render negative。"
    },
    rationale: "本阶段一次性签发全局角色边界；后续只消费该边界，不重新解析固定角色。",
    uncertainties: []
  };
}

export function mockVariants(input) {
  const count = Math.max(1, Math.min(6, Number(input.count) || 3));
  const fixed = input.creatorProfile?.fixedCharacter || "固定主角";
  const vertical = input.creatorProfile?.vertical || "生活记录";
  const seeds = [
    { title: "最后一格电", task: "在闭店前修复并送回一件承载回忆的旧设备", medium: "一段未导出的旧录音", pressure: "暴雨导致街区停电", helper: "夜班便利店员借出移动电源", ending: "老人把修好的设备放回空着的餐位旁，按下播放键", shape: ["建立结果问题", "证明关系重量", "获得帮助但保留人物尊严", "用日常仪式回应隐性需求"] },
    { title: "错过的那班车", task: "把临时改好的工具交给即将返乡的学徒", medium: "工具柄内侧刻下的一句交代", pressure: "末班车提前且道路封控", helper: "收摊摊主用三轮车带主角穿过旧街", ending: "学徒上车前习惯性地把工具擦净，再递回一块旧抹布", shape: ["建立结果问题", "把最大代价提前压到第二拍", "帮助来得很晚且只解决一半", "用日常仪式收尾但留下未答的下一次"] },
    { title: "今天也要开门", task: "赶在清晨营业前恢复一家小店的关键设备", medium: "贴在设备背后的手写营业日期", pressure: "凌晨低温与配件不匹配", helper: "早餐店老板翻出多年前留下的通用零件", ending: "卷帘门升起，被照料对象照常先为主角留下一份早餐", shape: ["先让主角判断失误", "承担失误代价并重新定目标", "获得帮助但保留人物尊严", "用日常仪式回应隐性需求"] },
    { title: "雨停之前", task: "把重新制作的纪念物送到一场小型告别仪式", medium: "被水浸过又重新描好的图案", pressure: "连续降雨与临时改址", helper: "公交司机在安全范围内提醒一条近路", ending: "所有人没有讲话，只把纪念物摆正并擦去雨滴", shape: ["建立结果问题", "证明关系重量", "帮助只给方向，主角仍需独自完成", "愿望没有完全达成，收在开放情绪"] },
    { title: "多出来的一份", task: "补做一份临时缺失的物品送给不愿麻烦别人的新人", medium: "与团队其他人相同的名字标记", pressure: "活动即将开始且材料用尽", helper: "隔壁同行分享最后一小份材料", ending: "新人默默把自己的那份与大家摆在同一排", shape: ["建立结果问题", "被关爱对象先行回避", "帮助者点破回避的真正原因", "用日常仪式回应隐性需求"] },
    { title: "灯亮以后", task: "修复一盏被当作约定信号的旧灯", medium: "灯罩内的一张褪色便签", pressure: "山路起雾且备用灯芯损坏", helper: "巡夜保安提供一段废旧铜线", ending: "远处窗口亮起另一盏灯，主角关掉手电站了一会儿", shape: ["建立结果问题", "证明关系重量", "帮助改变了主角原本的目标", "以另一个人的回应完成兑现"] }
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
      { beat: 1, phase: "钩子", action: "任务物出问题，明确最后期限", emotion: "紧迫", dramaticFunction: seed.shape[0], estimatedSeconds: 4 },
      { beat: 2, phase: "推进", action: "常规方案失效，主角付出额外成本保护任务", emotion: "担心", dramaticFunction: seed.shape[1], estimatedSeconds: 14 },
      { beat: 3, phase: "转折", action: `${seed.helper}看出困境并提供具体帮助`, emotion: "温暖", dramaticFunction: seed.shape[2], estimatedSeconds: 12 },
      { beat: 4, phase: "兑现", action: seed.ending, emotion: "释然", dramaticFunction: seed.shape[3], estimatedSeconds: 10 }
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
      sourceSurfaceAvoided: "来源表面表达按当前剧情需要处理，不作为全局内容禁词",
      protectedExpressionsAvoided: "来源记录未被机械注入；当前 Variant 已选用的表达保持不变",
      shootableWithinConstraints: input.creatorProfile?.constraints || "默认 60 秒、少场景、低成本可拍"
    },
    uncertainties: []
  };
}

export function mockAnimationPlan(input) {
  if (input.animationPlanMode === ANIMATION_DIRECT_SHOT_MODE) {
    return mockDirectAnimationPlan(input);
  }
  const variant = input.variant || {};
  const fullStory = input.fullStory || {};
  const fixed = input.creatorProfile?.fixedCharacter || fullStory.characterBible?.protagonist?.identity || variant.characterSetup?.protagonist || "固定主角";
  const fixedName = fixed.split(/[，,；;、。\n\r（(]/u)[0]?.trim() || fixed;
  const title = fullStory.title || variant.title || "可动画化短片";
  const targetRuntime = Number(fullStory.targetDurationSeconds) || 60;
  const targetAspectRatio = input.targetAspectRatio || "16:9";
  const aspectRatioLabel = targetAspectRatio === "16:9" ? "横屏 16:9" : "竖屏 9:16";
  const protagonistIdentity = fullStory.characterBible?.protagonist?.identity || fixed;
  const careRecipient = fullStory.characterBible?.careRecipient?.nameOrLabel || variant.characterSetup?.careRecipient || "被关爱对象";
  const explicitIdentity = [...new Set([fixed, protagonistIdentity].map((item) => String(item || "").trim()).filter(Boolean))].join("，");
  const protagonistPrompt = `${fixedName}，${explicitIdentity}，圆润可爱的 2.5D 动画造型，严格保持用户明确设定的身份、外观、服装、发型和年龄感，表情活泼但懂事，动作小而认真。`;
  const sceneScript = Array.isArray(fullStory.sceneScript) && fullStory.sceneScript.length ? fullStory.sceneScript : [
    { sceneId: "S1", timeRange: "00:00-00:05", location: "出发点", visibleAction: `${fixedName}确认任务物后出发。`, emotionNode: "任务启动", dramaticFunction: "建立任务" },
    { sceneId: "S2", timeRange: "00:05-00:14", location: "途中", visibleAction: `${fixedName}在环境压力中保护任务物。`, emotionNode: "压力上升", dramaticFunction: "增加成本" },
    { sceneId: "S3", timeRange: "00:14-00:25", location: "受阻点", visibleAction: `${fixedName}差点失手但护住任务物。`, emotionNode: "担心", dramaticFunction: "证明在意" },
    { sceneId: "S4", timeRange: "00:25-00:38", location: "临时停靠点", visibleAction: "帮助者递出关键工具。", emotionNode: "温暖", dramaticFunction: "善意转折" },
    { sceneId: "S5", timeRange: "00:38-00:51", location: "到达点", visibleAction: `${fixedName}把任务物交给${careRecipient}。`, emotionNode: "克制", dramaticFunction: "关系揭示" },
    { sceneId: "S6", timeRange: "00:51-01:00", location: "结尾空间", visibleAction: "两人完成生活化结尾动作。", emotionNode: "释然", dramaticFunction: "情绪兑现" }
  ];
  const sceneReferencePrompts = sceneScript.map((scene, index) => {
    const sceneId = `LOC${String(index + 1).padStart(2, "0")}`;
    const location = scene.location || "生活化场景";
    return {
      sceneId,
      sceneName: location,
      storyFunction: scene.dramaticFunction || "承载剧情动作和情绪变化",
      environmentPrompt: `${aspectRatioLabel}，${location}，治愈生活流 2.5D 动画场景参考图，空间真实可信，背景层级清楚，光线自然，适合${fixedName}在其中完成短镜头动作。`,
      continuityAnchors: [location, "同一室内外属性", "同一背景层级", "同一光线方向", `同一${aspectRatioLabel}构图逻辑`],
      sceneContinuityRules: ["室内外属性保持一致", "地点与背景层级保持一致", "光线方向保持连续"],
      relatedShotIds: [`A${String(index + 1).padStart(2, "0")}`]
    };
  });
  const shotPlan = sceneScript.flatMap((scene, index) => {
    const baseId = index + 1;
    const location = scene.location || "生活化场景";
    const action = scene.visibleAction || `${fixedName}继续完成任务。`;
    const emotion = scene.emotionNode || "克制温暖";
    const shotId = `A${String(baseId).padStart(2, "0")}`;
    const sourceSceneId = scene.sceneId || `S${baseId}`;
    const sceneId = sceneReferencePrompts[index]?.sceneId || `LOC${String(baseId).padStart(2, "0")}`;
    const structured = buildMockStructuredAnimationShot({
      fixedName,
      scene,
      sceneId,
      location,
      action,
      emotion,
      cameraMode: baseId <= 2 ? "continuous" : "locked"
    });
    const first = {
      shotId,
      sourceSceneId,
      sceneId,
      durationSeconds: baseId === 1 ? 4 : 5,
      storyPurpose: scene.dramaticFunction || "推进任务和情绪",
      emotionalTarget: emotion,
      ...structured,
      negativePrompts: buildMockShotNegativePrompts(scene, {
        shotId,
        sourceSceneId
      }),
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
    promptSchemaVersion: "2.0",
    selectedVariantId: variant.id || fullStory.selectedVariantId || "V1",
    title: `${title} · 首尾帧动画生产包`,
    productionStrategy: {
      format: "first_last_frame_video",
      targetAspectRatio,
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
      cameraLanguage: `${aspectRatioLabel}近中景为主，少量跟拍，关键情绪用静态停顿。`,
      characterConsistencyRules: [`${fixedName}始终保持用户明确设定的同一身份`, "同一发型、同一衣服、同一身高比例", "表情变化克制，动作先于语言"]
    },
	    characterReferencePrompts: [
      {
        characterName: fixedName,
        storyRole: "主角 / 任务执行者 / 善意连接者",
        identity: protagonistIdentity,
        appearancePrompt: protagonistPrompt,
        consistencyTags: [fixedName, "用户明确身份", "活泼懂事", "同一发型", "同一服装", "同一年龄感"],
        forbiddenChanges: ["保持用户明确身份", "保持同一年龄段", "保持同一核心服装"]
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
	    sceneReferencePrompts,
	    assetPrompts: (fullStory.keyProps || []).slice(0, 4).map((item, index) => ({
      assetName: item.prop || `关键道具${index + 1}`,
      storyFunction: item.storyFunction || "承载任务和情绪",
      imagePrompt: `竖屏动画道具参考图，${item.prop || `关键道具${index + 1}`}，生活化、低饱和、手感真实，适合${fixedName}拿在手中，能在开场、受阻和结尾保持同一外观。`,
      consistencyTags: [item.prop || `道具${index + 1}`, "低饱和", "同一外观", "生活化"],
      avoidSimilarityNote: "记录与来源道具的关系；当前剧情需要时允许使用，不因来源上下文机械添加。"
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
      { check: "角色一致性", passCriteria: `${fixedName}每个镜头都保持用户明确设定的同一身份，脸、发型、服装、年龄感一致。` },
      { check: "首尾帧因果", passCriteria: "首帧和尾帧之间只发生一个清楚动作，不跳剧情。" },
      { check: "情绪曲线", passCriteria: "镜头情绪按紧迫、担心、温暖、释然推进。" },
      { check: "可剪辑性", passCriteria: "每个镜头 3–6 秒，动作结束点可作为剪辑点。" },
      { check: "来源职责", passCriteria: "按当前 Full Story 使用人物、对白和道具；不得因来源上下文存在而机械添加。" }
    ],
    modelAgnosticNotes: [
      "服务端从 startFrame、endFrame 和 motion 统一编译图像/视频提示词，结构化字段是唯一事实源。",
      "如果视频模型只支持图生视频，优先用编译后的首帧生成，再用编译后的尾帧做结果验收。",
      "每个镜头至少生成 2 个候选，优先选择角色稳定而不是动作最复杂的版本。"
    ],
    continuityAndSafetyCheck: {
      fixedCharacterLocked: `动画主角始终锁定为${fixedName}`,
      positivePromptsAvoidSourceSurface: "正向提示词忠实承接当前 Full Story；来源表达可以使用，但不得机械注入或覆盖固定主角边界。",
      firstLastFrameContinuity: "每个镜头都给出首帧、尾帧、运动和验收标准。",
      shotDurationControlled: "所有镜头按 3–6 秒短镜头设计。",
      readyForVideoGeneration: "可以进入角色参考图、道具参考图、首尾帧和短视频候选生成。"
    },
    uncertainties: []
  };
}

export function mockAnimationVideoPromptRewrite(animationPlan = {}, videoPromptProfile = {}) {
  return {
    videoPrompts: (animationPlan.shotPlan || []).map((shot) => {
      const videoPrompt = [
        `沿用已签发动画计划的视觉风格、物理光线、地点、角色外观、服装与道具。`,
          `${shot.characterAction}。`,
          `镜头按顺序执行：${shot.cameraMotion}。`,
          shot.dialogueOrSubtitle ? `${shot.dialogueOrSubtitle}；对白只作为声音，不渲染画面文字。` : "",
          `${shot.soundDesign}。`,
          `${shot.continuityNotes}。`,
          `在 ${shot.durationSeconds} 秒内到达已签发动作终点后立即停止，不新增字幕、标题、Logo、水印或额外动作。`
        ].filter(Boolean).join("");
      return { shotId: shot.shotId, videoPrompt };
    })
  };
}

function mockDirectAnimationPlan(input) {
  const legacy = mockAnimationPlan({ ...input, animationPlanMode: "" });
  const videoPromptProfile = structuredClone(
    input.videoPromptProfile
    || (input.videoPromptTarget ? resolveVideoPromptProfile(input.videoPromptTarget) : {})
  );
  // 演示输出必须跟真实契约一致：开关缺省关闭，两个 Profile 各按自己的合法写法表达无配乐。
  const noBackgroundMusic = normalizeBackgroundMusicMode(
    input.backgroundMusicMode ?? input.backgroundMusicEnabled
  ) === BACKGROUND_MUSIC_NONE;
  const directShots = legacy.shotPlan.map((shot) => {
    const sourceScene = (input.fullStory?.sceneScript || []).find(
      (scene) => String(scene?.sceneId || "") === String(shot.sourceSceneId || "")
    ) || {};
    const sceneReference = (legacy.sceneReferencePrompts || []).find(
      (scene) => String(scene?.sceneId || "") === String(shot.sceneId || "")
    ) || {};
    const visibleCharacterPrompts = (Array.isArray(sourceScene.characters) ? sourceScene.characters : [])
      .map((characterName) => {
        const reference = (legacy.characterReferencePrompts || []).find(
          (item) => String(item?.characterName || "") === String(characterName || "")
        );
        return reference?.appearancePrompt
          ? `${characterName}（${reference.appearancePrompt}）`
          : String(characterName || "").trim();
      })
      .filter(Boolean)
      .join("；");
    const dialogue = (shot.motion?.audio?.dialogue || [])
      .map((item) => `${item.speaker}：${item.text}`)
      .join("；");
    const cameraMove = shot.motion?.cameraMove || {};
    const cameraMotion = [cameraMove.technique, cameraMove.path, cameraMove.speed]
      .filter(Boolean)
      .join("；");
    const characterAction = String(shot.motion?.primaryAction || "角色完成当前剧情动作").trim();
    const soundDesign = [
      shot.motion?.audio?.ambience,
      `与“${characterAction}”同步的自然动作声`,
      shot.motion?.audio?.musicCue
    ].filter(Boolean).join("；");
    const continuityNotes = (shot.motion?.preserve || []).join("；");
    const styleAndLighting = [
      legacy.visualBible?.animationStyle,
      legacy.visualBible?.overallStyle,
      legacy.visualBible?.lighting
    ].filter(Boolean).join("，");
    const environmentPrompt = sceneReference.environmentPrompt
      || sourceScene.location
      || "沿用当前场景锁定";
    const visiblePerformance = shot.motion?.emotionArc?.visibleProgression || "";
    const stopCondition = shot.motion?.stopCondition || "达到当前动作的可见结果后立即停止，不追加新动作";
    const seedanceVideoPrompt = [
      styleAndLighting ? `${styleAndLighting}。` : "",
      `${environmentPrompt}。`,
      visibleCharacterPrompts ? `${visibleCharacterPrompts}，${characterAction}。` : `${characterAction}。`,
      cameraMotion ? `镜头按动作顺序${cameraMotion}。` : "",
      visiblePerformance ? `${visiblePerformance}。` : "",
      `在 ${shot.durationSeconds} 秒内按上述顺序清楚完成动作，节奏服务“${shot.emotionalTarget}”。`,
      dialogue ? `${dialogue}；对白只作为声音，不渲染画面文字。` : "",
      soundDesign ? `${soundDesign}。` : "",
      continuityNotes ? `内部摄影段与前后镜头均保持${continuityNotes}。` : "",
      `${stopCondition}。`,
      noBackgroundMusic ? NO_BACKGROUND_MUSIC_SENTENCE : ""
    ].filter(Boolean).join("");
    return {
      shotId: shot.shotId,
      sourceSceneId: shot.sourceSceneId,
      sceneId: shot.sceneId,
      durationSeconds: shot.durationSeconds,
      storyPurpose: shot.storyPurpose,
      emotionalTarget: shot.emotionalTarget,
      videoPrompt: seedanceVideoPrompt,
      cameraMotion: cameraMotion || "固定机位，保持单一连续构图",
      characterAction,
      dialogueOrSubtitle: dialogue,
      soundDesign: soundDesign || "保留当前场景的自然环境声和动作声",
      continuityNotes: continuityNotes || "角色、场景和关键道具与前后镜头连续",
      negativePrompts: {
        image: [],
        video: structuredClone(shot.negativePrompts?.video || [])
      },
      acceptanceCriteria: [
        `“${characterAction}”按顺序完整发生且可见结果清楚`,
        cameraMotion ? `摄影表达按“${cameraMotion}”完成且不遗漏主要动作` : "主要动作在稳定构图中完整可见",
        continuityNotes ? `动作与摄影变化过程中保持${continuityNotes}` : "角色、场景和关键道具在动作过程中保持稳定"
      ]
    };
  });
  return {
    ...legacy,
    promptSchemaVersion: ANIMATION_DIRECT_PROMPT_SCHEMA_VERSION,
    title: legacy.title.replace("首尾帧动画生产包", "直接视频镜头生产包"),
    productionStrategy: {
      ...legacy.productionStrategy,
      format: "direct_shot_video",
      recommendedShotDurationSeconds: { min: 4, max: 6 },
      videoPromptProfile,
      generationOrder: ["锁定角色、场景和资产", "生成直接视频镜头", "质检并挑选候选", "剪辑、配音、字幕和音效"],
      whyThisWorkflow: "镜头内容由模型直接写成完整视频指令，不生产首帧、尾帧或端点运动结构。"
    },
    shotPlan: directShots,
    generationChecklist: (legacy.generationChecklist || []).filter((item) => item.check !== "首尾帧因果"),
    modelAgnosticNotes: [
      "videoPrompt 是每个镜头的完整自然语言渲染主指令，依次包含风格与光线、环境、主体锁定、动作链、摄影表达、节奏声音和稳定约束。",
      "同一业务镜头可以包含服务同一动作目标的内部景别变化或剪辑表达；它们不得反向增加 shotPlan 数量。",
      "当前流程不生产 startFrame、endFrame、motion、startFramePrompt 或 endFramePrompt。",
      "视频生成模式仍由请求显式选择，不根据字段缺失自动推断。"
    ],
    continuityAndSafetyCheck: {
      ...legacy.continuityAndSafetyCheck,
      firstLastFrameContinuity: "当前直接视频模式不生产首尾帧。",
      readyForVideoGeneration: "直接视频镜头已通过契约校验，可进入显式视频生成模式。"
    }
  };
}

function buildMockStructuredAnimationShot({ fixedName, scene = {}, sceneId, location, action, emotion, cameraMode }) {
  const timeAndWeather = `${scene.timeRange || "当前剧情时段"}，天气与本场剧情连续`;
  const startEmotion = String(emotion || "克制温暖");
  const endEmotion = `${startEmotion}中更坚定`;
  const startCamera = {
    shotSize: "中近景",
    height: "与主体视线齐平",
    angle: "平视",
    viewDirection: "沿同一空间轴线看向主体",
    lensFeel: "自然视角，无广角畸变",
    depthOfField: "主体和关键道具清晰，背景轻微柔化",
    composition: `${fixedName}位于竖屏中心偏左，预留动作方向空间`
  };
  const endCamera = cameraMode === "locked"
    ? { ...startCamera }
    : {
      ...startCamera,
      composition: `${fixedName}位于竖屏中心，连续跟随后保留动作终点空间`
    };
  const environment = {
    sceneId,
    foreground: "少量生活化前景，不遮挡手部和关键道具",
    midground: `${location}中的主要行动区域`,
    background: `${location}的稳定空间锚点和清晰背景层级`,
    atmosphere: "治愈生活流，空间真实可信，氛围克制"
  };
  const lighting = {
    source: "单一稳定的自然散射光",
    direction: "画面侧前方柔和入射",
    colorAndContrast: "低饱和暖中性色，柔和对比，关键道具可读"
  };
  const styleModifiers = ["竖屏 9:16", "温暖治愈 2.5D 动画", "轻微手绘质感", "细节干净"];
  const continuityLocks = [
    `${fixedName}身份、年龄感、发型和服装不变`,
    `${location}的室内外属性、空间轴线和背景层级不变`,
    "关键道具外观、尺寸和数量不变",
    "光源方向和色彩对比不跳变"
  ];
  const dialogue = Array.isArray(scene.dialogue)
    ? scene.dialogue.map((item) => ({
      speaker: String(item?.speaker || "").trim(),
      text: String(item?.line || item?.text || "").trim(),
      delivery: String(item?.deliveryOrSubtext || item?.delivery || "短句、克制、自然").trim()
    })).filter((item) => item.speaker && item.text)
    : [];
  const isLocked = cameraMode === "locked";
  const cameraMove = isLocked ? {
    mode: "locked",
    technique: "固定机位",
    path: "固定机位，保持首帧构图",
    speed: "slow",
    motivation: "让单一动作和手部道具状态清晰可读"
  } : {
    mode: "continuous",
    technique: "轻微跟随",
    path: "沿同一空间轴线缓慢向前并跟随主体，全程不切镜",
    speed: "slow",
    motivation: "在不破坏空间连续性的前提下让主要动作保持清晰"
  };
  const cameraBeat = isLocked ? "固定机位，保持首帧构图" : "沿同一轴线连续轻微跟随，不切镜";

  return {
    startFrame: {
      timeAndWeather,
      characters: [{
        name: fixedName,
        screenPosition: "画面中心偏左",
        bodyOrientation: "身体略朝动作方向",
        pose: "双脚稳定落地，躯干朝向动作方向，重心明确",
        actionState: "关键肢体停在动作起始位置，与目标道具之间留有清晰距离",
        handPropState: "双手与关键道具清晰分离，道具稳定停在画面中的起始位置",
        gaze: "视线落在关键道具或互动对象上",
        emotionState: startEmotion,
        expression: "表情克制专注，可见情绪与当前剧情一致"
      }],
      environment: { ...environment },
      camera: startCamera,
      lighting: { ...lighting },
      styleModifiers: [...styleModifiers],
      continuityLocks: [...continuityLocks]
    },
    endFrame: {
      timeAndWeather,
      characters: [{
        name: fixedName,
        screenPosition: isLocked ? "画面中心偏左" : "画面中心",
        bodyOrientation: "身体稳定停在主要动作的终点方向",
        pose: "双脚稳定落地，重心停在动作终点方向",
        actionState: "关键肢体停在动作终点位置，动作结果在画面中清晰可见",
        handPropState: "双手与关键道具的接触逻辑清楚，道具稳定停在动作完成位置",
        gaze: "视线停在主要动作的结果上",
        emotionState: endEmotion,
        expression: "表情仍克制，但目标完成后的坚定感可见"
      }],
      environment: { ...environment },
      camera: endCamera,
      lighting: { ...lighting },
      styleModifiers: [...styleModifiers],
      continuityLocks: [...continuityLocks]
    },
    motion: {
      mode: "continuous_action",
      primaryAction: action,
      cameraMove,
      emotionArc: {
        from: startEmotion,
        visibleProgression: `${fixedName}在完成同一动作的过程中，情绪从${startEmotion}逐步显露出更坚定的结果感`,
        to: endEmotion
      },
      environmentChange: `无地点或空间结构变化，${location}的前中后景保持连续`,
      lightingChange: "无，光源方向、色温和对比保持连续",
      timingBeats: [{
        fromPercent: 0,
        toPercent: 45,
        action: `${fixedName}从 startFrame 的冻结姿态自然启动同一主要动作`,
        camera: cameraBeat,
        emotion: `保持${startEmotion}，只出现微小进展`,
        environment: `${location}空间和道具位置连续，无跳变`,
        soundCue: "轻微环境底噪和动作启动声"
      }, {
        fromPercent: 45,
        toPercent: 100,
        action: `${fixedName}连续完成同一主要动作并稳定停在 endFrame 状态`,
        camera: cameraBeat,
        emotion: `可见过渡到${endEmotion}，不追加第二反应`,
        environment: `${location}空间、背景层级和光线保持不变`,
        soundCue: "主要动作完成声后立即收止"
      }],
      audio: {
        dialogue,
        ambience: `${location}的轻微生活环境声`,
        soundEffects: [scene.shotAndSound || "克制的手部与道具动作声"],
        musicCue: "轻钢琴或木吉他底色，不抢动作节奏"
      },
      preserve: [...continuityLocks],
      endStateRef: "endFrame",
      stopCondition: "达到 endFrame 定义的姿态、手部道具和表情状态后立即停止，不追加动作",
      postRetime: {
        recommended: false,
        speedCurve: "原速连续播放",
        reason: "当前单一动作已能在镜头时长内清晰完成"
      }
    }
  };
}

function buildMockShotNegativePrompts(scene = {}, context = {}) {
  const action = String(scene.visibleAction || "").trim();
  const sourceSceneId = context.sourceSceneId || scene.sceneId || "S1";
  const triggerEvidence = action ? [{
    sourcePath: `fullStory.sceneScript[${sourceSceneId}].visibleAction`,
    evidence: action
  }] : [];
  const showsGlassSlide = /玻璃(?:幻灯)?片|透明玻璃片|幻灯片/u.test(action);
  const hasHandInteraction = /打开|拿起|取出|手持|握住|捏住|举起|对着|观察/u.test(action);
  if (!showsGlassSlide || !hasHandInteraction || !triggerEvidence.length) return { image: [], video: [] };

  return {
    image: [
      {
        text: "手指与透明玻璃片融合",
        appliesTo: "image",
        triggerEvidence,
        reasonCode: "shot_interaction_failure",
        priority: "high",
        enabled: true
      },
      {
        text: "玻璃幻灯片被错误生成成手机屏幕",
        appliesTo: "image",
        triggerEvidence,
        reasonCode: "shot_object_confusion",
        priority: "medium",
        enabled: true
      }
    ],
    video: [
      {
        text: "拿起过程中手指与透明玻璃片融合",
        appliesTo: "video",
        triggerEvidence,
        reasonCode: "shot_interaction_failure",
        priority: "high",
        enabled: true
      },
      {
        text: "玻璃幻灯片在动作过程中变形",
        appliesTo: "video",
        triggerEvidence,
        reasonCode: "temporal_consistency_failure",
        priority: "medium",
        enabled: true
      }
    ]
  };
}

function time(seconds) {
  const value = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}
