import test from "node:test";
import assert from "node:assert/strict";
import { sealGlobalCharacterBoundary } from "../src/character-boundary.js";
import { mockAnimationPlan, mockBrief, mockFullStory, mockVisualGuardrails } from "../src/mock.js";
import { animationFoundationPrompt, animationShotBatchPrompt } from "../src/prompts.js";
import {
  ANIMATION_DIRECT_PROMPT_SCHEMA_VERSION,
  ANIMATION_DIRECT_SHOT_MODE,
  InputError,
  OutputContractError,
  ensureAnimationShotBatchContract,
  MINIMAX_H3_NO_MUSIC_SECTION,
  NO_BACKGROUND_MUSIC_SENTENCE,
  materializeGlobalCharacterBoundaryViews,
  normalizeBackgroundMusicMode,
  parseSceneTimeRangeSeconds,
  pruneAnimationPlanNegativePrompts,
  sceneMinimumShotCount
} from "../src/validation.js";
import { WorkflowService } from "../src/workflow.js";
import { generateShotVideo, normalizeShotVideoAspectRatio, ShotVideoConfigError } from "../src/shot-video-generator.js";
import { resolveVideoPromptProfile, VIDEO_PROMPT_PROFILE_IDS } from "../public/video-prompt-profiles.js";
import { assertMiniMaxH3BasePrompt, miniMaxH3DialogueTexts } from "../src/minimax-h3-prompt.js";

const DIRECT_SHOT_FIELDS = Object.freeze([
  "shotId",
  "sourceSceneId",
  "sceneId",
  "durationSeconds",
  "storyPurpose",
  "emotionalTarget",
  "videoPrompt",
  "cameraMotion",
  "characterAction",
  "dialogueOrSubtitle",
  "soundDesign",
  "continuityNotes",
  "negativePrompts",
  "acceptanceCriteria"
]);

const DISABLED_ENDPOINT_FIELDS = Object.freeze([
  "startFrame",
  "endFrame",
  "motion",
  "startFramePrompt",
  "endFramePrompt"
]);

function directShot() {
  return {
    shotId: "A01",
    sourceSceneId: "S1",
    sceneId: "LOC01",
    durationSeconds: 4,
    storyPurpose: "建立修理任务",
    emotionalTarget: "专注",
    videoPrompt: "阿岚在社区维修间检查旧收音机，镜头保持单一连续构图，修理动作完成后立即停止。",
    cameraMotion: "固定机位，中近景保持稳定",
    characterAction: "阿岚低头检查旧收音机并拧紧松动螺丝",
    dialogueOrSubtitle: "",
    soundDesign: "维修间环境声，螺丝刀轻响",
    continuityNotes: "阿岚、旧收音机和维修台位置保持连续",
    negativePrompts: { image: [], video: [] },
    acceptanceCriteria: ["阿岚身份稳定", "修理动作连续可见"]
  };
}

// 这些用例验证的是 direct_shot 的字段契约与各类修复协议，不是镜头数下限。
// 把每场脚本时长压到单镜上限以内，使「一场一镜」的既有 fixture 本身就满足
// 新的每场镜头数下限，测试焦点保持不变。下限本身由专门的用例覆盖。
function withSingleShotSceneTimeRanges(fullStory) {
  const story = structuredClone(fullStory);
  story.sceneScript = (Array.isArray(story.sceneScript) ? story.sceneScript : []).map((scene, index) => ({
    ...scene,
    timeRange: `00:${String(index * 5).padStart(2, "0")}-00:${String(index * 5 + 5).padStart(2, "0")}`
  }));
  return story;
}

function directContext(workflow = new WorkflowService()) {
  const creatorProfile = {
    fixedCharacter: "阿岚，社区修理师",
    vertical: "家电维修",
    constraints: "60 秒内"
  };
  const boundaryInput = {
    creatorProfile,
    referenceAnalysis: {},
    sourceScriptReconstruction: {}
  };
  const creativeBrief = mockBrief(boundaryInput);
  const variant = {
    id: "V1",
    title: "最后一格电",
    characterSetup: {
      protagonist: "阿岚，社区修理师",
      careRecipient: "独居老人",
      helper: "夜班便利店员"
    },
    newTask: "修复并送回旧设备",
    emotionalMedium: "一段旧录音",
    environmentPressure: "暴雨停电",
    endingRitual: "老人按下播放键"
  };
  const fullStory = withSingleShotSceneTimeRanges(mockFullStory({ ...boundaryInput, creativeBrief, variant }));
  const signingInput = { ...boundaryInput, creativeBrief };
  const visualGuardrails = sealGlobalCharacterBoundary(
    materializeGlobalCharacterBoundaryViews(mockVisualGuardrails(signingInput), creatorProfile),
    signingInput,
    workflow.characterBoundaryKey
  );
  return {
    ...signingInput,
    visualGuardrails,
    variant,
    fullStory,
    animationPlanMode: ANIMATION_DIRECT_SHOT_MODE,
    videoPromptTarget: {
      provider: "Seedance",
      model: "doubao-seedance-2-0-260128"
    },
    videoPromptProfile: resolveVideoPromptProfile({
      provider: "Seedance",
      model: "doubao-seedance-2-0-260128"
    })
  };
}

function miniMaxH3PromptForShot(shot) {
  const dialogue = miniMaxH3DialogueTexts(shot.dialogueOrSubtitle)
    .map((line, index) => `The signed speaker (S${index + 1}) says, <d>[Chinese] ${line}</d>.`)
    .join(" ");
  return `integrated_multimodal_description: [Shot 1] The signed character remains in the locked Animation Plan location with the authorized wardrobe and props, performs the complete planned action chain in its exact order, follows the specified camera sequence, and holds the stated visible final state. ${dialogue}`.trim()
    + `\noverall_soundscape: The signed diegetic ambience, action sounds, and spoken lines remain synchronized with every visible action.\nnon_diegetic_music: A restrained instrumental cue at a slow tempo, joined by sustained low strings that fade out on the completed action.`;
}

function animationVideoPromptSemanticAuditPayload(prompt) {
  const prefix = "服务端签发审核目录：";
  const suffix = "\n\n按目录 shots 顺序逐项输出";
  const text = String(prompt || "");
  const start = text.indexOf(prefix);
  const end = text.indexOf(suffix, start + prefix.length);
  assert.notEqual(start, -1, "语义审计 Prompt 必须包含服务端签发目录");
  assert.notEqual(end, -1, "语义审计 Prompt 必须包含签发目录终点");
  return JSON.parse(text.slice(start + prefix.length, end));
}

function passingAnimationVideoPromptSemanticAudit(prompt) {
  const payload = animationVideoPromptSemanticAuditPayload(prompt);
  return {
    schemaVersion: "animation_video_prompt_semantic_audit/2.0",
    shots: payload.shots.map((shot) => ({
      shotId: shot.shotId,
      shotFactsVerdict: "pass",
      videoPromptVerdict: "pass",
      issues: []
    }))
  };
}

function createPromptRewriteWorkflow(getSourcePlan) {
  const calls = [];
  const client = {
    async generateJson(args) {
      calls.push(args);
      if (/ANIMATION_VIDEO_PROMPT_REWRITE_SEMANTIC_AUDIT_V2/u.test(args.prompt)) {
        return passingAnimationVideoPromptSemanticAudit(args.prompt);
      }
      const sourcePlan = getSourcePlan();
      return {
        videoPrompts: sourcePlan.shotPlan.map((shot) => ({
          shotId: shot.shotId,
          videoPrompt: miniMaxH3PromptForShot(shot)
        }))
      };
    }
  };
  return {
    workflow: new WorkflowService({
      clients: { MiMo: client },
      animationProvider: "MiMo",
      animationModel: "animation-prompt-rewrite-test"
    }),
    calls
  };
}

test("direct foundation 与 batch prompt 声明 3.0 且 JSON 结构不含端点字段", () => {
  const context = directContext();
  const plan = mockAnimationPlan(context);
  const { shotPlan: ignoredShotPlan, ...animationFoundation } = structuredClone(plan);
  animationFoundation.sceneReferencePrompts.forEach((scene, index) => {
    scene.sourceSceneIds = [context.fullStory.sceneScript[index].sceneId];
    scene.relatedShotIds = [];
  });

  const foundationPrompt = animationFoundationPrompt(context);
  const batchPrompt = animationShotBatchPrompt({
    ...context,
    animationFoundation,
    sourceScenes: context.fullStory.sceneScript.slice(0, 2),
    shotIdStartIndex: 1
  });

  assert.match(foundationPrompt, /当前显式模式：direct_shot/u);
  assert.match(foundationPrompt, /"promptSchemaVersion":"3\.0"/u);
  assert.match(foundationPrompt, /"format":"direct_shot_video"/u);
  assert.match(batchPrompt, /当前显式模式：direct_shot/u);
  assert.match(batchPrompt, /契约版本：3\.0/u);
  assert.match(batchPrompt, /"videoPrompt":""/u);
  assert.match(batchPrompt, /"cameraMotion":""/u);

  for (const prompt of [foundationPrompt, batchPrompt]) {
    for (const field of DISABLED_ENDPOINT_FIELDS) {
      assert.doesNotMatch(
        prompt,
        new RegExp(`"${field}"\\s*:`, "u"),
        `direct prompt 的 JSON 结构不得声明 ${field}`
      );
    }
  }
});

test("MiniMax H3 direct batch Prompt 用带对白的完整三段换行示例并把纯文本对白逐字包装进 integrated", () => {
  const context = directContext();
  const h3Profile = resolveVideoPromptProfile({
    provider: "MiniMax",
    model: "MiniMax-H3"
  });
  const plan = mockAnimationPlan(context);
  const { shotPlan: ignoredShotPlan, ...animationFoundation } = structuredClone(plan);
  animationFoundation.productionStrategy.videoPromptProfile = h3Profile;
  animationFoundation.sceneReferencePrompts.forEach((scene, index) => {
    scene.sourceSceneIds = [context.fullStory.sceneScript[index].sceneId];
    scene.relatedShotIds = [];
  });

  const prompt = animationShotBatchPrompt({
    ...context,
    videoPromptProfile: h3Profile,
    animationFoundation,
    sourceScenes: context.fullStory.sceneScript.slice(0, 1),
    shotIdStartIndex: 1
  });
  const exampleStartMarker = "\n严格输出：\n";
  const exampleStart = prompt.lastIndexOf(exampleStartMarker);
  const exampleEnd = prompt.indexOf("\n\n不要生成", exampleStart + exampleStartMarker.length);
  assert.notEqual(exampleStart, -1, "H3 batch Prompt 必须提供 strict JSON 示例");
  assert.notEqual(exampleEnd, -1, "H3 batch Prompt 的 strict JSON 示例必须有明确边界");

  const rawExample = prompt.slice(exampleStart + exampleStartMarker.length, exampleEnd);
  assert.match(
    rawExample,
    /"videoPrompt":"integrated_multimodal_description:[^"]*\\noverall_soundscape:[^"]*\\nnon_diegetic_music:[^"]*"/u,
    "JSON 示例必须用转义的 \\n 分隔三个 H3 section，不能暗示模型把段名写在同一行"
  );
  const example = JSON.parse(rawExample);
  assert.deepEqual(
    [...example.shotPlan[0].videoPrompt.matchAll(/^(integrated_multimodal_description|overall_soundscape|non_diegetic_music):/gmu)]
      .map((match) => match[1]),
    ["integrated_multimodal_description", "overall_soundscape", "non_diegetic_music"],
    "解析后的示例必须让三个 section heading 各自位于行首"
  );
  assert.equal(
    example.shotPlan[0].dialogueOrSubtitle,
    "小白子：嗷呜~",
    "strict JSON 示例必须用非空拟声式对白演示结构化对白字段"
  );
  assert.match(
    example.shotPlan[0].videoPrompt,
    /<d>\[Chinese\] 嗷呜~<\/d>/u,
    "strict JSON 示例必须在 integrated 中逐字包装去除说话人前缀后的原对白"
  );
  assert.equal(
    [...example.shotPlan[0].videoPrompt.matchAll(/<d>\[[^\]]+\][\s\S]*?<\/d>/gu)].length,
    1,
    "strict JSON 示例中的签发对白必须恰好映射为一个 <d> 块"
  );
  assert.doesNotThrow(() => assertMiniMaxH3BasePrompt(example.shotPlan[0].videoPrompt, {
    durationSeconds: example.shotPlan[0].durationSeconds,
    dialogueTexts: miniMaxH3DialogueTexts(example.shotPlan[0].dialogueOrSubtitle)
  }));
  const soundscape = example.shotPlan[0].videoPrompt.split("\noverall_soundscape:")[1]
    .split("\nnon_diegetic_music:")[0];
  assert.doesNotMatch(soundscape, /嗷呜~/u, "soundscape 不得重复或替代逐字对白");

  const headingRule = prompt.split("\n").find(
    (line) => /新行行首/u.test(line) && /字段名|段名|heading|section/u.test(line)
  );
  assert.ok(headingRule, "H3 规则必须明确要求每个 section heading 从新行行首开始");

  const dialogueFieldRule = prompt.split("\n").find(
    (line) => /dialogueOrSubtitle 字段本身/u.test(line)
  );
  assert.ok(dialogueFieldRule, "H3 规则必须明确 dialogueOrSubtitle 的字段契约");
  assert.match(dialogueFieldRule, /纯剧情对白/u);
  assert.match(dialogueFieldRule, /(?:不得|禁止|严禁)[^；。]*<d>/u);

  const dialogueMappingRule = prompt.split("\n").find(
    (line) => /dialogueOrSubtitle 非空时/u.test(line)
      && /integrated_multimodal_description/u.test(line)
  );
  assert.ok(dialogueMappingRule, "H3 规则必须声明纯文本对白到 integrated <d> 块的逐条映射");
  assert.match(dialogueMappingRule, /(?:逐条|每一条|每句)/u);
  assert.match(dialogueMappingRule, /逐字/u);
  assert.match(
    dialogueMappingRule,
    /小白子：嗷呜~[^\n]*<d>\[Chinese\] 嗷呜~<\/d>/u,
    "示例必须证明说话人标签留在结构化字段，而 <d> 只包装剥离说话人后的原对白"
  );
  assert.match(dialogueMappingRule, /嗯…？/u, "规则必须明确短叹词也属于签发对白");
  assert.match(dialogueMappingRule, /murmur[^\n]*不能替代/u, "声音概述不得替代 <d> 对白块");
});

test("direct_shot 把用户选择的 16:9 锁入 Prompt、Mock 和最终计划", async () => {
  const workflow = new WorkflowService();
  const context = { ...directContext(workflow), targetAspectRatio: "16:9" };
  const prompt = animationFoundationPrompt(context);

  assert.match(prompt, /用户选择的目标画幅：16:9/u);
  assert.match(prompt, /"targetAspectRatio":"16:9"/u);
  const plan = await workflow.createAnimationPlan(context);
  assert.equal(plan.productionStrategy.targetAspectRatio, "16:9");
  assert.match(plan.visualBible.cameraLanguage, /横屏 16:9/u);
});

test("direct_shot 明确拒绝未支持的动画目标画幅", async () => {
  const workflow = new WorkflowService();
  const context = directContext(workflow);
  await assert.rejects(
    () => workflow.createAnimationPlan({ ...context, targetAspectRatio: "1:1" }),
    /targetAspectRatio 只允许 9:16 或 16:9/u
  );
});

test("direct foundation 只发送基础事实投影且 fixedCharacterBoundary 不重复", () => {
  const context = directContext();
  context.variant.foundationPromptLeakSentinel = "VARIANT_PROMPT_LEAK_SENTINEL";
  context.creativeBrief.foundationPromptLeakSentinel = "BRIEF_PROMPT_LEAK_SENTINEL";
  context.fullStory.beatSheet = [{ beat: "BEAT_SHEET_PROMPT_LEAK_SENTINEL" }];
  context.fullStory.shootingPlan = [{ setup: "SHOOTING_PLAN_PROMPT_LEAK_SENTINEL" }];

  const firstScene = context.fullStory.sceneScript[0];
  firstScene.timeRange = "TIME_RANGE_FOUNDATION_SENTINEL";
  firstScene.location = "LOCATION_FOUNDATION_SENTINEL";
  firstScene.characters = [...firstScene.characters, "SCENE_CHARACTER_FOUNDATION_SENTINEL"];
  firstScene.visibleAction = "VISIBLE_ACTION_FOUNDATION_SENTINEL";
  firstScene.emotionNode = "EMOTION_NODE_FOUNDATION_SENTINEL";
  firstScene.dramaticFunction = "DRAMATIC_FUNCTION_FOUNDATION_SENTINEL";
  firstScene.dialogue = [{ speaker: "DIALOGUE_PROMPT_LEAK_SENTINEL", line: "不应进入 Foundation" }];
  firstScene.shotAndSound = "SHOT_AND_SOUND_PROMPT_LEAK_SENTINEL";
  firstScene.shootingNotes = "SHOOTING_NOTES_PROMPT_LEAK_SENTINEL";
  context.fullStory.characterBible.protagonist.traits.push("CHARACTER_BIBLE_FOUNDATION_SENTINEL");
  context.fullStory.keyProps[0].visualUse = "KEY_PROP_FOUNDATION_SENTINEL";

  const prompt = animationFoundationPrompt(context);
  const boundarySignature = context.visualGuardrails.fixedCharacterBoundary.boundarySignature;

  assert.doesNotMatch(prompt, /\n选中主题变体：/u);
  assert.doesNotMatch(prompt, /\ncreativeBrief：/u);
  for (const sentinel of [
    "VARIANT_PROMPT_LEAK_SENTINEL",
    "BRIEF_PROMPT_LEAK_SENTINEL",
    "BEAT_SHEET_PROMPT_LEAK_SENTINEL",
    "SHOOTING_PLAN_PROMPT_LEAK_SENTINEL",
    "DIALOGUE_PROMPT_LEAK_SENTINEL",
    "SHOT_AND_SOUND_PROMPT_LEAK_SENTINEL",
    "SHOOTING_NOTES_PROMPT_LEAK_SENTINEL"
  ]) {
    assert.doesNotMatch(prompt, new RegExp(sentinel, "u"), `${sentinel} 不得进入 Foundation prompt`);
  }

  for (const sentinel of [
    "TIME_RANGE_FOUNDATION_SENTINEL",
    "LOCATION_FOUNDATION_SENTINEL",
    "SCENE_CHARACTER_FOUNDATION_SENTINEL",
    "VISIBLE_ACTION_FOUNDATION_SENTINEL",
    "EMOTION_NODE_FOUNDATION_SENTINEL",
    "DRAMATIC_FUNCTION_FOUNDATION_SENTINEL",
    "CHARACTER_BIBLE_FOUNDATION_SENTINEL",
    "KEY_PROP_FOUNDATION_SENTINEL"
  ]) {
    assert.match(prompt, new RegExp(sentinel, "u"), `${sentinel} 必须保留在 Foundation 基础事实投影`);
  }

  assert.equal(
    prompt.split(boundarySignature).length - 1,
    1,
    "已签发 fixedCharacterBoundary 在 Foundation prompt 中只能出现一次"
  );
  assert.match(prompt, /visualGuardrails 附加规则（不重复 fixedCharacterBoundary）/u);
  assert.doesNotMatch(prompt, /"sourceSimilarityRules"\s*:/u);
  assert.match(prompt, /原片道具组合、拟声词和配角组合不是本阶段的内容禁词/u);
});

test("direct batch 把完整动作链和内部摄影切换写入一条教程式 videoPrompt", () => {
  const context = directContext();
  const plan = mockAnimationPlan(context);
  const { shotPlan: ignoredShotPlan, ...animationFoundation } = structuredClone(plan);
  animationFoundation.sceneReferencePrompts.forEach((scene, index) => {
    scene.sourceSceneIds = [context.fullStory.sceneScript[index].sceneId];
    scene.relatedShotIds = [];
  });

  const sourceScene = structuredClone(context.fullStory.sceneScript[0]);
  sourceScene.location = "社区维修间";
  sourceScene.visibleAction = "阿岚快步走到维修台前，将录音带放入旧收音机，按下播放键，听到声音后松开紧绷的肩膀";
  sourceScene.shotAndSound = "中景跟随阿岚走近；投入录音带时硬切手部特写；最后切到阿岚放松肩膀的逆光近景";
  sourceScene.shootingNotes = "清晨柔和侧光，录音带与旧收音机跨切换保持同一造型";

  const prompt = animationShotBatchPrompt({
    ...context,
    animationFoundation,
    sourceScenes: [sourceScene],
    shotIdStartIndex: 1
  });

  // 拆镜表述必须是正向产出要求：有几个主要动作目标就产出几个 shot。
  assert.match(prompt, /拆镜依据只有两个：location 变化，或 visibleAction 中人物的主要动作目标变化/u);
  assert.match(prompt, /有几个主要动作目标就必须产出几个 shot/u);
  assert.match(prompt, /把两个以上主要动作目标塞进同一条 shot 属于错误输出/u);
  assert.match(prompt, /唯一正确的做法是增加 shot/u);
  assert.match(prompt, /把多个动作压进 6 秒、加速带过或省略动作都属于错误输出/u);
  // 禁令收敛成封闭的三类，不得再泛化成“默认别拆”。
  assert.match(prompt, /只有以下三类变化不得触发拆镜/u);
  assert.match(prompt, /① 景别、机位、构图、焦段、运镜或转场变化/u);
  assert.match(prompt, /② 同一主要动作目标内部的动作动词或连续阶段/u);
  assert.match(prompt, /③ 同一地点多人同步完成的同一个协作动作/u);
  assert.match(prompt, /除这三类之外，主要动作目标变化必须拆镜/u);
  assert.match(prompt, /同一个目标下的连续阶段（起步→加速→抵达）才合并为一条 shot/u);
  assert.match(prompt, /这些内部摄影段不得生成额外 shot/u);
  assert.match(prompt, /内部摄影变化允许但不强制/u);
  // 每场镜头数下限与全片进度必须出现在提示词里。
  assert.match(prompt, /本批镜头数下限（由各场 timeRange ÷ 6 秒单镜上限得出，硬性要求）：S1 脚本 5 秒 → 至少 1 个 shot/u);
  assert.match(prompt, /这是硬性产出要求而不是建议值/u);
  assert.match(prompt, /全片时长进度：/u);
  assert.match(prompt, /一条自包含、可直接交给 Seedance 2\.0 的中文自然语言提示词/u);
  assert.match(prompt, /视觉风格、物理光线与时段/u);
  assert.match(prompt, /严格依照 visibleAction 的顺序动作链与可见结果/u);
  assert.match(prompt, /内部摄影\/剪辑顺序/u);
  assert.match(prompt, /不得生成尚未绑定的 @图片、@视频或 @音频编号/u);
  assert.match(prompt, /acceptanceCriteria 必须在 1-3 条额度内覆盖主要动作链的完整顺序与可见终点/u);
  assert.match(prompt, /投信后改为拿起水桶给菜地浇水，主要动作目标已变化/u);
  assert.match(prompt, /中景跟随阿岚走近；投入录音带时硬切手部特写；最后切到阿岚放松肩膀的逆光近景/u);
  assert.doesNotMatch(prompt, /多个先后人物动作必须拆成相邻镜头/u);
  assert.doesNotMatch(prompt, /一个连续摄影方案/u);
  assert.doesNotMatch(prompt, /不得把硬切塞进同一 shot/u);
  assert.doesNotMatch(prompt, /cameraMotion 只写这一个镜头的连续摄影机运动/u);

  const oneActionShot = directShot();
  oneActionShot.durationSeconds = 6;
  oneActionShot.videoPrompt = "温暖治愈的2.5D手绘动画质感，社区维修间被清晨柔和侧光照亮。阿岚快步走到维修台前，将录音带放入旧收音机，按下播放键，听到声音后松开肩膀。镜头先以中景跟随，投入录音带时硬切手部特写，最后切到逆光反应近景。动作与摄影切换前后保持阿岚、录音带、旧收音机和光线方向一致，放松肩膀后立即停止。";
  oneActionShot.cameraMotion = "先以中景跟随，投入录音带时硬切手部特写，最后切到逆光反应近景";
  oneActionShot.characterAction = sourceScene.visibleAction;
  oneActionShot.acceptanceCriteria = [
    "阿岚按顺序完成走近、投入录音带、播放和放松肩膀",
    "内部摄影顺序为中景跟随、手部特写、逆光反应近景",
    "阿岚、录音带和旧收音机跨切换保持一致"
  ];
  assert.doesNotThrow(() => ensureAnimationShotBatchContract(
    { shotPlan: [oneActionShot] },
    { promptSchemaVersion: ANIMATION_DIRECT_PROMPT_SCHEMA_VERSION }
  ));
});

test("v3 batch 只接受精确 direct 字段并拒绝端点字段或非空 image negatives", () => {
  const batch = { shotPlan: [directShot()] };
  assert.equal(
    ensureAnimationShotBatchContract(batch, {
      promptSchemaVersion: ANIMATION_DIRECT_PROMPT_SCHEMA_VERSION
    }),
    batch
  );
  assert.deepEqual(Object.keys(batch.shotPlan[0]).sort(), [...DIRECT_SHOT_FIELDS].sort());

  const missingDirectField = structuredClone(batch);
  delete missingDirectField.shotPlan[0].videoPrompt;
  assert.throws(
    () => ensureAnimationShotBatchContract(missingDirectField, {
      promptSchemaVersion: ANIMATION_DIRECT_PROMPT_SCHEMA_VERSION
    }),
    /缺少字段：videoPrompt/u
  );

  const forbiddenValues = {
    startFrame: {},
    endFrame: {},
    motion: {},
    startFramePrompt: "旧首帧别名",
    endFramePrompt: "旧尾帧别名"
  };
  for (const [field, value] of Object.entries(forbiddenValues)) {
    const mixed = structuredClone(batch);
    mixed.shotPlan[0][field] = value;
    assert.throws(
      () => ensureAnimationShotBatchContract(mixed, {
        promptSchemaVersion: ANIMATION_DIRECT_PROMPT_SCHEMA_VERSION
      }),
      (error) => error instanceof OutputContractError && error.message.includes(field),
      `direct shot 混入 ${field} 必须失败`
    );
  }

  const imageNegative = structuredClone(batch);
  imageNegative.shotPlan[0].negativePrompts.image.push({
    text: "不要改变阿岚身份",
    appliesTo: "image",
    triggerEvidence: [{
      sourcePath: "creatorProfile.fixedCharacter",
      evidence: "阿岚，社区修理师"
    }],
    reasonCode: "explicit_identity_conflict",
    priority: "high",
    enabled: true
  });
  assert.throws(
    () => ensureAnimationShotBatchContract(imageNegative, {
      promptSchemaVersion: ANIMATION_DIRECT_PROMPT_SCHEMA_VERSION
    }),
    /negativePrompts\.image 在 direct_shot 模式必须为 \[\]/u
  );
});

test("demo direct_shot 返回无端点的 3.0 plan 并标记 compiler disabled", async () => {
  const workflow = new WorkflowService();
  const result = await workflow.createAnimationPlanWithMetadata(directContext(workflow));

  assert.equal(result.animationPlan.promptSchemaVersion, ANIMATION_DIRECT_PROMPT_SCHEMA_VERSION);
  assert.equal(result.animationPlan.productionStrategy.format, "direct_shot_video");
  assert.equal(
    result.animationPlan.productionStrategy.videoPromptProfile.profileId,
    VIDEO_PROMPT_PROFILE_IDS.SEEDANCE_2_0
  );
  assert.ok(result.animationPlan.shotPlan.length > 0);
  for (const shot of result.animationPlan.shotPlan) {
    assert.deepEqual(Object.keys(shot).sort(), [...DIRECT_SHOT_FIELDS].sort());
    for (const field of DISABLED_ENDPOINT_FIELDS) {
      assert.equal(Object.hasOwn(shot, field), false, `${shot.shotId} 不得包含 ${field}`);
    }
  }
  const firstShot = result.animationPlan.shotPlan[0];
  assert.match(firstShot.videoPrompt, /2\.5D 动画/u);
  assert.match(firstShot.videoPrompt, /出发点/u);
  assert.match(firstShot.videoPrompt, /在 4 秒内按上述顺序清楚完成动作/u);
  assert.match(firstShot.videoPrompt, /自然动作声/u);
  assert.match(firstShot.videoPrompt, /内部摄影段与前后镜头均保持/u);
  assert.equal(firstShot.acceptanceCriteria.length, 3);
  assert.match(firstShot.acceptanceCriteria[0], /按顺序完整发生且可见结果清楚/u);
  assert.match(firstShot.acceptanceCriteria[1], /摄影表达/u);

  assert.equal(result.metadata.characterFeatureCompiler.disabled, true);
  assert.equal(result.metadata.staticFrameCompiler.disabled, true);
  assert.deepEqual(result.metadata.staticFrameCompiler.runs, []);
  assert.equal(result.metadata.localPromptCompiler.disabled, true);
});

test("demo 首次选择 MiniMax H3 时明确失败，不能伪造英文 H3 Prompt", async () => {
  const workflow = new WorkflowService();
  const context = {
    ...directContext(workflow),
    videoPromptTarget: { provider: "MiniMax", model: "MiniMax-H3" }
  };
  delete context.videoPromptProfile;

  await assert.rejects(
    () => workflow.createAnimationPlanWithMetadata(context),
    /MiniMax H3 Animation Plan 需要已配置的文本模型.*demo mock 不得伪造/u
  );
});

test("确认切换提示词目标时只重写 videoPrompt 与签发 Profile", async () => {
  let sourcePlan;
  const { workflow, calls } = createPromptRewriteWorkflow(() => sourcePlan);
  const seedanceContext = directContext(workflow);
  sourcePlan = mockAnimationPlan(seedanceContext);
  const comparable = (plan) => {
    const clone = structuredClone(plan);
    delete clone.productionStrategy.videoPromptProfile;
    clone.shotPlan.forEach((shot) => delete shot.videoPrompt);
    return clone;
  };

  const result = await workflow.rewriteAnimationPlanVideoPrompts({
    ...seedanceContext,
    animationPlan: sourcePlan,
    videoPromptTarget: { provider: "MiniMax", model: "MiniMax-H3" }
  });

  assert.deepEqual(comparable(result.animationPlan), comparable(sourcePlan));
  assert.equal(
    result.animationPlan.productionStrategy.videoPromptProfile.profileId,
    VIDEO_PROMPT_PROFILE_IDS.MINIMAX_H3
  );
  assert.deepEqual(
    result.animationPlan.shotPlan.map((shot) => shot.shotId),
    sourcePlan.shotPlan.map((shot) => shot.shotId)
  );
  result.animationPlan.shotPlan.forEach((shot) => {
    assert.doesNotThrow(() => assertMiniMaxH3BasePrompt(shot.videoPrompt, {
      durationSeconds: shot.durationSeconds,
      dialogueTexts: miniMaxH3DialogueTexts(shot.dialogueOrSubtitle)
    }));
  });
  assert.deepEqual(
    result.metadata.videoPromptRewrite.rewrittenShotIds,
    sourcePlan.shotPlan.map((shot) => shot.shotId)
  );
  assert.equal(calls.length, 2);
  assert.match(calls[0].prompt, /只能改写 videoPrompt 的供应商表达/u);
  const rewriteExampleMatch = calls[0].prompt.match(
    /\{"shotId":"A01","videoPrompt":("(?:\\.|[^"\\])*")\}/u
  );
  assert.ok(rewriteExampleMatch, "H3 Profile rewrite 必须提供 videoPrompt JSON 字符串示例");
  assert.deepEqual(
    [...JSON.parse(rewriteExampleMatch[1]).matchAll(
      /^(integrated_multimodal_description|overall_soundscape|non_diegetic_music):/gmu
    )].map((match) => match[1]),
    ["integrated_multimodal_description", "overall_soundscape", "non_diegetic_music"],
    "Profile rewrite 的三个 H3 section 也必须各自行首"
  );
  const rewriteExample = JSON.parse(rewriteExampleMatch[1]);
  assert.match(
    rewriteExample,
    /<d>\[Chinese\] 嗷呜~<\/d>/u,
    "Profile rewrite 的 strict JSON 示例也必须展示逐字中文对白块"
  );
  assert.doesNotThrow(() => assertMiniMaxH3BasePrompt(rewriteExample, {
    durationSeconds: 4,
    dialogueTexts: ["嗷呜~"]
  }));
  assert.match(calls[1].prompt, /ANIMATION_VIDEO_PROMPT_REWRITE_SEMANTIC_AUDIT_V2/u);
  assert.equal(result.metadata.videoPromptRewrite.semanticAudit.verdict, "pass");
});

test("已有 3 秒 Seedance 镜头切换 H3 时明确失败而不静默改成 4 秒", async () => {
  const workflow = new WorkflowService();
  const context = directContext(workflow);
  const sourcePlan = await workflow.createAnimationPlan(context);
  sourcePlan.shotPlan[0].durationSeconds = 3;

  await assert.rejects(
    () => workflow.rewriteAnimationPlanVideoPrompts({
      ...context,
      animationPlan: sourcePlan,
      videoPromptTarget: { provider: "MiniMax", model: "MiniMax-H3" }
    }),
    /MiniMax H3.*4–15 秒整数/u
  );
  assert.equal(sourcePlan.shotPlan[0].durationSeconds, 3);
});

test("提示词改写会使旧 videoPrompt 负面词证据失效时明确失败，不静默删除证据", async () => {
  let sourcePlan;
  const { workflow, calls } = createPromptRewriteWorkflow(() => sourcePlan);
  const context = directContext(workflow);
  sourcePlan = mockAnimationPlan(context);
  const originalPrompt = sourcePlan.shotPlan[0].videoPrompt;
  sourcePlan.shotPlan[0].negativePrompts.video.push({
    text: "避免动作顺序错乱",
    appliesTo: "video",
    triggerEvidence: [{
      sourcePath: `animationPlan.shotPlan[${sourcePlan.shotPlan[0].shotId}].videoPrompt`,
      evidence: originalPrompt.slice(0, Math.min(24, originalPrompt.length))
    }],
    reasonCode: "temporal_consistency_failure",
    priority: "medium",
    enabled: true
  });
  const before = structuredClone(sourcePlan);

  await assert.rejects(
    () => workflow.rewriteAnimationPlanVideoPrompts({
      ...context,
      animationPlan: sourcePlan,
      videoPromptTarget: { provider: "MiniMax", model: "MiniMax-H3" }
    }),
    /不得改变 videoPrompt 与签发 Profile 之外的 Plan 字段/u
  );
  assert.deepEqual(sourcePlan, before);
  assert.equal(sourcePlan.shotPlan[0].negativePrompts.video.length, 1);
  assert.equal(calls.length, 1, "字段不变量失败后不得继续发送独立语义审计请求");
});

test("v3 视频请求不得静默进入 first_last_frame", async () => {
  await assert.rejects(
    () => generateShotVideo({
      animationPromptSchemaVersion: ANIMATION_DIRECT_PROMPT_SCHEMA_VERSION,
      generationMode: "first_last_frame",
      shot: directShot()
    }),
    (error) => error instanceof ShotVideoConfigError
      && /direct_shot.*不能使用 first_last_frame/u.test(error.message)
  );
});

test("逐镜视频请求只接受计划支持的两个画幅", () => {
  assert.equal(normalizeShotVideoAspectRatio("9:16"), "9:16");
  assert.equal(normalizeShotVideoAspectRatio("16:9"), "16:9");
  assert.throws(() => normalizeShotVideoAspectRatio("1:1"), /aspectRatio 只允许 9:16 或 16:9/u);
});

test("direct_shot 六个镜头职责字段都可作为逐镜视频负面词证据", () => {
  const evidenceFields = [
    "videoPrompt",
    "cameraMotion",
    "characterAction",
    "dialogueOrSubtitle",
    "soundDesign",
    "continuityNotes"
  ];
  for (const field of evidenceFields) {
    const shot = directShot();
    shot[field] = `${field}-DIRECT-EVIDENCE`;
    shot.negativePrompts.video = [{
      text: `${field} 对应过程不得跳变`,
      appliesTo: "video",
      triggerEvidence: [{
        sourcePath: `animationPlan.shotPlan[A01].${field}`,
        evidence: shot[field]
      }],
      reasonCode: "temporal_consistency_failure",
      priority: "medium",
      enabled: true
    }];
    const pruned = pruneAnimationPlanNegativePrompts({
      visualBible: {},
      sceneReferencePrompts: [],
      shotPlan: [shot]
    });
    assert.equal(pruned.shotPlan[0].negativePrompts.video.length, 1, `${field} 证据不得被裁剪`);
  }
});


test("每场镜头数下限由 timeRange 确定性推出，不可解析时退回下限 1", () => {
  assert.equal(parseSceneTimeRangeSeconds("00:15-00:33"), 18);
  assert.equal(parseSceneTimeRangeSeconds("01:00-01:20"), 20);
  // 非法或非正跨度一律返回 null，不猜测场次时长。
  assert.equal(parseSceneTimeRangeSeconds("00:20-00:10"), null);
  assert.equal(parseSceneTimeRangeSeconds("时长未知"), null);
  assert.equal(parseSceneTimeRangeSeconds(""), null);

  // 20 秒脚本 ÷ 6 秒单镜上限 → 至少 4 镜；正是旧行为只给 1 镜的那类场次。
  assert.equal(sceneMinimumShotCount({ timeRange: "01:00-01:20" }, 6), 4);
  assert.equal(sceneMinimumShotCount({ timeRange: "00:00-00:15" }, 6), 3);
  assert.equal(sceneMinimumShotCount({ timeRange: "00:00-00:06" }, 6), 1);
  // timeRange 不可解析、上限非法时退回既有契约下限 1，不失败也不推断。
  assert.equal(sceneMinimumShotCount({ timeRange: "乱写" }, 6), 1);
  assert.equal(sceneMinimumShotCount({}, 6), 1);
  assert.equal(sceneMinimumShotCount({ timeRange: "00:00-00:20" }, 0), 1);
});

test("长场次在批次提示词里拿到与 timeRange 匹配的镜头数下限和全片进度", () => {
  const context = directContext();
  const plan = mockAnimationPlan(context);
  const { shotPlan: ignoredShotPlan, ...animationFoundation } = structuredClone(plan);
  animationFoundation.sceneReferencePrompts.forEach((scene, index) => {
    scene.sourceSceneIds = [context.fullStory.sceneScript[index].sceneId];
    scene.relatedShotIds = [];
  });

  const longScene = structuredClone(context.fullStory.sceneScript[0]);
  longScene.timeRange = "01:00-01:20";
  const shortScene = structuredClone(context.fullStory.sceneScript[1]);
  shortScene.timeRange = "00:00-00:06";

  const prompt = animationShotBatchPrompt({
    ...context,
    animationFoundation,
    sourceScenes: [longScene, shortScene],
    shotIdStartIndex: 5,
    runtimeBudget: {
      plannedShotCount: 4,
      plannedSeconds: 21,
      scriptCompletedSeconds: 20,
      batchScriptSeconds: 26,
      scriptTotalSeconds: 60
    }
  });

  assert.match(prompt, /S1 脚本 20 秒 → 至少 4 个 shot/u);
  assert.match(prompt, /S2 脚本 6 秒 → 至少 1 个 shot/u);
  assert.match(prompt, /已产出 4 个 shot · 已用 21 秒 · 前面各场脚本合计 20 秒 · 本批脚本合计 26 秒 · 全片脚本合计 60 秒/u);
});

test("timeRange 不可解析时提示词说明未知，并退回下限 1 不阻断", () => {
  const context = directContext();
  const plan = mockAnimationPlan(context);
  const { shotPlan: ignoredShotPlan, ...animationFoundation } = structuredClone(plan);
  animationFoundation.sceneReferencePrompts.forEach((scene, index) => {
    scene.sourceSceneIds = [context.fullStory.sceneScript[index].sceneId];
    scene.relatedShotIds = [];
  });
  const brokenScene = structuredClone(context.fullStory.sceneScript[0]);
  brokenScene.timeRange = "未知";

  const prompt = animationShotBatchPrompt({
    ...context,
    animationFoundation,
    sourceScenes: [brokenScene],
    shotIdStartIndex: 1
  });

  assert.match(prompt, /S1 timeRange 不可解析 → 至少 1 个 shot/u);
  assert.match(prompt, /全片时长进度：未提供/u);
});


function foundationFor(context, { backgroundMusicMode = "none" } = {}) {
  const plan = mockAnimationPlan(context);
  const { shotPlan: ignoredShotPlan, ...foundation } = structuredClone(plan);
  foundation.sceneReferencePrompts.forEach((scene, index) => {
    scene.sourceSceneIds = [context.fullStory.sceneScript[index].sceneId];
    scene.relatedShotIds = [];
  });
  foundation.productionStrategy.backgroundMusicMode = backgroundMusicMode;
  return foundation;
}

test("背景音乐开关缺省关闭，只接受布尔值或两个合法字面量", () => {
  assert.equal(normalizeBackgroundMusicMode(undefined), "none");
  assert.equal(normalizeBackgroundMusicMode(null), "none");
  assert.equal(normalizeBackgroundMusicMode(false), "none");
  assert.equal(normalizeBackgroundMusicMode(true), "allowed");
  assert.equal(normalizeBackgroundMusicMode("none"), "none");
  assert.equal(normalizeBackgroundMusicMode("allowed"), "allowed");
  assert.throws(() => normalizeBackgroundMusicMode("off"), InputError);
  assert.throws(() => normalizeBackgroundMusicMode(1), InputError);
});

test("关闭背景音乐时 Seedance 批次提示词要求逐字收尾句，开启时不要求", () => {
  const context = directContext();
  const closedPrompt = animationShotBatchPrompt({
    ...context,
    animationFoundation: foundationFor(context, { backgroundMusicMode: "none" }),
    sourceScenes: context.fullStory.sceneScript.slice(0, 1),
    shotIdStartIndex: 1
  });
  assert.match(closedPrompt, /背景音乐：关闭，本片不使用任何背景音乐/u);
  assert.ok(closedPrompt.includes(NO_BACKGROUND_MUSIC_SENTENCE));
  assert.match(closedPrompt, /必须以这句话逐字收尾/u);
  assert.match(closedPrompt, /关闭的只是背景音乐，脚步、风声、器物声和对白都必须照常保留/u);

  const openPrompt = animationShotBatchPrompt({
    ...context,
    animationFoundation: foundationFor(context, { backgroundMusicMode: "allowed" }),
    sourceScenes: context.fullStory.sceneScript.slice(0, 1),
    shotIdStartIndex: 1
  });
  assert.match(openPrompt, /背景音乐：开启，允许使用背景音乐/u);
  assert.equal(openPrompt.includes(NO_BACKGROUND_MUSIC_SENTENCE), false);
});

test("关闭背景音乐时 H3 批次提示词要求 non_diegetic_music 逐字写 N/A", () => {
  const context = {
    ...directContext(),
    videoPromptTarget: { provider: "MiniMax", model: "MiniMax-H3" }
  };
  const foundation = foundationFor(context, { backgroundMusicMode: "none" });
  foundation.productionStrategy.videoPromptProfile = resolveVideoPromptProfile(context.videoPromptTarget);
  const prompt = animationShotBatchPrompt({
    ...context,
    videoPromptProfile: foundation.productionStrategy.videoPromptProfile,
    animationFoundation: foundation,
    sourceScenes: context.fullStory.sceneScript.slice(0, 1),
    shotIdStartIndex: 1
  });

  assert.match(prompt, /背景音乐：关闭，本片不使用任何背景音乐/u);
  assert.ok(prompt.includes(`non_diegetic_music 必须逐字只写 ${MINIMAX_H3_NO_MUSIC_SECTION}`));
  assert.match(prompt, /overall_soundscape 照常写环境声、物理动作声与非语言人声——关闭的只是配乐，不是现场声/u);
  // H3 不走中文追加句，避免踩非 Latin script 屏障。
  assert.equal(prompt.includes(NO_BACKGROUND_MUSIC_SENTENCE), false);
});

test("Foundation 提示词声明用户选择，并声明该字段由服务端签发", () => {
  const context = directContext();
  const closed = animationFoundationPrompt({ ...context, backgroundMusicMode: "none" });
  assert.match(closed, /用户选择的背景音乐：关闭，本片不使用任何背景音乐/u);
  assert.match(closed, /productionStrategy.backgroundMusicMode 都是服务端签发字段，模型不得输出/u);

  const open = animationFoundationPrompt({ ...context, backgroundMusicMode: "allowed" });
  assert.match(open, /用户选择的背景音乐：开启，允许使用背景音乐/u);
});
