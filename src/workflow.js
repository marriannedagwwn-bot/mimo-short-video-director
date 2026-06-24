import { analysisPrompt, briefPrompt, reconstructionPrompt, variantsPrompt } from "./prompts.js";
import { mockAnalysis, mockBrief, mockReconstruction, mockVariants } from "./mock.js";
import { ensureCreativeBriefMatchesProfile, ensureOutputContract, ensureThemeVariantsMatchProfile, requireFrames, requireObject, requireText } from "./validation.js";

export class WorkflowService {
  constructor({ client = null } = {}) {
    this.client = client;
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
    const result = !this.client
      ? mockBrief(input)
      : await this.client.generateJson({ prompt: briefPrompt(input) });
    return ensureCreativeBriefMatchesProfile(ensureOutputContract(result, "creativeBrief"), input.creatorProfile);
  }

  async createVariants(input) {
    requireObject(input, "请求");
    requireObject(input.creativeBrief, "creativeBrief");
    const profile = requireObject(input.creatorProfile, "creatorProfile");
    requireText(profile.fixedCharacter, "固定角色");
    requireText(profile.vertical, "垂直赛道");
    const result = !this.client
      ? mockVariants(input)
      : await this.client.generateJson({ prompt: variantsPrompt(input) });
    return ensureThemeVariantsMatchProfile(ensureOutputContract(result, "themeVariants"), profile, input.creativeBrief);
  }

  async run(input) {
    const referenceAnalysis = await this.analyze(input);
    const sourceScriptReconstruction = await this.reconstruct({ ...input, referenceAnalysis });
    const creativeBrief = await this.createBrief({ ...input, referenceAnalysis, sourceScriptReconstruction });
    const themeVariants = await this.createVariants({ ...input, creativeBrief });
    return { referenceAnalysis, sourceScriptReconstruction, creativeBrief, themeVariants };
  }
}
