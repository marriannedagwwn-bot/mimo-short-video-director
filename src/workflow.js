import { analysisPrompt, animationPlanPrompt, briefPrompt, fullStoryPrompt, reconstructionPrompt, variantsPrompt } from "./prompts.js";
import { mockAnalysis, mockAnimationPlan, mockBrief, mockFullStory, mockReconstruction, mockVariants } from "./mock.js";
import { OutputContractError, ensureAnimationPlanMatchesProfile, ensureCreativeBriefMatchesProfile, ensureFullStoryMatchesProfile, ensureOutputContract, ensureThemeVariantsMatchProfile, requireFrames, requireObject, requireText } from "./validation.js";

export class WorkflowService {
  constructor({
    client = null,
    storyModel = "mimo-v2.5-pro",
    storyMaxCompletionTokens = 12288,
    animationModel = "mimo-v2.5-pro",
    animationMaxCompletionTokens = 12288
  } = {}) {
    this.client = client;
    this.storyModel = storyModel;
    this.storyMaxCompletionTokens = storyMaxCompletionTokens;
    this.animationModel = animationModel;
    this.animationMaxCompletionTokens = animationMaxCompletionTokens;
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
    if (!this.client) return ensureThemeVariantsMatchProfile(ensureOutputContract(mockVariants(input), "themeVariants"), profile, input.creativeBrief);
    const prompt = variantsPrompt(input);
    return this.generateValidatedJson({
      prompt,
      validate: (result) => ensureThemeVariantsMatchProfile(ensureOutputContract(result, "themeVariants"), profile, input.creativeBrief)
    });
  }

  async createFullStory(input) {
    requireObject(input, "请求");
    requireObject(input.creativeBrief, "creativeBrief");
    requireObject(input.variant, "variant");
    const profile = requireObject(input.creatorProfile, "creatorProfile");
    requireText(profile.fixedCharacter, "固定角色");
    requireText(profile.vertical, "垂直赛道");
    if (!this.client) return ensureFullStoryMatchesProfile(ensureOutputContract(mockFullStory(input), "fullStory"), profile, input.creativeBrief, input.variant);
    const prompt = fullStoryPrompt(input);
    return this.generateValidatedJson({
      prompt,
      model: this.storyModel,
      maxCompletionTokens: this.storyMaxCompletionTokens,
      validate: (result) => ensureFullStoryMatchesProfile(ensureOutputContract(result, "fullStory"), profile, input.creativeBrief, input.variant)
    });
  }

  async generateValidatedJson({ prompt, model = null, maxCompletionTokens = null, validate }) {
    const first = await this.client.generateJson({
      prompt,
      model,
      maxCompletionTokens
    });
    try {
      return validate(first);
    } catch (error) {
      if (!(error instanceof OutputContractError)) throw error;
      const second = await this.client.generateJson({
        prompt: validationRetryPrompt(prompt, error.message),
        model,
        maxCompletionTokens: retryTokenLimit(maxCompletionTokens)
      });
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
    if (!this.client) return ensureAnimationPlanMatchesProfile(ensureOutputContract(mockAnimationPlan(input), "animationPlan"), profile, input.creativeBrief, input.variant);
    const prompt = animationPlanPrompt(input);
    return this.generateValidatedJson({
      prompt,
      model: this.animationModel,
      maxCompletionTokens: this.animationMaxCompletionTokens,
      validate: (result) => ensureAnimationPlanMatchesProfile(ensureOutputContract(result, "animationPlan"), profile, input.creativeBrief, input.variant)
    });
  }

  async run(input) {
    const referenceAnalysis = await this.analyze(input);
    const sourceScriptReconstruction = await this.reconstruct({ ...input, referenceAnalysis });
    const creativeBrief = await this.createBrief({ ...input, referenceAnalysis, sourceScriptReconstruction });
    const themeVariants = await this.createVariants({ ...input, creativeBrief });
    return { referenceAnalysis, sourceScriptReconstruction, creativeBrief, themeVariants };
  }
}

function validationRetryPrompt(originalPrompt, validationError) {
  return `${originalPrompt}

上一次输出已经是 JSON，但没有通过系统校验：
${validationError}

请基于同一个任务重新输出一份完整合法 JSON，并修复上述问题。
关键要求：
- 不要更换用户固定角色，不要改名，不要降级为配角。
- 不要复用被禁止的原片表面表达，例如企鹅、企鹅服、企鹅快递员、翅膀、尾巴、爪子、脚蹼、动物身份或玩偶外壳。
- 如果固定角色设定含“狼耳少女”，只能保留用户给定的狼耳少女身份；不要额外添加尾巴、爪子、动物化身体动作。
- 可以保留送达任务、旅途结构、帮助、天气阻力和仪式化结尾，但必须换成新人物、新任务、新道具、新对白和新画面表达。
- 只输出一个完整 JSON 对象，不要 Markdown，不要解释。`;
}

function retryTokenLimit(value) {
  const current = Number(value || 12288);
  if (!Number.isFinite(current)) return 12288;
  return Math.min(32768, Math.max(12288, Math.ceil(current * 1.25)));
}
