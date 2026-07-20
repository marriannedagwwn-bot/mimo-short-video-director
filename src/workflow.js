import { analysisPrompt, animationPlanPrompt, briefPrompt, characterReferenceRefinePrompt, fullStoryPrompt, reconstructionPrompt, variantsPrompt, visualGuardrailsPrompt } from "./prompts.js";
import { mockAnalysis, mockAnimationPlan, mockBrief, mockFullStory, mockReconstruction, mockVariants, mockVisualGuardrails } from "./mock.js";
import { InputError, OutputContractError, ensureAnimationPlanMatchesProfile, ensureCreativeBriefMatchesProfile, ensureFullStoryMatchesProfile, ensureOutputContract, ensureThemeVariantsMatchProfile, ensureVisualGuardrailsMatchesProfile, pruneAnimationPlanNegativePrompts, requireFrames, requireObject, requireText } from "./validation.js";

export class WorkflowService {
  constructor({
    client = null,
    clients = null,
    stageDefaults = null,
    storyClient = null,
    storyModel = "mimo-v2.5-pro",
    storyMaxCompletionTokens = 12288,
    storyProvider = "MiMo",
    animationClient = null,
    animationModel = "mimo-v2.5-pro",
    animationMaxCompletionTokens = 12288,
    animationProvider = "MiMo"
  } = {}) {
    this.clients = normalizeClients(clients);
    if (client && !Object.keys(this.clients).length) this.clients.MiMo = client;
    if (storyClient) this.clients[canonicalProvider(storyProvider)] = storyClient;
    if (animationClient) this.clients[canonicalProvider(animationProvider)] = animationClient;
    this.stageDefaults = normalizeStageDefaults(stageDefaults, {
      provider: client ? "MiMo" : firstClientProvider(this.clients),
      storyProvider,
      storyModel,
      storyMaxCompletionTokens,
      animationProvider,
      animationModel,
      animationMaxCompletionTokens
    });
    this.client = this.resolveStage("analysis").client;
    const storyStage = this.resolveStage("fullStory");
    this.storyClient = storyStage.client;
    this.storyModel = storyStage.model;
    this.storyMaxCompletionTokens = storyStage.maxCompletionTokens;
    this.storyProvider = storyStage.provider;
    const animationStage = this.resolveStage("animationPlan");
    this.animationClient = animationStage.client;
    this.animationModel = animationStage.model;
    this.animationMaxCompletionTokens = animationStage.maxCompletionTokens;
    this.animationProvider = animationStage.provider;
  }

  get mode() {
    return this.hasLiveClient ? "live" : "demo";
  }

  get hasLiveClient() {
    return Object.values(this.clients).some(Boolean);
  }

  resolveStage(stage, input = {}) {
    const defaults = this.stageDefaults[stage] || {};
    const override = stageOverride(input, stage);
    const provider = canonicalProvider(override.provider || defaults.provider);
    let model = String(override.model || defaults.model || "").trim();
    if (requiresMediaModel(stage) && provider === "Qwen" && isKnownQwenTextOnlyModel(model)) {
      const fallbackModel = String(defaults.model || "").trim();
      if (fallbackModel && !isKnownQwenTextOnlyModel(fallbackModel)) model = fallbackModel;
    }
    const maxCompletionTokens = finiteNumber(override.maxCompletionTokens, defaults.maxCompletionTokens);
    return {
      provider,
      model,
      maxCompletionTokens,
      client: provider ? this.clients[provider] || null : null
    };
  }

  async analyze(input) {
    requireObject(input, "请求");
    requireFrames(input.frames);
    const result = !this.hasLiveClient
      ? mockAnalysis(input)
      : await this.generateStageJson("analysis", input, {
        prompt: analysisPrompt(input),
        frames: input.frames,
        video: input.video,
        validate: (value) => ensureOutputContract(value, "referenceAnalysis")
      });
    return ensureOutputContract(result, "referenceAnalysis");
  }

  async reconstruct(input) {
    requireObject(input, "请求");
    requireFrames(input.frames);
    requireObject(input.referenceAnalysis, "referenceAnalysis");
    const result = !this.hasLiveClient
      ? mockReconstruction(input)
      : await this.generateStageJson("reconstruction", input, {
        prompt: reconstructionPrompt(input),
        frames: input.frames,
        video: input.video,
        validate: (value) => ensureOutputContract(value, "sourceScriptReconstruction")
      });
    return ensureOutputContract(result, "sourceScriptReconstruction");
  }

  async createBrief(input) {
    requireObject(input, "请求");
    requireObject(input.referenceAnalysis, "referenceAnalysis");
    requireObject(input.sourceScriptReconstruction, "sourceScriptReconstruction");
    requireObject(input.creatorProfile || {}, "creatorProfile");
    if (!this.hasLiveClient) return ensureCreativeBriefMatchesProfile(ensureOutputContract(mockBrief(input), "creativeBrief"), input.creatorProfile);
    const prompt = briefPrompt(input);
    return this.generateStageJson("brief", input, {
      prompt,
      validate: (result) => ensureCreativeBriefMatchesProfile(ensureOutputContract(result, "creativeBrief"), input.creatorProfile)
    });
  }

  async createVariants(input) {
    requireObject(input, "请求");
    requireObject(input.creativeBrief, "creativeBrief");
    const profile = requireObject(input.creatorProfile, "creatorProfile");
    requireText(profile.fixedCharacter, "固定角色");
    requireText(profile.vertical, "垂直赛道");
    if (!this.hasLiveClient) return ensureThemeVariantsMatchProfile(ensureOutputContract(mockVariants(input), "themeVariants"), profile, input.creativeBrief, input.visualGuardrails);
    const prompt = variantsPrompt(input);
    return this.generateStageJson("variants", input, {
      prompt,
      validate: (result) => ensureThemeVariantsMatchProfile(ensureOutputContract(result, "themeVariants"), profile, input.creativeBrief, input.visualGuardrails)
    });
  }

  async createVisualGuardrails(input) {
    requireObject(input, "请求");
    requireObject(input.referenceAnalysis, "referenceAnalysis");
    requireObject(input.sourceScriptReconstruction, "sourceScriptReconstruction");
    requireObject(input.creativeBrief, "creativeBrief");
    const profile = requireObject(input.creatorProfile, "creatorProfile");
    requireText(profile.fixedCharacter, "固定角色");
    requireText(profile.vertical, "垂直赛道");
    if (!this.hasLiveClient) return ensureVisualGuardrailsMatchesProfile(ensureOutputContract(mockVisualGuardrails(input), "visualGuardrails"), profile);
    const prompt = visualGuardrailsPrompt(input);
    return this.generateStageJson("visualGuardrails", input, {
      prompt,
      frames: input.frames || [],
      video: input.video || null,
      validate: (result) => ensureVisualGuardrailsMatchesProfile(ensureOutputContract(result, "visualGuardrails"), profile)
    });
  }

  async createFullStory(input) {
    requireObject(input, "请求");
    requireObject(input.creativeBrief, "creativeBrief");
    requireObject(input.variant, "variant");
    const profile = requireObject(input.creatorProfile, "creatorProfile");
    requireText(profile.fixedCharacter, "固定角色");
    requireText(profile.vertical, "垂直赛道");
    const settings = this.resolveStage("fullStory", input);
    if (!this.hasLiveClient) return ensureFullStoryMatchesProfile(ensureOutputContract(mockFullStory(input), "fullStory"), profile, input.creativeBrief, input.variant, input.visualGuardrails);
    this.assertStageClient(settings, "完整剧情");
    const prompt = fullStoryPrompt({ ...input, targetProvider: settings.provider, targetModel: settings.model });
    return this.generateValidatedJson({
      client: settings.client,
      prompt,
      model: settings.model,
      maxCompletionTokens: settings.maxCompletionTokens,
      validate: (result) => ensureFullStoryMatchesProfile(ensureOutputContract(result, "fullStory"), profile, input.creativeBrief, input.variant, input.visualGuardrails)
    });
  }

  async generateStageJson(stage, input, options) {
    const settings = this.resolveStage(stage, input);
    this.assertStageClient(settings, stageLabel(stage));
    return this.generateValidatedJson({
      ...options,
      client: settings.client,
      model: settings.model,
      maxCompletionTokens: settings.maxCompletionTokens
    });
  }

  async generateValidatedJson({ client = this.client, prompt, model = null, maxCompletionTokens = null, frames = [], video = null, validate }) {
    const request = { prompt, model, maxCompletionTokens };
    const first = frames.length || video
      ? await client.generateJsonWithMedia({ ...request, frames, video })
      : await client.generateJson(request);
    try {
      return validate(first);
    } catch (error) {
      if (!(error instanceof OutputContractError)) throw error;
      const retryRequest = {
        prompt: validationRetryPrompt(prompt, error.message),
        model,
        maxCompletionTokens: retryTokenLimit(maxCompletionTokens)
      };
      const second = frames.length || video
        ? await client.generateJsonWithMedia({ ...retryRequest, frames, video })
        : await client.generateJson(retryRequest);
      return validate(second);
    }
  }

  async createAnimationPlan(input) {
    requireObject(input, "请求");
    requireObject(input.creativeBrief, "creativeBrief");
    requireObject(input.variant, "variant");
    requireObject(input.fullStory, "fullStory");
    const profile = requireObject(input.creatorProfile, "creatorProfile");
    requireText(profile.fixedCharacter, "固定角色");
    requireText(profile.vertical, "垂直赛道");
    const settings = this.resolveStage("animationPlan", input);
    if (!this.hasLiveClient) return validateAnimationPlanOutput(mockAnimationPlan(input), input);
    this.assertStageClient(settings, "首尾帧动画生产包");
    const prompt = animationPlanPrompt({ ...input, targetProvider: settings.provider, targetModel: settings.model });
    return this.generateValidatedJson({
      client: settings.client,
      prompt,
      model: settings.model,
      maxCompletionTokens: settings.maxCompletionTokens,
      validate: (result) => validateAnimationPlanOutput(result, input)
    });
  }

  async refineCharacterReference(input) {
    requireObject(input, "请求");
    const characterReference = requireObject(input.characterReference, "characterReference");
    const imageDataUrl = requireText(input.imageDataUrl, "人物参考图", { max: 16 * 1024 * 1024 });
    if (!imageDataUrl.startsWith("data:image/")) throw new InputError("人物参考图必须是图片 data URL");
    const prompt = characterReferenceRefinePrompt(input);
    if (!this.hasLiveClient) {
      return normalizeCharacterReference({
        ...characterReference,
        appearancePrompt: `${characterReference.appearancePrompt || ""} 参考用户上传的人物图，保持人物外观、服装和色彩一致。`,
        referenceImageNotes: "演示模式：已标记为使用人物参考图。"
      }, characterReference, input);
    }
    return this.generateStageJson("characterReference", input, {
      prompt,
      frames: [{ timestamp: 0, dataUrl: imageDataUrl }],
      validate: (result) => normalizeCharacterReference(result, characterReference, input)
    });
  }

  async run(input) {
    const referenceAnalysis = await this.analyze(input);
    const sourceScriptReconstruction = await this.reconstruct({ ...input, referenceAnalysis });
    const creativeBrief = await this.createBrief({ ...input, referenceAnalysis, sourceScriptReconstruction });
    const visualGuardrails = await this.createVisualGuardrails({ ...input, referenceAnalysis, sourceScriptReconstruction, creativeBrief });
    const themeVariants = await this.createVariants({ ...input, creativeBrief, visualGuardrails });
    return { referenceAnalysis, sourceScriptReconstruction, creativeBrief, visualGuardrails, themeVariants };
  }

  assertStageClient(settings, label) {
    if (settings.client) return;
    throw new InputError(`${label} 选择了 ${settings.provider || "未知 provider"}，但该 provider 未配置或不可用。`);
  }
}

function normalizeCharacterReference(result = {}, fallback = {}, input = {}) {
  const value = result.characterReference || result;
  const characterName = String(value.characterName || fallback.characterName || "").trim();
  const appearancePrompt = String(value.appearancePrompt || fallback.appearancePrompt || "").trim();
  if (!characterName) throw new OutputContractError("characterReference 缺少 characterName");
  if (!appearancePrompt) throw new OutputContractError("characterReference 缺少 appearancePrompt");
  return {
    ...fallback,
    characterName,
    storyRole: String(value.storyRole || fallback.storyRole || "").trim(),
    identity: String(value.identity || fallback.identity || "").trim(),
    appearancePrompt,
    consistencyTags: normalizeStringArray(value.consistencyTags, fallback.consistencyTags),
    forbiddenChanges: normalizeStringArray(value.forbiddenChanges, fallback.forbiddenChanges),
    referenceImageAdded: true,
    referenceImageName: String(input.imageName || fallback.referenceImageName || "").trim(),
    referenceImageNotes: String(value.referenceImageNotes || value.imageAnalysis || fallback.referenceImageNotes || "").trim()
  };
}

function normalizeStringArray(value, fallback = []) {
  const source = Array.isArray(value) && value.length ? value : fallback;
  return Array.isArray(source) ? source.map((item) => String(item || "").trim()).filter(Boolean) : [];
}

function validateAnimationPlanOutput(result, input = {}) {
  const structured = ensureOutputContract(result, "animationPlan");
  const pruned = pruneAnimationPlanNegativePrompts(structured, input);
  return ensureAnimationPlanMatchesProfile(
    pruned,
    input.creatorProfile,
    input.creativeBrief,
    input.variant,
    input.visualGuardrails,
    input
  );
}

function normalizeClients(clients = null) {
  if (!clients || typeof clients !== "object") return {};
  return Object.fromEntries(
    Object.entries(clients)
      .map(([provider, client]) => [canonicalProvider(provider), client])
      .filter(([provider, client]) => provider && client)
  );
}

function normalizeStageDefaults(stageDefaults = null, fallback = {}) {
  const provider = fallback.provider || "MiMo";
  const defaults = {
    analysis: { provider, model: "", maxCompletionTokens: null },
    reconstruction: { provider, model: "", maxCompletionTokens: null },
    brief: { provider, model: "", maxCompletionTokens: null },
    visualGuardrails: { provider, model: "", maxCompletionTokens: null },
    variants: { provider, model: "", maxCompletionTokens: null },
    fullStory: { provider: fallback.storyProvider || provider, model: fallback.storyModel || "", maxCompletionTokens: fallback.storyMaxCompletionTokens || null },
    animationPlan: { provider: fallback.animationProvider || fallback.storyProvider || provider, model: fallback.animationModel || fallback.storyModel || "", maxCompletionTokens: fallback.animationMaxCompletionTokens || null },
    characterReference: { provider, model: "", maxCompletionTokens: null }
  };
  const merged = { ...defaults, ...(stageDefaults || {}) };
  return Object.fromEntries(Object.entries(merged).map(([stage, value]) => [stage, normalizeStageSetting(value, defaults[stage] || defaults.analysis)]));
}

function normalizeStageSetting(value = {}, fallback = {}) {
  return {
    provider: canonicalProvider(value.provider || fallback.provider),
    model: String(value.model || fallback.model || "").trim(),
    maxCompletionTokens: finiteNumber(value.maxCompletionTokens, fallback.maxCompletionTokens)
  };
}

function stageOverride(input = {}, stage) {
  const overrides = input.modelOverrides || input.modelSelection || {};
  const value = overrides[stage] || {};
  return value && typeof value === "object" ? value : {};
}

function requiresMediaModel(stage) {
  return ["analysis", "reconstruction", "visualGuardrails", "characterReference"].includes(stage);
}

function isKnownQwenTextOnlyModel(model = "") {
  return /^qwen(?:\d+(?:\.\d+)?)?-max(?:-|$)/iu.test(String(model).trim());
}

function canonicalProvider(provider = "") {
  const value = String(provider || "").trim();
  if (!value) return "";
  if (/qwen|千问|通义/iu.test(value)) return "Qwen";
  if (/mimo|小米/iu.test(value)) return "MiMo";
  return value;
}

function firstClientProvider(clients = {}) {
  return Object.entries(clients).find(([, client]) => Boolean(client))?.[0] || "MiMo";
}

function finiteNumber(value, fallback = null) {
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) return Math.round(number);
  return fallback ?? null;
}

function stageLabel(stage) {
  return ({
    analysis: "参考片分析",
    reconstruction: "原片脚本还原",
    brief: "创意简报",
    visualGuardrails: "角色与表达边界",
    variants: "主题变体",
    fullStory: "完整剧情",
    animationPlan: "首尾帧动画生产包",
    characterReference: "人物参考修正"
  })[stage] || stage;
}

function validationRetryPrompt(originalPrompt, validationError) {
  const animationCorrection = originalPrompt.includes('"negativePrompts"')
    ? `
- 每个 shot 必须输出 negativePrompts.image 和 negativePrompts.video 数组，数组允许为空。
- 每个保留条目必须有当前镜头的具体 triggerEvidence、受支持的 reasonCode、正确的 appliesTo 和 priority；不要复制通用负面词，不要用“未声明/未提及”作为唯一理由。
- dialogueRules 不进入图片/视频负面提示词；sourceSimilarityRules 只有在当前生成确实传入视觉参考时才可按 reference_leak 使用。`
    : "";
  return `${originalPrompt}

上一次输出已经是 JSON，但没有通过系统校验：
${validationError}

请基于同一个任务重新输出一份完整合法 JSON，并修复上述问题。
关键要求：
- 不要更换用户固定角色，不要改名，不要降级为配角。
- 不要复用有明确证据的原片表面表达。
- 正向提示词只能使用固定角色文本已经明确授权的身份与外观；未授权信息保持不写，且不得把“未声明”转换成渲染负面提示词。
- 可以保留送达任务、旅途结构、帮助、天气阻力和仪式化结尾，但必须换成新人物、新任务、新道具、新对白和新画面表达。
- 规则必须保持分类：角色正向边界、原片规避、台词规则和逐镜渲染负面提示词不得混写。${animationCorrection}
- 只输出一个完整 JSON 对象，不要 Markdown，不要解释。`;
}

function retryTokenLimit(value) {
  const current = Number(value || 12288);
  if (!Number.isFinite(current)) return 12288;
  return Math.min(32768, Math.max(12288, Math.ceil(current * 1.25)));
}
