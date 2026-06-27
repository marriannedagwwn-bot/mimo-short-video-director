import { analysisPrompt, animationPlanPrompt, briefPrompt, characterReferenceRefinePrompt, fullStoryPrompt, reconstructionPrompt, variantsPrompt, visualGuardrailsPrompt } from "./prompts.js";
import { mockAnalysis, mockAnimationPlan, mockBrief, mockFullStory, mockReconstruction, mockVariants, mockVisualGuardrails } from "./mock.js";
import { InputError, OutputContractError, ensureCreativeBriefMatchesProfile, ensureFullStoryMatchesProfile, ensureOutputContract, ensureThemeVariantsMatchProfile, ensureVisualGuardrailsMatchesProfile, requireFrames, requireObject, requireText } from "./validation.js";

export class WorkflowService {
  constructor({
    client = null,
    storyClient = null,
    storyModel = "mimo-v2.5-pro",
    storyMaxCompletionTokens = 12288,
    storyProvider = "MiMo",
    animationClient = null,
    animationModel = "mimo-v2.5-pro",
    animationMaxCompletionTokens = 12288,
    animationProvider = "MiMo"
  } = {}) {
    this.client = client;
    this.storyClient = storyClient || client;
    this.storyModel = storyModel;
    this.storyMaxCompletionTokens = storyMaxCompletionTokens;
    this.storyProvider = storyProvider;
    this.animationClient = animationClient || storyClient || client;
    this.animationModel = animationModel;
    this.animationMaxCompletionTokens = animationMaxCompletionTokens;
    this.animationProvider = animationProvider;
  }

  get mode() {
    return this.client ? "mimo" : "demo";
  }

  async analyze(input) {
    requireObject(input, "请求");
    requireFrames(input.frames);
    const result = !this.client
      ? mockAnalysis(input)
      : await this.client.generateJsonWithMedia({ prompt: analysisPrompt(input), frames: input.frames, video: input.video });
    return ensureOutputContract(result, "referenceAnalysis");
  }

  async reconstruct(input) {
    requireObject(input, "请求");
    requireFrames(input.frames);
    requireObject(input.referenceAnalysis, "referenceAnalysis");
    const result = !this.client
      ? mockReconstruction(input)
      : await this.client.generateJsonWithMedia({ prompt: reconstructionPrompt(input), frames: input.frames, video: input.video });
    return ensureOutputContract(result, "sourceScriptReconstruction");
  }

  async createBrief(input) {
    requireObject(input, "请求");
    requireObject(input.referenceAnalysis, "referenceAnalysis");
    requireObject(input.sourceScriptReconstruction, "sourceScriptReconstruction");
    requireObject(input.creatorProfile || {}, "creatorProfile");
    if (!this.client) return ensureCreativeBriefMatchesProfile(ensureOutputContract(mockBrief(input), "creativeBrief"), input.creatorProfile);
    const prompt = briefPrompt(input);
    return this.generateValidatedJson({
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
    if (!this.client) return ensureThemeVariantsMatchProfile(ensureOutputContract(mockVariants(input), "themeVariants"), profile, input.creativeBrief, input.visualGuardrails);
    const prompt = variantsPrompt(input);
    return this.generateValidatedJson({
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
    if (!this.client) return ensureVisualGuardrailsMatchesProfile(ensureOutputContract(mockVisualGuardrails(input), "visualGuardrails"), profile);
    const prompt = visualGuardrailsPrompt(input);
    return this.generateValidatedJson({
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
    const client = this.storyClient || this.client;
    if (!client) return ensureFullStoryMatchesProfile(ensureOutputContract(mockFullStory(input), "fullStory"), profile, input.creativeBrief, input.variant, input.visualGuardrails);
    const prompt = fullStoryPrompt({ ...input, targetProvider: this.storyProvider, targetModel: this.storyModel });
    return this.generateValidatedJson({
      client,
      prompt,
      model: this.storyModel,
      maxCompletionTokens: this.storyMaxCompletionTokens,
      validate: (result) => ensureFullStoryMatchesProfile(ensureOutputContract(result, "fullStory"), profile, input.creativeBrief, input.variant, input.visualGuardrails)
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
    const client = this.animationClient || this.storyClient || this.client;
    if (!client) return ensureAnimationPlanContract(ensureOutputContract(mockAnimationPlan(input), "animationPlan"), input.variant);
    const prompt = animationPlanPrompt({ ...input, targetProvider: this.animationProvider, targetModel: this.animationModel });
    return this.generateValidatedJson({
      client,
      prompt,
      model: this.animationModel,
      maxCompletionTokens: this.animationMaxCompletionTokens,
      validate: (result) => ensureAnimationPlanContract(ensureOutputContract(result, "animationPlan"), input.variant)
    });
  }

  async refineCharacterReference(input) {
    requireObject(input, "请求");
    const characterReference = requireObject(input.characterReference, "characterReference");
    const imageDataUrl = requireText(input.imageDataUrl, "人物参考图", { max: 16 * 1024 * 1024 });
    if (!imageDataUrl.startsWith("data:image/")) throw new InputError("人物参考图必须是图片 data URL");
    const prompt = characterReferenceRefinePrompt(input);
    if (!this.client) {
      return normalizeCharacterReference({
        ...characterReference,
        appearancePrompt: `${characterReference.appearancePrompt || ""} 参考用户上传的人物图，保持人物外观、服装和色彩一致。`,
        referenceImageNotes: "演示模式：已标记为使用人物参考图。"
      }, characterReference, input);
    }
    return this.generateValidatedJson({
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

function ensureAnimationPlanContract(value, variant = null) {
  if (variant?.id && String(value.selectedVariantId || "") !== String(variant.id)) {
    throw new OutputContractError(`animationPlan.selectedVariantId 必须等于选中的主题变体 ${variant.id}`);
  }
  return value;
}

function validationRetryPrompt(originalPrompt, validationError) {
  return `${originalPrompt}

上一次输出已经是 JSON，但没有通过系统校验：
${validationError}

请基于同一个任务重新输出一份完整合法 JSON，并修复上述问题。
关键要求：
- 不要更换用户固定角色，不要改名，不要降级为配角。
- 不要复用被禁止的原片表面表达，例如企鹅、企鹅服、企鹅快递员、动物身份或玩偶外壳。
- 只能使用固定角色文本里已经明确写出的身体/外观特征；如果只写“狼耳/猫耳/兽耳”，不要自动补尾巴、爪子、肉垫、翅膀、脚蹼等身体特征。若原始任务已经明确允许某个特征（例如固定角色写了“有狼尾巴”），重试时必须保留该允许特征。
- 可以保留送达任务、旅途结构、帮助、天气阻力和仪式化结尾，但必须换成新人物、新任务、新道具、新对白和新画面表达。
- 只输出一个完整 JSON 对象，不要 Markdown，不要解释。`;
}

function retryTokenLimit(value) {
  const current = Number(value || 12288);
  if (!Number.isFinite(current)) return 12288;
  return Math.min(32768, Math.max(12288, Math.ceil(current * 1.25)));
}
