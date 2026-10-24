import { hasFullStoryCharacterRegistry } from "../public/full-story-format.js";
import { STORYBOARD_PLAN_VERSION, SHOT_VIDEO_PROMPT_VERSION, storyboardShotCharacterNames } from "../public/storyboard-plan.js";
import { storyDurationWindow } from "../public/story-duration.js";
import { currentDurableTaskContext, durableTaskHeartbeat } from "./durable-task-context.js";
import { fullStoryCharacterFacts } from "./full-story-contract.js";
import { storyCharacterNames, fullStoryCharacterRegistryInput, mergeFullStoryCharacterRegistry, mockFullStoryCharacterRegistry } from "./full-story-character-registry.js";
import { fullStoryCharacterRegistryPrompt } from "./full-story-character-registry-prompt.js";
import { STORYBOARD_LOCKED_DIALOGUE_KEPT_CONTENT, storyboardPrompt, storyboardPromptWithLockedDialogue, storyboardRetryPrompt, storyboardReviewRetryPrompt, storyboardSystem, shotPrompt, shotPromptRetryPrompt } from "./storyboard-prompts.js";
import { STORY_MODE_FULL_TEXT } from "../public/story-entry.js";
import { ModelPipelineError } from "./model-errors.js";
import { storyboardReviewPrompt, validateStoryboardReview } from "./storyboard-review.js";
import { storyboardRevisionPrompt } from "./storyboard-revision-prompt.js";
import { applyEditorial, revisionSystem } from "./storyboard-editorial.js";
import { ensureStoryboardDesign, ensureStoryboardPlan, storyboardDesignFromPlan } from "./storyboard-contract.js";
import { STORYBOARD_DESIGN_MODEL_SCHEMA_NAME, storyboardDesignModelSchema } from "./contracts/storyboard-design-model-schema.js";
import { storyboardReviewClaudeResponseSchema } from "./contracts/storyboard-review-claude-schema.js";
import { InputError, OutputContractError, ensureOutputContract, ensureFullStoryMatchesProfile, ensureCharacterReferenceMatchesBoundary,
  characterReferenceRestorableMissingTraits,
  normalizeBackgroundMusicMode, requireAnimationPlanAspectRatio, NO_BACKGROUND_MUSIC_SENTENCE } from "./validation.js";
import { normalizeCharacterArtStyle } from "../public/character-art-style.js";
import { isScriptVariant } from "../public/reference-rewrite.js";

const STORYBOARD_DESIGN_RESPONSE_SCHEMA = { name: STORYBOARD_DESIGN_MODEL_SCHEMA_NAME, schema: storyboardDesignModelSchema() };
// 审阅与终审复查共用：只有 Claude 客户端读 claudeResponseSchema，另外三家按参数名解构、不认识就忽略，
// 所以 MiMo 的审阅请求体逐字不变（2026-10-21）。重试话术也换成审阅自己的。
const STORYBOARD_REVIEW_CALL_OPTIONS = { claudeResponseSchema: storyboardReviewClaudeResponseSchema(), retryPromptFor: storyboardReviewRetryPrompt };

// storyEntry 只由服务端在剧情入口的 Run 上传入，用来按剧情入口的摘要验角色边界；
// projected 不因它多出任何键（整份 projected 会原样序列化进分镜提示词）。
export async function storyboardInput(workflow, input, telemetry = null, onStep = null, { storyEntry = null } = {}) {
  const visualGuardrails = workflow.assertGlobalCharacterBoundary(input, { storyEntry });
  const fullStory = ensureFullStoryMatchesProfile(ensureOutputContract(input.fullStory, "fullStory"), input.creatorProfile, input.creativeBrief, input.variant, visualGuardrails);
  let characterRegistry = fullStory.characterBible;
  if (!hasFullStoryCharacterRegistry(fullStory)) {
    // Old stories stay byte-for-byte unchanged. Only extract the missing cast
    // facts for this new Plan; never call Full Story generation or re-sign it.
    const registryInput = fullStoryCharacterRegistryInput(fullStory, input.creatorProfile);
    const settings = workflow.resolveStage("animationPlan", input);
    let response;
    if (workflow.hasLiveClient) {
      workflow.assertStageClient(settings, "分镜角色事实整理");
      response = await call(workflow, settings, "storyboardCharacterFacts", fullStoryCharacterRegistryPrompt(registryInput), value => {
        mergeFullStoryCharacterRegistry(fullStory, value, registryInput);
        return value;
      }, { telemetry, onStep });
    } else response = mockFullStoryCharacterRegistry(registryInput);
    characterRegistry = mergeFullStoryCharacterRegistry(fullStory, response, registryInput).characterBible;
  }
  const projected = {
    fullStory: structuredClone(fullStory), characterRegistry: structuredClone(characterRegistry), characterSettings: fullStoryCharacterFacts(visualGuardrails),
    targetDurationSeconds: fullStory.targetDurationSeconds, durationWindow: storyDurationWindow(fullStory.targetDurationSeconds),
    targetAspectRatio: requireAnimationPlanAspectRatio(input.targetAspectRatio || "16:9"),
    visualStyle: String(input.creatorProfile?.vertical || ""), characterExpressionRules: String(input.characterExpressionRules || ""),
    backgroundMusicMode: normalizeBackgroundMusicMode(input.backgroundMusicEnabled),
    // 角色画风只在填了时才进提示词参数，不填时整份 projected（和它序列化进的提示词）与之前逐字相同。
    ...(normalizeCharacterArtStyle(input.artStyle) ? { artStyle: normalizeCharacterArtStyle(input.artStyle) } : {})
  };
  if (!projected.durationWindow) throw new InputError("完整剧情时长不能作为新版分镜目标");
  return { projected, visualGuardrails };
}

// 允许第一次做错：预算固定 2 次 provider 调用，第二次仍被拦即 fail closed。**禁止第三次。**
// 依据是 AGENTS.md §2.12b ⑦ 与 docs/animation-plan-review-落地方案.md §4 的实测定论：
// 事前在提示词里定规矩没用（三次加码都没用），事后拿诊断打回去重做有用。
// 传输中断同样吃这 2 次预算——实测失败率约三分之一，其中一类是几秒就断、一个 token 都没烧。
const STORYBOARD_PROVIDER_CALL_BUDGET = 2;

// 走 coordinator 就拿不到 generateValidatedJson 那条路自带的 recorder：它挂在
// client.generateJson 的 onCompletion 上，而 coordinator 走 requestCompletion。
// 漏接的后果是**静默不写**，两次调用的原文全部丢失。scope 取值必须逐字等于 stage 名——
// writer map 按 scope 建、按 stage 查，对不上同样静默不写（AGENTS.md §三 侧车一节）。
function stageAttemptRecorder(workflow, stage) {
  const writer = workflow.stageModelOutputLogWriters?.get(stage) || null;
  return writer?.enabled ? (attempt) => writer.recordAttempt(attempt) : null;
}

/**
 * ModelPipelineError 只带最后一次的 diagnostics。两次都被拦时两次诊断都要在，
 * 否则用户只看得到第二次的错、以为第一次是对的。形状照 workflow.js 的
 * candidateReviewPipelineFailure，其余字段逐字照抄。
 */
function storyboardPipelineFailure(error, rejections = []) {
  const diagnostics = (Array.isArray(rejections) ? rejections : []).flatMap((rejection, index) => (
    (Array.isArray(rejection?.details) ? rejection.details : []).map((detail) => ({ ...detail, attempt: index + 1 }))
  ));
  if (!(error instanceof ModelPipelineError) || !diagnostics.length) return error;
  return new ModelPipelineError(error.message, {
    category: error.category, code: error.code, origin: error.origin, httpStatus: error.httpStatus,
    retryable: error.retryable, diagnostics, attempts: error.attempts, cause: error.cause
  });
}

async function call(workflow, settings, stage, prompt, validate, { systemPrompt = storyboardSystem, telemetry = null, responseSchema = null, claudeResponseSchema = null, onStep = null, retryPromptFor = storyboardRetryPrompt } = {}) {
  await onStep?.(stage);
  const rejections = [];
  const record = stageAttemptRecorder(workflow, stage);
  // 实数调用次数由 observer 计数，**不能从「有没有被拦」反推**——传输失败时供应商确实
  // 被调用了两次而没有诊断，少报就等于把花掉的钱藏起来。
  let providerCalls = 0;
  try {
    return await workflow.modelCallCoordinator.runJson({
      client: settings.client, provider: settings.provider, stage,
      request: { prompt, systemPrompt, model: settings.model, maxCompletionTokens: settings.maxCompletionTokens, requestTimeoutMs: settings.requestTimeoutMs,
        ...(responseSchema ? { responseSchema } : {}), ...(claudeResponseSchema ? { claudeResponseSchema } : {}) },
      maxProviderCalls: STORYBOARD_PROVIDER_CALL_BUDGET,
      attemptObserver: async (attempt) => {
        providerCalls += 1;
        if (!record) return;
        try { await record(attempt); } catch { /* 观测是 fail-open 的，绝不改变本次成败或预算 */ }
      },
      retryPrompt: ({ originalPrompt, issue, error }) => {
        // 截断与「被校验拦下」是两种完全不同的失败。截断那一刻没有任何校验诊断，
        // 只认「有没有诊断」的分支会原样重发，第二次照样写超。
        if (String(issue?.code || error?.code || "") === "MODEL_OUTPUT_TRUNCATED") {
          return retryPromptFor({ originalPrompt, truncated: true });
        }
        const last = rejections[rejections.length - 1];
        // 没有结构化诊断时退回原提示词：只说「你错了」不说错在哪，第二次只会重复第一次。
        return last?.details?.length ? retryPromptFor({ originalPrompt, details: last.details }) : originalPrompt;
      },
      validate: (candidate) => {
        try { return validate(candidate); } catch (error) {
          if (error instanceof OutputContractError) {
            rejections.push({ message: error.message, details: Array.isArray(error.details) ? error.details : [] });
          }
          throw error;
        }
      }
    });
  } catch (error) {
    // The coordinator may wrap a provider's post-response conflict. Preserve
    // task lineage semantics by checking the frozen context outside that layer.
    await currentDurableTaskContext()?.assertFrozenContextCurrent();
    throw storyboardPipelineFailure(error, rejections);
  } finally {
    // 服务端拦过一次就必须说出来，成功失败都记。
    if (Array.isArray(telemetry)) {
      telemetry.push({ stage, providerCalls, rejections: rejections.map((row, index) => ({ ...row, attempt: index + 1 })) });
    }
  }
}

export async function createStoryboardPlan(workflow, input, { storyEntry = null } = {}) {
  // 每个阶段的实际调用次数与被拦诊断都记在这里，最后如实进 metadata。
  const calls = [];
  const stepMax = (hasFullStoryCharacterRegistry(input.fullStory) ? 0 : 1) + 4;
  let stepIndex = 0;
  // Heartbeats merge progress under the Run lock. Reset only this step's counts;
  // provider heartbeats retain the stage and all other existing progress fields.
  const onStep = (step) => durableTaskHeartbeat({ step, stepIndex: ++stepIndex, stepMax, streamedChars: 0, reasoningChars: 0 });
  const { projected, visualGuardrails } = await storyboardInput(workflow, input, calls, onStep, { storyEntry });
  // 粘贴完整故事的 Run：Full Story 的台词逐字来自用户原文，分镜设计与修订都不得改动。
  // 参考视频的 Run 选中剧本格式的主题变体时（2026-10-24）同理：台词逐字来自那篇剧本。
  const dialogueLocked = storyEntry?.storySource?.storyMode === STORY_MODE_FULL_TEXT || isScriptVariant(input.variant);
  const settings = workflow.resolveStage("animationPlan", input);
  let design, initialReview = null, finalReview = null, repairs = [], guidance = [];
  if (!workflow.hasLiveClient) {
    design = mockStoryboardDesign(projected);
    guidance = ["演示模式：未进行真实 AI 分镜审查或修订。"];
  } else {
    workflow.assertStageClient(settings, "自主分镜");
    design = await call(workflow, settings, "storyboardDesign", (dialogueLocked ? storyboardPromptWithLockedDialogue : storyboardPrompt)(projected), value => ensureStoryboardDesign(value, projected), { telemetry: calls, responseSchema: STORYBOARD_DESIGN_RESPONSE_SCHEMA, onStep });
    initialReview = await call(workflow, settings, "storyboardReview", storyboardReviewPrompt({ input: projected, plan: design }), value => validateStoryboardReview(value, { input: projected, plan: design }), { telemetry: calls, onStep, ...STORYBOARD_REVIEW_CALL_OPTIONS });
    guidance.push(...initialReview.guidance);
    if (initialReview.items.length) {
      const context = { input: projected, plan: design, items: initialReview.items, keptContent: [
        "核心目标、关键选择、主要因果、角色身份关系与结局不变；保留已经成立的观看关系。",
        "不得改变片段时长、beat结构、角色名单、说话人与来源；合理简写只给引导。",
        ...(dialogueLocked ? [STORYBOARD_LOCKED_DIALOGUE_KEPT_CONTENT] : []), ...initialReview.strengths
      ] };
      const merged = await call(workflow, settings, "storyboardRevision", storyboardRevisionPrompt(context), value => {
        const result = applyEditorial(value, context);
        // 诊断带 code + 指针，否则这一档的重试只能原样重发。判据逐字未改。
        if (result.errors.length) throw new OutputContractError(result.errors.join("；"), result.errors.map(reason => ({ code: "STORYBOARD_REVISION_INVALID", path: "/repairs", reason })));
        return result;
      }, { systemPrompt: revisionSystem, telemetry: calls, onStep });
      design = merged.result;
      repairs = merged.rows;
      guidance.push(...repairs.map(row => row.note));
      if (repairs.some(row => row.status === "applied")) {
        finalReview = await call(workflow, settings, "storyboardReviewFinal", storyboardReviewPrompt({ input: projected, plan: design }), value => validateStoryboardReview(value, { input: projected, plan: design }), { telemetry: calls, onStep, ...STORYBOARD_REVIEW_CALL_OPTIONS });
        guidance.push(...finalReview.guidance);
      }
    }
  }
  const bible = projected.characterRegistry;
  const characterReferencePrompts = design.visualDesign.characters.map(row => {
    const primary = row.name === bible.protagonist.name;
    const known = primary ? bible.protagonist : bible.supportingCharacters.find(item => item.name === row.name);
    return { characterName: row.name, storyRole: primary ? "主角" : known?.storyRole || "", identity: known?.identity || "",
      appearancePrompt: row.appearance, consistencyTags: primary ? [...(known.traits || [])] : [...(known.personalityFacts || [])],
      forbiddenChanges: primary ? projected.characterSettings.forbiddenTraits.map(trait => trait.canonicalName) : [] };
  });
  // 剧情的 characterBible.protagonist.traits 从来没有「必须逐条镜像边界」的契约，所以
  // 直接拿它当 consistencyTags 会丢掉全局必需角色事实——实测《迷路的蒲公英》缺了 identity 类的
  // 「学生或村民身份」，5 次模型调用全部一次通过却在这里硬失败、¥1.37 作废。
  //
  // 与 AGENTS.md §2.8 给 /api/refine-character-reference 定的同一条既有策略：缺哪条就在
  // consistencyTags **尾部按签发顺序**补它的 exact canonicalName，冻结 appearancePrompt，
  // 不用同义词、不重排。判定与扫描共用 characterReferenceRestorableMissingTraits，不另建第二套。
  //
  // **补写只覆盖非 appearance scope**（由该 helper 过滤）：外观必需事实缺失意味着模型真把
  // 长相写错了，补个标签不会让图里长出猫耳，那一档必须继续在下面硬失败。这条不对称是
  // 整个机制不沦为免检后门的唯一原因，由构造保证。
  //
  // 对每一行都调用即可：helper 在 characterName !== boundary.characterName 时恒返回 []，
  // 对配角是 no-op，不需要在这里再判断谁是固定角色。
  const boundaryRestores = [];
  for (const reference of characterReferencePrompts) {
    const restoredTraits = characterReferenceRestorableMissingTraits(reference, visualGuardrails);
    if (!restoredTraits.length) continue;
    reference.consistencyTags = [...reference.consistencyTags, ...restoredTraits];
    boundaryRestores.push({ characterName: reference.characterName, restoredTraits });
  }
  const plan = {
    promptSchemaVersion: STORYBOARD_PLAN_VERSION, selectedVariantId: projected.fullStory.selectedVariantId, title: projected.fullStory.title,
    productionStrategy: { format: "storyboard_video", targetAspectRatio: projected.targetAspectRatio, targetRuntimeSeconds: projected.targetDurationSeconds,
      backgroundMusicMode: projected.backgroundMusicMode, visualStyle: projected.visualStyle, characterExpressionRules: projected.characterExpressionRules,
      // 服务端按请求签发，模型写不到；空串表示这一份分镜没有指定画风。
      artStyle: projected.artStyle || "",
      sourceSceneIds: projected.fullStory.sceneScript.map(scene => scene.sceneId), characterNames: storyCharacterNames(projected.fullStory) },
    ...design, shotPlan: design.shotPlan.map((shot, i) => ({ shotId: `A${String(i + 1).padStart(2, "0")}`, ...shot })),
    characterReferencePrompts, characterRegistry: projected.characterRegistry,
    editorial: { initialReview, repairs, finalReview, guidance: [...guidance, ...((finalReview || initialReview)?.items || []).map(row => row.reportedProblem)] }
  };
  ensureStoryboardPlan(plan, projected);
  for (const reference of characterReferencePrompts) ensureCharacterReferenceMatchesBoundary(reference, visualGuardrails);
  return { animationPlan: plan, metadata: { storyboard: {
    version: STORYBOARD_PLAN_VERSION, provider: settings.provider, model: settings.model,
    // 服务端拦过一次就必须说出来，不能让用户以为模型一次就写对了。
    providerCalls: calls.reduce((total, row) => total + row.providerCalls, 0),
    calls,
    // 服务端改了模型输出同样必须说出来。放 metadata 而不是 Plan 里：§2.8 要求这类提示
    // 只用于展示、不进入 Artifact，而分镜这条路没有「浏览器写回前剥离」那一步——
    // Plan 由服务端一次构造并签发，放 metadata 才是由构造保证干净。
    boundaryRestores
  } } };
}

export function singleShotPromptInput(plan, shotId, target) {
  ensureStoryboardPlan(plan);
  const index = plan.shotPlan.findIndex(shot => shot.shotId === shotId);
  if (index < 0) throw new InputError("镜头不在当前分镜中");
  const design = storyboardDesignFromPlan(plan);
  return {
    shot: design.shotPlan[index], previousShot: index > 0 ? design.shotPlan[index - 1] : null, nextShot: design.shotPlan[index + 1] || null,
    visualDesign: design.visualDesign,
    characterReferences: plan.characterReferencePrompts.map(({ characterName, storyRole, identity, appearancePrompt, consistencyTags, forbiddenChanges }) => ({ characterName, storyRole, identity, appearancePrompt, consistencyTags, forbiddenChanges })),
    targetAspectRatio: plan.productionStrategy.targetAspectRatio, visualStyle: plan.productionStrategy.visualStyle,
    characterExpressionRules: plan.productionStrategy.characterExpressionRules, backgroundMusicMode: plan.productionStrategy.backgroundMusicMode, target,
    // 旧分镜没有画风，单镜提示词的输入与之前逐字相同。
    ...(normalizeCharacterArtStyle(plan.productionStrategy.artStyle) ? { artStyle: normalizeCharacterArtStyle(plan.productionStrategy.artStyle) } : {})
  };
}

// 写稿时写出来的素材编号都是猜的：附哪几张、编号是几，要到生成视频那一刻才由素材清单
// （buildReferenceManifestText）按本次实际附带的素材写定。只认编号写法，不认「图片」「视频」这类普通词。
const SHOT_PROMPT_REFERENCE_TOKEN = /@\s*(?:图片|视频|音频)\s*\d*|参考(?:图|视频|音频)\s*\d+|图片\s*\d+|<\s*(?:Subject|Picture|Video|Audio)\s*\d+\s*>/giu;

// 台词原话、画风、出镜角色名是同一份判据要求逐字写出的分镜内容，不是写稿猜的编号。它们本身含编号写法时
// （用户台词「快看图片 3！」），写进去被判素材编号、不写被判漏写，两条判据互相矛盾、永远过不了。
// 所以扫编号之前先把这类片段遮掉，只查其余文字。只遮本身含编号写法的片段：不含时扫描的文字与原来逐字相同。
// 长的先遮，免得短片段先占掉长片段的一部分；遮成 \u0000（不是空白、不是数字），前后文字拼不出新的编号。
function unboundReferenceTokens(videoPrompt, requiredFragments) {
  const tokenLike = [...new Set(requiredFragments)].filter(fragment => fragment && fragment.match(SHOT_PROMPT_REFERENCE_TOKEN)).sort((a, b) => b.length - a.length);
  const scanned = tokenLike.reduce((text, fragment) => text.replaceAll(fragment, "\u0000"), videoPrompt);
  return [...new Set(scanned.match(SHOT_PROMPT_REFERENCE_TOKEN) || [])];
}

/**
 * 单镜视频提示词的判据，按先后顺序列出全部问题。
 * 生成（createSingleShotPrompt，2026-10-12 起一次报出全部）与一句话修改（2026-10-11）共用这一份，
 * 两边不会各说各话；一句话修改改之前的那道检查只报第一条。2026-10-12 新加的两条
 * （出镜角色名、素材编号）排在原有四条之后，已经不合格的旧提示词报出的第一条诊断不变。
 * value 是 { videoPrompt }；projected 来自 singleShotPromptInput。
 */
export function shotVideoPromptViolations(value, projected) {
  const issue = (code, reason) => ({ code, path: "/videoPrompt", reason });
  if (!value || Object.keys(value).join(",") !== "videoPrompt" || typeof value.videoPrompt !== "string" || !value.videoPrompt.trim()) {
    return [issue("SHOT_PROMPT_STRUCTURE_INVALID", "单镜提示词结构无效：只允许一个非空字符串键 videoPrompt")];
  }
  const issues = [];
  for (const beat of projected.shot.beats) for (const line of beat.dialogue) if (!value.videoPrompt.includes(line.text)) issues.push(issue("SHOT_PROMPT_DIALOGUE_MISSING", `单镜提示词未逐字保留对白：${line.text}`));
  if (projected.backgroundMusicMode === "none" && !value.videoPrompt.endsWith(NO_BACKGROUND_MUSIC_SENTENCE)) issues.push(issue("SHOT_PROMPT_BACKGROUND_MUSIC_SENTENCE", `关闭背景音乐时，单镜提示词必须以这句话逐字收尾：${NO_BACKGROUND_MUSIC_SENTENCE}`));
  // 画风只在分镜签发了它时校验：每个镜头都要逐字写出同一个画风，否则没有角色参考图约束的
  // 空镜和场景会自己挑风格，和角色对不上。
  if (projected.artStyle && !value.videoPrompt.includes(projected.artStyle)) issues.push(issue("SHOT_PROMPT_ART_STYLE_MISSING", `单镜提示词必须逐字写出分镜的画风：${projected.artStyle}`));
  // 出镜角色名必须原样写出：生成视频时按同一组名字挑角色参考图，素材清单再用这个名字把图对到人。
  // 画外说话者不在 characters 里，不要求。名字是分镜里签发的事实，不是关键词表。
  const characterNames = storyboardShotCharacterNames(projected.shot);
  for (const name of characterNames) {
    if (!value.videoPrompt.includes(name)) issues.push(issue("SHOT_PROMPT_CHARACTER_NAME_MISSING", `单镜提示词没有写出出镜角色的登记名「${name}」：生成视频时素材清单按这个名字把角色参考图对应到角色，必须原样写出`));
  }
  const requiredVerbatim = [...projected.shot.beats.flatMap(beat => beat.dialogue.map(line => line.text)), projected.artStyle || "", ...characterNames];
  const tokens = unboundReferenceTokens(value.videoPrompt, requiredVerbatim);
  if (tokens.length) issues.push(issue("SHOT_PROMPT_UNBOUND_REFERENCE_TOKEN", `单镜提示词不能写素材编号：${tokens.join("、")}——附哪些参考素材、编号是几由生成视频时的素材清单决定，角色只用登记名称呼`));
  return issues;
}

// 演示模式的单镜稿：沿用原来的逐 beat 一行（一句话修改的测试夹具依赖其中「固定机位」、每句台词、
// 画风各出现一次），每个 beat 补一句「画面里：……」写出出镜角色名。测试替身会把它当模型回复送回，
// 所以它必须天然过 shotVideoPromptViolations，生成后照样过一遍。
function demoShotVideoPrompt(projected) {
  return (projected.artStyle ? `画风：${projected.artStyle}。\n` : "")
    + projected.shot.beats.map(beat => `${beat.startSeconds}–${beat.endSeconds}秒：${beat.characters.length ? `画面里：${beat.characters.join("、")}。` : ""}${beat.framing} ${beat.camera} ${beat.visibleAction} ${beat.dialogue.map(line => `${line.speaker}：${line.text}`).join("；")} ${beat.soundDesign}`).join("\n")
    + (projected.backgroundMusicMode === "none" ? `\n${NO_BACKGROUND_MUSIC_SENTENCE}` : "");
}

export async function createSingleShotPrompt(workflow, input) {
  const { plan, shotId, planDigest, target } = input;
  const projected = singleShotPromptInput(plan, shotId, target);
  const settings = workflow.resolveStage("animationPlan", input);
  let result;
  if (!workflow.hasLiveClient) {
    result = { videoPrompt: demoShotVideoPrompt(projected) };
    const [demoIssue] = shotVideoPromptViolations(result, projected);
    if (demoIssue) throw new Error(`演示模式的单镜提示词没有通过校验：${demoIssue.reason}`);
  } else {
    workflow.assertStageClient(settings, "单镜视频提示词");
    result = await call(workflow, settings, "shotVideoPrompt", shotPrompt(projected), value => {
      // 一次报出全部问题（2026-10-12 起）：两次调用的预算里，第二次要能把漏写的台词、角色名一并补齐，
      // 只报第一条时第二次可能补了这条又漏那条。判据写在 shotVideoPromptViolations，一句话修改共用。
      const issues = shotVideoPromptViolations(value, projected);
      if (issues.length) throw new OutputContractError(issues.map(entry => entry.reason).join("；"), issues);
      return value;
    }, { retryPromptFor: shotPromptRetryPrompt });
  }
  return { schemaVersion: SHOT_VIDEO_PROMPT_VERSION, shotId, planDigest, target: structuredClone(target), writer: { provider: settings.provider, model: settings.model }, videoPrompt: result.videoPrompt };
}

function mockStoryboardDesign(input) {
  const story = input.fullStory;
  const names = storyCharacterNames(story);
  const count = Math.max(story.sceneScript.length, Math.ceil(input.targetDurationSeconds / 12));
  const lengths = Array.from({ length: count }, (_, i) => Math.floor(input.targetDurationSeconds / count) + (i < input.targetDurationSeconds % count ? 1 : 0));
  return {
    viewingIntent: story.shootingSynopsis,
    visualDesign: {
      characters: names.map(name => ({ name, appearance: name === input.characterRegistry.protagonist.name ? input.characterSettings.canonicalDescription : input.characterRegistry.supportingCharacters.find(row => row.name === name)?.appearanceFacts.join("、") || "", designedDetails: [] })),
      locations: story.sceneScript.map(scene => ({ name: scene.location, sourceSceneIds: [scene.sceneId], layout: scene.location, lighting: "演示场景的自然光" })),
      props: story.keyProps.map(prop => ({ name: prop.prop, appearanceAndSupport: prop.visualUse }))
    }, adaptations: [], blockedIssues: [],
    shotPlan: lengths.map((durationSeconds, i) => {
      const scene = story.sceneScript[Math.min(i, story.sceneScript.length - 1)];
      return { sourceSceneIds: [scene.sceneId], durationSeconds, storyPurpose: scene.dramaticFunction, emotionalTarget: scene.emotionNode,
        transitionIn: { type: i === 0 ? "start" : "cut", description: scene.location },
        beats: [{ startSeconds: 0, endSeconds: durationSeconds, sourceSceneIds: [scene.sceneId], location: scene.location, characters: scene.characters,
          framing: "演示中景", camera: "固定机位", visibleAction: scene.visibleAction,
          dialogue: scene.dialogue.map(line => ({ speaker: line.speaker, text: line.line, source: "onscreen", timing: "本段内自然交流" })), soundDesign: scene.shotAndSound }],
        continuityOut: scene.visibleAction, acceptanceCriteria: ["演示内容，未经过真实模型设计"] };
    })
  };
}
