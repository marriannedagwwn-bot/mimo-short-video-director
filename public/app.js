import { syncShotCharacterReference } from "./character-reference-sync.js";
import { formatStageUsageSuffix, mergeStageUsage } from "./token-usage-format.js";
import { compileShotNegativePrompt } from "./negative-prompts.js";
import { buildShotFrameImagePrompt, compileShotFrameNegativePrompt } from "./shot-frame-prompt.js";
import { buildCharacterReferenceImagePrompt } from "./character-reference-prompt.js";
import {
  buildFrameReferenceManifest,
  canReusePreviousEndFrameAsStart,
  resolveFrameReferenceMode,
  validateFrameReferenceMode,
  shotRelatedCharacterReferences
} from "./shot-reference-images.js";
import { computeDependencyHash, computePromptHash } from "./frame-dependency.js";
import { buildShotFrameMultiImagePrompt } from "./shot-frame-multi-image-prompt.js";
import {
  createApiRequestError,
  renderCompilerFailureDetails
} from "./compiler-observability.js";
import {
  ACTIVE_PRODUCTION_RUN_STORAGE_KEY,
  beginArtifactRequest,
  emptyProductionState,
  finishArtifactRequest,
  isArtifactRequestCurrent,
  lineageDependency,
  planProductionContext,
  productionRequestHeaders,
  productionStateFromRun
} from "./production-lineage-client.js";
import {
  animationPlanRuntimeSummary,
  animationPlanShotDurationRange,
  normalizeAnimationPlanAspectRatio,
} from "./animation-plan-settings.js";
import {
  dropStaleMediaResults,
  previousShotReferenceFrameCount,
  shotFrameResultKey,
  previousShotInPlan,
  selectedShotVideoCandidate,
  SHOT_VIDEO_CONTINUITY_NONE,
  SHOT_VIDEO_CONTINUITY_PREVIOUS_SHOT_FRAMES,
  shotVideoArtifactIdFor,
  shotVideoResultKey
} from "./shot-video-continuity.js";
import {
  resolveImportedVariant,
  resolveRestoredVariantId
} from "./variant-restore.js";
import {
  runtimePromptOverride,
  shouldAppendSeedanceNoTextRule,
  videoPromptProfileLabel,
  videoPromptProfileUiState,
  videoPromptTargetForSetting
} from "./video-prompt-profile-ui.js";

const state = {
  file: null,
  previewUrl: null,
  videoDataUrl: null,
  frames: [],
  metadata: null,
  output: {},
  characterBoundaryProfile: null,
  variantsRegenerating: false,
  selectedVariantId: null,
  fullStories: {},
  animationPlans: {},
  animationPlanMetadata: {},
  animationAspectRatioDrafts: {},
  animationAspectRatioDefault: "16:9",
  backgroundMusicDrafts: {},
  animationPromptRewriting: false,
  shotVideoResults: {},
  shotFrameResults: {},
  characterReferenceStatuses: {},
  production: emptyProductionState(),
  characterImageGeneration: {
    open: false,
    running: false,
    selectedIndex: 0,
    count: 1,
    referenceImageDataUrl: "",
    referenceImageName: "",
    boundaryWarning: "",
    results: []
  },
  shotFrameImageGeneration: {
    open: false,
    running: false,
    shotId: "",
    frameKind: "start",
    count: 4,
    frameReferenceMode: "",
    referenceManifest: null,
    previewRevision: 0
  },
  shotVideoGeneration: {
    open: false,
    running: false,
    shotId: "",
    count: 1,
    validationRevision: 0,
    generationMode: "first_last_frame",
    includePreviousShotFrames: false,
    includeEndpointFrames: true,
    includeCharacterReferences: true,
    referenceAssets: []
  },
  mode: "demo",
  mediaMode: "auto",
  storyModel: "mimo-v2.5-pro",
  animationModel: "mimo-v2.5-pro",
  staticFrameCompilerModel: "",
  storyProvider: "MiMo",
  animationProvider: "MiMo",
  staticFrameCompilerProvider: "",
  analysisProvider: "MiMo",
  analysisModel: "mimo-v2.5",
  modelStages: {},
  stageHealth: {},
  providers: {},
  modelOverrides: {},
  imageModel: "doubao-seedream-5-0-260128",
  imageProvider: "Jimeng",
  imageProviderConfigured: false,
  nativeVideoMaxBytes: 0,
  running: false,
  storyRunning: false,
  animationRunning: false
};

const $ = (selector) => document.querySelector(selector);
const elements = {
  input: $("#videoInput"), dropzone: $("#dropzone"), uploadTitle: $("#uploadTitle"), uploadHint: $("#uploadHint"),
  videoInfo: $("#videoInfo"), preview: $("#videoPreview"), fileName: $("#fileName"), fileMeta: $("#fileMeta"),
  frames: $("#frames"), frameStatus: $("#frameStatus"), replace: $("#replaceVideo"), transcript: $("#transcript"),
  fixedCharacter: $("#fixedCharacter"), vertical: $("#vertical"), constraints: $("#constraints"), variantCount: $("#variantCount"),
  run: $("#runWorkflow"), error: $("#errorMessage"), modelState: $("#modelState"),
  pipelineUsage: $("#pipelineUsage"),
  openModelSettings: $("#openModelSettings"), modelSettingsModal: $("#modelSettingsModal"), closeModelSettings: $("#closeModelSettings"),
  modelStageList: $("#modelStageList"), resetModelSettings: $("#resetModelSettings"), saveModelSettings: $("#saveModelSettings"),
  modelSettingsStatus: $("#modelSettingsStatus"),
  empty: $("#emptyResults"), resultStack: $("#resultStack"), export: $("#exportButton"),
  analysis: $("#analysisResult"), script: $("#scriptResult"), brief: $("#briefResult"), guardrails: $("#guardrailsResult"), variants: $("#variantsResult"),
  mainPage: $("#top"), storyPage: $("#storyPage"), storyModelName: $("#storyModelName"),
  selectedVariantSummary: $("#selectedVariantSummary"), storyStatus: $("#storyStatus"),
  storyGenerate: $("#generateFullStory"), fullStory: $("#fullStoryResult"), backToResults: $("#backToResults"),
  animationGenerate: $("#generateAnimationPlan"), animationStatus: $("#animationStatus"), animationPlan: $("#animationPlanResult"),
  animationAspectRatio: $("#animationAspectRatio"),
  exportStoryPackage: $("#exportStoryPackage"), copyAnimationPack: $("#copyAnimationPack"),
  importStoryPackage: $("#importStoryPackage"), exportStoryTestPackage: $("#exportStoryTestPackage"),
  storyPackageFile: $("#storyPackageFile"), storyPackageStatus: $("#storyPackageStatus"),
  characterImageModal: $("#characterImageModal"), closeCharacterImageModal: $("#closeCharacterImageModal"),
  characterImageRole: $("#characterImageRole"), characterImageCount: $("#characterImageCount"),
  characterImageDrop: $("#characterImageDrop"), characterImageInput: $("#characterImageInput"),
  characterImageDropTitle: $("#characterImageDropTitle"), characterImageDropHint: $("#characterImageDropHint"),
  characterImagePreviewWrap: $("#characterImagePreviewWrap"), characterImagePreview: $("#characterImagePreview"),
  replaceCharacterImage: $("#replaceCharacterImage"), characterImagePromptPreview: $("#characterImagePromptPreview"),
  characterImageStatus: $("#characterImageStatus"), generateCharacterImages: $("#generateCharacterImages"),
  characterImageResults: $("#characterImageResults"),
  shotFrameImageModal: $("#shotFrameImageModal"), closeShotFrameImageModal: $("#closeShotFrameImageModal"),
  shotFrameImageModalTitle: $("#shotFrameImageModalTitle"), shotFrameImageMeta: $("#shotFrameImageMeta"),
  shotFrameReferenceList: $("#shotFrameReferenceList"),
  shotFrameImageKind: $("#shotFrameImageKind"),
  shotFrameImageCount: $("#shotFrameImageCount"),
  shotFrameReferenceModeField: $("#shotFrameReferenceModeField"),
  shotFrameReferenceMode: $("#shotFrameReferenceMode"),
  shotFrameReferenceModeHint: $("#shotFrameReferenceModeHint"),
  shotFrameImagePromptPreview: $("#shotFrameImagePromptPreview"), shotFrameImageStatus: $("#shotFrameImageStatus"),
  confirmGenerateShotFrameImage: $("#confirmGenerateShotFrameImage"), confirmGenerateShotFrameImageLabel: $("#confirmGenerateShotFrameImageLabel"),
  shotFrameImageResults: $("#shotFrameImageResults"),
  shotVideoModal: $("#shotVideoModal"), closeShotVideoModal: $("#closeShotVideoModal"),
  shotVideoEyebrow: $("#shotVideoModal .eyebrow"),
  shotVideoModalTitle: $("#shotVideoModalTitle"), shotVideoMeta: $("#shotVideoMeta"),
  shotVideoReferenceList: $("#shotVideoReferenceList"), shotVideoCount: $("#shotVideoCount"),
  shotVideoGenerationMode: $("#shotVideoGenerationMode"),
  shotVideoAllReferenceControls: $("#shotVideoAllReferenceControls"),
  shotVideoIncludePreviousShotFrames: $("#shotVideoIncludePreviousShotFrames"),
  shotVideoEndpointReferenceToggle: $("#shotVideoEndpointReferenceToggle"),
  shotVideoIncludeEndpointFrames: $("#shotVideoIncludeEndpointFrames"),
  shotVideoIncludeCharacterReferences: $("#shotVideoIncludeCharacterReferences"),
  shotVideoReferenceDrop: $("#shotVideoReferenceDrop"), shotVideoReferenceInput: $("#shotVideoReferenceInput"),
  shotVideoPromptPreview: $("#shotVideoPromptPreview"), shotVideoStatus: $("#shotVideoStatus"),
  confirmGenerateShotVideo: $("#confirmGenerateShotVideo"), shotVideoResults: $("#shotVideoResults"),
  generatedImagePreview: $("#generatedImagePreview"), generatedImagePreviewImage: $("#generatedImagePreviewImage"),
  generatedImagePreviewCaption: $("#generatedImagePreviewCaption"), closeGeneratedImagePreview: $("#closeGeneratedImagePreview")
};

const MODEL_STAGE_DEFS = [
  { key: "analysis", label: "参考片分析", hint: "视频解析、定位、人物、节奏", capability: "视觉模型", capabilityKind: "vision" },
  { key: "reconstruction", label: "脚本还原", hint: "分场、动作、镜头、转折", capability: "视觉模型", capabilityKind: "vision" },
  { key: "brief", label: "创意简报", hint: "保留价值、受控变量", capability: "文本模型", capabilityKind: "text" },
  { key: "visualGuardrails", label: "视觉规则", hint: "角色边界、原片来源记录、台词规则", capability: "视觉模型", capabilityKind: "vision" },
  { key: "variants", label: "主题变体", hint: "新故事方向", capability: "文本模型", capabilityKind: "text" },
  { key: "fullStory", label: "完整剧情", hint: "可拍分场剧本", capability: "文本模型", capabilityKind: "text" },
  { key: "animationPlan", label: "动画生产包", hint: "首尾帧、镜头与视频提示词", capability: "文本模型", capabilityKind: "text" },
  { key: "staticFrameCompiler", label: "静态帧编译器", hint: "叙事语言到静态视觉语言的语义合法化", capability: "文本模型", capabilityKind: "text" },
  { key: "characterReference", label: "人物图修正", hint: "根据上传图片修正角色描述", capability: "视觉模型", capabilityKind: "vision" },
  { key: "imageGeneration", label: "图片生成", hint: "角色参考图、镜头首尾帧图片", capability: "图片生成", capabilityKind: "image", providerLocked: true, optional: true },
  { key: "shotVideo", label: "镜头视频", hint: "首尾帧或全能参考单镜头视频候选", capability: "视频生成", capabilityKind: "video", providers: ["Kling", "Seedance", "MiniMax"], optional: true }
];
const MEDIA_INPUT_MODEL_STAGES = new Set(["analysis", "reconstruction", "visualGuardrails", "characterReference"]);
const SHOT_VIDEO_PROVIDER_LABELS = {
  Kling: "可灵 AI",
  Seedance: "Seedance 2.0",
  MiniMax: "MiniMax H3",
  VideoHTTP: "自定义 HTTP"
};
const SHOT_VIDEO_PROVIDER_EYEBROWS = {
  Kling: "KLING AI",
  Seedance: "SEEDANCE 2.0",
  MiniMax: "MINIMAX H3",
  VideoHTTP: "CUSTOM VIDEO HTTP"
};
const MODEL_OPTION_CATALOG = {
  Qwen: {
    media: ["qwen3.7-plus", "qwen-vl-max-latest", "qwen-vl-plus-latest", "qwen-omni-turbo-latest"],
    text: ["qwen3.7-max", "qwen3.7-plus", "qwen-max-latest", "qwen-plus-latest", "qwen-turbo-latest"]
  },
  MiMo: {
    media: ["mimo-v2.5", "mimo-v2.5-pro"],
    text: ["mimo-v2.5", "mimo-v2.5-pro"]
  },
  DeepSeek: {
    text: ["deepseek-v4-flash", "deepseek-v4-pro"]
  },
  Jimeng: {
    imageGeneration: ["doubao-seedream-5-0-260128", "seedream-5-0-lite-260128"]
  },
  Kling: {
    shotVideo: ["kling-v3", "kling-v2-1"]
  },
  Seedance: {
    shotVideo: [
      "doubao-seedance-2-0-260128",
      "doubao-seedance-2-0-fast-260128",
      "doubao-seedance-2-0-mini-260615"
    ]
  },
  MiniMax: {
    shotVideo: ["MiniMax-H3"]
  },
  VideoHTTP: {
    shotVideo: []
  }
};

init();

async function init() {
  restoreProfile();
  bindEvents();
  validateReady();
  try {
    const health = await fetch("/api/health").then((response) => response.json());
    state.mode = health.mode;
    state.mediaMode = health.mediaMode || "auto";
    state.modelStages = health.modelStages || {};
    state.stageHealth = health.stageHealth || {};
    state.providers = health.providers || {};
    state.modelOverrides = readModelOverrides();
    applyEffectiveModelState();
    state.imageModel = health.imageModel || state.imageModel;
    state.imageProvider = health.imageProvider || state.imageProvider;
    state.imageProviderConfigured = Boolean(health.imageProviderConfigured);
    state.nativeVideoMaxBytes = health.nativeVideoMaxBytes || 0;
    elements.storyModelName.textContent = modelDisplayLabel(state.storyProvider, state.storyModel);
    updateModelActionLabels();
    const connected = health.mode !== "demo" && modelStagesReady();
    elements.modelState.className = `model-state ${connected ? "ready" : health.mode !== "demo" ? "" : "demo"}`;
    elements.modelState.lastElementChild.textContent = connected
      ? modelStateSummary()
      : health.mode !== "demo"
        ? "模型已配置，但部分阶段不可用"
        : "演示模式 · 配置模型后启用真实分析";
    renderModelSettings();
    await restoreActiveProductionRun();
  } catch {
    elements.modelState.lastElementChild.textContent = "服务连接失败";
  }
  renderRoute();
}

function bindEvents() {
  elements.input.addEventListener("change", (event) => event.target.files[0] && handleFile(event.target.files[0]));
  ["dragenter", "dragover"].forEach((name) => elements.dropzone.addEventListener(name, (event) => { event.preventDefault(); elements.dropzone.classList.add("dragging"); }));
  ["dragleave", "drop"].forEach((name) => elements.dropzone.addEventListener(name, (event) => { event.preventDefault(); elements.dropzone.classList.remove("dragging"); }));
  elements.dropzone.addEventListener("drop", (event) => event.dataTransfer.files[0] && handleFile(event.dataTransfer.files[0]));
  elements.replace.addEventListener("click", () => elements.input.click());
  elements.run.addEventListener("click", runWorkflow);
  elements.export.addEventListener("click", exportJson);
  elements.openModelSettings.addEventListener("click", openModelSettings);
  elements.closeModelSettings.addEventListener("click", closeModelSettings);
  elements.modelSettingsModal.addEventListener("click", (event) => {
    if (event.target === elements.modelSettingsModal) closeModelSettings();
  });
  elements.resetModelSettings.addEventListener("click", resetModelSettings);
  elements.saveModelSettings.addEventListener("click", saveModelSettings);
  elements.modelStageList.addEventListener("change", handleModelStageListChange);
  elements.variants.addEventListener("click", (event) => {
    const button = event.target.closest("[data-story-variant]");
    if (button) navigateToStory(button.dataset.storyVariant);
    if (event.target.closest("[data-regenerate-variants]")) regenerateThemeVariants();
  });
  elements.backToResults.addEventListener("click", backToMainResults);
  elements.storyGenerate.addEventListener("click", () => generateFullStory({ force: true }));
  elements.animationGenerate.addEventListener("click", () => generateAnimationPlan({ force: true }));
  elements.animationAspectRatio.addEventListener("change", () => handleDefaultAspectRatioChange(elements.animationAspectRatio.value));
  elements.exportStoryPackage.addEventListener("click", exportCurrentStoryPackage);
  elements.copyAnimationPack.addEventListener("click", copyAnimationProductionPack);
  elements.importStoryPackage.addEventListener("click", () => elements.storyPackageFile.click());
  elements.exportStoryTestPackage.addEventListener("click", exportStoryTestPackage);
  elements.storyPackageFile.addEventListener("change", (event) => {
    const file = event.target.files[0];
    if (file) importStoryTestPackage(file);
    event.target.value = "";
  });
  elements.closeCharacterImageModal.addEventListener("click", closeCharacterImageGenerator);
  elements.characterImageModal.addEventListener("click", (event) => {
    if (event.target === elements.characterImageModal) closeCharacterImageGenerator();
    const previewButton = event.target.closest("[data-preview-generated-reference]");
    if (previewButton) return openGeneratedImagePreview(previewButton.dataset.previewGeneratedReference);
    const useButton = event.target.closest("[data-use-generated-reference]");
    if (useButton) useGeneratedCharacterReference(useButton.dataset.useGeneratedReference);
  });
  elements.variants.addEventListener("change", (event) => {
    const toggle = event.target.closest("[data-background-music]");
    if (toggle) handleBackgroundMusicToggle(toggle.dataset.backgroundMusic, toggle.checked);
  });
  elements.closeShotFrameImageModal.addEventListener("click", closeShotFrameImageGenerator);
  elements.shotFrameImageModal.addEventListener("click", (event) => {
    if (event.target === elements.shotFrameImageModal) closeShotFrameImageGenerator();
    const previewButton = event.target.closest("[data-preview-modal-shot-frame]");
    if (previewButton) return openShotFramePreview(previewButton.dataset.previewModalShotFrame, previewButton.dataset.frameKind, previewButton.dataset.candidateIndex);
    const selectButton = event.target.closest("[data-select-modal-shot-frame]");
    if (selectButton) return useModalShotFrameCandidate(selectButton.dataset.selectModalShotFrame, selectButton.dataset.frameKind, selectButton.dataset.candidateIndex);
  });
  elements.shotFrameImageKind.addEventListener("change", () => {
    elements.confirmGenerateShotFrameImage.disabled = true;
    updateShotFrameImageGeneratorPreview({ resetMode: true });
  });
  elements.shotFrameReferenceMode.addEventListener("change", () => {
    elements.confirmGenerateShotFrameImage.disabled = true;
    updateShotFrameImageGeneratorPreview();
  });
  elements.confirmGenerateShotFrameImage.addEventListener("click", confirmGenerateShotFrameImage);
  elements.closeShotVideoModal.addEventListener("click", closeShotVideoGenerator);
  elements.shotVideoModal.addEventListener("click", (event) => {
    if (event.target === elements.shotVideoModal) closeShotVideoGenerator();
    const useButton = event.target.closest("[data-use-shot-video]");
    if (useButton) return selectShotVideoCandidate(useButton.dataset.useShotVideo, useButton.dataset.candidateIndex);
    const removeButton = event.target.closest("[data-remove-shot-video-reference]");
    if (removeButton) return removeShotVideoReferenceAsset(removeButton.dataset.removeShotVideoReference);
  });
  elements.shotVideoGenerationMode.addEventListener("change", () => {
    state.shotVideoGeneration.generationMode = normalizeShotVideoGenerationMode(elements.shotVideoGenerationMode.value);
    updateShotVideoGeneratorPreview({ preservePrompt: true });
  });
  elements.shotVideoCount.addEventListener("change", () => {
    state.shotVideoGeneration.count = Number(elements.shotVideoCount.value) || 1;
  });
  elements.shotVideoIncludePreviousShotFrames.addEventListener("change", () => {
    state.shotVideoGeneration.includePreviousShotFrames = elements.shotVideoIncludePreviousShotFrames.checked;
    updateShotVideoGeneratorPreview({ preservePrompt: true });
  });
  elements.shotVideoIncludeEndpointFrames.addEventListener("change", () => {
    state.shotVideoGeneration.includeEndpointFrames = elements.shotVideoIncludeEndpointFrames.checked;
    updateShotVideoGeneratorPreview({ preservePrompt: true });
  });
  elements.shotVideoIncludeCharacterReferences.addEventListener("change", () => {
    state.shotVideoGeneration.includeCharacterReferences = elements.shotVideoIncludeCharacterReferences.checked;
    updateShotVideoGeneratorPreview({ preservePrompt: true });
  });
  elements.shotVideoReferenceInput.addEventListener("change", async (event) => {
    const files = [...(event.target.files || [])];
    event.target.value = "";
    if (files.length) await addShotVideoReferenceFiles(files);
  });
  ["dragenter", "dragover"].forEach((name) => elements.shotVideoReferenceDrop.addEventListener(name, (event) => {
    event.preventDefault();
    elements.shotVideoReferenceDrop.classList.add("dragging");
  }));
  ["dragleave", "drop"].forEach((name) => elements.shotVideoReferenceDrop.addEventListener(name, (event) => {
    event.preventDefault();
    elements.shotVideoReferenceDrop.classList.remove("dragging");
  }));
  elements.shotVideoReferenceDrop.addEventListener("drop", async (event) => {
    const files = [...(event.dataTransfer?.files || [])];
    if (files.length) await addShotVideoReferenceFiles(files);
  });
  elements.confirmGenerateShotVideo.addEventListener("click", confirmGenerateShotVideo);
  elements.generatedImagePreview.addEventListener("click", (event) => {
    if (event.target === elements.generatedImagePreview) closeGeneratedImagePreview();
  });
  elements.closeGeneratedImagePreview.addEventListener("click", closeGeneratedImagePreview);
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !elements.generatedImagePreview.classList.contains("hidden")) closeGeneratedImagePreview();
    else if (event.key === "Escape" && !elements.modelSettingsModal.classList.contains("hidden")) closeModelSettings();
    else if (event.key === "Escape" && !elements.shotVideoModal.classList.contains("hidden")) closeShotVideoGenerator();
    else if (event.key === "Escape" && !elements.shotFrameImageModal.classList.contains("hidden")) closeShotFrameImageGenerator();
    else if (event.key === "Escape" && !elements.characterImageModal.classList.contains("hidden")) closeCharacterImageGenerator();
  });
  elements.characterImageRole.addEventListener("change", () => {
    state.characterImageGeneration.selectedIndex = Number(elements.characterImageRole.value) || 0;
    renderCharacterImagePromptPreview();
  });
  elements.characterImageCount.addEventListener("change", () => {
    state.characterImageGeneration.count = Number(elements.characterImageCount.value) || 1;
    renderCharacterImagePromptPreview();
  });
  elements.characterImageInput.addEventListener("change", (event) => {
    const file = event.target.files[0];
    if (file) setCharacterImageReferenceFile(file);
    event.target.value = "";
  });
  elements.replaceCharacterImage.addEventListener("click", () => elements.characterImageInput.click());
  elements.generateCharacterImages.addEventListener("click", generateCharacterReferenceImages);
  ["dragenter", "dragover"].forEach((name) => elements.characterImageDrop.addEventListener(name, (event) => { event.preventDefault(); elements.characterImageDrop.classList.add("dragging"); }));
  ["dragleave", "drop"].forEach((name) => elements.characterImageDrop.addEventListener(name, (event) => { event.preventDefault(); elements.characterImageDrop.classList.remove("dragging"); }));
  elements.characterImageDrop.addEventListener("drop", (event) => {
    const file = [...(event.dataTransfer?.files || [])].find((item) => item.type.startsWith("image/"));
    if (file) setCharacterImageReferenceFile(file);
  });
  elements.animationPlan.addEventListener("click", (event) => {
    const imageGeneratorButton = event.target.closest("[data-open-character-image-generator]");
    if (imageGeneratorButton) return openCharacterImageGenerator();
    const selectFrameButton = event.target.closest("[data-select-shot-frame]");
    if (selectFrameButton) return selectShotFrameCandidate(selectFrameButton.dataset.selectShotFrame, selectFrameButton.dataset.frameKind, selectFrameButton.dataset.candidateIndex);
    const shotFramePreview = event.target.closest("[data-preview-shot-frame]");
    if (shotFramePreview) return openShotFramePreview(shotFramePreview.dataset.previewShotFrame, shotFramePreview.dataset.frameKind, shotFramePreview.dataset.candidateIndex);
    const frameButton = event.target.closest("[data-open-shot-frame-generator]");
    if (frameButton) return openShotFrameImageGenerator(frameButton.dataset.openShotFrameGenerator);
    const reuseFrameButton = event.target.closest("[data-reuse-previous-tail]");
    if (reuseFrameButton) return reusePreviousTailAsStart(reuseFrameButton.dataset.reusePreviousTail);
    const button = event.target.closest("[data-generate-shot-video]");
    if (button) return openShotVideoGenerator(button.dataset.generateShotVideo);
    if (event.target.closest("[data-character-reference-input]")) return;
    const card = event.target.closest("[data-character-reference-card]");
    if (card) return openCharacterReferenceInput(card.dataset.characterReferenceCard);
  });
  elements.animationPlan.addEventListener("keydown", (event) => {
    if (!["Enter", " "].includes(event.key)) return;
    const card = event.target.closest("[data-character-reference-card]");
    if (!card) return;
    event.preventDefault();
    openCharacterReferenceInput(card.dataset.characterReferenceCard);
  });
  elements.animationPlan.addEventListener("change", (event) => {
    const input = event.target.closest("[data-character-reference-input]");
    if (input && input.files[0]) {
      refineCharacterReferenceWithImage(input.dataset.characterReferenceInput, input.files[0]);
      input.value = "";
    }
  });
  elements.animationPlan.addEventListener("dragenter", handleCharacterReferenceDrag);
  elements.animationPlan.addEventListener("dragover", handleCharacterReferenceDrag);
  elements.animationPlan.addEventListener("dragleave", handleCharacterReferenceDragLeave);
  elements.animationPlan.addEventListener("drop", handleCharacterReferenceDrop);
  window.addEventListener("popstate", renderRoute);
  [elements.fixedCharacter, elements.vertical, elements.constraints].forEach((element) => element.addEventListener("input", handleProfileInput));
  elements.transcript.addEventListener("input", () => {
    if (state.characterBoundaryProfile || state.production.runId) invalidateGlobalCharacterBoundary("字幕或台词文本已修改；旧的生产 Run 与全局角色边界已失效，请重新运行工作流。");
  });
}

async function handleFile(file) {
  if (!file.type.startsWith("video/")) return showError("请选择视频文件。支持 MP4、MOV、WebM 等浏览器可播放格式。");
  if (state.characterBoundaryProfile || state.production.runId) invalidateGlobalCharacterBoundary("参考视频已替换；旧的生产 Run 与全局角色边界已失效，请重新运行工作流。");
  const media = analysisMediaSettings();
  if (state.mode !== "demo" && media.mediaMode === "video" && file.size > media.nativeVideoMaxBytes) {
    return showError(`当前强制使用原生视频，文件不能超过 ${formatBytes(media.nativeVideoMaxBytes)}。请压缩视频或改用 auto 模式。`);
  }
  showError("");
  state.file = file;
  state.frames = [];
  state.videoDataUrl = null;
  elements.dropzone.classList.add("hidden");
  elements.videoInfo.classList.remove("hidden");
  elements.fileName.textContent = file.name;
  elements.fileMeta.textContent = `${formatBytes(file.size)} · 正在读取视频`;
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = URL.createObjectURL(file);
  elements.preview.src = state.previewUrl;
  elements.frames.innerHTML = skeletonFrames(10);
  elements.frameStatus.textContent = "正在抽取关键帧…";
  elements.run.disabled = true;
  try {
    const shouldReadNativeVideo = state.mode !== "demo"
      && media.mediaMode !== "frames"
      && file.size <= media.nativeVideoMaxBytes;
    const [sampled, videoDataUrl] = await Promise.all([
      sampleVideo(file, 10),
      shouldReadNativeVideo ? readFileAsDataUrl(file) : Promise.resolve(null)
    ]);
    state.frames = sampled.frames;
    state.videoDataUrl = videoDataUrl;
    state.metadata = sampled.metadata;
    elements.fileMeta.textContent = `${formatBytes(file.size)} · ${formatTime(sampled.metadata.duration)} · ${sampled.metadata.width}×${sampled.metadata.height}`;
    elements.frames.innerHTML = sampled.frames.map((frame, index) => `<div class="frame"><img src="${frame.dataUrl}" alt="采样画面 ${index + 1}"><span>F${index + 1} · ${formatTime(frame.timestamp)}</span></div>`).join("");
    const mediaNote = videoDataUrl
      ? "原生视频已就绪"
      : state.mode !== "demo" && media.mediaMode !== "frames" && file.size > media.nativeVideoMaxBytes
        ? "视频较大，使用关键帧"
        : "关键帧模式";
    elements.frameStatus.textContent = `已抽取 ${sampled.frames.length} 帧 · ${mediaNote}`;
  } catch (error) {
    state.file = null;
    elements.frameStatus.textContent = "抽帧失败";
    showError(`无法读取视频：${error.message}`);
  }
  validateReady();
}

async function sampleVideo(file, count) {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  video.src = url;
  try {
    await once(video, "loadedmetadata", 20_000);
    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) throw new Error("未识别到有效时长");
    const actualCount = Math.max(6, Math.min(count, Math.ceil(duration / 4)));
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, 720 / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext("2d", { alpha: false });
    const frames = [];
    for (let index = 0; index < actualCount; index += 1) {
      const ratio = actualCount === 1 ? .5 : .03 + (.94 * index / (actualCount - 1));
      const timestamp = Math.min(duration - .02, Math.max(0, duration * ratio));
      video.currentTime = timestamp;
      await once(video, "seeked", 12_000);
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      frames.push({ timestamp: Number(timestamp.toFixed(2)), dataUrl: canvas.toDataURL("image/jpeg", .72) });
    }
    return { frames, metadata: { name: file.name, size: file.size, type: file.type, duration, width: video.videoWidth, height: video.videoHeight } };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function once(target, event, timeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`${event} 超时`)); }, timeout);
    const onEvent = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error("浏览器无法解码该视频")); };
    const cleanup = () => { clearTimeout(timer); target.removeEventListener(event, onEvent); target.removeEventListener("error", onError); };
    target.addEventListener(event, onEvent, { once: true });
    target.addEventListener("error", onError, { once: true });
  });
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result), { once: true });
    reader.addEventListener("error", () => reject(new Error("无法读取文件")), { once: true });
    reader.readAsDataURL(file);
  });
}

async function urlToDataUrl(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`无法读取生成图片（${response.status}）`);
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result), { once: true });
    reader.addEventListener("error", () => reject(new Error("无法读取生成图片")), { once: true });
    reader.readAsDataURL(blob);
  });
}

async function runWorkflow() {
  if (state.running) return;
  const creatorProfile = profile();
  if (state.frames.length < 3 || !creatorProfile.fixedCharacter || !creatorProfile.vertical) return showError("请先上传视频，并填写固定角色和垂直赛道。 ");
  state.running = true;
  beginStageUsage();
  elements.pipelineUsage.textContent = "";
  state.output = {};
  state.characterBoundaryProfile = null;
  state.fullStories = {};
  state.animationPlans = {};
  state.animationPlanMetadata = {};
  state.animationAspectRatioDrafts = {};
  state.shotVideoResults = {};
  state.shotFrameResults = {};
  state.characterReferenceStatuses = {};
  state.production = emptyProductionState();
  localStorage.removeItem(ACTIVE_PRODUCTION_RUN_STORAGE_KEY);
  state.selectedVariantId = null;
  showError("");
  setRunning(true);
  resetPipeline();
  elements.empty.classList.add("hidden");
  elements.resultStack.classList.remove("hidden");
  [elements.analysis, elements.script, elements.brief, elements.guardrails, elements.variants].forEach((element) => { element.innerHTML = ""; element.classList.add("hidden"); });
  const media = analysisMediaSettings();
  const canSendNativeVideo = Boolean(state.videoDataUrl)
    && state.mode !== "demo"
    && media.mediaMode !== "frames"
    && state.file?.size <= media.nativeVideoMaxBytes;
  const shared = {
    frames: state.frames,
    ...(canSendNativeVideo ? { video: { dataUrl: state.videoDataUrl, mimeType: state.file.type, size: state.file.size } } : {}),
    metadata: state.metadata,
    transcript: elements.transcript.value.trim(),
    creatorProfile
  };
  try {
    const productionRun = await api("/api/production/run/start", {
      metadata: {
        sourceVideo: state.metadata,
        creatorProfile,
        transcript: shared.transcript
      }
    });
    state.production = productionStateFromRun(productionRun);
    persistActiveProductionRun();

    setStage("analysis", "active");
    state.output.referenceAnalysis = await requestProductionArtifact({
      endpoint: "/api/analyze",
      requestBody: shared,
      artifactId: "referenceAnalysis",
      artifactType: "referenceAnalysis"
    });
    renderAnalysis(state.output.referenceAnalysis);
    setStage("analysis", "done");

    setStage("script", "active");
    state.output.sourceScriptReconstruction = await requestProductionArtifact({
      endpoint: "/api/reconstruct",
      requestBody: { ...shared, referenceAnalysis: state.output.referenceAnalysis },
      artifactId: "sourceScriptReconstruction",
      artifactType: "sourceScriptReconstruction",
      dependencyIds: ["referenceAnalysis"]
    });
    renderScript(state.output.sourceScriptReconstruction);
    setStage("script", "done");

    setStage("brief", "active");
    state.output.creativeBrief = await requestProductionArtifact({
      endpoint: "/api/brief",
      requestBody: { referenceAnalysis: state.output.referenceAnalysis, sourceScriptReconstruction: state.output.sourceScriptReconstruction, creatorProfile },
      artifactId: "creativeBrief",
      artifactType: "creativeBrief",
      dependencyIds: ["referenceAnalysis", "sourceScriptReconstruction"]
    });
    renderBrief(state.output.creativeBrief);
    setStage("brief", "done");

    setStage("guardrails", "active");
    state.output.visualGuardrails = await requestProductionArtifact({
      endpoint: "/api/visual-guardrails",
      requestBody: {
        ...shared,
        referenceAnalysis: state.output.referenceAnalysis,
        sourceScriptReconstruction: state.output.sourceScriptReconstruction,
        creativeBrief: state.output.creativeBrief
      },
      artifactId: "visualGuardrails",
      artifactType: "visualGuardrails",
      dependencyIds: ["referenceAnalysis", "sourceScriptReconstruction", "creativeBrief"]
    });
    state.characterBoundaryProfile = { ...creatorProfile };
    renderVisualGuardrails(state.output.visualGuardrails);
    setStage("guardrails", "done");

    setStage("variants", "active");
    state.output.themeVariants = await requestProductionArtifact({
      endpoint: "/api/variants",
      requestBody: {
        referenceAnalysis: state.output.referenceAnalysis,
        sourceScriptReconstruction: state.output.sourceScriptReconstruction,
        creativeBrief: state.output.creativeBrief,
        visualGuardrails: state.output.visualGuardrails,
        creatorProfile,
        count: Number(elements.variantCount.value)
      },
      artifactId: "themeVariants",
      artifactType: "themeVariants",
      dependencyIds: ["creativeBrief", "visualGuardrails"]
    });
    renderVariants(state.output.themeVariants);
    setStage("variants", "done");
    const pipelineUsage = endStageUsage();
    elements.pipelineUsage.textContent = pipelineUsage
      ? `AI 导演阶段完成${formatStageUsageSuffix(pipelineUsage)}`
      : "";
    elements.pipelineUsage.className = "story-status ready";
    elements.export.classList.remove("hidden");
    elements.variants.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    const active = document.querySelector(".pipeline li.active");
    if (active) setStage(active.dataset.stage, "error");
    const suffix = failedStageUsageSuffix();
    elements.pipelineUsage.textContent = suffix ? `AI 导演阶段失败${suffix}` : "";
    elements.pipelineUsage.className = "story-status error";
    showError(error.message || "工作流执行失败");
  } finally {
    endStageUsage();
    state.running = false;
    setRunning(false);
    validateReady();
  }
}

async function requestProductionArtifact({
  endpoint,
  requestBody,
  artifactId,
  artifactType,
  dependencyIds = [],
  dependencyRefs = null,
  createMediaNamespace = false,
  contentForArtifact = (value) => value
}) {
  assertActiveProductionRun();
  const requestId = crypto.randomUUID();
  const token = beginArtifactRequest(state.production, artifactId, requestId);
  try {
    const dependencies = dependencyRefs ? structuredClone(dependencyRefs) : productionDependencies(dependencyIds);
    const started = await api("/api/production/stage/update", {
      ...token,
      stageId: artifactId,
      status: "running"
    });
    assertCurrentProductionRequest(token);
    updateProductionCheckpoint(started);
    const responseContent = await api(endpoint, requestBody, { productionToken: token });
    assertCurrentProductionRequest(token);
    const content = contentForArtifact(responseContent);
    const committed = await api("/api/production/artifact/commit", {
      ...token,
      artifactType,
      content,
      dependencies,
      createMediaNamespace
    });
    assertCurrentProductionRequest(token);
    acceptProductionCommit(committed);
    return responseContent;
  } catch (error) {
    if (isArtifactRequestCurrent(state.production, token)) {
      const diagnostics = Array.isArray(error.details) ? error.details : [];
      await api("/api/production/stage/update", {
        ...token,
        stageId: artifactId,
        status: "failed",
        error: {
          code: diagnostics[0]?.code || error.code || "STAGE_FAILED",
          category: error.category || "unknown",
          message: error.message || "阶段执行失败",
          diagnostics
        }
      }).catch(() => {});
    }
    throw error;
  } finally {
    finishArtifactRequest(state.production, token);
  }
}

async function commitProductionArtifact({
  artifactId,
  artifactType,
  content,
  dependencyIds = [],
  dependencyRefs = null,
  createMediaNamespace = false,
  requestToken = null
}) {
  assertActiveProductionRun();
  const ownsToken = !requestToken;
  const token = requestToken || beginArtifactRequest(state.production, artifactId, crypto.randomUUID());
  try {
    assertCurrentProductionRequest(token);
    const committed = await api("/api/production/artifact/commit", {
      ...token,
      artifactType,
      content,
      dependencies: dependencyRefs ? structuredClone(dependencyRefs) : productionDependencies(dependencyIds),
      createMediaNamespace
    });
    assertCurrentProductionRequest(token);
    acceptProductionCommit(committed);
    return committed.lineage;
  } finally {
    if (ownsToken) finishArtifactRequest(state.production, token);
  }
}

function productionDependencies(artifactIds = []) {
  return artifactIds.map((artifactId) => {
    const lineage = state.production.artifacts[artifactId];
    if (!lineage || lineage.status !== "current") {
      throw new Error(`上游生产状态已失效：${artifactId}，请从该阶段重新生成。`);
    }
    return lineageDependency(lineage);
  });
}

function acceptProductionCommit(result = {}) {
  const lineage = result.lineage;
  if (!lineage?.artifactId) throw new Error("服务端没有返回 artifact lineage。");
  state.production.artifacts[lineage.artifactId] = lineage;
  if (result.checkpoint) state.production.checkpoint = result.checkpoint;
  applyStaleProductionArtifacts(result.staleArtifactIds || []);
  persistActiveProductionRun();
}

function applyStaleProductionArtifacts(artifactIds = []) {
  for (const artifactId of artifactIds) {
    if (state.production.artifacts[artifactId]) {
      state.production.artifacts[artifactId] = { ...state.production.artifacts[artifactId], status: "stale" };
    }
    if (artifactId.startsWith("animationPlan:")) {
      const variantId = artifactId.slice("animationPlan:".length);
      delete state.animationPlans[variantId];
      delete state.animationPlanMetadata[variantId];
      if (
        String(state.selectedVariantId || "") === variantId
        || String(state.output.animationPlan?.selectedVariantId || "") === variantId
      ) delete state.output.animationPlan;
      dropStaleMediaResults(state, artifactId);
      if (String(state.selectedVariantId || "") === variantId) state.characterReferenceStatuses = {};
      elements.animationPlan.innerHTML = "";
      elements.animationPlan.classList.add("hidden");
    } else if (artifactId.startsWith("fullStory:")) {
      const variantId = artifactId.slice("fullStory:".length);
      delete state.fullStories[variantId];
      if (
        String(state.selectedVariantId || "") === variantId
        || String(state.output.fullStory?.selectedVariantId || "") === variantId
      ) delete state.output.fullStory;
      if (String(state.selectedVariantId || "") === variantId) {
        elements.fullStory.innerHTML = "";
        elements.fullStory.classList.add("hidden");
      }
    } else if (artifactId.startsWith("shotVideo:") || artifactId.startsWith("shotFrame:")) {
      dropStaleMediaResults(state, artifactId);
    }
  }
  state.output.fullStories = state.fullStories;
  state.output.animationPlans = state.animationPlans;
  state.output.animationPlanMetadata = state.animationPlanMetadata;
}

function updateProductionCheckpoint(result = {}) {
  if (result.stage?.stageId) state.production.stages[result.stage.stageId] = result.stage;
  if (result.checkpoint) state.production.checkpoint = result.checkpoint;
  persistActiveProductionRun();
}

function assertCurrentProductionRequest(token) {
  if (!isArtifactRequestCurrent(state.production, token)) {
    const error = new Error("该请求对应的生产版本已被替换，已丢弃旧结果。");
    error.code = "STALE_ASYNC_RESULT";
    throw error;
  }
}

function assertActiveProductionRun() {
  if (!state.production.projectId || !state.production.runId) {
    throw new Error("当前没有可写入的生产 Run，请重新运行工作流。 ");
  }
}

// 一个「阶段」= 用户点一次按钮触发的整个操作。启动 AI 导演是 5 个后端请求，
// 剧情和镜头各 1 个但内部有多次模型调用。这里按阶段收集每个响应带回的 usage。
let stageUsageEntries = null;

function beginStageUsage() {
  stageUsageEntries = [];
}

function endStageUsage() {
  const entries = stageUsageEntries;
  stageUsageEntries = null;
  return mergeStageUsage(entries || []);
}

// 纯旁路：没有 usage 的请求（簿记类）不会进合计，也不影响返回值或失败语义。
function recordStageUsage(usage) {
  if (stageUsageEntries && usage) stageUsageEntries.push(usage);
}

/** 阶段失败时的后缀：失败前调用过的模型照样计费，不能显示成 0 或干脆不显示。 */
function failedStageUsageSuffix() {
  return formatStageUsageSuffix(endStageUsage(), { label: "失败前已消耗" });
}

async function api(path, body, { productionToken = null } = {}) {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...productionRequestHeaders(productionToken || {})
    },
    body: JSON.stringify(withModelOverrides(body))
  });
  const data = await response.json().catch(() => ({}));
  // 先记账再判成败：失败响应上的 usage 是失败前真实花掉的钱，抛错前必须收进合计。
  recordStageUsage(data.usage);
  if (!response.ok || !data.ok) {
    throw createApiRequestError(data, response.status, `请求失败（${response.status}）`);
  }
  return data.result;
}

async function streamJsonEvents(path, body, onEvent) {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(withModelOverrides(body)) });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw createApiRequestError(data, response.status, `请求失败（${response.status}）`);
  }
  if (!response.body) throw new Error("浏览器不支持流式读取。");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split(/\r?\n\r?\n/u);
    buffer = blocks.pop() || "";
    for (const block of blocks) {
      const event = parseEventStreamBlock(block);
      if (event?.type === "error") {
        throw createApiRequestError(event, event.status, "流式请求失败。");
      }
      if (event) onEvent(event);
    }
  }
  buffer += decoder.decode();
  const tail = parseEventStreamBlock(buffer);
  if (tail?.type === "error") {
    throw createApiRequestError(tail, tail.status, "流式请求失败。");
  }
  if (tail) onEvent(tail);
}

function parseEventStreamBlock(block) {
  const lines = String(block || "").split(/\r?\n/u);
  const data = [];
  for (const line of lines) {
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (!data.length) return null;
  try {
    return JSON.parse(data.join("\n"));
  } catch {
    return null;
  }
}

function renderAnalysis(data) {
  const positioning = data.contentPositioning || {};
  const audience = data.targetAudience || {};
  elements.analysis.innerHTML = `${resultHeader("REFERENCE ANALYSIS", "参考片为什么好看", `置信度 ${data.analysisConfidence ?? "-"}%`)}
    <div class="summary-strip">${escape(data.whyWatchToEnd || data.storySynopsis)}</div>
    <div class="data-grid">
      ${cell("内容类型", positioning.genre || positioning.format)}
      ${cell("目标观众", audience.primary)}
      ${cell("内容承诺", positioning.contentPromise)}
      ${cell("主角身份", joinParts(data.protagonistIdentity, ["occupation", "socialRole"]))}
      ${cell("被关爱对象", data.careRecipient?.identity)}
      ${cell("隐性需求", data.careRecipient?.implicitNeed)}
    </div>
    ${block("情绪曲线", `<div class="curve">${(data.emotionCurve || []).map((item) => `<div class="curve-item" style="--intensity:${Number(item.intensity) || 0}%"><small>${escape(item.timeRange)} · ${escape(item.phase)}</small><strong>${escape(item.emotion)} ${escape(item.intensity)}</strong><span>${escape(item.trigger)}</span></div>`).join("")}</div>`)}
    ${block("完播驱动力", `<div class="beat-list">${(data.retentionDrivers || []).map((item) => `<div class="beat"><strong>${escape(item.driver)}</strong><p>观众追问：${escape(item.viewerQuestion)}<br>兑现：${escape(item.payoff)}</p></div>`).join("")}</div>`)}
    ${uncertainties(data.uncertainties)}`;
  reveal(elements.analysis);
}

function renderScript(data) {
  const isCompleteScript = (data.scenes || []).some((scene) =>
    Object.prototype.hasOwnProperty.call(scene || {}, "visibleActions")
    || Object.prototype.hasOwnProperty.call(scene || {}, "location")
  );
  if (isCompleteScript) {
    elements.script.innerHTML = `${resultHeader("SOURCE SCRIPT RECONSTRUCTION", "原片完整脚本还原")}
      <div class="summary-strip">${escape(data.relationshipPattern || "关系模式待确认")}</div>
      <div class="timeline">${(data.scenes || []).map((scene) => `<div class="scene">
        <span class="scene-id">${escape(scene.sceneId)}</span>
        <div class="scene-head"><strong>${escape(scene.location || "地点待确认")}</strong><span>${escape(scene.timeRange)}</span></div>
        <p>${escape((scene.visibleActions || []).join(" → ") || "无可确认动作")}</p>
        <p><b>对白大意：</b>${escape(scene.dialogueGist || "无可确认对白")}</p>
        <div class="scene-meta"><span>${escape(scene.emotionNode)}</span><span>${escape(scene.dramaticFunction)}</span><span>置信度 ${escape(scene.confidence)}%</span>${(scene.keyProps || []).map((prop) => `<span>${escape(prop)}</span>`).join("")}</div>
      </div>`).join("")}</div>
      ${block("核心事件顺序", `<div class="tag-row">${(data.coreEventSequence || []).map((item) => `<span class="tag orange">${escape(item.order)} · ${escape(item.event)}</span>`).join("")}</div>`)}
      ${block("结尾动作", `<div class="beat"><strong>${escape(data.endingAction?.action || "无可确认结尾")}</strong><p>${escape(data.endingAction?.emotionalMeaning)}</p></div>`)}
      ${uncertainties(data.uncertainties)}`;
    reveal(elements.script);
    return;
  }
  const factMap = new Map((data.sourceFacts || []).map((fact) => [fact.factId, fact]));
  const factIdOf = (reference) => typeof reference === "string" ? reference : reference?.factId;
  const claims = (refs) => (refs || []).map((reference) => factMap.get(factIdOf(reference))?.sourceText).filter(Boolean);
  const relationshipClaims = claims(data.relationshipPattern?.factRefs);
  elements.script.innerHTML = `${resultHeader("SOURCE SCRIPT RECONSTRUCTION", "原片完整脚本还原")}
    <div class="summary-strip">${escape(relationshipClaims.join("；") || "关系事实待确认")}</div>
    <div class="timeline">${(data.scenes || []).map((scene) => `<div class="scene">
      <span class="scene-id">${escape(scene.sceneId)}</span>
      <div class="scene-head"><strong>${escape(scene.structureRole)}</strong><span>${formatTime(scene.startMs / 1000)}-${formatTime(scene.endMs / 1000)}</span></div>
      <p>${escape(claims(scene.factRefs).join(" → ") || "无可确认事实")}</p>
      <div class="scene-meta">${(scene.factRefs || []).map((reference) => `<span>${escape(factIdOf(reference))}${reference?.evidenceId ? ` @ ${escape(reference.evidenceId)}` : ""}</span>`).join("")}</div>
    </div>`).join("")}</div>
    ${block("核心事件顺序", `<div class="tag-row">${(data.coreEventSequence || []).map((item) => `<span class="tag orange">${escape(item.order)} · ${escape(claims(item.factRefs).join("；"))}</span>`).join("")}</div>`)}
    ${block("结尾事实", `<div class="beat"><strong>${escape(claims(data.endingAction?.factRefs).join("；") || "无可确认结尾")}</strong></div>`)}
    ${uncertainties(data.uncertainties)}`;
  reveal(elements.script);
}

function renderBrief(data) {
  elements.brief.innerHTML = `${resultHeader("CREATIVE BRIEF", "AI 导演创意简报")}
    <div class="summary-strip">${escape(data.creativeDistancePolicy)}</div>
    <div class="data-grid">
      ${cell("内容类型", data.contentType)}${cell("核心情绪", data.coreEmotion)}${cell("目标观众", data.targetAudience)}
      ${cell("人物欲望", data.storyEngine?.desire)}${cell("主要障碍", data.storyEngine?.obstacle)}${cell("情绪兑现", data.storyEngine?.payoff)}
    </div>
    ${block("可复用高价值桥段", `<div class="beat-list">${(data.reusableHighValueBeats || []).map((item) => `<div class="beat"><strong>${escape(item.beat)}</strong><p>${escape(item.dramaticValue)}<br><b>必须保留：</b>${escape(item.mustRetain)}</p></div>`).join("")}</div>`)}
    ${block("允许继续使用的叙事构件", `<div class="allow-grid">${(data.allowedNarrativeComponents || []).map((item) => `<div class="allow-item"><strong>✓ ${escape(item.component)}</strong><p>${escape(item.howToReuseSafely)}</p></div>`).join("")}</div>`)}
    ${block("受控改写变量", `<div class="rule-list">${(data.controlledRewriteVariables || []).map((item) => `<div class="rule"><strong>${escape(item.variable)}${item.mustChange ? " · 必须改" : ""}</strong><p>${escape(item.reason)}<br>方向：${escape((item.allowedDirections || []).join(" / "))}</p></div>`).join("")}</div>`)}
    ${block("最低变换规则", `<div class="rule-list">${(data.minimumTransformationRules || []).map((item) => `<div class="rule"><strong>${escape(item.dimension)}</strong><p>${escape(item.minimumChange)}<br><b>验收：</b>${escape(item.acceptanceCheck)}</p></div>`).join("")}</div>`)}
    <div class="warning-box"><b>真正禁止直接复制：</b> ${(data.protectedExpressions || []).map((item) => `${escape(item.expressionType)}：${escape(item.prohibition)}`).join("；") || "无"}</div>`;
  reveal(elements.brief);
}

function renderVisualGuardrails(data) {
  const boundary = data.fixedCharacterBoundary || {};
  elements.guardrails.innerHTML = `${resultHeader("VISUAL GUARDRAILS", "角色与创作边界", "非渲染负面")}
    <div class="summary-strip">${escape(data.rationale || "已签发全局角色边界，后续阶段只消费、不重新推断。")}</div>
    <div class="data-grid">
      ${cell("角色锁定", boundary.characterName)}
      ${cell("规范描述", boundary.canonicalDescription)}
      ${cell("身体形态", boundary.bodyForm)}
      ${cell("边界版本", boundary.schemaVersion)}
      ${cell("边界摘要", boundary.boundaryDigest)}
    </div>
    ${block("必须沿用", renderBoundaryTraits(boundary.requiredTraits))}
    ${block("允许选择", renderBoundaryTraits(boundary.allowedTraits))}
    ${block("禁止出现", renderBoundaryTraits(boundary.forbiddenTraits))}
    ${block("允许正向使用", renderAllowedPositiveTraits(data.allowedPositiveTraits))}
    ${block("正向提示词边界", renderGuardrailRuleList(data.positivePromptBoundary, "无额外正向提示词边界。"))}
    ${block("原片表面表达来源记录", renderGuardrailRuleList(data.sourceSimilarityRules, "无原片表面表达来源记录。"))}
    ${block("台词与行为规则", renderGuardrailRuleList(data.dialogueRules, "无额外台词或行为规则。"))}
    <div class="warning-box"><b>渲染负面提示词不在本阶段生成。</b> 图片与视频负面提示词只在 animationPlan 中按当前镜头分别生成，并必须附带触发证据。</div>
    ${uncertainties(data.uncertainties)}`;
  reveal(elements.guardrails);
}

function renderBoundaryTraits(value = []) {
  const items = Array.isArray(value) ? value : [];
  if (!items.length) return `<div class="tag-row"><span class="tag">无</span></div>`;
  return `<div class="rule-list">${items.map((item) => `<div class="rule"><strong>${escape(item.canonicalName || "未命名事实")}</strong><p>${escape(item.scope || "")} · ${escape(item.evidenceLevel || "")}<br>${escape(item.reason || "")}</p></div>`).join("")}</div>`;
}

function renderAllowedPositiveTraits(value = []) {
  const items = Array.isArray(value) ? value : [];
  if (!items.length) return `<div class="tag-row"><span class="tag">无额外允许项</span></div>`;
  return `<div class="tag-row">${items.map((item) => {
    if (typeof item === "string") return `<span class="tag">${escape(item)}</span>`;
    const text = item?.term || item?.text || item?.rule || "未命名特征";
    return `<span class="tag">${escape(text)}${item?.scope ? ` · ${escape(item.scope)}` : ""}</span>`;
  }).join("")}</div>`;
}

function renderGuardrailRuleList(value, emptyText) {
  const items = normalizeRuleItems(value);
  if (!items.length) return `<div class="rule-list"><p class="long-copy">${escape(emptyText)}</p></div>`;
  return `<div class="rule-list">${items.map((item) => {
    if (typeof item === "string") return `<div class="rule"><strong>${escape(item)}</strong></div>`;
    const title = firstRuleValue(item, ["text", "rule", "term", "name", "requirement", "boundary", "prohibition", "category"]) || "规则";
    const details = ruleDetailPairs(item).map(([label, detail]) => `<b>${escape(label)}：</b>${escape(structuredValue(detail))}`).join("<br>");
    return `<div class="rule"><strong>${escape(title)}</strong>${details ? `<p>${details}</p>` : ""}</div>`;
  }).join("")}</div>`;
}

function normalizeRuleItems(value) {
  if (Array.isArray(value)) return value.filter((item) => item !== null && item !== undefined && item !== "");
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (!value || typeof value !== "object") return [];
  if (firstRuleValue(value, ["text", "rule", "term", "name", "requirement", "boundary", "prohibition"])) return [value];
  return Object.entries(value).flatMap(([category, nested]) => {
    if (Array.isArray(nested)) return nested.map((item) => typeof item === "object" && item !== null ? { category, ...item } : { category, text: item });
    if (nested && typeof nested === "object") return [{ category, ...nested }];
    return nested === null || nested === undefined || nested === "" ? [] : [{ category, text: nested }];
  });
}

function firstRuleValue(item, keys = []) {
  for (const key of keys) {
    const value = item?.[key];
    if (value !== null && value !== undefined && value !== "") return structuredValue(value);
  }
  return "";
}

function ruleDetailPairs(item = {}) {
  const labels = {
    scope: "范围", reason: "原因", source: "来源", triggerEvidence: "触发证据",
    priority: "优先级", appliesTo: "适用目标", severity: "级别", allowed: "允许",
    forbidden: "禁止", behavior: "行为", note: "说明", description: "说明"
  };
  const titleKeys = new Set(["text", "rule", "term", "name", "requirement", "boundary", "prohibition", "category"]);
  return Object.entries(item)
    .filter(([key, value]) => !titleKeys.has(key) && value !== null && value !== undefined && value !== "")
    .map(([key, value]) => [labels[key] || key, value]);
}

function structuredValue(value) {
  if (Array.isArray(value)) return value.map(structuredValue).filter(Boolean).join(" / ");
  if (value && typeof value === "object") return Object.entries(value).map(([key, item]) => `${key}=${structuredValue(item)}`).join("；");
  return String(value ?? "");
}

const REGENERATE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-.9 4.5"/><polyline points="20 4 20 11 13 11"/></svg>`;

function renderVariants(data) {
  const regenerating = Boolean(state.variantsRegenerating);
  const regenerateButton = `<button class="round-add-button${regenerating ? " is-busy" : ""}" type="button" data-regenerate-variants aria-label="换一批主题变体" title="${regenerating ? "正在重新生成主题变体…" : "换一批：用同一份上游证据重新生成主题变体"}"${regenerating ? " disabled" : ""}>${REGENERATE_ICON}</button>`;
  elements.variants.innerHTML = `${resultHeader("THEME VARIANTS", "可拍摄的具体主题变体", "", regenerateButton)}
    <div class="variant-grid">${(data.variants || []).map((variant) => `<div class="variant">
      <div class="variant-top">
        <div><span class="variant-number">${escape(variant.id)} · NEW EPISODE</span><h4>${escape(variant.title)}</h4></div>
        <div class="variant-top-meta">
          <label class="variant-switch" title="${backgroundMusicEnabled(variant.id) ? "开启：允许为该主题生成背景音乐" : "关闭：成片只保留现场环境声与动作声"}">
            <input type="checkbox" data-background-music="${escape(variant.id)}" aria-label="${escape(variant.title)} 的背景音乐"${backgroundMusicEnabled(variant.id) ? " checked" : ""}>
            <span class="variant-switch-track" aria-hidden="true"></span>
            <span class="variant-switch-label">配乐</span>
          </label>
          <span class="risk">相似风险 ${escape(variant.originalityRiskCheck?.riskLevel || "-")}</span>
        </div>
      </div>
      <p class="variant-hook">${escape(variant.oneLineHook)}</p>
      <p class="variant-logline">${escape(variant.logline)}</p>
      <div class="variant-cast">
        <span><b>主角</b>${escape(variant.characterSetup?.protagonist || "待确认")}</span>
        <span><b>被关爱对象</b>${escape(variant.characterSetup?.careRecipient || "待确认")}</span>
        <span><b>帮助者</b>${escape(variant.characterSetup?.helper || "待确认")}</span>
      </div>
      <ul class="mini-beats">${(variant.storyOutline || []).map((beat) => `<li><b>${escape(beat.beat)}</b><span><strong>${escape(beat.phase)}</strong> · ${escape(beat.action)}</span></li>`).join("")}</ul>
      <div class="variant-ending"><b>结尾仪式：</b>${escape(variant.endingRitual)}</div>
      <button class="outline-button variant-story-button" type="button" data-story-variant="${escape(variant.id)}">进入完整剧情 →</button>
    </div>`).join("")}</div>`;
  reveal(elements.variants);
}

// 换一批：用同一份已签发的上游证据（referenceAnalysis / sourceScriptReconstruction /
// creativeBrief / visualGuardrails）重新调用一次 /api/variants，不重跑前四个阶段。
//
// 新的 themeVariants revision 会让服务端 propagateStale 递归作废下游的
// variant / fullStory / animationPlan / 镜头媒体——这是 P0 的状态隔离要求，
// 不是可选项。所以下游已经有产出时必须先明确征求同意，拒绝就什么都不动。
async function regenerateThemeVariants() {
  if (state.variantsRegenerating) return;
  if (!state.output.creativeBrief || !state.output.visualGuardrails) {
    showError("上游创意简报或角色边界尚未生成，无法重新生成主题变体。");
    return;
  }

  const downstream = [
    ...Object.keys(state.fullStories || {}).map((variantId) => `${variantId} 的完整剧情`),
    ...Object.keys(state.animationPlans || {}).map((variantId) => `${variantId} 的镜头计划`)
  ];
  if (downstream.length) {
    const confirmed = window.confirm(
      "换一批会签发新的主题变体，已生成的下游内容会全部失效：\n"
      + `${downstream.join("、")}，以及它们下面已生成的镜头媒体。\n\n是否继续？`
    );
    if (!confirmed) return;
  }

  state.variantsRegenerating = true;
  renderVariants(state.output.themeVariants);
  setStage("variants", "active");
  beginStageUsage();
  try {
    const themeVariants = await requestProductionArtifact({
      endpoint: "/api/variants",
      requestBody: {
        referenceAnalysis: state.output.referenceAnalysis,
        sourceScriptReconstruction: state.output.sourceScriptReconstruction,
        creativeBrief: state.output.creativeBrief,
        visualGuardrails: state.output.visualGuardrails,
        creatorProfile: profile(),
        count: Number(elements.variantCount.value)
      },
      artifactId: "themeVariants",
      artifactType: "themeVariants",
      dependencyIds: ["creativeBrief", "visualGuardrails"]
    });
    state.output.themeVariants = themeVariants;
    // 旧的选中项已经不存在了，别让它继续指向一个已作废的 variant。
    state.selectedVariantId = null;
    state.backgroundMusicDrafts = {};
    setStage("variants", "done");
    const usage = endStageUsage();
    elements.pipelineUsage.textContent = usage ? `主题变体已换一批${formatStageUsageSuffix(usage)}` : "";
    elements.pipelineUsage.className = "story-status ready";
  } catch (error) {
    setStage("variants", "error");
    const suffix = failedStageUsageSuffix();
    elements.pipelineUsage.textContent = suffix ? `换一批失败${suffix}` : "";
    elements.pipelineUsage.className = "story-status error";
    showError(error.message || "重新生成主题变体失败");
  } finally {
    state.variantsRegenerating = false;
    renderVariants(state.output.themeVariants);
  }
}

// 开关默认关闭；已有 Plan 时以 Plan 已签发的 backgroundMusicMode 为准。
function backgroundMusicEnabled(variantId) {
  if (Object.prototype.hasOwnProperty.call(state.backgroundMusicDrafts, variantId)) {
    return Boolean(state.backgroundMusicDrafts[variantId]);
  }
  const plan = state.animationPlans[variantId];
  const mode = plan?.productionStrategy?.backgroundMusicMode;
  return mode ? mode !== "none" : false;
}

async function handleBackgroundMusicToggle(variantId, enabled) {
  const plan = state.animationPlans[variantId];
  const currentMode = plan?.productionStrategy?.backgroundMusicMode;
  // 没有 Plan：只是记录选择，等生成时使用。
  if (!plan || !currentMode) {
    state.backgroundMusicDrafts[variantId] = enabled;
    renderVariants(state.output.themeVariants);
    return;
  }
  if ((currentMode !== "none") === enabled) {
    state.backgroundMusicDrafts[variantId] = enabled;
    renderVariants(state.output.themeVariants);
    return;
  }
  // 已有 Plan：切换必须重生整包，不能只改提示词末尾。明确征求同意。
  const confirmed = window.confirm(
    `切换背景音乐需要用模型重新生成整个 Animation Plan。\n`
    + `新 Plan 会签发新的 revision 和媒体目录，该变体已生成的镜头视频将全部失效。\n\n是否继续？`
  );
  if (!confirmed) {
    renderVariants(state.output.themeVariants);
    return;
  }
  state.backgroundMusicDrafts[variantId] = enabled;
  renderVariants(state.output.themeVariants);
  state.selectedVariantId = variantId;
  await generateAnimationPlan(true);
}

function navigateToStory(variantId) {
  if (!variantId) return;
  state.selectedVariantId = variantId;
  history.pushState({ storyVariantId: variantId }, "", `/story/${encodeURIComponent(variantId)}`);
  renderStoryPage({ autoGenerate: true });
}

function backToMainResults() {
  history.pushState({}, "", "/");
  renderMainPage();
  const target = elements.variants.classList.contains("hidden") ? elements.resultStack : elements.variants;
  target?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderRoute() {
  const match = location.pathname.match(/^\/story\/([^/]+)/);
  if (match) {
    state.selectedVariantId = decodeURIComponent(match[1]);
    renderStoryPage({ autoGenerate: false });
  } else {
    renderMainPage();
  }
}

function renderMainPage() {
  elements.storyPage.classList.add("hidden");
  elements.mainPage.classList.remove("hidden");
}

function renderStoryPage({ autoGenerate = false } = {}) {
  elements.mainPage.classList.add("hidden");
  elements.storyPage.classList.remove("hidden");
  window.scrollTo({ top: 0, behavior: "instant" });
  const variant = selectedVariant();
  renderSelectedVariantSummary(variant);
  const existing = variant ? state.fullStories[variant.id] : null;
  const animationExisting = variant ? state.animationPlans[variant.id] : null;
  syncAnimationAspectRatioControls(animationExisting);
  if (existing) {
    renderFullStory(existing);
    setStoryStatus(`已生成完整剧情 · ${storyModelLabel()}`, "ready");
    elements.animationGenerate.disabled = state.animationRunning;
    updateStoryExportActions();
    if (animationExisting) {
      renderAnimationPlan(animationExisting);
      setAnimationStatus(`已生成动画生产包 · ${animationModelLabel()}`, "ready");
    } else {
      elements.animationPlan.classList.add("hidden");
      elements.animationPlan.innerHTML = "";
      setAnimationStatus("可以继续生成动画镜头生产包。", "");
    }
  } else {
    elements.fullStory.classList.add("hidden");
    elements.fullStory.innerHTML = "";
    elements.animationPlan.classList.add("hidden");
    elements.animationPlan.innerHTML = "";
    setAnimationStatus("", "");
    elements.animationGenerate.disabled = true;
    updateStoryExportActions();
    if (variant) {
      setStoryStatus("准备生成完整剧情。", "");
      if (autoGenerate) generateFullStory();
    } else {
      setStoryStatus("当前页面没有可用主题变体。请先返回工作台，完成视频分析并选择一个主题变体。", "error");
    }
  }
  elements.storyGenerate.disabled = !variant || state.storyRunning;
  updateStoryExportActions();
}

function renderSelectedVariantSummary(variant) {
  if (!variant) {
    elements.selectedVariantSummary.innerHTML = `<div class="warning-box"><b>缺少选中主题。</b> 当前浏览器状态里没有主题变体结果，无法继续生成完整剧情。</div>`;
    return;
  }
  elements.selectedVariantSummary.innerHTML = `
    <span class="variant-number">${escape(variant.id)} · SELECTED</span>
    <h3>${escape(variant.title)}</h3>
    <p>${escape(variant.logline || variant.oneLineHook)}</p>
    <div class="variant-cast compact">
      <span><b>主角</b>${escape(variant.characterSetup?.protagonist || "待确认")}</span>
      <span><b>任务</b>${escape(variant.newTask || "待确认")}</span>
      <span><b>压力</b>${escape(variant.environmentPressure || "待确认")}</span>
      <span><b>媒介</b>${escape(variant.emotionalMedium || "待确认")}</span>
    </div>`;
}

async function generateFullStory({ force = false } = {}) {
  if (state.storyRunning) return;
  const variant = selectedVariant();
  if (!variant) return setStoryStatus("请先选择一个可拍摄主题变体。", "error");
  if (!force && state.fullStories[variant.id]) {
    renderFullStory(state.fullStories[variant.id]);
    return;
  }
  state.storyRunning = true;
  setStoryRunning(true);
  beginStageUsage();
  setStoryStatus(`正在调用 ${storyModelLabel()} 生成完整剧情…`, "active");
  try {
    const candidateLineage = await ensureSelectedVariantArtifact(variant);
    const fullStory = await requestProductionArtifact({
      endpoint: "/api/full-story",
      requestBody: {
        referenceAnalysis: state.output.referenceAnalysis,
        sourceScriptReconstruction: state.output.sourceScriptReconstruction,
        creativeBrief: state.output.creativeBrief,
        visualGuardrails: state.output.visualGuardrails,
        themeVariants: state.output.themeVariants,
        variant,
        candidateBinding: lineageDependency(candidateLineage),
        creatorProfile: profile()
      },
      artifactId: `fullStory:${variant.id}`,
      artifactType: "fullStory",
      dependencyIds: [
        "referenceAnalysis",
        "sourceScriptReconstruction",
        "creativeBrief",
        "visualGuardrails",
        "themeVariants",
        `variant:${variant.id}`
      ]
    });
    assertSelectedVariant(variant.id);
    state.fullStories[variant.id] = fullStory;
    state.output.fullStories = state.fullStories;
    state.output.fullStory = fullStory;
    renderFullStory(fullStory);
    setStoryStatus(`完整剧情已生成 · ${storyModelLabel()}${formatStageUsageSuffix(endStageUsage())}`, "ready");
    elements.animationGenerate.disabled = false;
    setAnimationStatus("可以继续生成动画镜头生产包。", "");
    updateStoryExportActions();
    elements.export.classList.remove("hidden");
  } catch (error) {
    setStoryStatus(`${error.message || "完整剧情生成失败"}${failedStageUsageSuffix()}`, "error");
  } finally {
    endStageUsage();
    state.storyRunning = false;
    setStoryRunning(false);
  }
}

function renderFullStory(data) {
  elements.fullStory.innerHTML = `${resultHeader("FULL STORY", data.title || "完整剧情", `${escape(data.targetDurationSeconds || 60)} 秒`)}
    <div class="summary-strip">${escape(data.oneLinePremise || data.shootingSynopsis)}</div>
    <div class="data-grid">
      ${cell("主角锁定", data.characterBible?.protagonist?.identity || data.characterBible?.protagonist?.name)}
      ${cell("被关爱对象", joinParts(data.characterBible?.careRecipient, ["identity", "implicitNeed"]))}
      ${cell("对白规则", data.dialogueStyleGuide?.protagonistSpeechRule || data.characterBible?.protagonist?.speechRules)}
    </div>
    ${block("剧情梗概", `<p class="long-copy">${escape(data.shootingSynopsis)}</p>`)}
    ${block("剧情节拍", `<div class="beat-list">${(data.beatSheet || []).map((beat) => `<div class="beat"><strong>${escape(beat.timeRange)} · ${escape(beat.emotion)}</strong><p>${escape(beat.storyAction)}<br><b>功能：</b>${escape(beat.dramaticFunction)}<br><b>保留价值：</b>${escape(beat.retainedValueFromBrief)}</p></div>`).join("")}</div>`)}
    ${block("可拍分场剧本", `<div class="timeline">${(data.sceneScript || []).map((scene) => `<div class="scene">
      <span class="scene-id">${escape(scene.sceneId)}</span>
      <div class="scene-head"><strong>${escape(scene.location)}</strong><span>${escape(scene.timeRange)}</span></div>
      <p><b>人物：</b>${escape((scene.characters || []).join("、"))}</p>
      <p><b>动作：</b>${escape(scene.visibleAction)}</p>
      <p><b>对白：</b>${formatDialogue(scene.dialogue)}</p>
      <p><b>镜头/声音：</b>${escape(scene.shotAndSound)}</p>
      <div class="scene-meta"><span>${escape(scene.emotionNode)}</span><span>${escape(scene.dramaticFunction)}</span></div>
      <p><b>拍摄备注：</b>${escape(scene.shootingNotes)}</p>
    </div>`).join("")}</div>`)}
    ${block("关键道具", `<div class="rule-list">${(data.keyProps || []).map((item) => `<div class="rule"><strong>${escape(item.prop)}</strong><p>${escape(item.storyFunction)}<br>${escape(item.visualUse)}<br><b>避相似：</b>${escape(item.avoidSimilarityNote)}</p></div>`).join("")}</div>`)}
    ${block("拍摄计划", `<div class="rule-list">${(data.shootingPlan || []).map((item) => `<div class="rule"><strong>${escape(item.unit)}</strong><p>${escape(item.setup)}<br><b>必拍：</b>${escape(item.mustCapture)}<br><b>执行：</b>${escape(item.practicalNote)}</p></div>`).join("")}</div>`)}
    ${block("体验保真", `<div class="data-grid">
      ${cell("定位", data.experienceFidelity?.positioning)}${cell("受众", data.experienceFidelity?.audience)}${cell("情绪", data.experienceFidelity?.emotion)}
      ${cell("驱动力", data.experienceFidelity?.plotDriver)}${cell("高价值桥段", data.experienceFidelity?.highValueBeats)}${cell("改写证明", data.transformationProof?.changedVisualExpression)}
    </div>`)}
    <div class="warning-box"><b>连续性检查：</b> ${escape(Object.values(data.continuityAndSafetyCheck || {}).filter(Boolean).join("；")) || "已通过结构校验"}</div>
    ${uncertainties(data.uncertainties)}`;
  reveal(elements.fullStory);
}

async function generateAnimationPlan({ force = false } = {}) {
  if (state.animationRunning) return;
  const variant = selectedVariant();
  if (!variant) return setAnimationStatus("请先选择一个主题变体。", "error");
  const fullStory = state.fullStories[variant.id] || state.output.fullStory;
  if (!fullStory) return setAnimationStatus("请先生成完整剧情，再生成动画生产包。", "error");
  const targetAspectRatio = selectedAnimationAspectRatio(variant.id);
  let videoPromptTarget;
  try {
    videoPromptTarget = videoPromptTargetForSetting(shotVideoSetting());
  } catch (error) {
    return setAnimationStatus(`${error.message} 请先在模型设置中选择 Seedance 2.0 或 MiniMax H3。`, "error");
  }
  if (!force && state.animationPlans[variant.id]) {
    renderAnimationPlan(state.animationPlans[variant.id]);
    return;
  }
  state.animationRunning = true;
  setAnimationRunning(true);
  beginStageUsage();
  setAnimationStatus(`正在调用 ${animationModelLabel()} 生成直接视频镜头生产包…`, "active");
  try {
    const animationPlanMode = "direct_shot";
    const previousPrivateSidecars = state.animationPlanMetadata[variant.id]?.privateSidecars;
    await ensureSelectedVariantArtifact(variant);
    const result = await requestProductionArtifact({
      endpoint: "/api/animation-plan",
      requestBody: {
        referenceAnalysis: state.output.referenceAnalysis,
        sourceScriptReconstruction: state.output.sourceScriptReconstruction,
        creativeBrief: state.output.creativeBrief,
        visualGuardrails: state.output.visualGuardrails,
        variant,
        fullStory,
        creatorProfile: profile(),
        animationPlanMode,
        targetAspectRatio,
        backgroundMusicEnabled: backgroundMusicEnabled(variant.id),
        videoPromptTarget,
        // 暂时弃置，后续优化或删除：direct_shot 不消费 Character Feature private sidecar；旧 v2 请求兼容保留。
        ...(animationPlanMode !== "direct_shot" && previousPrivateSidecars && typeof previousPrivateSidecars === "object" && !Array.isArray(previousPrivateSidecars)
          ? { privateSidecars: structuredClone(previousPrivateSidecars) }
          : {}),
        includeCompilerMetadata: true
      },
      artifactId: `animationPlan:${variant.id}`,
      artifactType: "animationPlan",
      dependencyIds: [
        "referenceAnalysis",
        "sourceScriptReconstruction",
        "creativeBrief",
        "visualGuardrails",
        `variant:${variant.id}`,
        `fullStory:${variant.id}`
      ],
      createMediaNamespace: true,
      contentForArtifact: (value) => normalizeAnimationPlanResponse(value).animationPlan
    });
    assertSelectedVariant(variant.id);
    const { animationPlan, metadata } = normalizeAnimationPlanResponse(result);
    state.animationPlans[variant.id] = animationPlan;
    if (metadata?.staticFrameCompiler) state.animationPlanMetadata[variant.id] = metadata;
    else delete state.animationPlanMetadata[variant.id];
    state.output.animationPlans = state.animationPlans;
    state.output.animationPlanMetadata = state.animationPlanMetadata;
    state.output.animationPlan = animationPlan;
    state.animationAspectRatioDrafts[variant.id] = normalizeAnimationPlanAspectRatio(animationPlan.productionStrategy?.targetAspectRatio);
    renderAnimationPlan(animationPlan, metadata);
    setAnimationStatus(`动画生产包已生成 · ${state.animationAspectRatioDrafts[variant.id]} · ${animationModelLabel()}${formatStageUsageSuffix(endStageUsage())}`, "ready");
    updateStoryExportActions();
    elements.export.classList.remove("hidden");
  } catch (error) {
    setAnimationStatus(`${error.message || "动画生产包生成失败"}${failedStageUsageSuffix()}`, "error");
    const compilerFailure = renderCompilerFailureDetails(error);
    if (compilerFailure) {
      elements.animationPlan.innerHTML = `${resultHeader("COMPILER FAILURE", "动画生产包未能安全编译")}${compilerFailure}`;
      reveal(elements.animationPlan);
    }
  } finally {
    endStageUsage();
    state.animationRunning = false;
    setAnimationRunning(false);
  }
}

async function ensureSelectedVariantArtifact(variant) {
  if (!variant?.id) throw new Error("选中主题缺少 id。");
  return commitProductionArtifact({
    artifactId: `variant:${variant.id}`,
    artifactType: "selectedVariant",
    content: variant,
    dependencyIds: ["themeVariants"]
  });
}

function assertSelectedVariant(variantId) {
  if (String(state.selectedVariantId || "") !== String(variantId || "")) {
    const error = new Error("生成期间切换了主题变体，已丢弃旧页面回写。");
    error.code = "STALE_VARIANT_RESULT";
    throw error;
  }
}

function animationPlanArtifactId(variantId) {
  return `animationPlan:${variantId}`;
}

function shotVideoArtifactId(variantId, shotId) {
  return shotVideoArtifactIdFor(variantId, shotId);
}

function shotVideoStateItem(shotId, variantId = selectedVariant()?.id) {
  return state.shotVideoResults[shotVideoResultKey(variantId, shotId)] || null;
}

function setShotVideoStateItem(shotId, value, variantId = selectedVariant()?.id) {
  state.shotVideoResults[shotVideoResultKey(variantId, shotId)] = value;
  return value;
}

function currentPlanProductionContext(variantId) {
  const context = planProductionContext(state.production, animationPlanArtifactId(variantId));
  if (!context) throw new Error("当前 Animation Plan 没有有效 lineage/mediaNamespace，请重新生成动画生产包。");
  return context;
}

function assertPlanProductionContextCurrent(context) {
  const current = planProductionContext(state.production, context?.planArtifactId);
  if (
    !current
    || current.projectId !== context.projectId
    || current.runId !== context.runId
    || current.planRevision !== context.planRevision
    || current.planDigest !== context.planDigest
    || current.mediaNamespace !== context.mediaNamespace
  ) {
    const error = new Error("Animation Plan 已更新，旧媒体结果已保留在历史目录但不会挂到新方案。");
    error.code = "STALE_MEDIA_RESULT";
    throw error;
  }
}

function currentPlanDependencyIds(variantId) {
  const lineage = state.production.artifacts[animationPlanArtifactId(variantId)];
  if (!lineage || lineage.status !== "current") throw new Error("当前 Animation Plan lineage 已失效。");
  return (lineage.dependencies || []).map((dependency) => dependency.artifactId);
}

function currentPlanDependencyRefs(variantId) {
  const lineage = state.production.artifacts[animationPlanArtifactId(variantId)];
  if (!lineage || lineage.status !== "current") throw new Error("当前 Animation Plan lineage 已失效。");
  return structuredClone(lineage.dependencies || []);
}

function currentPlanLineageRef(variantId) {
  const lineage = state.production.artifacts[animationPlanArtifactId(variantId)];
  if (!lineage || lineage.status !== "current") throw new Error("当前 Animation Plan lineage 已失效。");
  return lineageDependency(lineage);
}

function selectedAnimationAspectRatio(variantId = selectedVariant()?.id) {
  const plan = variantId ? state.animationPlans[variantId] : null;
  const planAspectRatio = normalizeAnimationPlanAspectRatio(
    plan?.productionStrategy?.targetAspectRatio,
    state.animationAspectRatioDefault
  );
  const draft = variantId ? state.animationAspectRatioDrafts[variantId] : "";
  return normalizeAnimationPlanAspectRatio(draft, planAspectRatio);
}

// 创作宇宙面板上的画幅只是新 Plan 的默认值：已签发的 Plan 保持它自己锁入的画幅，
// 不因为这里拨一下就重签 revision 或 stale 媒体。切换已有 Plan 的入口仍在 Plan 卡片内。
function handleDefaultAspectRatioChange(value) {
  state.animationAspectRatioDefault = normalizeAnimationPlanAspectRatio(value);
  syncAnimationAspectRatioControls();
}

function syncAnimationAspectRatioControls(plan = null) {
  void plan;
  elements.animationAspectRatio.value = state.animationAspectRatioDefault;
  elements.animationAspectRatio.disabled = false;
}

function normalizeAnimationPlanResponse(result) {
  if (
    result
    && typeof result === "object"
    && !Array.isArray(result)
    && result.animationPlan
    && typeof result.animationPlan === "object"
    && !Array.isArray(result.animationPlan)
  ) {
    return {
      animationPlan: result.animationPlan,
      metadata: result.metadata && typeof result.metadata === "object" && !Array.isArray(result.metadata)
        ? result.metadata
        : null
    };
  }
  return { animationPlan: result, metadata: null };
}

function selectedAnimationPlanMetadata() {
  const variant = selectedVariant();
  return variant ? state.animationPlanMetadata[variant.id] || null : null;
}

function hasPlannedEndpoints(shot = {}) {
  const hasStructuredEndpoints = Boolean(shot.startFrame && shot.endFrame && shot.motion);
  const hasCompiledEndpoints = Boolean(
    String(shot.startFramePrompt || "").trim()
    && String(shot.endFramePrompt || "").trim()
  );
  return hasStructuredEndpoints || hasCompiledEndpoints;
}

function renderAnimationPlan(data, metadata = selectedAnimationPlanMetadata()) {
  const strategy = data.productionStrategy || {};
  const visual = data.visualBible || {};
  const directShotPlan = data.promptSchemaVersion === "3.0";
  const currentAspectRatio = normalizeAnimationPlanAspectRatio(strategy.targetAspectRatio);
  const sharedPromptClauses = sharedVideoPromptClauses(data.shotPlan);
  const runtimeSummary = animationPlanRuntimeSummary(data);
  elements.animationPlan.innerHTML = `${resultHeader("ANIMATION PLAN", data.title || "动画镜头生产包", strategy.format || (directShotPlan ? "direct_shot_video" : "first_last_frame_video"))}
    <div class="summary-strip">${escape(strategy.whyThisWorkflow || (directShotPlan ? "镜头内容直接组织为视频生成指令。" : "按首尾帧拆镜头，逐镜生成短视频，优先控制角色一致性。"))}</div>
    <div class="data-grid">
      ${cell("目标画幅", `${currentAspectRatio} · ${currentAspectRatio === "9:16" ? "竖屏" : "横屏"}`)}
      ${cell("镜头计划合计时长", formatAnimationPlanRuntime(runtimeSummary))}
      ${cell("单镜头", formatAnimationShotDurationRange(data))}
      ${cell("动画风格", visual.animationStyle)}
      ${cell("色彩", (visual.colorPalette || []).join(" / "))}
      ${cell("镜头语言", visual.cameraLanguage)}
      ${directShotPlan ? renderVideoPromptProfileCell(data) : ""}
    </div>
    ${directShotPlan ? "" : renderStaticFrameCompilerLog(metadata)}
    ${block("生产顺序", `<div class="tag-row">${(strategy.generationOrder || []).map((item, index) => `<span class="tag orange">${index + 1} · ${escape(item)}</span>`).join("")}</div>`)}
    ${block("视觉圣经", `<div class="rule-list">
      <div class="rule"><strong>整体风格</strong><p>${escape(visual.overallStyle)}<br><b>光线：</b>${escape(visual.lighting)}</p></div>
      <div class="rule"><strong>世界规则</strong><p>${escape((visual.worldRules || []).join("；"))}</p></div>
      <div class="rule"><strong>角色一致性</strong><p>${escape((visual.characterConsistencyRules || []).join("；"))}</p></div>
    </div>`)}
    ${actionBlock("角色参考提示词", renderCharacterReferencePrompts(data.characterReferencePrompts || []), `<button class="round-add-button" type="button" data-open-character-image-generator aria-label="用即梦生成角色参考图">+</button>`)}
    ${block("场景参考提示词", `<div class="rule-list">${(data.sceneReferencePrompts || []).map((item) => `<div class="rule">
      <strong>${escape(item.sceneName || item.sceneId)}<br><small>${escape(item.sceneId)}</small></strong>
      <p>${escape(item.environmentPrompt)}<br><b>功能：</b>${escape(item.storyFunction)}<br><b>连续性锚点：</b>${escape((item.continuityAnchors || []).join(" / "))}</p>
    </div>`).join("") || "<p class=\"long-copy\">无单独场景参考提示词。</p>"}</div>`)}
    ${block("关键资产提示词", `<div class="rule-list">${(data.assetPrompts || []).map((item) => `<div class="rule">
      <strong>${escape(item.assetName)}</strong>
      <p>${escape(item.imagePrompt)}<br><b>功能：</b>${escape(item.storyFunction)}<br><b>一致性：</b>${escape((item.consistencyTags || []).join(" / "))}</p>
    </div>`).join("") || "<p class=\"long-copy\">无单独资产提示词。</p>"}</div>`)}
    ${block(directShotPlan ? "直接视频镜头计划" : "首尾帧镜头计划", `<div class="shot-list">${(data.shotPlan || []).map((shot, shotIndex) => `<div class="shot-card">
      <div class="scene-head"><strong>${escape(shot.shotId)} · ${escape(shot.sourceSceneId)} · ${escape(shot.sceneId || "")}</strong><span>${escape(shot.durationSeconds)} 秒 · ${escape(shot.emotionalTarget)}</span></div>
      <p><b>剧情功能：</b>${escape(shot.storyPurpose)}</p>
      <div class="prompt-grid">
        ${hasPlannedEndpoints(shot) ? `
          ${renderShotFramePromptCard(shot.shotId, "start", "首帧 prompt", shot.startFramePrompt)}
          ${renderShotFramePromptCard(shot.shotId, "end", "尾帧 prompt", shot.endFramePrompt)}
        ` : ""}
        <div class="prompt-card"><span class="prompt-label">视频 prompt</span><p class="video-prompt-body">${renderVideoPromptBody(shot.videoPrompt, sharedPromptClauses)}</p></div>
        ${hasPlannedEndpoints(shot) ? renderShotNegativePromptCard(shot, "image", "图片负面提示词") : ""}
        ${renderShotVideoPromptCell(shot, currentAspectRatio)}
      </div>
      <p><b>镜头运动：</b>${escape(shot.cameraMotion)}<br><b>动作：</b>${escape(shot.characterAction)}<br><b>对白/字幕：</b>${escape(shot.dialogueOrSubtitle)}<br><b>声音：</b>${escape(shot.soundDesign)}</p>
      <div class="tag-row">${(shot.acceptanceCriteria || []).map((item) => `<span class="tag">${escape(item)}</span>`).join("")}</div>
      <div class="shot-video-action">
        <div class="shot-action-row">
          <button class="outline-button shot-video-button" type="button" data-generate-shot-video="${escape(shot.shotId)}"${shotVideoStateItem(shot.shotId, data.selectedVariantId)?.status === "running" ? " disabled" : ""}>用 ${escape(shotVideoProviderLabel())} 生成此镜头视频</button>
          ${hasPlannedEndpoints(shot) ? `<button class="outline-button shot-video-button" type="button" data-open-shot-frame-generator="${escape(shot.shotId)}"${shotFrameIsRunning(shot.shotId) ? " disabled" : ""}>生成首尾帧</button>` : ""}
          ${hasPlannedEndpoints(shot) ? renderPreviousTailReuseButton(data, shot, shotIndex) : ""}
        </div>
        ${hasPlannedEndpoints(shot) ? `<div class="shot-frame-result" data-shot-frame-result="${escape(shot.shotId)}">${renderShotFrameResult(shot.shotId)}</div>` : ""}
        <div class="shot-video-result" data-shot-video-result="${escape(shot.shotId)}">${renderShotVideoResult(shot.shotId)}</div>
      </div>
    </div>`).join("")}</div>`)}
    ${block("剪辑与声音", `<div class="data-grid">
      ${cell("节奏", data.editPlan?.sequenceRhythm)}
      ${cell("转场", (data.editPlan?.transitions || []).join(" / "))}
      ${cell("字幕", data.editPlan?.subtitlePlan)}
      ${cell("音乐音效", data.editPlan?.musicAndSfx)}
      ${cell("开头结尾", data.editPlan?.hookAndEndingNotes)}
      ${cell("模型无关说明", (data.modelAgnosticNotes || []).join("；"))}
    </div>`)}
    ${block("生成验收清单", `<div class="rule-list">${(data.generationChecklist || []).map((item) => `<div class="rule"><strong>${escape(item.check)}</strong><p>${escape(item.passCriteria)}</p></div>`).join("")}</div>`)}
    <div class="warning-box"><b>动画连续性检查：</b> ${escape(Object.values(data.continuityAndSafetyCheck || {}).filter(Boolean).join("；")) || "已通过结构校验"}</div>
    ${uncertainties(data.uncertainties)}`;
  syncAnimationAspectRatioControls(data);
  reveal(elements.animationPlan);
}

function renderVideoPromptProfileCell(plan = {}) {
  const ui = videoPromptProfileUiState(plan, shotVideoSetting());
  if (ui.status === "matched") {
    return cell("视频提示词", `${videoPromptProfileLabel(ui.current)} · 与当前模型一致`);
  }
  if (ui.status === "mismatch") {
    return cell("视频提示词", `${videoPromptProfileLabel(ui.current)} → 当前 ${videoPromptProfileLabel(ui.target)} · 尚未重写`);
  }
  if (ui.status === "unsupported_target") {
    return cell("视频提示词", `${videoPromptProfileLabel(ui.current)} · 当前模型没有 direct_shot Profile`);
  }
  return cell("视频提示词", "Plan Profile 无效 · 已阻止自动判断");
}

// 视频提示词里，风格、光线、锁定外观、签发的无配乐句这类模板内容会在每个镜头逐字重复；
// 只在本镜出现的小句才是这条 shot 真正的内容。判定依据是跨镜重复次数，不维护关键词表——
// 措辞完全由模型决定，写死一份词表必然既漏判又误伤。纯展示逻辑，不改任何字段。
const SHARED_VIDEO_PROMPT_CLAUSE_MIN_SHOTS = 2;
const VIDEO_PROMPT_CLAUSE_SPLIT = /([，。；！？\n]+)/u;

function normalizeVideoPromptClause(value) {
  return String(value || "").replace(/\s+/gu, " ").trim();
}

function sharedVideoPromptClauses(shotPlan = []) {
  const counts = new Map();
  (Array.isArray(shotPlan) ? shotPlan : []).forEach((shot) => {
    const seen = new Set();
    String(shot?.videoPrompt || "").split(VIDEO_PROMPT_CLAUSE_SPLIT).forEach((segment, index) => {
      if (index % 2) return;
      const clause = normalizeVideoPromptClause(segment);
      if (clause) seen.add(clause);
    });
    seen.forEach((clause) => counts.set(clause, (counts.get(clause) || 0) + 1));
  });
  return new Set([...counts.entries()]
    .filter(([, count]) => count >= SHARED_VIDEO_PROMPT_CLAUSE_MIN_SHOTS)
    .map(([clause]) => clause));
}

// 只加标记，不改一个字：分隔符原样保留，每段单独转义后再包 strong。
function renderVideoPromptBody(prompt, sharedClauses = new Set()) {
  return String(prompt || "").split(VIDEO_PROMPT_CLAUSE_SPLIT).map((segment, index) => {
    if (index % 2) return escape(segment);
    const clause = normalizeVideoPromptClause(segment);
    if (!clause || sharedClauses.has(clause)) return escape(segment);
    return `<strong>${escape(segment)}</strong>`;
  }).join("");
}

// 时长缺失是契约错误，不是可以静默补 4 秒的显示问题：如实显示缺失。
function formatShotDurationSeconds(shot) {
  const duration = Number(shot?.durationSeconds);
  return Number.isFinite(duration) && duration > 0 ? `${duration} 秒` : "时长缺失";
}

// direct_shot 3.1 的单镜时长由各场 timeRange 派生，只能从 shotPlan 汇总；
// 旧的首尾帧 Plan 仍旧读它自己签发的 recommendedShotDurationSeconds。
function formatAnimationShotDurationRange(plan) {
  const range = animationPlanShotDurationRange(plan);
  if (range) {
    return range.min === range.max ? `${range.min} 秒` : `${range.min}-${range.max} 秒`;
  }
  const recommended = plan?.productionStrategy?.recommendedShotDurationSeconds;
  const min = Number(recommended?.min);
  const max = Number(recommended?.max);
  return Number.isFinite(min) && Number.isFinite(max) ? `${min}-${max} 秒` : "待确认";
}

function formatAnimationPlanRuntime(summary) {
  if (!summary.valid) return `待确认（${summary.reason}）`;
  if (summary.targetSeconds === null) return `${summary.plannedSeconds} 秒`;
  if (summary.deltaSeconds === 0) return `${summary.plannedSeconds} 秒（与目标一致）`;
  const sign = summary.deltaSeconds > 0 ? "+" : "";
  return `${summary.plannedSeconds} 秒（目标 ${summary.targetSeconds} 秒，偏差 ${sign}${summary.deltaSeconds} 秒）`;
}

function renderStaticFrameCompilerLog(metadata = null) {
  const compiler = metadata?.staticFrameCompiler;
  if (!compiler || typeof compiler !== "object" || Array.isArray(compiler)) return "";
  if (compiler.disabled === true) return "";
  const runs = Array.isArray(compiler.runs) ? compiler.runs : [];
  const modificationCount = runs.reduce((total, run) => total + compilerRunModifications(run).length, 0);
  const identity = [compiler.provider, compiler.model].filter(Boolean).join(" · ") || "模型信息未记录";
  const version = compiler.version ? ` · v${compiler.version}` : "";
  const content = runs.length
    ? `<div class="compiler-run-list">${runs.map((run, index) => renderStaticFrameCompilerRun(run, index)).join("")}</div>`
    : `<p class="compiler-log-empty">已返回 Static Frame Compiler metadata，但没有运行记录。</p>`;
  return `<details class="result-block compiler-log-disclosure">
    <summary class="compiler-log-toggle">
      <span>
        <span class="block-label">Static Frame Compiler 修改日志</span>
        <span class="compiler-log-toggle-summary">${escape(identity)}${escape(version)} · ${escape(runs.length)} 次运行 · ${escape(modificationCount)} 条修改</span>
      </span>
      <span class="compiler-log-toggle-action" aria-hidden="true"></span>
    </summary>
    <div class="compiler-log">${content}</div>
  </details>`;
}

function renderStaticFrameCompilerRun(run = {}, index = 0) {
  const modifications = compilerRunModifications(run);
  const phase = {
    "post-generate": "生成后",
    "post-patch": "Patch 后",
    "second-pass": "Second-pass"
  }[run.phase] || run.phase || "未标注阶段";
  const runIdentity = [run.provider, run.model].filter(Boolean).join(" · ");
  const batch = run.batchIndex === 0 || run.batchIndex ? `Batch ${run.batchIndex}` : "Batch 未标注";
  const noOp = run.noOp === true || (run.noOp === undefined && modifications.length === 0 && compilerRunSucceeded(run));
  return `<section class="compiler-run-card">
    <div class="compiler-run-head">
      <div><strong>Run ${escape(index + 1)} · ${escape(batch)} · ${escape(phase)}</strong>${runIdentity ? `<small>${escape(runIdentity)}</small>` : ""}</div>
      <div class="compiler-flag-row">
        ${compilerFlag(noOp, "no-op", "非 no-op", "neutral")}
        ${compilerFlag(run.runAccepted, "runAccepted", "runRejected")}
      </div>
    </div>
    ${renderCompilerProtocolLog(run)}
    ${renderStaticGroundingLog(run)}
    ${modifications.length
      ? `<div class="compiler-modification-list">${modifications.map((item) => renderCompilerModification(item)).join("")}</div>`
      : `<p class="compiler-log-empty">${noOp ? "输入已经满足静态帧契约，原字段保持不变。" : "本次运行没有可展示的字段修改。"}</p>`}
  </section>`;
}

function renderStaticGroundingLog(run = {}) {
  const attempts = Array.isArray(run.attempts) ? run.attempts : [];
  const intermediateCodes = Array.isArray(run.intermediateErrorCodes)
    ? run.intermediateErrorCodes
    : [];
  const retry = run.candidateLevelBatchRetry && typeof run.candidateLevelBatchRetry === "object"
    ? run.candidateLevelBatchRetry
    : null;
  const summary = [
    `candidate ${Number(run.catalogCandidateEvidenceCount) || 0}`,
    `selected ${Number(run.selectedValidatedEvidenceCount) || 0}`,
    `unselected ${Number(run.unselectedCandidateEvidenceCount) || 0}`,
    run.repairMode ? `repairMode ${run.repairMode}` : "",
    run.errorCode ? `error ${run.errorCode}` : "",
    ...intermediateCodes.map((code) => `intermediate ${code}`),
    retry ? `Batch Retry ${retry.batchRetryTriggered ? "已触发" : "未触发"}` : ""
  ].filter(Boolean);
  if (!attempts.length && summary.length <= 3 && !run.errorCode && !run.repairMode && !retry) {
    return "";
  }
  const attemptCards = attempts.map((attempt, attemptIndex) => {
    const targetResults = Array.isArray(attempt.targets) ? attempt.targets : [];
    const searches = new Map(
      (Array.isArray(attempt.combinationSearch) ? attempt.combinationSearch : [])
        .map((search) => [search.targetId, search])
    );
    const targetRows = targetResults.map((target) => {
      const search = searches.get(target.targetId) || {};
      const dimensions = Array.isArray(target.safeDimensions) ? target.safeDimensions : [];
      return `<div class="compiler-transport-row">
        <strong>${escape(target.targetId || "target")}</strong>
        <span>required ${escape(target.requiredDimensionCount ?? 0)} · selected ${escape(target.selectedValidatedEvidenceCount ?? 0)} · unselected ${escape(target.unselectedCandidateEvidenceCount ?? 0)}</span>
        <span>${dimensions.length ? `safe ${escape(dimensions.join(" / "))}` : "safe 无"} · combinations ${escape(search.combinationTriedCount ?? 0)} · ${search.combinationAccepted ? "accepted" : "rejected"}</span>
      </div>`;
    }).join("");
    return `<div class="compiler-protocol-card">
      <div class="compiler-protocol-head">
        <strong>Grounding attempt ${escape(attempt.attempt ?? attemptIndex + 1)}</strong>
        <span>${escape(attempt.errorCode || attempt.repairMode || "validated")}</span>
      </div>
      ${targetRows || "<p class=\"compiler-transport-empty\">无 target 审核明细</p>"}
    </div>`;
  }).join("");
  return `<div class="compiler-grounding-log">
    <p class="compiler-reason"><b>Grounding</b> ${summary.map(escape).join(" · ")}</p>
    ${attemptCards ? `<div class="compiler-protocol-list">${attemptCards}</div>` : ""}
  </div>`;
}

function compilerRunSucceeded(run = {}) {
  const result = String(run.finalResult || run.result || run.status || "").toLowerCase();
  return !result || ["success", "succeeded", "accepted", "ok", "completed"].includes(result);
}

function compilerRunModifications(run = {}) {
  for (const key of ["modifications", "changes", "patches", "patchLog"]) {
    if (Array.isArray(run[key])) return run[key];
  }
  return [];
}

function renderCompilerModification(item = {}) {
  const before = item.before ?? "";
  const after = item.after ?? item.value ?? "";
  return `<article class="compiler-modification">
    <div class="compiler-modification-head">
      <strong>${escape(item.path || "未记录 path")}</strong>
      <div class="compiler-flag-row">
        ${compilerFlag(item.applied, "applied", "not applied")}
        ${compilerFlag(item.finalAccepted, "finalAccepted", "not final")}
      </div>
    </div>
    <div class="compiler-before-after">
      <div><span>Before</span><p>${escape(before)}</p></div>
      <div><span>After</span><p>${escape(after)}</p></div>
    </div>
    <p class="compiler-reason"><b>reasonCode</b> ${escape(item.reasonCode || "-")}</p>
    ${renderCompilerEvidence("triggerSpans", item.triggerSpans)}
    ${renderCompilerEvidence("visibleFacts", item.visibleFacts)}
  </article>`;
}

function renderCompilerEvidence(label, spans) {
  const values = Array.isArray(spans) ? spans : [];
  return `<div class="compiler-evidence"><b>${escape(label)}</b><div>${values.length
    ? values.map((value) => `<span>${escape(value)}</span>`).join("")
    : "<span class=\"empty\">无</span>"}</div></div>`;
}

function renderCompilerProtocolLog(run = {}) {
  const attempts = Array.isArray(run.protocolAttempts)
    ? run.protocolAttempts
    : Array.isArray(run.attempts)
      ? run.attempts
      : [];
  if (attempts.length) {
    return `<div class="compiler-protocol-list">${attempts.map((attempt, index) => renderCompilerProtocolAttempt(attempt, index)).join("")}</div>`;
  }
  const transportAttempts = compilerTransportAttempts(run);
  if (!transportAttempts.length && run.protocolAttempt === undefined) return "";
  return `<div class="compiler-protocol-list">${renderCompilerProtocolAttempt({
    protocolAttempt: run.protocolAttempt,
    transportAttempts,
    finalResult: run.finalResult,
    errorCategory: run.errorCategory,
    retryDecision: run.retryDecision
  }, 0)}</div>`;
}

function renderCompilerProtocolAttempt(attempt = {}, index = 0) {
  const attemptNumber = attempt.protocolAttempt ?? attempt.attempt ?? index + 1;
  const result = attempt.finalResult || attempt.result || attempt.status || attempt.errorCategory || "未记录结果";
  const retryDecision = attempt.retryDecision ?? attempt.retry;
  const transportAttempts = compilerTransportAttempts(attempt);
  return `<div class="compiler-protocol-card">
    <div class="compiler-protocol-head"><strong>Protocol attempt ${escape(attemptNumber)}</strong><span>${escape(structuredValue(result))}</span></div>
    ${attempt.protocolError ? `<p><b>Protocol error：</b>${escape(structuredValue(attempt.protocolError))}</p>` : ""}
    ${retryDecision === undefined ? "" : `<p><b>Protocol retry：</b>${escape(structuredValue(retryDecision))}</p>`}
    ${transportAttempts.length
      ? `<div class="compiler-transport-list">${transportAttempts.map((transport, transportIndex) => renderCompilerTransportAttempt(transport, transportIndex)).join("")}</div>`
      : `<p class="compiler-transport-empty">无 transport 明细</p>`}
  </div>`;
}

function compilerTransportAttempts(value = {}) {
  for (const key of ["transportAttempts", "transport", "requests"]) {
    if (Array.isArray(value[key])) return value[key];
  }
  return [];
}

function renderCompilerTransportAttempt(transport = {}, index = 0) {
  const attempt = transport.transportAttempt ?? transport.attempt ?? index + 1;
  const result = transport.finalResult || transport.result || transport.status || "未记录结果";
  const category = transport.errorClassification || transport.errorCategory || transport.classification || transport.errorClass || "";
  const retryDecision = transport.retryDecision ?? transport.retry;
  return `<div class="compiler-transport-row">
    <strong>Transport ${escape(attempt)}</strong>
    <span>${escape(structuredValue(result))}${category ? ` · ${escape(structuredValue(category))}` : ""}</span>
    <span>${retryDecision === undefined ? "retry 未记录" : `retry ${escape(structuredValue(retryDecision))}`}</span>
  </div>`;
}

function compilerFlag(value, trueLabel, falseLabel, falseTone = "no") {
  const label = value === true ? trueLabel : value === false ? falseLabel : "未记录";
  const tone = value === true ? "yes" : value === false ? falseTone : "neutral";
  return `<span class="compiler-flag ${tone}">${escape(label)}</span>`;
}

function renderShotNegativePromptCard(shot = {}, target = "image", label = "负面提示词") {
  return `<div class="prompt-card">${renderShotNegativePromptCardBody(shot, target, label)}</div>`;
}

function renderShotNegativePromptCardBody(shot = {}, target = "image", label = "负面提示词") {
  const entries = Array.isArray(shot?.negativePrompts?.[target]) ? shot.negativePrompts[target] : [];
  const content = entries.length
    ? `<div class="rule-list">${entries.map((entry) => renderShotNegativePromptEntry(entry)).join("")}</div>`
    : `<p class="long-copy">无</p>`;
  return `<span class="prompt-label">${escape(label)}</span>${content}`;
}

// 镜头卡片右上这一格：本镜头一有可播放的视频候选，整格就换成视频；没有视频时逐字保持
// 原来的视频负面提示词卡片。纯展示切换，不改 Plan 的 negativePrompts 字段，也不改任何 lineage。
function renderShotVideoPromptCell(shot = {}, aspectRatio) {
  return `<div class="prompt-card" data-shot-video-media="${escape(shot.shotId)}" style="${shotVideoAspectStyle(aspectRatio)}">${renderShotVideoPromptCellBody(shot)}</div>`;
}

// 候选播放器的画幅跟随当前 Plan 的 targetAspectRatio：16:9 的成片不该被塞进 9:16 的黑框里。
// 只影响播放器外框尺寸，不改任何 Plan 字段，也不碰旧 v2 首尾帧图的 9:16 预览。
function shotVideoAspectStyle(aspectRatio) {
  return normalizeAnimationPlanAspectRatio(aspectRatio) === "9:16"
    ? "--shot-video-aspect: 9 / 16; --shot-video-card-max: 165px"
    : "--shot-video-aspect: 16 / 9; --shot-video-card-max: 240px";
}

function renderShotVideoPromptCellBody(shot = {}) {
  const videos = shotVideoPlayableCandidates(shot.shotId);
  if (!videos.length) return renderShotNegativePromptCardBody(shot, "video", "视频负面提示词");
  const selectedIndex = shotVideoSelectedIndex(shotVideoStateItem(shot.shotId));
  return `<span class="prompt-label">${videos.length > 1 ? `镜头视频 · ${escape(videos.length)} 条候选` : "当前镜头视频"}</span>
    <div class="shot-video-candidate-list">${videos.map((video, index) => {
      const url = video.outputUrl || video.url || "";
      return `<div class="shot-video-result-card${index === selectedIndex ? " selected" : ""}">
        <span>${index === selectedIndex ? "当前镜头视频" : `候选 ${index + 1}`}</span>
        <video src="${escape(url)}" controls playsinline></video>
        <a href="${escape(url)}" download>下载视频</a>
      </div>`;
    }).join("")}</div>`;
}

function shotVideoPlayableCandidates(shotId) {
  const stateItem = shotVideoStateItem(shotId);
  if (!stateItem || stateItem.status === "running" || stateItem.status === "error") return [];
  const result = stateItem.result;
  const videos = Array.isArray(result?.videos) && result.videos.length ? result.videos : result?.outputUrl ? [result] : [];
  return videos.filter((video) => video?.outputUrl || video?.url);
}

function shotVideoSelectedIndex(stateItem) {
  const raw = Number(stateItem?.selectedIndex ?? stateItem?.result?.selectedIndex);
  return Number.isFinite(raw) ? raw : 0;
}

function renderShotNegativePromptEntry(entry = {}) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return `<div class="rule"><strong>无效条目</strong></div>`;
  const status = entry.enabled === false ? "已停用" : "已启用";
  return `<div class="rule">
    <strong>${escape(entry.text || "未填写负面描述")}</strong>
    <p><b>状态：</b>${escape(status)} · <b>目标：</b>${escape(entry.appliesTo || "-")} · <b>优先级：</b>${escape(entry.priority || "-")}<br>
    <b>原因：</b>${escape(entry.reasonCode || "-")}<br><b>触发证据：</b>${escape(structuredValue(entry.triggerEvidence) || "-")}</p>
  </div>`;
}

function renderCharacterReferencePrompts(items = []) {
  return `<div class="rule-list">${items.map((item, index) => {
    const key = characterReferenceStatusKey(index);
    const status = state.characterReferenceStatuses[key];
    const hasReference = Boolean(item.referenceImageAdded || item.referenceImageDataUrl);
    const statusText = status?.message || (hasReference ? "点击或拖入图片可更换人物参考图" : "点击或拖入人物参考图");
    return `<div class="rule character-reference-card${hasReference ? " has-reference-image" : ""}" data-character-reference-card="${escape(index)}" role="button" tabindex="0" aria-label="${escape(item.characterName || "角色")}人物参考图上传区">
      <div class="reference-card-top">
        <strong>${escape(item.characterName)}<br><small>${escape(item.storyRole)}</small></strong>
        ${hasReference ? `<span class="reference-image-badge">已添加人物参考图</span>` : ""}
      </div>
      <div class="character-reference-body">
        <p>${escape(item.appearancePrompt)}<br><b>一致性标签：</b>${escape((item.consistencyTags || []).join(" / "))}<br><b>禁止变化：</b>${escape((item.forbiddenChanges || []).join(" / "))}${item.referenceImageNotes ? `<br><b>参考图吸收：</b>${escape(item.referenceImageNotes)}` : ""}</p>
        <div class="character-reference-actions">
          <input class="hidden" type="file" accept="image/*" data-character-reference-input="${escape(index)}">
          <span class="character-reference-status ${escape(status?.status || "idle")}">${escape(statusText)}</span>
        </div>
      </div>
    </div>`;
  }).join("") || "<p class=\"long-copy\">无角色参考提示词。</p>"}</div>`;
}

function renderShotFramePromptCard(shotId, frameKind, label, prompt) {
  return `<div class="prompt-card shot-frame-prompt-card" data-shot-frame-prompt-card="${escape(shotId)}" data-frame-kind="${escape(frameKind)}">
    <div class="prompt-card-head">
      <span class="prompt-label">${escape(label)}</span>
      ${renderShotFrameStatusBadge(shotId, frameKind)}
    </div>
    <p>${escape(prompt)}</p>
  </div>`;
}

function renderShotFrameStatusBadge(shotId, frameKind) {
  const status = shotFrameStatus(shotId, frameKind);
  const label = status === "ready"
    ? "已添加参考图"
    : status === "pending"
      ? "待选择"
      : status === "running"
        ? "生成中"
        : status === "error"
          ? "生成失败"
          : status === "stale"
            ? "依赖已失效"
            : status === "prompt_changed"
              ? "Prompt 已变化"
              : status === "legacy_unverified"
                ? "旧结果待验证"
                : "";
  return `<span class="shot-frame-status-badge ${escape(status || "idle")}" data-shot-frame-badge="${escape(shotFrameKey(shotId, frameKind))}">${escape(label)}</span>`;
}

function openCharacterReferenceInput(indexValue) {
  const key = characterReferenceStatusKey(indexValue);
  if (state.characterReferenceStatuses[key]?.status === "running") return;
  const input = [...elements.animationPlan.querySelectorAll("[data-character-reference-input]")]
    .find((item) => String(item.dataset.characterReferenceInput) === String(indexValue));
  if (input) input.click();
}

function handleCharacterReferenceDrag(event) {
  const card = event.target.closest("[data-character-reference-card]");
  if (!card || !hasImageTransfer(event)) return;
  event.preventDefault();
  card.classList.add("dragging");
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
}

function handleCharacterReferenceDragLeave(event) {
  const card = event.target.closest("[data-character-reference-card]");
  if (!card) return;
  const nextTarget = event.relatedTarget;
  if (nextTarget && card.contains(nextTarget)) return;
  card.classList.remove("dragging");
}

function handleCharacterReferenceDrop(event) {
  const card = event.target.closest("[data-character-reference-card]");
  if (!card) return;
  event.preventDefault();
  card.classList.remove("dragging");
  const file = [...(event.dataTransfer?.files || [])].find((item) => item.type.startsWith("image/"));
  if (file) refineCharacterReferenceWithImage(card.dataset.characterReferenceCard, file);
}

function hasImageTransfer(event) {
  const items = [...(event.dataTransfer?.items || [])];
  if (items.length) return items.some((item) => item.kind === "file" && item.type.startsWith("image/"));
  return [...(event.dataTransfer?.files || [])].some((item) => item.type.startsWith("image/"));
}

async function refineCharacterReferenceWithImage(indexValue, file) {
  const index = Number(indexValue);
  const variant = selectedVariant();
  const plan = variant ? state.animationPlans[variant.id] || state.output.animationPlan : state.output.animationPlan;
  const item = plan?.characterReferencePrompts?.[index];
  if (!variant || !plan || !item) return setAnimationStatus("没有找到对应角色参考项。", "error");
  if (!file.type.startsWith("image/")) return setAnimationStatus("请选择人物图片文件。", "error");
  if (file.size > 8 * 1024 * 1024) return setAnimationStatus(`人物参考图不能超过 ${formatBytes(8 * 1024 * 1024)}。`, "error");

  const key = characterReferenceStatusKey(index);
  const planArtifactId = animationPlanArtifactId(variant.id);
  const planDependencyRefs = currentPlanDependencyRefs(variant.id);
  const planToken = beginArtifactRequest(state.production, planArtifactId, crypto.randomUUID());
  state.characterReferenceStatuses[key] = { status: "running", message: "正在用 MiMo 分析人物参考图…" };
  renderAnimationPlan(plan);
  setAnimationStatus(`正在分析 ${item.characterName || "角色"} 的人物参考图…`, "active");

  try {
    const imageDataUrl = await readFileAsDataUrl(file);
    const { referenceImageDataUrl, ...safeCharacterReference } = item;
    const refined = await api("/api/refine-character-reference", {
      imageName: file.name,
      imageDataUrl,
      characterReference: safeCharacterReference,
      creatorProfile: profile(),
      referenceAnalysis: state.output.referenceAnalysis,
      sourceScriptReconstruction: state.output.sourceScriptReconstruction,
      creativeBrief: state.output.creativeBrief,
      visualGuardrails: state.output.visualGuardrails,
      selectedVariant: variant,
      fullStory: currentFullStory(),
      animationPlan: {
        title: plan.title,
        productionStrategy: plan.productionStrategy,
        visualBible: plan.visualBible
      }
    });
    assertCurrentProductionRequest(planToken);
    // 这三个都只用于提醒展示，绝不写进 Plan Artifact。
    const { boundaryWarning = "", referenceImageOverrideNotice = "", boundaryRestoreNotice = "", ...refinedFields } = refined || {};
    const refineNotice = [referenceImageOverrideNotice, boundaryRestoreNotice, boundaryWarning].filter(Boolean).join("；");
    const updatedPlan = structuredClone(plan);
    const previousInPlan = updatedPlan.characterReferencePrompts[index];
    const updated = {
      ...previousInPlan,
      ...refinedFields,
      referenceImageAdded: true,
      referenceImageName: file.name,
      referenceImageDataUrl: imageDataUrl
    };
    updatedPlan.characterReferencePrompts[index] = updated;
    const syncedShots = syncShotCharacterReference(updatedPlan, previousInPlan, updated);
    await commitProductionArtifact({
      artifactId: planArtifactId,
      artifactType: "animationPlan",
      content: updatedPlan,
      dependencyRefs: planDependencyRefs,
      createMediaNamespace: true,
      requestToken: planToken
    });
    assertSelectedVariant(variant.id);
    state.animationPlans[variant.id] = updatedPlan;
    state.output.animationPlans = state.animationPlans;
    state.output.animationPlan = updatedPlan;
    state.characterReferenceStatuses[key] = refineNotice
      ? { status: "warn", message: refineNotice }
      : { status: "ready", message: syncedShots ? `已更新人物描述，并同步 ${syncedShots} 个镜头` : "已更新人物描述" };
    renderAnimationPlan(updatedPlan);
    setAnimationStatus(`${updated.characterName || "角色"} 已添加人物参考图，并更新了角色描述${syncedShots ? `，同步了 ${syncedShots} 个镜头提示词` : ""}。`, refineNotice ? "warn" : "ready");
    updateStoryExportActions();
  } catch (error) {
    const currentLineage = state.production.artifacts[planArtifactId];
    if (currentLineage?.status === "current" && currentLineage.revision === planToken.expectedCurrentRevision) {
      state.characterReferenceStatuses[key] = { status: "error", message: error.message || "人物参考图分析失败" };
      renderAnimationPlan(plan);
    }
    setAnimationStatus(error.message || "人物参考图分析失败", "error");
  } finally {
    finishArtifactRequest(state.production, planToken);
  }
}

function characterReferenceStatusKey(index) {
  const variant = selectedVariant();
  return `${variant?.id || "variant"}:${index}`;
}

function openCharacterImageGenerator() {
  const variant = selectedVariant();
  const plan = variant ? state.animationPlans[variant.id] || state.output.animationPlan : state.output.animationPlan;
  const items = plan?.characterReferencePrompts || [];
  if (!variant || !plan || !items.length) return setAnimationStatus("请先生成动画生产包，再生成角色参考图。", "error");
  state.characterImageGeneration.open = true;
  state.characterImageGeneration.running = false;
  state.characterImageGeneration.selectedIndex = Math.min(state.characterImageGeneration.selectedIndex || 0, items.length - 1);
  state.characterImageGeneration.count = Number(elements.characterImageCount.value) || 1;
  state.characterImageGeneration.results = [];
  state.characterImageGeneration.boundaryWarning = "";
  elements.characterImageRole.innerHTML = items.map((item, index) => `<option value="${escape(index)}">${escape(item.characterName || `角色 ${index + 1}`)} · ${escape(item.storyRole || "角色参考")}</option>`).join("");
  elements.characterImageRole.value = String(state.characterImageGeneration.selectedIndex);
  elements.characterImageCount.value = String(state.characterImageGeneration.count);
  elements.characterImageResults.innerHTML = "";
  setCharacterImageStatus(state.imageProviderConfigured ? "上传一张参考图片后即可生成。" : "未检测到 JIMENG_API_KEY，生成时会提示配置错误。", state.imageProviderConfigured ? "" : "error");
  renderCharacterImagePromptPreview();
  elements.characterImageModal.classList.remove("hidden");
  elements.characterImageModal.setAttribute("aria-hidden", "false");
}

function closeCharacterImageGenerator() {
  if (state.characterImageGeneration.running) return setCharacterImageStatus("参考图仍在生成中，完成后再关闭。", "active");
  state.characterImageGeneration.open = false;
  elements.characterImageModal.classList.add("hidden");
  elements.characterImageModal.setAttribute("aria-hidden", "true");
}

async function setCharacterImageReferenceFile(file) {
  if (!file.type.startsWith("image/")) return setCharacterImageStatus("请选择图片文件。", "error");
  if (file.size > 30 * 1024 * 1024) return setCharacterImageStatus(`参考图片不能超过 ${formatBytes(30 * 1024 * 1024)}。`, "error");
  try {
    const dataUrl = await readFileAsDataUrl(file);
    state.characterImageGeneration.referenceImageDataUrl = dataUrl;
    state.characterImageGeneration.referenceImageName = file.name;
    elements.characterImagePreview.src = dataUrl;
    elements.characterImagePreviewWrap.classList.remove("hidden");
    elements.characterImageDropTitle.textContent = file.name;
    elements.characterImageDropHint.textContent = "已载入参考图。生成时会参考它，但会移除无关背景。";
    setCharacterImageStatus("参考图片已载入。", "ready");
  } catch (error) {
    setCharacterImageStatus(error.message || "参考图片读取失败。", "error");
  }
}

function renderCharacterImagePromptPreview() {
  const count = Number(elements.characterImageCount.value) || state.characterImageGeneration.count || 1;
  // 与服务端回退路径共用同一份模板：用户在这里看到并可编辑的，就是实际发送的。
  const prompt = buildCharacterReferenceImagePrompt({
    characterReference: currentCharacterImageReference() || {},
    count,
    visualBible: currentCharacterImagePlan()?.visualBible || null
  });
  elements.characterImagePromptPreview.value = prompt || "当前角色没有可用的角色参考提示词。";
}

async function generateCharacterReferenceImages() {
  if (state.characterImageGeneration.running) return;
  const item = currentCharacterImageReference();
  if (!item) return setCharacterImageStatus("请选择要生成参考图的角色。", "error");
  if (!state.characterImageGeneration.referenceImageDataUrl) return setCharacterImageStatus("请先上传一张参考图片。", "error");
  const count = Math.max(1, Math.min(6, Number(elements.characterImageCount.value) || 1));
  const prompt = elements.characterImagePromptPreview.value.trim();
  if (!prompt) return setCharacterImageStatus("生成提示词不能为空。", "error");
  const variant = selectedVariant();
  if (!variant) return setCharacterImageStatus("当前没有选中的主题变体。", "error");
  const productionContext = currentPlanProductionContext(variant.id);
  const planLineageRef = currentPlanLineageRef(variant.id);
  const roleIndex = Number(elements.characterImageRole.value) || 0;
  state.characterImageGeneration.running = true;
  state.characterImageGeneration.count = count;
  state.characterImageGeneration.boundaryWarning = "";
  state.characterImageGeneration.results = Array.from({ length: count }, (_, index) => ({ status: "loading", imageIndex: index }));
  renderCharacterImageResults();
  setCharacterImageRunning(true);
  setCharacterImageStatus(`正在用 ${state.imageProvider} ${modelName(state.imageModel)} 生成 ${count} 张参考图…`, "active");
  try {
    await streamJsonEvents("/api/generate-character-reference-images", {
      count,
      prompt,
      referenceImageDataUrl: state.characterImageGeneration.referenceImageDataUrl,
      referenceImageName: state.characterImageGeneration.referenceImageName,
      characterReference: stripReferenceImageData(item),
      creatorProfile: profile(),
      referenceAnalysis: state.output.referenceAnalysis,
      sourceScriptReconstruction: state.output.sourceScriptReconstruction,
      creativeBrief: state.output.creativeBrief,
      visualGuardrails: state.output.visualGuardrails,
      selectedVariant: variant,
      productionContext
    }, (event) => {
      assertPlanProductionContextCurrent(productionContext);
      handleCharacterImageStreamEvent(event);
    });
    assertPlanProductionContextCurrent(productionContext);
    const readyCount = state.characterImageGeneration.results.filter((result) => result.status === "ready").length;
    if (readyCount) {
      await commitProductionArtifact({
        artifactId: `characterImages:${variant.id}:${roleIndex}`,
        artifactType: "characterImages",
        content: {
          characterName: item.characterName || "",
          results: state.characterImageGeneration.results.filter((result) => result.status === "ready")
        },
        dependencyRefs: [planLineageRef]
      });
    }
    const finalMessage = readyCount ? `已生成 ${readyCount} 张参考图，可选择一张设为人物参考图。` : "生成结束，但没有返回可用图片。";
    const finalWarning = state.characterImageGeneration.boundaryWarning;
    setCharacterImageStatus(
      finalWarning ? `${finalMessage}${finalWarning}` : finalMessage,
      readyCount ? (finalWarning ? "warn" : "ready") : "error"
    );
  } catch (error) {
    if (error.code === "STALE_MEDIA_RESULT") {
      state.characterImageGeneration.results = [];
      renderCharacterImageResults();
    }
    setCharacterImageStatus(error.message || "角色参考图生成失败。", "error");
  } finally {
    state.characterImageGeneration.running = false;
    setCharacterImageRunning(false);
  }
}

function handleCharacterImageStreamEvent(event) {
  if (event.type === "start") {
    setCharacterImageStatus(event.message || "即梦开始生成参考图…", "active");
    return;
  }
  if (event.type === "image") {
    const index = Number(event.imageIndex) || 0;
    state.characterImageGeneration.results[index] = { ...event, status: "ready" };
    renderCharacterImageResults();
    setCharacterImageStatus(`已返回第 ${index + 1} 张参考图。`, "active");
    return;
  }
  if (event.type === "image-error") {
    const index = Number(event.imageIndex) || 0;
    state.characterImageGeneration.results[index] = { ...event, status: "error" };
    renderCharacterImageResults();
    return;
  }
  if (event.type === "boundary-warning") {
    state.characterImageGeneration.boundaryWarning = event.message || "";
    if (event.message) setCharacterImageStatus(event.message, "warn");
    return;
  }
  if (event.type === "completed") {
    const generated = event.usage?.generated_images;
    if (generated) setCharacterImageStatus(`即梦生成完成：${generated} 张。`, "ready");
    return;
  }
  if (event.type === "error") {
    throw createApiRequestError(event, event.status, "角色参考图生成失败。");
  }
}

function renderCharacterImageResults() {
  const results = state.characterImageGeneration.results || [];
  elements.characterImageResults.innerHTML = results.map((item, index) => {
    if (item.status === "loading") return `<div class="generated-reference-card loading"><span>第 ${index + 1} 张生成中…</span></div>`;
    if (item.status === "error") return `<div class="generated-reference-card error"><strong>第 ${index + 1} 张失败</strong><p>${escape(item.error || "生成失败")}</p></div>`;
    return `<div class="generated-reference-card">
      <button class="generated-reference-preview-button" type="button" data-preview-generated-reference="${escape(index)}" aria-label="放大预览第 ${escape(index + 1)} 张角色参考图">
        <img src="${escape(item.url)}" alt="生成的角色参考图 ${index + 1}">
      </button>
      <small>${escape(item.size || "")} · ${escape(modelName(item.model || state.imageModel))}</small>
      <button class="outline-button" type="button" data-use-generated-reference="${escape(index)}">设为人物参考图</button>
    </div>`;
  }).join("");
}

function openGeneratedImagePreview(resultIndexValue) {
  const result = state.characterImageGeneration.results[Number(resultIndexValue)];
  if (!result?.url) return;
  elements.generatedImagePreviewImage.src = result.url;
  elements.generatedImagePreviewImage.alt = `放大的角色参考图 ${Number(resultIndexValue) + 1}`;
  elements.generatedImagePreviewCaption.textContent = `第 ${Number(resultIndexValue) + 1} 张 · ${result.size || "尺寸待确认"} · 按 Esc 关闭`;
  elements.generatedImagePreview.classList.remove("hidden");
  elements.generatedImagePreview.setAttribute("aria-hidden", "false");
  elements.closeGeneratedImagePreview.focus();
}

function openShotFramePreview(shotId, frameKindValue, candidateIndexValue = "") {
  const frameKind = frameKindValue === "end" ? "end" : "start";
  const stateItem = state.shotFrameResults[shotFrameKey(shotId, frameKind)];
  const images = stateItem?.result?.images || [];
  const candidateIndex = candidateIndexValue === "" ? Number(stateItem?.selectedIndex || stateItem?.result?.selectedIndex || 0) : Number(candidateIndexValue);
  const result = images[candidateIndex] || stateItem?.result;
  if (!result?.url) return;
  const label = frameKind === "end" ? "尾帧" : "首帧";
  elements.generatedImagePreviewImage.src = result.url;
  elements.generatedImagePreviewImage.alt = `${shotId} ${label}`;
  elements.generatedImagePreviewCaption.textContent = `${shotId} · ${label} · ${result.size || "尺寸待确认"} · 按 Esc 关闭`;
  elements.generatedImagePreview.classList.remove("hidden");
  elements.generatedImagePreview.setAttribute("aria-hidden", "false");
  elements.closeGeneratedImagePreview.focus();
}

function closeGeneratedImagePreview() {
  elements.generatedImagePreview.classList.add("hidden");
  elements.generatedImagePreview.setAttribute("aria-hidden", "true");
  elements.generatedImagePreviewImage.removeAttribute("src");
}

async function useGeneratedCharacterReference(resultIndexValue) {
  const result = state.characterImageGeneration.results[Number(resultIndexValue)];
  const roleIndex = Number(elements.characterImageRole.value);
  const variant = selectedVariant();
  const plan = variant ? state.animationPlans[variant.id] || state.output.animationPlan : state.output.animationPlan;
  const previous = plan?.characterReferencePrompts?.[roleIndex];
  if (!result?.url || !previous || !plan) return setCharacterImageStatus("没有可用的生成图或角色项。", "error");
  const planArtifactId = animationPlanArtifactId(variant.id);
  const planDependencyRefs = currentPlanDependencyRefs(variant.id);
  const planToken = beginArtifactRequest(state.production, planArtifactId, crypto.randomUUID());
  try {
    setCharacterImageStatus("正在写入角色参考图并同步镜头提示词…", "active");
    const imageDataUrl = await urlToDataUrl(result.url);
    assertCurrentProductionRequest(planToken);
    const updatedPlan = structuredClone(plan);
    const previousInPlan = updatedPlan.characterReferencePrompts[roleIndex];
    const updated = {
      ...previousInPlan,
      referenceImageAdded: true,
      referenceImageName: result.filename || `jimeng-reference-${Number(resultIndexValue) + 1}.png`,
      referenceImageDataUrl: imageDataUrl,
      referenceImageNotes: `由 ${state.imageProvider} ${modelName(result.model || state.imageModel)} 根据上传参考图生成；已要求干净背景，保留站立全身角色。`
    };
    updatedPlan.characterReferencePrompts[roleIndex] = updated;
    const syncedShots = syncShotCharacterReference(updatedPlan, previousInPlan, updated);
    await commitProductionArtifact({
      artifactId: planArtifactId,
      artifactType: "animationPlan",
      content: updatedPlan,
      dependencyRefs: planDependencyRefs,
      createMediaNamespace: true,
      requestToken: planToken
    });
    assertSelectedVariant(variant.id);
    state.animationPlans[variant.id] = updatedPlan;
    state.output.animationPlans = state.animationPlans;
    state.output.animationPlan = updatedPlan;
    state.characterReferenceStatuses[characterReferenceStatusKey(roleIndex)] = {
      status: "ready",
      message: syncedShots ? `已使用即梦生成图，并同步 ${syncedShots} 个镜头` : "已使用即梦生成图"
    };
    renderAnimationPlan(updatedPlan);
    setAnimationStatus(`${updated.characterName || "角色"} 已使用即梦生成的人物参考图${syncedShots ? `，同步了 ${syncedShots} 个镜头提示词` : ""}。`, "ready");
    setCharacterImageStatus("已设为人物参考图。", "ready");
    updateStoryExportActions();
  } catch (error) {
    setCharacterImageStatus(error.message || "写入人物参考图失败。", "error");
  } finally {
    finishArtifactRequest(state.production, planToken);
  }
}

function currentCharacterImagePlan() {
  const variant = selectedVariant();
  return variant ? state.animationPlans[variant.id] || state.output.animationPlan : state.output.animationPlan;
}

function currentCharacterImageReference() {
  const plan = currentCharacterImagePlan();
  return plan?.characterReferencePrompts?.[Number(elements.characterImageRole.value) || state.characterImageGeneration.selectedIndex || 0] || null;
}

function stripReferenceImageData(item = {}) {
  const { referenceImageDataUrl, ...safe } = item;
  return safe;
}

function setCharacterImageRunning(running) {
  elements.generateCharacterImages.classList.toggle("running", running);
  elements.generateCharacterImages.querySelector("span").textContent = running ? "参考图生成中…" : "生成参考图";
  elements.generateCharacterImages.disabled = running;
  elements.characterImageRole.disabled = running;
  elements.characterImageCount.disabled = running;
}

function setCharacterImageStatus(message, tone = "") {
  elements.characterImageStatus.textContent = message;
  elements.characterImageStatus.className = `story-status ${tone}`;
}

function renderPreviousTailReuseButton(plan = {}, shot = {}, shotIndex = -1) {
  const previousShot = Array.isArray(plan.shotPlan) && shotIndex > 0 ? plan.shotPlan[shotIndex - 1] : null;
  if (!previousShot || !canReusePreviousEndFrameAsStart(previousShot, shot)) return "";
  const previousTail = selectedShotFrameCandidate(previousShot.shotId, "end");
  const title = !previousTail
    ? `请先选择上一镜头 ${previousShot.shotId} 的尾帧`
    : `直接把 ${previousShot.shotId} 的已选尾帧复用为本镜头首帧`;
  return `<button class="outline-button shot-video-button" type="button" data-reuse-previous-tail="${escape(shot.shotId)}" title="${escape(title)}">复用上一尾帧为首帧</button>`;
}

function reusePreviousTailAsStart(shotId) {
  const context = shotFrameContext(shotId);
  const shots = context?.plan?.shotPlan || [];
  const shotIndex = shots.findIndex((shot) => String(shot.shotId) === String(shotId));
  const previousShot = shotIndex > 0 ? shots[shotIndex - 1] : null;
  const currentShot = shots[shotIndex];
  if (!previousShot || !currentShot || !canReusePreviousEndFrameAsStart(previousShot, currentShot)) {
    return setAnimationStatus("只有同 source scene、同 sceneId 且摄影机一致的相邻镜头才能复用上一尾帧。", "error");
  }
  const previousTail = selectedShotFrameCandidate(previousShot.shotId, "end");
  if (!previousTail) return setAnimationStatus(`请先选择 ${previousShot.shotId} 的尾帧。`, "error");
  const previousStartIdentity = frameCandidateIdentity(selectedShotFrameCandidate(shotId, "start"));
  const {
    dependencyHash: _dependencyHash,
    promptHash: _promptHash,
    frameReferenceMode: _frameReferenceMode,
    usedStartFrameReference: _usedStartFrameReference,
    ...startImage
  } = previousTail;
  startImage.reusedFromShotId = String(previousShot.shotId || "");
  const result = {
    images: [startImage],
    selectedIndex: 0,
    url: startImage.url || "",
    dataUrl: startImage.dataUrl || "",
    size: startImage.size || "",
    model: startImage.model || "",
    count: 1,
    actualCount: 1,
    reusedFromShotId: String(previousShot.shotId || ""),
    generatedAt: startImage.generatedAt || new Date().toISOString()
  };
  state.shotFrameResults[shotFrameKey(shotId, "start")] = {
    status: "ready",
    frameKind: "start",
    result,
    selectedIndex: 0,
    message: `已复用 ${previousShot.shotId} 的尾帧作为本镜头首帧。`
  };
  const videoModalOpen = state.shotVideoGeneration.open && String(state.shotVideoGeneration.shotId) === String(shotId);
  if (previousStartIdentity !== frameCandidateIdentity(startImage) && !videoModalOpen) refreshEndFrameDependencyState(shotId);
  updateShotFrameResult(shotId);
  if (videoModalOpen) updateShotVideoGeneratorPreview();
  setAnimationStatus(`${shotId} 已复用 ${previousShot.shotId} 的尾帧作为首帧；后续尾帧会把它计入硬依赖。`, "ready");
}

function shotFrameKey(shotId, frameKind, variantId = selectedVariant()?.id) {
  return shotFrameResultKey(variantId, shotId, frameKind);
}

function shotFrameStatus(shotId, frameKind) {
  return state.shotFrameResults[shotFrameKey(shotId, frameKind)]?.status || "";
}

function shotFrameIsRunning(shotId) {
  return shotFrameStatus(shotId, "start") === "running" || shotFrameStatus(shotId, "end") === "running";
}

function selectedShotFrameCandidate(shotId, frameKind) {
  const stateItem = state.shotFrameResults[shotFrameKey(shotId, frameKind)];
  if (!["ready", "prompt_changed", "legacy_unverified"].includes(stateItem?.status)) return null;
  return storedShotFrameCandidate(shotId, frameKind);
}

function storedShotFrameCandidate(shotId, frameKind) {
  const stateItem = state.shotFrameResults[shotFrameKey(shotId, frameKind)];
  const images = stateItem?.result?.images || [];
  const index = Number(stateItem?.selectedIndex ?? stateItem?.result?.selectedIndex ?? 0);
  return images[index] || stateItem?.result || null;
}

function selectShotFrameCandidate(shotId, frameKindValue, candidateIndexValue) {
  const frameKind = frameKindValue === "end" ? "end" : "start";
  const key = shotFrameKey(shotId, frameKind);
  const stateItem = state.shotFrameResults[key];
  const images = stateItem?.result?.images || [];
  const selectedIndex = Number(candidateIndexValue);
  if (!images[selectedIndex]) return;
  const previousCandidate = selectedShotFrameCandidate(shotId, frameKind);
  stateItem.status = frameKind === "end" && !images[selectedIndex].dependencyHash && !stateItem.result?.dependencyHash
    ? "legacy_unverified"
    : "ready";
  stateItem.selectedIndex = selectedIndex;
  stateItem.result.selectedIndex = selectedIndex;
  stateItem.result.url = images[selectedIndex].url;
  stateItem.result.dataUrl = images[selectedIndex].dataUrl;
  if (frameKind === "end") {
    stateItem.result.frameReferenceMode = images[selectedIndex].frameReferenceMode || stateItem.result.frameReferenceMode || "";
    stateItem.result.dependencyHash = images[selectedIndex].dependencyHash || stateItem.result.dependencyHash || "";
    stateItem.result.promptHash = images[selectedIndex].promptHash || stateItem.result.promptHash || "";
  }
  state.shotFrameResults[key] = stateItem;
  const selectionChanged = frameCandidateIdentity(previousCandidate) !== frameCandidateIdentity(images[selectedIndex]);
  const videoModalOpen = state.shotVideoGeneration.open && String(state.shotVideoGeneration.shotId) === String(shotId);
  if (frameKind === "start" && selectionChanged && !videoModalOpen) refreshEndFrameDependencyState(shotId);
  updateShotFrameResult(shotId);
  if (videoModalOpen) updateShotVideoGeneratorPreview();
  setAnimationStatus(`${shotId} ${frameKind === "end" ? "尾帧" : "首帧"}已切换为第 ${selectedIndex + 1} 张，并添加到镜头。`, "ready");
}

function frameCandidateIdentity(candidate = {}) {
  return String(candidate.dataUrl || candidate.url || "");
}

async function refreshEndFrameDependencyState(shotId) {
  if (!state.shotFrameResults[shotFrameKey(shotId, "end")]) return;
  await evaluateShotVideoEndpoints(shotId);
}

function useModalShotFrameCandidate(shotId, frameKindValue, candidateIndexValue) {
  selectShotFrameCandidate(shotId, frameKindValue, candidateIndexValue);
  renderShotFrameImageResults();
  const frameKind = frameKindValue === "end" ? "尾帧" : "首帧";
  setShotFrameImageStatus(`已将第 ${Number(candidateIndexValue) + 1} 张设为${frameKind}参考图。`, "ready");
}

function cssEscape(value) {
  if (window.CSS?.escape) return window.CSS.escape(String(value));
  return String(value).replace(/["\\]/gu, "\\$&");
}

async function openShotFrameImageGenerator(shotId, frameKindValue = "start") {
  const context = shotFrameContext(shotId);
  if (!context || !hasPlannedEndpoints(context.shot)) {
    // 暂时弃置，后续优化或删除：direct_shot 不开放首尾帧生成入口；旧 v2 弹窗实现保留在下方。
    setAnimationStatus("当前 direct_shot 镜头不生成首尾帧。", "error");
    return;
  }
  const frameKind = frameKindValue === "end" ? "end" : "start";
  state.shotFrameImageGeneration.open = true;
  state.shotFrameImageGeneration.running = false;
  state.shotFrameImageGeneration.shotId = String(shotId);
  state.shotFrameImageGeneration.frameKind = frameKind;
  state.shotFrameImageGeneration.frameReferenceMode = "";
  state.shotFrameImageGeneration.referenceManifest = null;
  state.shotFrameImageGeneration.count = Number(elements.shotFrameImageCount.value) || 4;
  elements.shotFrameImageKind.value = frameKind;
  elements.shotFrameImageModal.classList.remove("hidden");
  elements.shotFrameImageModal.setAttribute("aria-hidden", "false");
  setShotFrameImageStatus("正在整理端点状态与参考图…", "active");
  if (!await updateShotFrameImageGeneratorPreview({ resetMode: true })) return;
  setShotFrameImageGeneratorRunning(false);
  renderShotFrameImageResults();
  elements.shotFrameImagePromptPreview.focus();
}

async function updateShotFrameImageGeneratorPreview(options = {}) {
  if (!state.shotFrameImageGeneration.open) return true;
  const revision = ++state.shotFrameImageGeneration.previewRevision;
  elements.confirmGenerateShotFrameImage.disabled = true;
  const shotId = state.shotFrameImageGeneration.shotId;
  const frameKind = elements.shotFrameImageKind.value === "end" ? "end" : "start";
  const context = shotFrameContext(shotId);
  if (!context) {
    setAnimationStatus("没有找到对应镜头。", "error");
    return false;
  }
  const { shot, plan } = context;
  const label = frameKind === "end" ? "尾帧" : "首帧";
  const structuredEndpointShot = hasStructuredEndpointState(shot);
  state.shotFrameImageGeneration.frameKind = frameKind;
  elements.shotFrameImageModalTitle.textContent = `生成${label}镜头`;
  elements.confirmGenerateShotFrameImageLabel.textContent = `生成${label}`;
  elements.shotFrameImageMeta.textContent = `${shot.shotId || "镜头"} · ${shot.sourceSceneId || "未标注场次"} · ${formatShotDurationSeconds(shot)} · 参考顺序由统一清单锁定`;
  elements.shotFrameReferenceModeField.classList.toggle("hidden", frameKind !== "end" || !structuredEndpointShot);
  elements.shotFrameReferenceModeHint.classList.toggle("hidden", frameKind !== "end" || !structuredEndpointShot);
  let frameReferenceMode = "";
  if (frameKind === "end" && structuredEndpointShot) {
    try {
      const inferredMode = resolveFrameReferenceMode(shot);
      const currentMode = elements.shotFrameReferenceMode.value;
      frameReferenceMode = options.resetMode || !["inherit", "transition", "independent"].includes(currentMode)
        ? inferredMode
        : currentMode;
      elements.shotFrameReferenceMode.value = frameReferenceMode;
      state.shotFrameImageGeneration.frameReferenceMode = frameReferenceMode;
      elements.shotFrameReferenceModeHint.textContent = frameReferenceModeHint(frameReferenceMode);
    } catch (error) {
      elements.confirmGenerateShotFrameImage.disabled = true;
      setShotFrameImageStatus(error.message || "首尾帧场景关系无效。", "error");
      return false;
    }
  } else {
    state.shotFrameImageGeneration.frameReferenceMode = "";
  }
  let referenceContext;
  try {
    referenceContext = await buildShotFrameReferenceContext({ shot, plan, frameKind, frameReferenceMode });
  } catch (error) {
    if (revision !== state.shotFrameImageGeneration.previewRevision) return false;
    elements.confirmGenerateShotFrameImage.disabled = true;
    elements.shotFrameImagePromptPreview.value = "";
    elements.shotFrameReferenceList.innerHTML = "<p>当前策略需要先选择首帧视觉参考；系统不会自动改成 independent。</p>";
    setShotFrameImageStatus(error.message || "参考图读取失败。", "error");
    return false;
  }
  if (revision !== state.shotFrameImageGeneration.previewRevision) return false;
  const { characterReferences, sceneReference, manifest, startFrameDataUrl } = referenceContext;
  state.shotFrameImageGeneration.referenceManifest = manifest;
  elements.shotFrameReferenceList.innerHTML = renderShotFrameReferenceUploadList(manifest, {
    frameKind,
    frameReferenceMode,
    missingStartFrame: frameKind === "end" && frameReferenceMode !== "independent" && !startFrameDataUrl
  });
  const basePrompt = buildShotFrameImagePrompt({
    frameKind,
    shot,
    visualBible: plan.visualBible || {},
    characterReferences,
    sceneReference,
    referenceManifest: manifest,
    frameReferenceMode
  });
  const negativePromptApplication = compileShotFrameNegativePrompt(shot);
  elements.shotFrameImagePromptPreview.value = appendMissingPromptLines(basePrompt, negativePromptApplication.positiveConstraints);
  renderShotFrameImageResults();
  const blockReason = shotFrameGenerationBlockReason({ shot, frameKind, frameReferenceMode, startFrameDataUrl });
  elements.confirmGenerateShotFrameImage.disabled = Boolean(blockReason);
  setShotFrameImageStatus(
    blockReason || (!structuredEndpointShot && frameKind === "end"
      ? "旧版镜头按兼容流程生成；结果可预览，但需重新生成 v2 动画计划后才能获得视频硬依赖校验。"
      : frameKind === "end" && frameReferenceMode === "independent" && !selectedShotFrameCandidate(shotId, "start")
      ? "可以独立生成尾帧；生成视频前仍需选择首帧。"
      : ""),
    blockReason ? "error" : ""
  );
  return true;
}

async function buildShotFrameReferenceContext({ shot, plan, frameKind, frameReferenceMode }) {
  const characterReferences = shotRelatedCharacterReferences(shot, plan.characterReferencePrompts || [], { frameKind });
  const sceneReference = sceneReferenceForShot(plan, shot);
  let startFrameDataUrl = "";
  let endpointReference = null;
  if (frameKind === "end" && ["inherit", "transition"].includes(frameReferenceMode)) {
    const selectedStart = selectedShotFrameCandidate(shot.shotId, "start");
    if (selectedStart) {
      startFrameDataUrl = await frameCandidateDataUrl(selectedStart);
      endpointReference = {
        role: "start_frame",
        dataUrl: startFrameDataUrl,
        sourceShotId: String(shot.shotId || "")
      };
    }
  }
  const manifest = await buildFrameReferenceManifest({
    frameKind: frameKind === "end" && !hasStructuredEndpointState(shot) ? "start" : frameKind,
    frameReferenceMode,
    endpointReference,
    characterReferences,
    maxProviderImages: 6
  });
  return { characterReferences, sceneReference, manifest, startFrameDataUrl, endpointReference };
}

function frameReferenceModeHint(mode) {
  if (mode === "inherit") return "首帧作为强视觉基底；保持同一场景、机位、构图和光线，只改变 EndState 声明的可见状态。";
  if (mode === "transition") return "仅限同一 sceneId；首帧锁定身份与场景内容，尾帧可采用 EndState 声明的新机位、构图或光线。";
  return "尾帧只读取 EndState 和角色参考图，不上传首帧；最终生成视频时仍必须选择首帧。";
}

function shotFrameGenerationBlockReason({ shot, frameKind, frameReferenceMode, startFrameDataUrl }) {
  if (frameKind !== "end") return "";
  if (!hasStructuredEndpointState(shot)) {
    return shot?.endFramePrompt ? "" : "旧版镜头缺少尾帧提示词，无法生成。";
  }
  if (!shot?.endFrame) return "尾帧缺少 EndState，无法生成。";
  if (!["inherit", "transition", "independent"].includes(frameReferenceMode)) return "请选择有效的尾帧参考策略。";
  if (frameReferenceMode !== "independent" && !startFrameDataUrl) return "当前策略需要已选择的首帧；请先生成并选择首帧，或显式切换为“独立尾帧”。";
  try {
    validateFrameReferenceMode(shot, frameReferenceMode, {
      hasStartFrameReference: Boolean(startFrameDataUrl)
    });
  } catch (error) {
    return error.message || "当前尾帧参考策略与端点状态不兼容。";
  }
  return "";
}

function hasStructuredEndpointState(shot = {}) {
  return Boolean(shot?.startFrame && shot?.endFrame && shot?.motion);
}

function appendMissingPromptLines(prompt, lines = []) {
  const additions = (Array.isArray(lines) ? lines : [])
    .map((line) => String(line || "").trim())
    .filter((line) => line && !String(prompt || "").includes(line));
  return additions.length
    ? [String(prompt || "").trim(), ...additions].filter(Boolean).join("\n")
    : String(prompt || "").trim();
}

function shotFrameContext(shotId) {
  const variant = selectedVariant();
  const plan = variant ? state.animationPlans[variant.id] || state.output.animationPlan : state.output.animationPlan;
  const shot = (plan?.shotPlan || []).find((item) => String(item.shotId) === String(shotId));
  return shot && plan ? { variant, plan, shot } : null;
}

function previousShotVideoReferenceContext(shotId) {
  const context = shotFrameContext(shotId);
  if (!context?.variant) return { available: false, reason: "当前没有可用的主题变体或 Animation Plan。" };
  const previousShot = previousShotInPlan(context.plan, shotId);
  if (!previousShot) return { available: false, reason: "当前镜头是计划中的第一镜，没有上个镜头内容。" };
  const planLineage = state.production.artifacts[animationPlanArtifactId(context.variant.id)];
  const sourceArtifactId = shotVideoArtifactId(context.variant.id, previousShot.shotId);
  const sourceLineage = state.production.artifacts[sourceArtifactId];
  const belongsToCurrentPlan = sourceLineage?.status === "current"
    && (sourceLineage.dependencies || []).some((dependency) => (
      dependency.artifactId === planLineage?.artifactId
      && dependency.revision === planLineage?.revision
      && dependency.contentDigest === planLineage?.contentDigest
    ));
  if (!belongsToCurrentPlan) {
    return { available: false, previousShot, reason: `${previousShot.shotId} 没有属于当前 Plan 的可用视频。` };
  }
  const candidate = selectedShotVideoCandidate(shotVideoStateItem(previousShot.shotId, context.variant.id));
  if (!candidate) {
    return { available: false, previousShot, reason: `${previousShot.shotId} 尚未生成并选择可用的视频候选。` };
  }
  // 抽帧数已固定为 5 张，不再随时长变化；这里只需要确认上一镜时长有效。
  // 5 张与本镜角色参考图共用 9 图上限，超限由服务端 validateAllReferenceArtifacts 明确拦截。
  const estimatedFrameCount = previousShotReferenceFrameCount(previousShot.durationSeconds);
  if (!estimatedFrameCount) {
    return {
      available: false,
      previousShot,
      reason: `${previousShot.shotId} 的时长无效，无法抽取参考帧。`
    };
  }
  return {
    available: true,
    previousShot,
    candidate,
    sourceArtifactId,
    sourceLineage,
    estimatedFrameCount
  };
}
function sceneReferenceForShot(plan = {}, shot = {}) {
  const scenes = Array.isArray(plan.sceneReferencePrompts) ? plan.sceneReferencePrompts : [];
  return scenes.find((item) => String(item.sceneId || "") === String(shot.sceneId || ""))
    || scenes.find((item) => String(item.sceneId || "") === String(shot.sourceSceneId || ""))
    || null;
}

function closeShotFrameImageGenerator() {
  if (state.shotFrameImageGeneration.running) return setShotFrameImageStatus("镜头帧图片仍在生成中，完成后再关闭。", "active");
  state.shotFrameImageGeneration.open = false;
  state.shotFrameImageGeneration.previewRevision += 1;
  elements.shotFrameImageModal.classList.add("hidden");
  elements.shotFrameImageModal.setAttribute("aria-hidden", "true");
}

async function confirmGenerateShotFrameImage() {
  if (state.shotFrameImageGeneration.running) return;
  const shotId = state.shotFrameImageGeneration.shotId;
  const frameKind = elements.shotFrameImageKind.value === "end" ? "end" : "start";
  state.shotFrameImageGeneration.frameKind = frameKind;
  try {
    const context = shotFrameContext(shotId);
    if (!context) throw new Error("没有找到对应镜头。");
    const frameReferenceMode = frameKind === "end" && hasStructuredEndpointState(context.shot)
      ? elements.shotFrameReferenceMode.value
      : "";
    const referenceContext = await buildShotFrameReferenceContext({
      ...context,
      frameKind,
      frameReferenceMode
    });
    const blockReason = shotFrameGenerationBlockReason({
      shot: context.shot,
      frameKind,
      frameReferenceMode,
      startFrameDataUrl: referenceContext.startFrameDataUrl
    });
    if (blockReason) throw new Error(blockReason);
    const prompt = elements.shotFrameImagePromptPreview.value.trim();
    if (!prompt) throw new Error("提示词不能为空。");
    const count = Math.max(1, Math.min(6, Number(elements.shotFrameImageCount.value) || 1));
    const dependencyHash = frameKind === "end" && frameReferenceMode
      ? await computeDependencyHash({
        startImageDataUrl: referenceContext.startFrameDataUrl,
        endState: context.shot.endFrame,
        referenceImages: referenceContext.manifest.additionalReferences,
        frameReferenceMode
      })
      : "";
    const promptHash = frameKind === "end" && frameReferenceMode
      ? await computePromptHash(buildShotFrameMultiImagePrompt(prompt, count))
      : "";
    setShotFrameImageGeneratorRunning(true);
    setShotFrameImageStatus(`正在用即梦生成${frameKind === "end" ? "尾帧" : "首帧"}图片…`, "active");
    state.shotFrameImageGeneration.count = count;
    await generateShotFrameImage(shotId, frameKind, prompt, {
      count,
      throwOnError: true,
      frameReferenceMode,
      referenceContext,
      dependencyHash,
      promptHash
    });
    const actualCount = state.shotFrameResults[shotFrameKey(shotId, frameKind)]?.result?.images?.length || count;
    setShotFrameImageStatus(`已生成 ${actualCount} 张${frameKind === "end" ? "尾帧" : "首帧"}候选图，请选择一张添加到镜头。`, "ready");
    setShotFrameImageGeneratorRunning(false);
  } catch (error) {
    setShotFrameImageStatus(error.message || "镜头帧图片生成失败", "error");
  } finally {
    if (state.shotFrameImageGeneration.running) setShotFrameImageGeneratorRunning(false);
  }
}

function setShotFrameImageGeneratorRunning(running) {
  state.shotFrameImageGeneration.running = running;
  elements.shotFrameImageKind.disabled = running;
  elements.shotFrameReferenceMode.disabled = running;
  elements.shotFrameImagePromptPreview.disabled = running;
  elements.shotFrameImageCount.disabled = running;
  if (running) {
    elements.confirmGenerateShotFrameImage.disabled = true;
  } else {
    const context = shotFrameContext(state.shotFrameImageGeneration.shotId);
    const frameKind = elements.shotFrameImageKind.value === "end" ? "end" : "start";
    const mode = frameKind === "end" ? elements.shotFrameReferenceMode.value : "";
    const manifest = state.shotFrameImageGeneration.referenceManifest;
    const hasStart = Boolean(manifest?.endpointReference?.dataUrl);
    elements.confirmGenerateShotFrameImage.disabled = Boolean(context && shotFrameGenerationBlockReason({
      shot: context.shot,
      frameKind,
      frameReferenceMode: mode,
      startFrameDataUrl: hasStart ? manifest.endpointReference.dataUrl : ""
    }));
  }
  elements.closeShotFrameImageModal.disabled = running;
}

function setShotFrameImageStatus(message, tone = "") {
  elements.shotFrameImageStatus.textContent = message;
  elements.shotFrameImageStatus.className = `story-status ${tone}`;
}

function renderShotFrameImageResults() {
  if (!state.shotFrameImageGeneration.open) return;
  const shotId = state.shotFrameImageGeneration.shotId;
  const frameKind = elements.shotFrameImageKind.value === "end" ? "end" : "start";
  const label = frameKind === "end" ? "尾帧" : "首帧";
  const stateItem = state.shotFrameResults[shotFrameKey(shotId, frameKind)];
  if (!stateItem) {
    elements.shotFrameImageResults.innerHTML = "";
    return;
  }
  if (stateItem.status === "running") {
    elements.shotFrameImageResults.innerHTML = `<div class="generated-reference-card loading"><span>${label}候选图生成中…</span></div>`;
    return;
  }
  if (stateItem.status === "error") {
    elements.shotFrameImageResults.innerHTML = `<div class="generated-reference-card error"><strong>${label}生成失败</strong><p>${escape(stateItem.message || "生成失败")}</p></div>`;
    return;
  }
  const images = stateItem.result?.images || [];
  if (!images.length) {
    elements.shotFrameImageResults.innerHTML = "";
    return;
  }
  const selectedIndex = Number.isFinite(Number(stateItem.selectedIndex)) ? Number(stateItem.selectedIndex) : -1;
  const referenceCountText = Number.isFinite(Number(stateItem.result?.referenceImageCount)) ? ` · 参考图 ${Number(stateItem.result.referenceImageCount)} 张` : "";
  const stateNotice = ["stale", "prompt_changed", "legacy_unverified"].includes(stateItem.status)
    ? `<p class="${escape(stateItem.status)}">${escape(stateItem.message || frameStatusDescription(stateItem.status))}</p>`
    : "";
  elements.shotFrameImageResults.innerHTML = `${stateNotice}${images.map((image, index) => `<div class="generated-reference-card shot-frame-candidate${index === selectedIndex ? " selected" : ""}">
    <button class="generated-reference-preview-button" type="button" data-preview-modal-shot-frame="${escape(shotId)}" data-frame-kind="${escape(frameKind)}" data-candidate-index="${escape(index)}" aria-label="放大预览 ${escape(shotId)} ${label}第 ${escape(index + 1)} 张">
      <img src="${escape(image.url)}" alt="${escape(shotId)} ${label}候选 ${index + 1}">
    </button>
    <small>${escape(label)}候选 ${escape(index + 1)} · ${escape(image.size || stateItem.result?.size || "")} · ${escape(modelName(image.model || stateItem.result?.model || state.imageModel))}${escape(referenceCountText)}</small>
    <button class="outline-button" type="button" data-select-modal-shot-frame="${escape(shotId)}" data-frame-kind="${escape(frameKind)}" data-candidate-index="${escape(index)}">${index === selectedIndex ? `已设为${label}参考图` : `设为${label}参考图`}</button>
  </div>`).join("")}`;
}

function renderShotFrameReferenceUploadList(manifest = {}, options = {}) {
  const images = Array.isArray(manifest.providerImages) ? manifest.providerImages : [];
  const warning = options.missingStartFrame
    ? "<p>当前策略需要首帧视觉参考，但尚未选择首帧。系统不会自动降级为独立模式。</p>"
    : "";
  if (!images.length) {
    return `${warning}<p>当前没有可上传的视觉参考；图片只会读取结构化端点状态与文字角色设定。</p>`;
  }
  return `<div>
    ${warning}
    <span class="block-label">统一参考图清单 · ${escape(images.length)} 张图片</span>
    <div class="shot-frame-reference-grid">
      ${images.map((item) => `<div class="shot-frame-reference-card">
        <strong>${escape(item.role === "start_frame" ? "已选首帧 · 视觉基底" : item.characterName || "角色参考")}</strong>
        <small>${escape(item.token)} · ${escape(item.role === "start_frame" ? "端点参考" : "身份参考")}</small>
      </div>`).join("")}
    </div>
  </div>`;
}

async function openShotVideoGenerator(shotId) {
  state.shotVideoGeneration.open = true;
  state.shotVideoGeneration.running = false;
  state.shotVideoGeneration.shotId = String(shotId);
  state.shotVideoGeneration.count = Number(elements.shotVideoCount.value) || 1;
  state.shotVideoGeneration.referenceAssets = [];
  state.shotVideoGeneration.includePreviousShotFrames = false;
  elements.shotVideoGenerationMode.value = state.shotVideoGeneration.generationMode;
  elements.shotVideoIncludePreviousShotFrames.checked = false;
  elements.shotVideoIncludeEndpointFrames.checked = state.shotVideoGeneration.includeEndpointFrames;
  elements.shotVideoIncludeCharacterReferences.checked = state.shotVideoGeneration.includeCharacterReferences;
  setShotVideoGeneratorRunning(false);
  elements.shotVideoModal.classList.remove("hidden");
  elements.shotVideoModal.setAttribute("aria-hidden", "false");
  setShotVideoStatus("正在校验视频参考素材…", "active");
  if (!await updateShotVideoGeneratorPreview()) return;
  renderShotVideoModalResults();
  elements.shotVideoPromptPreview.focus();
}

async function updateShotVideoGeneratorPreview(options = {}) {
  if (!state.shotVideoGeneration.open) return true;
  const validationRevision = ++state.shotVideoGeneration.validationRevision;
  const shotId = state.shotVideoGeneration.shotId;
  const context = shotFrameContext(shotId);
  if (!context) {
    setAnimationStatus("没有找到对应镜头。", "error");
    return false;
  }
  const { shot, plan } = context;
  const generationMode = normalizeShotVideoGenerationMode(state.shotVideoGeneration.generationMode);
  state.shotVideoGeneration.generationMode = generationMode;
  elements.shotVideoGenerationMode.value = generationMode;
  elements.shotVideoAllReferenceControls.classList.toggle("hidden", generationMode !== "all_reference");
  elements.shotVideoEndpointReferenceToggle.classList.toggle("hidden", !hasPlannedEndpoints(shot));
  const previousReference = previousShotVideoReferenceContext(shotId);
  elements.shotVideoIncludePreviousShotFrames.disabled = state.shotVideoGeneration.running || !previousReference.available;
  const count = Math.max(1, Math.min(4, Number(state.shotVideoGeneration.count) || Number(elements.shotVideoCount.value) || 1));
  elements.shotVideoCount.value = String(count);
  elements.shotVideoModalTitle.textContent = `用 ${shotVideoProviderLabel()} 生成 ${shot.shotId || "镜头"} 视频`;
  const promptProfileUi = videoPromptProfileUiState(plan, shotVideoSetting());
  const promptProfileStatus = promptProfileUi.status === "matched"
    ? `${videoPromptProfileLabel(promptProfileUi.current)} 提示词匹配`
    : promptProfileUi.status === "mismatch"
      ? `当前 ${videoPromptProfileLabel(promptProfileUi.target)} · Plan 为 ${videoPromptProfileLabel(promptProfileUi.current)} 提示词`
      : `当前模型与 Plan 提示词 Profile 未匹配`;
  elements.shotVideoMeta.textContent = `${shot.shotId || "镜头"} · ${shot.sourceSceneId || "未标注场次"} · ${formatShotDurationSeconds(shot)} · ${normalizeAnimationPlanAspectRatio(plan.productionStrategy?.targetAspectRatio)} · ${promptProfileStatus} · ${generationMode === "all_reference"
    ? "多模态参考生成，不锁定精确首尾帧"
    : hasPlannedEndpoints(shot)
      ? "精确锁定已添加的首帧/尾帧"
      : "当前镜头没有端点；首尾帧模式不可用"}`;
  elements.shotVideoReferenceList.innerHTML = renderShotVideoReferenceList(shotId);
  if (!options.preservePrompt || !elements.shotVideoPromptPreview.value.trim()) {
    elements.shotVideoPromptPreview.value = buildShotVideoPromptPreview(
      shot,
      plan.promptSchemaVersion,
      plan.productionStrategy?.videoPromptProfile
    );
  }
  const validation = await evaluateShotVideoReferences(shotId);
  if (validationRevision !== state.shotVideoGeneration.validationRevision || validation.cancelled) return false;
  elements.shotVideoReferenceList.innerHTML = renderShotVideoReferenceList(shotId);
  setShotVideoStatus(validation.message, validation.ok ? (validation.status === "prompt_changed" ? "active" : "") : "error");
  elements.confirmGenerateShotVideo.disabled = !validation.ok;
  return true;
}

function evaluateShotVideoReferences(shotId) {
  return state.shotVideoGeneration.generationMode === "all_reference"
    ? evaluateAllReferenceAssets(shotId)
    : evaluateShotVideoEndpoints(shotId);
}

async function evaluateAllReferenceAssets(shotId) {
  const context = shotFrameContext(shotId);
  if (!context) return { ok: false, message: "没有找到对应镜头。" };
  const provider = shotVideoSetting().provider;
  if (!shotVideoModeSupported(provider, "all_reference")) {
    return {
      ok: false,
      message: provider === "Kling"
        ? "当前可灵接入是官方首尾帧 image-to-video 接口，尚无已验证的 Omni API 协议；全能参考请选择 Seedance 2.0 或 MiniMax H3。"
        : `${shotVideoProviderLabel(provider)} 当前不支持全能参考模式。`
    };
  }
  const previousReference = previousShotVideoReferenceContext(shotId);
  if (state.shotVideoGeneration.includePreviousShotFrames && !previousReference.available) {
    return { ok: false, message: previousReference.reason };
  }
  const assets = allReferenceAssetDescriptors(shotId);
  const issue = validateAllReferenceAssetDescriptors(assets);
  if (issue) return { ok: false, message: issue };
  const counts = referenceAssetCounts(assets);
  return {
    ok: true,
    status: "ready",
    message: `全能参考已就绪：${counts.image} 图、${counts.video} 视频、${counts.audio} 音频。${state.shotVideoGeneration.includePreviousShotFrames
      ? `${previousReference.previousShot.shotId} 将由服务端 FFmpeg 均匀抽取 ${previousReference.estimatedFrameCount} 张（首帧、末帧和中间三等分点）；`
      : ""}它们只作为参考，不会被解释为精确首帧或尾帧。`
  };
}

async function evaluateShotVideoEndpoints(shotId) {
  const context = shotFrameContext(shotId);
  if (!context) return { ok: false, message: "没有找到对应镜头。" };
  if (!hasPlannedEndpoints(context.shot)) {
    return {
      ok: false,
      status: "endpointless",
      message: "当前 direct_shot 镜头没有首尾帧。请显式选择“全能参考”模式并添加受支持的图片或视频参考；系统不会自动切换生成模式。"
    };
  }
  const startCandidate = selectedShotFrameCandidate(shotId, "start");
  if (!startCandidate) return { ok: false, message: "请先生成并选择该镜头的首帧参考图。" };
  const endKey = shotFrameKey(shotId, "end");
  const endStateItem = state.shotFrameResults[endKey];
  if (!endStateItem) return { ok: false, message: "请先生成并选择该镜头的尾帧参考图。" };
  if (endStateItem.status === "running") return { ok: false, message: "尾帧仍在生成中，请等待完成。" };
  if (endStateItem.status === "error") return { ok: false, message: endStateItem.message || "尾帧生成失败，请重新生成。" };
  const endCandidate = storedShotFrameCandidate(shotId, "end");
  if (!frameCandidateIdentity(endCandidate)) return { ok: false, message: "请先从候选图中选择一张尾帧。" };
  const dependencyHash = endCandidate?.dependencyHash || endStateItem.result?.dependencyHash || "";
  const frameReferenceMode = endCandidate?.frameReferenceMode || endStateItem.result?.frameReferenceMode || "";
  const endpointIdentity = currentVideoEndpointIdentity(shotId);
  const endpointsUnchanged = () => currentVideoEndpointIdentity(shotId) === endpointIdentity;
  if (!dependencyHash || !["inherit", "transition", "independent"].includes(frameReferenceMode)) {
    endStateItem.status = "legacy_unverified";
    endStateItem.message = "旧尾帧没有硬依赖校验信息；可以预览，但生成新视频前必须重新生成尾帧。";
    state.shotFrameResults[endKey] = endStateItem;
    updateShotFrameResult(shotId);
    return { ok: false, status: "legacy_unverified", message: endStateItem.message };
  }
  let referenceContext;
  let currentDependencyHash;
  try {
    referenceContext = await buildShotFrameReferenceContext({
      shot: context.shot,
      plan: context.plan,
      frameKind: "end",
      frameReferenceMode
    });
    currentDependencyHash = await computeDependencyHash({
      startImageDataUrl: referenceContext.startFrameDataUrl,
      endState: context.shot.endFrame,
      referenceImages: referenceContext.manifest.additionalReferences,
      frameReferenceMode
    });
  } catch (error) {
    if (!endpointsUnchanged()) return { ok: false, cancelled: true, message: "首尾帧选择已变化，正在重新校验。" };
    return { ok: false, status: endStateItem.status, message: error.message || "当前无法验证尾帧硬依赖，请检查首帧和角色参考图。" };
  }
  if (!endpointsUnchanged()) return { ok: false, cancelled: true, message: "首尾帧选择已变化，正在重新校验。" };
  if (currentDependencyHash !== dependencyHash) {
    endStateItem.status = "stale";
    endStateItem.message = "尾帧的首图、EndState、角色参考图或参考策略已变化，请重新生成尾帧。";
    state.shotFrameResults[endKey] = endStateItem;
    updateShotFrameResult(shotId);
    return { ok: false, status: "stale", message: endStateItem.message };
  }
  try {
    const currentPrompt = appendMissingPromptLines(buildShotFrameImagePrompt({
      frameKind: "end",
      shot: context.shot,
      visualBible: context.plan.visualBible || {},
      characterReferences: referenceContext.characterReferences,
      sceneReference: referenceContext.sceneReference,
      referenceManifest: referenceContext.manifest,
      frameReferenceMode
    }), compileShotFrameNegativePrompt(context.shot).positiveConstraints);
    const generatedCount = Math.max(1, Number(endStateItem.result?.count) || 1);
    const currentPromptHash = await computePromptHash(buildShotFrameMultiImagePrompt(currentPrompt, generatedCount));
    if (!endpointsUnchanged()) return { ok: false, cancelled: true, message: "首尾帧选择已变化，正在重新校验。" };
    const generatedPromptHash = endCandidate?.promptHash || endStateItem.result?.promptHash || "";
    if (generatedPromptHash && currentPromptHash !== generatedPromptHash) {
      endStateItem.status = "prompt_changed";
      endStateItem.message = "当前尾帧 Prompt 与生成时不同，但硬依赖仍匹配，可以继续生成视频。";
      state.shotFrameResults[endKey] = endStateItem;
      updateShotFrameResult(shotId);
      return { ok: true, status: "prompt_changed", message: endStateItem.message };
    }
  } catch (error) {
    if (!endpointsUnchanged()) return { ok: false, cancelled: true, message: "首尾帧选择已变化，正在重新校验。" };
    // promptHash is provenance only; a prompt-compilation problem must not invalidate hard endpoint dependencies.
  }
  endStateItem.status = "ready";
  endStateItem.message = "首尾帧硬依赖已验证，可以生成视频。";
  state.shotFrameResults[endKey] = endStateItem;
  updateShotFrameResult(shotId);
  return { ok: true, status: "ready", message: "首尾帧硬依赖已验证，确认提示词和数量后即可生成视频。" };
}

function currentVideoEndpointIdentity(shotId) {
  const startStateItem = state.shotFrameResults[shotFrameKey(shotId, "start")];
  const endStateItem = state.shotFrameResults[shotFrameKey(shotId, "end")];
  const startCandidate = storedShotFrameCandidate(shotId, "start");
  const endCandidate = storedShotFrameCandidate(shotId, "end");
  return [
    startStateItem?.selectedIndex ?? startStateItem?.result?.selectedIndex ?? "",
    frameCandidateIdentity(startCandidate),
    endStateItem?.selectedIndex ?? endStateItem?.result?.selectedIndex ?? "",
    frameCandidateIdentity(endCandidate),
    endCandidate?.dependencyHash || endStateItem?.result?.dependencyHash || "",
    endCandidate?.frameReferenceMode || endStateItem?.result?.frameReferenceMode || ""
  ].join("\u0000");
}

function closeShotVideoGenerator() {
  if (state.shotVideoGeneration.running) return setShotVideoStatus("镜头视频仍在生成中，完成后再关闭。", "active");
  state.shotVideoGeneration.open = false;
  state.shotVideoGeneration.validationRevision += 1;
  elements.shotVideoModal.classList.add("hidden");
  elements.shotVideoModal.setAttribute("aria-hidden", "true");
}

async function confirmGenerateShotVideo() {
  if (state.shotVideoGeneration.running) return;
  const prompt = elements.shotVideoPromptPreview.value.trim();
  if (!prompt) return setShotVideoStatus("视频提示词不能为空。", "error");
  const shotId = state.shotVideoGeneration.shotId;
  const context = shotFrameContext(shotId);
  if (!context) return setShotVideoStatus("没有找到对应镜头。", "error");
  const promptOverride = runtimePromptOverride(prompt);
  const validation = await evaluateShotVideoReferences(shotId);
  if (!validation.ok) return setShotVideoStatus(validation.message, "error");
  const count = Math.max(1, Math.min(4, Number(elements.shotVideoCount.value) || 1));
  state.shotVideoGeneration.count = count;
  setShotVideoGeneratorRunning(true);
  setShotVideoStatus(`${shotVideoProviderLabel()} 正在生成 ${count} 条视频候选…`, "active");
  try {
    await generateShotVideo(shotId, promptOverride, { count, throwOnError: true });
    const actualCount = shotVideoStateItem(shotId)?.result?.videos?.length || count;
    setShotVideoStatus(`已生成 ${actualCount} 条视频候选，可选择一条设为当前镜头视频。`, "ready");
  } catch (error) {
    setShotVideoStatus(error.message || "镜头视频生成失败", "error");
  } finally {
    if (state.shotVideoGeneration.running) setShotVideoGeneratorRunning(false);
  }
}

function setShotVideoGeneratorRunning(running) {
  state.shotVideoGeneration.running = running;
  elements.shotVideoCount.disabled = running;
  elements.shotVideoGenerationMode.disabled = running;
  elements.shotVideoIncludePreviousShotFrames.disabled = running
    || !previousShotVideoReferenceContext(state.shotVideoGeneration.shotId).available;
  elements.shotVideoIncludeEndpointFrames.disabled = running;
  elements.shotVideoIncludeCharacterReferences.disabled = running;
  elements.shotVideoReferenceInput.disabled = running;
  elements.shotVideoPromptPreview.disabled = running;
  elements.confirmGenerateShotVideo.disabled = running;
  elements.closeShotVideoModal.disabled = running;
  elements.confirmGenerateShotVideo.classList.toggle("running", running);
  elements.confirmGenerateShotVideo.querySelector("span").textContent = running ? `${shotVideoProviderLabel()} 生成中…` : `用 ${shotVideoProviderLabel()} 生成`;
}

function setShotVideoStatus(message, tone = "") {
  elements.shotVideoStatus.textContent = message;
  elements.shotVideoStatus.className = `story-status ${tone}`;
}

function allReferenceAssetDescriptors(shotId) {
  const context = shotFrameContext(shotId);
  if (!context) return [];
  const assets = [];
  if (state.shotVideoGeneration.includePreviousShotFrames) {
    const previousReference = previousShotVideoReferenceContext(shotId);
    if (previousReference.available) {
      assets.push({
        id: "previous-shot-frames",
        mediaType: "image",
        name: `${previousReference.previousShot.shotId} 上一镜内容（均匀 ${previousReference.estimatedFrameCount} 帧）`,
        sizeBytes: 0,
        durationSeconds: 0,
        referenceCount: previousReference.estimatedFrameCount,
        source: "previous_shot_frames",
        sourceShotId: previousReference.previousShot.shotId,
        serverGenerated: true
      });
    }
  }
  if (state.shotVideoGeneration.includeCharacterReferences) {
    const references = shotRelatedCharacterReferences(context.shot, context.plan.characterReferencePrompts || []);
    for (const reference of references) {
      if (!reference?.referenceImageDataUrl) continue;
      assets.push({
        id: `character-${reference.characterName || assets.length}`,
        mediaType: "image",
        name: `${reference.characterName || "角色"}参考图`,
        dataUrl: reference.referenceImageDataUrl,
        sizeBytes: 0,
        durationSeconds: 0,
        source: "character_reference",
        // 服务端仍会用 Plan 解析结果覆写这个值，这里只是让本地描述符与之一致。
        sourceCharacterName: reference.characterName || ""
      });
    }
  }
  if (state.shotVideoGeneration.includeEndpointFrames && hasPlannedEndpoints(context.shot)) {
    const start = selectedShotFrameCandidate(shotId, "start");
    const end = storedShotFrameCandidate(shotId, "end");
    if (start) assets.push({
      id: "workflow-start-frame",
      mediaType: "image",
      name: "已选首帧（普通参考图）",
      dataUrl: start.dataUrl || "",
      url: start.url || "",
      sizeBytes: 0,
      durationSeconds: 0,
      source: "workflow_start_frame"
    });
    if (end) assets.push({
      id: "workflow-end-frame",
      mediaType: "image",
      name: "已选尾帧（普通参考图）",
      dataUrl: end.dataUrl || "",
      url: end.url || "",
      sizeBytes: 0,
      durationSeconds: 0,
      source: "workflow_end_frame"
    });
  }
  assets.push(...state.shotVideoGeneration.referenceAssets);
  const seen = new Set();
  return assets.filter((asset) => {
    const identity = asset.dataUrl || asset.url || `${asset.source}:${asset.name}:${asset.id}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function referenceAssetCounts(assets) {
  return assets.reduce((counts, asset) => {
    if (Object.hasOwn(counts, asset.mediaType)) {
      const referenceCount = Math.max(1, Math.round(Number(asset.referenceCount) || 1));
      counts[asset.mediaType] += referenceCount;
    }
    return counts;
  }, { image: 0, video: 0, audio: 0 });
}

function validateAllReferenceAssetDescriptors(assets) {
  const counts = referenceAssetCounts(assets);
  if (!counts.image && !counts.video) return "全能参考模式至少需要一张图片或一段视频，不能只上传音频。";
  if (counts.image > 9) return `全能参考图片最多 9 张，当前 ${counts.image} 张。`;
  if (counts.video > 3) return `全能参考视频最多 3 段，当前 ${counts.video} 段。`;
  if (counts.audio > 3) return `全能参考音频最多 3 段，当前 ${counts.audio} 段。`;
  const videos = assets.filter((asset) => asset.mediaType === "video");
  const audios = assets.filter((asset) => asset.mediaType === "audio");
  const invalidDuration = [...videos, ...audios].find((asset) => asset.durationSeconds < 2 || asset.durationSeconds > 15);
  if (invalidDuration) return `${invalidDuration.name} 时长必须在 2–15 秒之间。`;
  if (videos.some((asset) => asset.sizeBytes > 50 * 1024 * 1024)) return "单段参考视频不得超过 50MB。";
  const videoDuration = videos.reduce((sum, asset) => sum + Number(asset.durationSeconds || 0), 0);
  const audioDuration = audios.reduce((sum, asset) => sum + Number(asset.durationSeconds || 0), 0);
  if (videoDuration > 15.05) return `参考视频总时长不得超过 15 秒，当前 ${videoDuration.toFixed(2)} 秒。`;
  if (audioDuration > 15.05) return `参考音频总时长不得超过 15 秒，当前 ${audioDuration.toFixed(2)} 秒。`;
  return "";
}

async function addShotVideoReferenceFiles(files) {
  try {
    const added = [];
    for (const file of files) {
      const mediaType = referenceFileMediaType(file);
      if (!mediaType) throw new Error(`${file.name} 不是支持的图片、视频或音频文件。`);
      const durationSeconds = mediaType === "image" ? 0 : await browserMediaDuration(file, mediaType);
      added.push({
        id: `upload-${Date.now()}-${added.length}`,
        mediaType,
        name: file.name,
        dataUrl: await readFileAsDataUrl(file),
        sizeBytes: file.size,
        durationSeconds,
        source: "upload"
      });
    }
    const candidateAssets = [...state.shotVideoGeneration.referenceAssets, ...added];
    const issue = validateAllReferenceAssetDescriptors(candidateAssets);
    if (issue && !/至少需要一张图片或一段视频/u.test(issue)) throw new Error(issue);
    state.shotVideoGeneration.referenceAssets = candidateAssets;
    await updateShotVideoGeneratorPreview({ preservePrompt: true });
  } catch (error) {
    setShotVideoStatus(error.message || "无法添加全能参考素材。", "error");
  }
}

function removeShotVideoReferenceAsset(assetId) {
  state.shotVideoGeneration.referenceAssets = state.shotVideoGeneration.referenceAssets
    .filter((asset) => String(asset.id) !== String(assetId));
  updateShotVideoGeneratorPreview({ preservePrompt: true });
}

function referenceFileMediaType(file) {
  const type = String(file?.type || "").split("/", 1)[0];
  return ["image", "video", "audio"].includes(type) ? type : "";
}

function browserMediaDuration(file, mediaType) {
  return new Promise((resolve, reject) => {
    const element = document.createElement(mediaType === "video" ? "video" : "audio");
    const url = URL.createObjectURL(file);
    const cleanup = () => URL.revokeObjectURL(url);
    element.preload = "metadata";
    element.addEventListener("loadedmetadata", () => {
      const duration = Number(element.duration);
      cleanup();
      if (!Number.isFinite(duration) || duration <= 0) reject(new Error(`无法读取 ${file.name} 的时长。`));
      else resolve(duration);
    }, { once: true });
    element.addEventListener("error", () => {
      cleanup();
      reject(new Error(`浏览器无法读取 ${file.name}。`));
    }, { once: true });
    element.src = url;
  });
}

function renderShotVideoReferenceList(shotId) {
  if (state.shotVideoGeneration.generationMode === "all_reference") {
    const assets = allReferenceAssetDescriptors(shotId);
    const previousReference = previousShotVideoReferenceContext(shotId);
    if (!assets.length) {
      return `<div>
      <span class="block-label">全能参考素材 · 0 项</span>
      <div class="shot-video-reference-box">
        <p class="shot-video-reference-note">尚未选择参考素材。可加入上个镜头抽帧、已有首尾帧、角色参考图，或上传图片、视频和音频。${previousReference.available ? `上个镜头 ${escape(previousReference.previousShot.shotId)} 已就绪，勾选后预计抽取 ${escape(previousReference.estimatedFrameCount)} 张。` : `上个镜头不可用：${escape(previousReference.reason)}`}</p>
      </div>
    </div>`;
    }
    const labels = { image: "图片", video: "视频", audio: "音频" };
    return `<div>
      <span class="block-label">全能参考素材 · ${escape(assets.length)} 项</span>
      <div class="shot-video-reference-box">
        <div class="shot-video-reference-assets">
          ${assets.map((asset) => `<div class="shot-video-reference-asset">
          <span>${escape(labels[asset.mediaType] || asset.mediaType)}</span>
          <strong title="${escape(asset.name)}">${escape(asset.name)}</strong>
          <small>${asset.source === "previous_shot_frames"
            ? `FFmpeg 1 fps · 预计 ${escape(asset.referenceCount)} 张`
            : asset.durationSeconds
              ? `${escape(asset.durationSeconds.toFixed(2))} 秒`
              : asset.sizeBytes
                ? escape(formatBytes(asset.sizeBytes))
                : escape(asset.source === "character_reference" ? "角色锁定" : "工作流参考")}</small>
          ${asset.source === "upload" ? `<button class="shot-video-reference-remove" type="button" data-remove-shot-video-reference="${escape(asset.id)}" aria-label="移除 ${escape(asset.name)}">×</button>` : ""}
        </div>`).join("")}
      </div>
      <p class="shot-video-reference-note">这些素材会以 reference_image / reference_video / reference_audio 发送，不会混入 first_frame / last_frame。上一镜抽帧只增强一致性，当前镜头的剧情、角色边界与目标场景仍优先。${previousReference.available
        ? state.shotVideoGeneration.includePreviousShotFrames
          ? ""
          : `上个镜头 ${escape(previousReference.previousShot.shotId)} 已就绪，可按需勾选，预计抽取 ${escape(previousReference.estimatedFrameCount)} 张。`
        : `上个镜头不可用：${escape(previousReference.reason)}`}</p>
      </div>
    </div>`;
  }
  const context = shotFrameContext(shotId);
  if (context && !hasPlannedEndpoints(context.shot)) {
    return `<p class="shot-video-reference-note">当前 direct_shot 镜头没有首尾帧，不能使用首尾帧模式。请在上方显式选择“全能参考”并添加图片或视频参考。</p>`;
  }
  const start = selectedShotFrameCandidate(shotId, "start");
  const end = storedShotFrameCandidate(shotId, "end");
  const endStatus = state.shotFrameResults[shotFrameKey(shotId, "end")]?.status || "";
  const frame = (label, item, status = "ready") => item?.url
    ? `<figure class="shot-video-reference-frame ${escape(status)}"><img src="${escape(item.url)}" alt="${escape(label)}"><figcaption>${escape(label)} · ${escape(frameStatusDescription(status))}</figcaption></figure>`
    : `<figure class="shot-video-reference-frame empty"><span>${escape(label)}</span><p>未添加参考图</p></figure>`;
  return `<div>
    <span class="block-label">首尾帧参考图</span>
    <div class="shot-video-reference-grid">
      ${frame("首帧", start)}
      ${frame("尾帧", end, endStatus)}
    </div>
    <p class="shot-video-reference-note">生成视频时会把这两张已选图片连同右侧视频提示词一起传给 ${escape(shotVideoProviderLabel())}。</p>
  </div>`;
}

function frameStatusDescription(status) {
  if (status === "stale") return "硬依赖已失效";
  if (status === "prompt_changed") return "Prompt 已变化，仍可使用";
  if (status === "legacy_unverified") return "旧结果，依赖未验证";
  return "已锁定参考图";
}

function buildShotVideoPromptPreview(shot = {}, promptSchemaVersion = "", videoPromptProfile = null) {
  const noTextRule = "禁止新增字幕、对白文字、标题、说明字、Logo、水印、UI 文本或漫画拟声词；对白只用于理解动作和情绪，不要渲染成画面文字。";
  if (promptSchemaVersion === "3.0") {
    // 暂时弃置，后续优化或删除：direct_shot 不再由前端拼装镜头职责字段，直接使用模型签发的完整 videoPrompt。
    return [
      shot.videoPrompt || "",
      shouldAppendSeedanceNoTextRule(videoPromptProfile) ? noTextRule : ""
    ].filter(Boolean).join("\n");
  }
  if (shot.startFrame && shot.endFrame && shot.motion) {
    return [shot.videoPrompt || "", noTextRule].filter(Boolean).join("\n");
  }
  return [
    shot.videoPrompt || "",
    shot.cameraMotion ? `镜头运动：${shot.cameraMotion}` : "",
    shot.characterAction ? `角色动作：${shot.characterAction}` : "",
    shot.dialogueOrSubtitle ? `对白：${shot.dialogueOrSubtitle}` : "",
    shot.soundDesign ? `声音：${shot.soundDesign}` : "",
    shot.continuityNotes ? `连续性：${shot.continuityNotes}` : "",
    noTextRule
  ].filter(Boolean).join("\n");
}

async function generateShotVideo(shotId, promptOverride = "", options = {}) {
  const variant = selectedVariant();
  const plan = variant ? state.animationPlans[variant.id] || state.output.animationPlan : state.output.animationPlan;
  const shot = (plan?.shotPlan || []).find((item) => String(item.shotId) === String(shotId));
  if (!shot) return setAnimationStatus("没有找到对应镜头。", "error");
  const productionContext = currentPlanProductionContext(variant.id);
  const planLineageRef = currentPlanLineageRef(variant.id);
  const mediaArtifactId = shotVideoArtifactId(variant.id, shotId);
  const mediaToken = beginArtifactRequest(state.production, mediaArtifactId, crypto.randomUUID());
  const count = Math.max(1, Math.min(4, Number(options.count) || 1));
  setShotVideoStateItem(shotId, { status: "running", message: `正在调用 ${shotVideoProviderLabel()} · ${count} 条…`, expectedCount: count }, variant.id);
  updateShotVideoResult(shotId);
  renderShotVideoModalResults();
  setAnimationStatus(`正在用 ${shotVideoProviderLabel()} 生成 ${shotId} 镜头视频 · ${count} 条候选…`, "active");
  try {
    const generationMode = normalizeShotVideoGenerationMode(state.shotVideoGeneration.generationMode);
    const continuityReferenceMode = generationMode === "all_reference"
      && state.shotVideoGeneration.includePreviousShotFrames
      ? SHOT_VIDEO_CONTINUITY_PREVIOUS_SHOT_FRAMES
      : SHOT_VIDEO_CONTINUITY_NONE;
    const referenceValidation = await evaluateShotVideoReferences(shotId);
    if (!referenceValidation.ok) throw new Error(referenceValidation.message);
    let startFrameDataUrl = "";
    let endFrameDataUrl = "";
    let referenceAssets = [];
    if (generationMode === "all_reference") {
      referenceAssets = await collectAllReferenceAssets(shotId);
    } else {
      const startFrame = selectedShotFrameCandidate(shotId, "start");
      const endFrame = selectedShotFrameCandidate(shotId, "end");
      if (!startFrame || !endFrame) throw new Error("请先生成并选择首帧和尾帧参考图。");
      [startFrameDataUrl, endFrameDataUrl] = await Promise.all([
        frameCandidateDataUrl(startFrame),
        frameCandidateDataUrl(endFrame)
      ]);
    }
    const result = await api("/api/generate-shot-video", {
      ...globalCharacterBoundaryContext(),
      selectedVariantId: variant?.id || "",
      count,
      generationMode,
      continuityReferenceMode,
      aspectRatio: normalizeAnimationPlanAspectRatio(plan.productionStrategy?.targetAspectRatio),
      animationPromptSchemaVersion: plan.promptSchemaVersion || "",
      shotId: shot.shotId,
      promptOverride: promptOverride || "",
      ...(generationMode === "all_reference"
        ? { referenceAssets }
        : { startFrameDataUrl, endFrameDataUrl }),
      productionContext
    });
    assertPlanProductionContextCurrent(productionContext);
    assertCurrentProductionRequest(mediaToken);
    const videos = Array.isArray(result.videos) && result.videos.length ? result.videos : result.outputUrl ? [result] : [];
    if (videos.length !== count) throw new Error(`视频数量不足：请求 ${count} 条，实际返回 ${videos.length} 条。`);
    if (
      continuityReferenceMode === SHOT_VIDEO_CONTINUITY_PREVIOUS_SHOT_FRAMES
      && !result.continuityReferenceReceipt?.sourceArtifact
    ) {
      throw new Error("服务端没有返回上一镜抽帧的精确媒体血缘，已拒绝提交结果。");
    }
    const selectedIndex = 0;
    const readyResult = {
      status: "ready",
      result: { ...result, videos, selectedIndex, outputUrl: videos[selectedIndex]?.outputUrl || result.outputUrl || "" },
      selectedIndex
    };
    await commitProductionArtifact({
      artifactId: mediaArtifactId,
      artifactType: "shotVideo",
      content: readyResult,
      dependencyRefs: [
        planLineageRef,
        ...(result.continuityReferenceReceipt?.sourceArtifact
          ? [result.continuityReferenceReceipt.sourceArtifact]
          : [])
      ],
      requestToken: mediaToken
    });
    assertPlanProductionContextCurrent(productionContext);
    setShotVideoStateItem(shotId, readyResult, variant.id);
    setAnimationStatus(`${shotId} 镜头视频已生成 ${videos.length} 条候选。`, "ready");
  } catch (error) {
    if (isArtifactRequestCurrent(state.production, mediaToken) && !["STALE_ASYNC_RESULT", "STALE_MEDIA_RESULT"].includes(error.code)) {
      setShotVideoStateItem(shotId, { status: "error", message: error.message || "镜头视频生成失败" }, variant.id);
    }
    setAnimationStatus(error.message || "镜头视频生成失败", "error");
    updateShotVideoResult(shotId);
    renderShotVideoModalResults();
    if (options.throwOnError) throw error;
    return false;
  } finally {
    finishArtifactRequest(state.production, mediaToken);
  }
  updateShotVideoResult(shotId);
  renderShotVideoModalResults();
  return true;
}

async function collectAllReferenceAssets(shotId) {
  const descriptors = allReferenceAssetDescriptors(shotId);
  const descriptorIssue = validateAllReferenceAssetDescriptors(descriptors);
  if (descriptorIssue) throw new Error(descriptorIssue);
  const clientDescriptors = descriptors.filter((asset) => !asset.serverGenerated);
  const assets = await Promise.all(clientDescriptors.map(async (asset) => ({
    mediaType: asset.mediaType,
    name: asset.name,
    dataUrl: asset.dataUrl || await urlToDataUrl(asset.url),
    sizeBytes: Number(asset.sizeBytes) || 0,
    durationSeconds: Number(asset.durationSeconds) || 0,
    source: asset.source || "upload"
  })));
  const seen = new Set();
  const unique = assets.filter((asset) => {
    if (seen.has(asset.dataUrl)) return false;
    seen.add(asset.dataUrl);
    return true;
  });
  return unique;
}

async function frameCandidateDataUrl(candidate = {}) {
  if (candidate.dataUrl) return candidate.dataUrl;
  if (candidate.url) return urlToDataUrl(candidate.url);
  throw new Error("首尾帧参考图缺少可上传的图片数据。");
}

function renderShotVideoModalResults() {
  if (!state.shotVideoGeneration.open) return;
  const shotId = state.shotVideoGeneration.shotId;
  const stateItem = shotVideoStateItem(shotId);
  elements.shotVideoResults.setAttribute("style", shotVideoAspectStyle(shotFrameContext(shotId)?.plan?.productionStrategy?.targetAspectRatio));
  if (!stateItem) {
    elements.shotVideoResults.innerHTML = "";
    return;
  }
  if (stateItem.status === "running") {
    const count = Number(stateItem.expectedCount) || 1;
    elements.shotVideoResults.innerHTML = Array.from({ length: count }, (_, index) => `<div class="generated-reference-card shot-video-candidate loading"><span>第 ${index + 1} 条视频生成中…</span></div>`).join("");
    return;
  }
  if (stateItem.status === "error") {
    elements.shotVideoResults.innerHTML = `<div class="generated-reference-card error"><strong>视频生成失败</strong><p>${escape(stateItem.message || "生成失败")}</p></div>`;
    return;
  }
  const videos = Array.isArray(stateItem.result?.videos) && stateItem.result.videos.length ? stateItem.result.videos : stateItem.result?.outputUrl ? [stateItem.result] : [];
  const selectedIndex = Number.isFinite(Number(stateItem.selectedIndex ?? stateItem.result?.selectedIndex)) ? Number(stateItem.selectedIndex ?? stateItem.result?.selectedIndex) : 0;
  elements.shotVideoResults.innerHTML = videos.map((video, index) => `<div class="generated-reference-card shot-video-candidate${index === selectedIndex ? " selected" : ""}">
    <video src="${escape(video.outputUrl || video.url || "")}" controls playsinline></video>
    <small>候选 ${escape(index + 1)} · ${escape(shotVideoResultLabel(video, stateItem.result))} · ${escape(video.generatedAt || stateItem.result?.generatedAt || "")}</small>
    <button class="outline-button" type="button" data-use-shot-video="${escape(shotId)}" data-candidate-index="${escape(index)}">${index === selectedIndex ? "已设为当前镜头视频" : "设为当前镜头视频"}</button>
  </div>`).join("");
}

async function selectShotVideoCandidate(shotId, candidateIndexValue) {
  const stateItem = shotVideoStateItem(shotId);
  const videos = stateItem?.result?.videos || [];
  const selectedIndex = Number(candidateIndexValue);
  if (!videos[selectedIndex]) return;
  const variant = selectedVariant();
  if (!variant) return setShotVideoStatus("当前没有选中的主题变体。", "error");
  try {
    const mediaArtifactId = shotVideoArtifactId(variant.id, shotId);
    const currentMediaLineage = state.production.artifacts[mediaArtifactId];
    const updatedStateItem = structuredClone(stateItem);
    updatedStateItem.status = "ready";
    updatedStateItem.selectedIndex = selectedIndex;
    updatedStateItem.result.selectedIndex = selectedIndex;
    updatedStateItem.result.outputUrl = videos[selectedIndex].outputUrl || videos[selectedIndex].url || "";
    updatedStateItem.result.outputPath = videos[selectedIndex].outputPath || "";
    await commitProductionArtifact({
      artifactId: mediaArtifactId,
      artifactType: "shotVideo",
      content: updatedStateItem,
      dependencyRefs: currentMediaLineage?.dependencies?.length
        ? currentMediaLineage.dependencies
        : [currentPlanLineageRef(variant.id)]
    });
    setShotVideoStateItem(shotId, updatedStateItem, variant.id);
    updateShotVideoResult(shotId);
    renderShotVideoModalResults();
    setShotVideoStatus(`已将第 ${selectedIndex + 1} 条设为当前镜头视频。`, "ready");
    setAnimationStatus(`${shotId} 已切换为第 ${selectedIndex + 1} 条视频候选。`, "ready");
  } catch (error) {
    setShotVideoStatus(error.message || "切换镜头视频失败。", "error");
  }
}

async function generateShotFrameImage(shotId, frameKindValue, promptOverride = "", options = {}) {
  const frameKind = frameKindValue === "end" ? "end" : "start";
  const variant = selectedVariant();
  const plan = variant ? state.animationPlans[variant.id] || state.output.animationPlan : state.output.animationPlan;
  const shot = (plan?.shotPlan || []).find((item) => String(item.shotId) === String(shotId));
  if (!shot || !plan) return setAnimationStatus("没有找到对应镜头。", "error");
  if (!hasPlannedEndpoints(shot)) {
    return setAnimationStatus("当前 direct_shot 镜头不生成首尾帧。", "error");
  }
  const key = shotFrameKey(shotId, frameKind);
  const productionContext = currentPlanProductionContext(variant.id);
  const planLineageRef = currentPlanLineageRef(variant.id);
  const mediaArtifactId = `shotFrame:${variant.id}:${shotId}:${frameKind}`;
  const mediaToken = beginArtifactRequest(state.production, mediaArtifactId, crypto.randomUUID());
  const count = Math.max(1, Math.min(6, Number(options.count) || 1));
  state.shotFrameResults[key] = { status: "running", frameKind, message: `正在生成${frameKind === "end" ? "尾帧" : "首帧"}镜头 · ${count} 张…` };
  updateShotFrameResult(shotId);
  renderShotFrameImageResults();
  setAnimationStatus(`${shotId} ${frameKind === "end" ? "尾帧" : "首帧"}正在用即梦生成…`, "active");
  try {
    const characterReferences = shotRelatedCharacterReferences(shot, plan.characterReferencePrompts || [], { frameKind });
    const negativePromptApplication = compileShotFrameNegativePrompt(shot);
    const frameReferenceMode = frameKind === "end" && hasStructuredEndpointState(shot)
      ? options.frameReferenceMode || state.shotFrameImageGeneration.frameReferenceMode || resolveFrameReferenceMode(shot)
      : "";
    const referenceContext = options.referenceContext || await buildShotFrameReferenceContext({
      shot,
      plan,
      frameKind,
      frameReferenceMode
    });
    const dependencyHash = frameKind === "end" && frameReferenceMode
      ? options.dependencyHash || await computeDependencyHash({
        startImageDataUrl: referenceContext.startFrameDataUrl,
        endState: shot.endFrame,
        referenceImages: referenceContext.manifest.additionalReferences,
        frameReferenceMode
      })
      : "";
    const promptHash = frameKind === "end" && frameReferenceMode
      ? options.promptHash || await computePromptHash(buildShotFrameMultiImagePrompt(promptOverride, count))
      : "";
    const endpointReferences = frameKind === "end" && ["inherit", "transition"].includes(frameReferenceMode)
      ? [{
        role: "start_frame",
        dataUrl: referenceContext.startFrameDataUrl,
        sourceShotId: String(shot.shotId || "")
      }]
      : [];
    const frameShot = { ...shot };
    delete frameShot.negativePrompt;
    delete frameShot.negativePromptEntries;
    delete frameShot.compiledNegativePrompt;
    frameShot.negativePrompts = { image: negativePromptApplication.negativePromptEntries };
    const result = await api("/api/generate-shot-frame-image", {
      ...globalCharacterBoundaryContext(),
      selectedVariantId: variant?.id || "",
      animationPromptSchemaVersion: plan.promptSchemaVersion || "",
      frameKind,
      count,
      ...(promptOverride ? { prompt: promptOverride } : {}),
      shot: frameShot,
      negativePromptApplication,
      visualBible: plan.visualBible || {},
      characterReferences,
      sceneReference: sceneReferenceForShot(plan, shot),
      productionContext,
      ...(frameKind === "end" && frameReferenceMode ? {
        frameReferenceMode,
        referenceImages: endpointReferences,
        dependencyHash,
        promptHash
      } : {})
    });
    assertPlanProductionContextCurrent(productionContext);
    assertCurrentProductionRequest(mediaToken);
    const images = Array.isArray(result.images) && result.images.length ? result.images : [result];
    const authority = {
      frameReferenceMode: result.frameReferenceMode || frameReferenceMode,
      dependencyHash: result.dependencyHash || dependencyHash,
      promptHash: result.promptHash || promptHash,
      usedStartFrameReference: Boolean(result.usedStartFrameReference)
    };
    result.images = await Promise.all(images.map(async (image) => ({
      ...image,
      ...(frameKind === "end" && frameReferenceMode ? authority : {}),
      dataUrl: await urlToDataUrl(image.url)
    })));
    if (frameKind === "end" && frameReferenceMode) Object.assign(result, authority);
    result.selectedIndex = -1;
    result.url = "";
    result.dataUrl = "";
    const readyResult = { status: options.autoSelectFirst ? "ready" : "pending", frameKind, result, selectedIndex: options.autoSelectFirst ? 0 : -1, message: `已生成 ${result.images.length} 张候选图，请选择一张添加到镜头。` };
    await commitProductionArtifact({
      artifactId: mediaArtifactId,
      artifactType: "shotFrame",
      content: readyResult,
      dependencyRefs: [planLineageRef],
      requestToken: mediaToken
    });
    assertPlanProductionContextCurrent(productionContext);
    state.shotFrameResults[key] = readyResult;
    if (options.autoSelectFirst) {
      selectShotFrameCandidate(shotId, frameKind, 0);
    } else {
      setAnimationStatus(`${shotId} ${frameKind === "end" ? "尾帧" : "首帧"}镜头已生成 ${result.images.length} 张候选图，等待选择。`, "ready");
    }
  } catch (error) {
    if (isArtifactRequestCurrent(state.production, mediaToken) && !["STALE_ASYNC_RESULT", "STALE_MEDIA_RESULT"].includes(error.code)) {
      state.shotFrameResults[key] = { status: "error", frameKind, message: error.message || "镜头帧图片生成失败" };
    }
    setAnimationStatus(error.message || "镜头帧图片生成失败", "error");
    updateShotFrameResult(shotId);
    renderShotFrameImageResults();
    if (options.throwOnError) throw error;
    return false;
  } finally {
    finishArtifactRequest(state.production, mediaToken);
  }
  updateShotFrameResult(shotId);
  renderShotFrameImageResults();
  return true;
}

function updateShotVideoResult(shotId) {
  const resultBox = [...elements.animationPlan.querySelectorAll("[data-shot-video-result]")]
    .find((item) => String(item.dataset.shotVideoResult) === String(shotId));
  if (resultBox) resultBox.innerHTML = renderShotVideoResult(shotId);
  const mediaCell = [...elements.animationPlan.querySelectorAll("[data-shot-video-media]")]
    .find((item) => String(item.dataset.shotVideoMedia) === String(shotId));
  const mediaContext = shotFrameContext(shotId);
  if (mediaCell && mediaContext?.shot) {
    mediaCell.setAttribute("style", shotVideoAspectStyle(mediaContext.plan?.productionStrategy?.targetAspectRatio));
    mediaCell.innerHTML = renderShotVideoPromptCellBody(mediaContext.shot);
  }
  const button = [...elements.animationPlan.querySelectorAll("[data-generate-shot-video]")]
    .find((item) => String(item.dataset.generateShotVideo) === String(shotId));
  if (button) button.disabled = shotVideoStateItem(shotId)?.status === "running";
}

function updateShotFrameResult(shotId) {
  const resultBox = [...elements.animationPlan.querySelectorAll("[data-shot-frame-result]")]
    .find((item) => String(item.dataset.shotFrameResult) === String(shotId));
  if (resultBox) resultBox.innerHTML = renderShotFrameResult(shotId);
  updateShotFramePromptBadge(shotId, "start");
  updateShotFramePromptBadge(shotId, "end");
  const button = [...elements.animationPlan.querySelectorAll(`[data-open-shot-frame-generator="${cssEscape(shotId)}"]`)].find(Boolean);
  if (button) button.disabled = shotFrameIsRunning(shotId);
}

function updateShotFramePromptBadge(shotId, frameKind) {
  const badge = [...elements.animationPlan.querySelectorAll("[data-shot-frame-badge]")]
    .find((item) => String(item.dataset.shotFrameBadge) === shotFrameKey(shotId, frameKind));
  if (badge) badge.outerHTML = renderShotFrameStatusBadge(shotId, frameKind);
}

function renderShotFrameResult(shotId) {
  const start = state.shotFrameResults[shotFrameKey(shotId, "start")];
  const end = state.shotFrameResults[shotFrameKey(shotId, "end")];
  const visibleItems = [
    { label: "首帧", stateItem: start },
    { label: "尾帧", stateItem: end }
  ].filter((item) => item.stateItem?.status && item.stateItem.status !== "ready");
  if (
    end?.status === "ready"
    && end?.result?.frameReferenceMode === "independent"
    && !selectedShotFrameCandidate(shotId, "start")
  ) {
    visibleItems.push({
      label: "尾帧",
      stateItem: {
        status: "waiting_start",
        message: "独立尾帧已就绪，尚未选择视频首帧；选择首帧后无需重新生成尾帧。"
      }
    });
  }
  if (!visibleItems.length) return "";
  return `<div class="shot-frame-status-list">
    ${visibleItems.map((item) => `<p class="${escape(item.stateItem.status)}">${escape(item.label)}：${escape(item.stateItem.message || (item.stateItem.status === "running" ? "生成中…" : "生成失败"))}</p>`).join("")}
  </div>`;
}

function renderOneShotFramePreview(shotId, frameKind, stateItem) {
  const label = frameKind === "end" ? "尾帧" : "首帧";
  if (!stateItem) return `<figure class="empty"><span>${label}</span><p>未生成</p></figure>`;
  if (stateItem.status === "running") return `<figure class="loading"><span>${label}</span><p>${escape(stateItem.message || "生成中…")}</p></figure>`;
  if (stateItem.status === "error") return `<figure class="error"><span>${label}</span><p>${escape(stateItem.message || "生成失败")}</p></figure>`;
  const result = stateItem.result || {};
  const images = Array.isArray(result.images) && result.images.length ? result.images : [result];
  const selectedIndex = Number(stateItem.selectedIndex || result.selectedIndex || 0);
  const referenceCountText = Number.isFinite(Number(result.referenceImageCount)) ? ` · 参考图 ${Number(result.referenceImageCount)} 张` : "";
  return `<figure>
    <span>${label}</span>
    <div class="shot-frame-candidate-grid">
      ${images.map((image, index) => `<div class="shot-frame-candidate${index === selectedIndex ? " selected" : ""}">
        <button class="generated-reference-preview-button" type="button" data-preview-shot-frame="${escape(shotId)}" data-frame-kind="${escape(frameKind)}" data-candidate-index="${escape(index)}" aria-label="放大预览 ${escape(shotId)} ${label}第 ${escape(index + 1)} 张">
          <img src="${escape(image.url)}" alt="${escape(shotId)} ${label}候选 ${index + 1}">
        </button>
        <button class="text-button" type="button" data-select-shot-frame="${escape(shotId)}" data-frame-kind="${escape(frameKind)}" data-candidate-index="${escape(index)}">${index === selectedIndex ? "已添加到镜头" : "设为此帧"}</button>
      </div>`).join("")}
    </div>
    <figcaption>${label} · ${escape(images.length)} 张候选 · ${escape(result.size || modelName(result.model || state.imageModel))}${escape(referenceCountText)}</figcaption>
  </figure>`;
}

function renderShotVideoResult(shotId) {
  const stateItem = shotVideoStateItem(shotId);
  if (!stateItem) return `<p>选择首尾帧模式或全能参考模式，即可用 ${escape(shotVideoProviderLabel())} 生成该镜头视频。</p>`;
  if (stateItem.status === "running") return `<p class="active">生成中：正在生成 ${escape(stateItem.expectedCount || 1)} 条视频候选…</p>`;
  if (stateItem.status === "error") return `<p class="error">${escape(stateItem.message)}</p>`;
  const startFrameUrl = stateItem.result?.startFrameUrl || "";
  const endFrameUrl = stateItem.result?.endFrameUrl || "";
  const frameHtml = startFrameUrl || endFrameUrl
    ? `<div class="shot-frame-preview">
        ${startFrameUrl ? `<figure><img src="${escape(startFrameUrl)}" alt="首帧"><figcaption>首帧</figcaption></figure>` : ""}
        ${endFrameUrl ? `<figure><img src="${escape(endFrameUrl)}" alt="尾帧"><figcaption>尾帧</figcaption></figure>` : ""}
      </div>`
    : "";
  // 可播放的候选已上移到上方 prompt 网格那一格，这里只留连续性回执、旧 v2 首尾帧预览与异常说明。
  const videos = shotVideoPlayableCandidates(shotId);
  const continuityReceipt = stateItem.result?.continuityReferenceReceipt;
  const continuityHtml = continuityReceipt?.mode === SHOT_VIDEO_CONTINUITY_PREVIOUS_SHOT_FRAMES
    ? `<p class="ready">连续性参考：${escape(continuityReceipt.sourceShotId)} 均匀抽帧，共 ${escape(continuityReceipt.frameCount)} 张普通参考图。</p>`
    : "";
  return videos.length
    ? `${continuityHtml}${frameHtml}`
    : `${continuityHtml}${frameHtml}<p>视频已生成，但未返回可播放地址。</p>`;
}

function resultHeader(kicker, title, badge = "", action = "") {
  return `<div class="result-title"><div><p>${kicker}</p><h3>${title}</h3></div>${badge ? `<span class="confidence">${escape(badge)}</span>` : ""}${action}</div>`;
}
function block(label, content) { return `<div class="result-block"><span class="block-label">${label}</span>${content}</div>`; }
function actionBlock(label, content, action = "") { return `<div class="result-block"><div class="result-block-head"><span class="block-label">${label}</span>${action}</div>${content}</div>`; }
function cell(label, value) { return `<div class="data-cell"><span>${label}</span><strong>${escape(value || "待确认")}</strong></div>`; }
function uncertainties(items = []) { return items.length ? `<div class="warning-box"><b>待确认：</b> ${items.map((item) => escape(item.reason || item.unknown)).join("；")}</div>` : ""; }
function joinParts(object = {}, keys = []) { return keys.map((key) => object?.[key]).filter(Boolean).join(" · "); }
function reveal(element) { element.classList.remove("hidden"); }

function setStage(stage, status) {
  const element = document.querySelector(`[data-stage="${stage}"]`);
  element.className = status;
  element.querySelector("b").textContent = ({ active: "生成中", done: "完成", error: "失败" })[status] || "等待";
}
function resetPipeline() { document.querySelectorAll(".pipeline li").forEach((item) => { item.className = ""; item.querySelector("b").textContent = "等待"; }); }
function setRunning(running) { elements.run.classList.toggle("running", running); elements.run.querySelector("span").textContent = running ? "AI 导演工作中…" : "启动 AI 导演"; elements.run.disabled = running; }
function setStoryRunning(running) {
  elements.storyGenerate.classList.toggle("running", running);
  elements.storyGenerate.querySelector("span").textContent = running ? "完整剧情生成中…" : `用 ${storyModelLabel()} 生成完整剧情`;
  elements.storyGenerate.disabled = running || !selectedVariant();
}
function setAnimationRunning(running) {
  elements.animationGenerate.classList.toggle("running", running);
  const variant = selectedVariant();
  const fullStory = variant ? state.fullStories[variant.id] || state.output.fullStory : null;
  const plan = variant ? state.animationPlans[variant.id] : null;
  const draft = selectedAnimationAspectRatio(variant?.id);
  const currentRatio = normalizeAnimationPlanAspectRatio(plan?.productionStrategy?.targetAspectRatio);
  elements.animationGenerate.textContent = running
    ? `正在生成 ${draft} 动画生产包…`
    : plan && draft !== currentRatio
      ? `按 ${draft} 重新生成动画镜头生产包`
      : `生成动画镜头生产包 · ${draft}`;
  elements.animationGenerate.disabled = running || !variant || !fullStory;
  updateStoryExportActions();
}
function setStoryStatus(message, tone = "") {
  elements.storyStatus.textContent = message;
  elements.storyStatus.className = `story-status ${tone}`;
}
function setAnimationStatus(message, tone = "") {
  elements.animationStatus.textContent = message;
  elements.animationStatus.className = `story-status ${tone}`;
}
function storyModelLabel() { return modelDisplayLabel(state.storyProvider, state.storyModel); }
function animationModelLabel() { return modelDisplayLabel(state.animationProvider, state.animationModel); }
function staticFrameCompilerModelLabel() { return modelDisplayLabel(state.staticFrameCompilerProvider, state.staticFrameCompilerModel); }
function normalizeShotVideoProvider(provider = "") {
  return provider;
}
function normalizeShotVideoGenerationMode(value = "") {
  return String(value || "").trim().toLowerCase() === "all_reference" ? "all_reference" : "first_last_frame";
}
function shotVideoModeSupported(provider, mode) {
  const normalizedMode = normalizeShotVideoGenerationMode(mode);
  if (normalizedMode === "first_last_frame") return true;
  return ["Seedance", "MiniMax"].includes(normalizeShotVideoProvider(provider));
}
function shotVideoSetting() {
  const setting = effectiveStageSetting("shotVideo");
  return { ...setting, provider: normalizeShotVideoProvider(setting.provider) || "Kling" };
}
function shotVideoProviderLabel(provider = shotVideoSetting().provider) {
  const normalized = normalizeShotVideoProvider(provider);
  return SHOT_VIDEO_PROVIDER_LABELS[normalized] || normalized || "视频模型";
}
function shotVideoResultLabel(video = {}, result = {}) {
  const setting = shotVideoSetting();
  const provider = normalizeShotVideoProvider(video.provider || result.provider || setting.provider);
  const model = video.model || result.model || setting.model || "";
  return model ? `${shotVideoProviderLabel(provider)} ${modelName(model)}` : shotVideoProviderLabel(provider);
}
function openModelSettings() {
  renderModelSettings();
  elements.modelSettingsModal.classList.remove("hidden");
  elements.modelSettingsModal.setAttribute("aria-hidden", "false");
}
function closeModelSettings() {
  elements.modelSettingsModal.classList.add("hidden");
  elements.modelSettingsModal.setAttribute("aria-hidden", "true");
}
function renderModelSettings() {
  if (!elements.modelStageList) return;
  const providers = availableModelProviders();
  elements.modelStageList.innerHTML = MODEL_STAGE_DEFS.map((stage) => {
    const current = effectiveStageSetting(stage.key);
    const defaultSetting = normalizeStageSetting(stage.key, state.modelStages[stage.key] || {});
    const eligibleProviders = providers.filter((provider) => providerAllowedForStage(provider, stage.key));
    const providerOptions = stage.providers
      ? [...new Set([
          ...(current.provider === "VideoHTTP" || defaultSetting.provider === "VideoHTTP" ? ["VideoHTTP"] : []),
          ...stage.providers
        ])]
      : (stage.providerLocked ? [current.provider || defaultSetting.provider].filter(Boolean) : eligibleProviders);
    const selectedProvider = providerOptions.includes(current.provider) ? current.provider : providerOptions[0] || current.provider;
    const selectedModel = modelAllowedForStage(current.model, selectedProvider, stage.key)
      ? current.model
      : providerDefaultModel(selectedProvider, stage.key);
    return `<div class="model-stage-row" data-model-stage="${escape(stage.key)}">
      <div class="model-stage-label">
        <div class="model-stage-title"><strong>${escape(stage.label)}</strong><span class="model-capability-tag ${escape(stage.capabilityKind)}">${escape(stage.capability)}</span></div>
        <small>默认：${escape(modelDisplayLabel(defaultSetting.provider, defaultSetting.model))}<br>${escape(stage.hint)}</small>
      </div>
      <select data-model-provider="${escape(stage.key)}"${stage.providerLocked ? " disabled" : ""}>
        ${providerOptions.map((provider) => `<option value="${escape(provider)}"${provider === selectedProvider ? " selected" : ""}>${escape(provider)}</option>`).join("")}
      </select>
      <select data-model-name="${escape(stage.key)}">
        ${renderModelOptions(stage, selectedProvider, selectedModel, defaultSetting)}
      </select>
    </div>`;
  }).join("");
}
function handleModelStageListChange(event) {
  const providerSelect = event.target.closest("[data-model-provider]");
  if (!providerSelect) return;
  const row = providerSelect.closest("[data-model-stage]");
  if (!row) return;
  const stage = MODEL_STAGE_DEFS.find((item) => item.key === row.dataset.modelStage);
  const modelSelect = row.querySelector("[data-model-name]");
  if (!stage || !modelSelect) return;
  const provider = providerSelect.value;
  const defaultSetting = normalizeStageSetting(stage.key, state.modelStages[stage.key] || {});
  const selectedModel = defaultSetting.provider === provider ? defaultSetting.model : providerDefaultModel(provider, stage.key);
  modelSelect.innerHTML = renderModelOptions(stage, provider, selectedModel, defaultSetting);
}
async function saveModelSettings() {
  const next = {};
  for (const stage of MODEL_STAGE_DEFS) {
    const row = elements.modelStageList.querySelector(`[data-model-stage="${stage.key}"]`);
    if (!row) continue;
    const defaults = normalizeStageSetting(stage.key, state.modelStages[stage.key] || {});
    const provider = row.querySelector("[data-model-provider]")?.value || defaults.provider || "";
    const model = row.querySelector("[data-model-name]")?.value.trim() || defaults.model || "";
    if (provider && model && (provider !== defaults.provider || model !== defaults.model)) {
      next[stage.key] = { provider, model };
    }
  }
  state.modelOverrides = next;
  localStorage.setItem("directorModelOverrides", JSON.stringify(next));
  applyEffectiveModelState();
  renderModelSettings();
  updateModelStateLabel();
  updateModelActionLabels();
  elements.storyModelName.textContent = modelDisplayLabel(state.storyProvider, state.storyModel);
  setModelSettingsStatus("已应用。之后所有生成请求都会使用当前模型路由。", "ready");
  await offerVideoPromptRewriteForCurrentPlan();
}
async function resetModelSettings() {
  state.modelOverrides = {};
  localStorage.removeItem("directorModelOverrides");
  applyEffectiveModelState();
  renderModelSettings();
  updateModelStateLabel();
  updateModelActionLabels();
  elements.storyModelName.textContent = modelDisplayLabel(state.storyProvider, state.storyModel);
  setModelSettingsStatus("已恢复后端默认模型。", "ready");
  await offerVideoPromptRewriteForCurrentPlan();
}

async function offerVideoPromptRewriteForCurrentPlan() {
  const variant = selectedVariant();
  const plan = variant ? state.animationPlans[variant.id] || null : null;
  if (!variant || !plan || plan.promptSchemaVersion !== "3.0" || plan.productionStrategy?.format !== "direct_shot_video") return;
  renderAnimationPlan(plan);
  const ui = videoPromptProfileUiState(plan, shotVideoSetting());
  if (ui.status === "matched") return;
  if (ui.status === "unsupported_target") {
    setModelSettingsStatus(`模型设置已保存，但不会改写提示词：${ui.message}`, "error");
    setAnimationStatus("当前模型没有 direct_shot 视频提示词 Profile；原 Animation Plan 保持不变。", "error");
    return;
  }
  if (ui.status === "invalid_current_profile") {
    setModelSettingsStatus(`模型设置已保存，但当前 Plan Profile 无效：${ui.message}`, "error");
    setAnimationStatus("当前 Animation Plan 的提示词 Profile 无效，已阻止自动重写。", "error");
    return;
  }
  const currentLabel = videoPromptProfileLabel(ui.current);
  const targetLabel = videoPromptProfileLabel(ui.target);
  const accepted = window.confirm(
    `镜头视频模型已切换为 ${targetLabel}，当前 Animation Plan 使用 ${currentLabel} 提示词。\n\n是否只重新生成 direct_shot.videoPrompt？\n确认后会签发新的 Plan revision 和媒体命名空间；取消则保留现有提示词。`
  );
  if (!accepted) {
    setModelSettingsStatus(`模型设置已保存；已保留 ${currentLabel} 提示词，未修改 Animation Plan。`, "ready");
    setAnimationStatus(`当前模型为 ${targetLabel}，Plan 仍使用 ${currentLabel} 提示词。`, "active");
    return;
  }
  await rewriteCurrentAnimationVideoPrompts(videoPromptTargetForSetting(shotVideoSetting()));
}

async function rewriteCurrentAnimationVideoPrompts(videoPromptTarget) {
  if (state.animationPromptRewriting) return;
  const variant = selectedVariant();
  const plan = variant ? state.animationPlans[variant.id] || null : null;
  const fullStory = variant ? state.fullStories[variant.id] || state.output.fullStory : null;
  if (!variant || !plan || !fullStory) {
    setModelSettingsStatus("缺少当前主题、完整剧情或 Animation Plan，不能重写提示词。", "error");
    return;
  }
  const planArtifactId = animationPlanArtifactId(variant.id);
  let productionContext;
  let dependencyRefs;
  try {
    productionContext = currentPlanProductionContext(variant.id);
    dependencyRefs = currentPlanDependencyRefs(variant.id);
  } catch (error) {
    setModelSettingsStatus(error.message || "当前 Animation Plan lineage 已失效。", "error");
    return;
  }
  state.animationPromptRewriting = true;
  elements.saveModelSettings.disabled = true;
  elements.resetModelSettings.disabled = true;
  elements.animationGenerate.disabled = true;
  setModelSettingsStatus(`正在为 ${shotVideoProviderLabel(videoPromptTarget.provider)} 重写 direct_shot.videoPrompt…`, "active");
  setAnimationStatus("正在只重写视频提示词；镜头映射、动作、时长和其他字段保持不变…", "active");
  try {
    const response = await requestProductionArtifact({
      endpoint: "/api/animation-plan/video-prompts/rewrite",
      requestBody: {
        creatorProfile: profile(),
        creativeBrief: state.output.creativeBrief,
        variant,
        fullStory,
        visualGuardrails: state.output.visualGuardrails,
        fixedCharacterBoundary: state.output.visualGuardrails?.fixedCharacterBoundary,
        animationPlanMode: "direct_shot",
        videoPromptTarget,
        productionContext
      },
      artifactId: planArtifactId,
      artifactType: "animationPlan",
      dependencyRefs,
      createMediaNamespace: true,
      contentForArtifact: (value) => normalizeAnimationPlanResponse(value).animationPlan
    });
    assertSelectedVariant(variant.id);
    const { animationPlan, metadata } = normalizeAnimationPlanResponse(response);
    state.animationPlans[variant.id] = animationPlan;
    state.output.animationPlans = state.animationPlans;
    state.output.animationPlan = animationPlan;
    if (metadata) {
      state.animationPlanMetadata[variant.id] = {
        ...(state.animationPlanMetadata[variant.id] || {}),
        ...metadata
      };
      state.output.animationPlanMetadata = state.animationPlanMetadata;
    }
    state.animationAspectRatioDrafts[variant.id] = normalizeAnimationPlanAspectRatio(animationPlan.productionStrategy?.targetAspectRatio);
    renderAnimationPlan(animationPlan);
    setModelSettingsStatus(`已重写为 ${videoPromptProfileLabel(animationPlan.productionStrategy?.videoPromptProfile)} 提示词。`, "ready");
    setAnimationStatus("视频提示词已更新并签发新 Plan revision；旧 Plan 媒体已标记 stale。", "ready");
    updateStoryExportActions();
  } catch (error) {
    renderAnimationPlan(plan);
    setModelSettingsStatus(error.message || "视频提示词重写失败。", "error");
    setAnimationStatus("提示词重写失败；原 Animation Plan 保持不变。", "error");
  } finally {
    state.animationPromptRewriting = false;
    elements.saveModelSettings.disabled = false;
    elements.resetModelSettings.disabled = false;
    setAnimationRunning(false);
  }
}
function setModelSettingsStatus(message, tone = "") {
  elements.modelSettingsStatus.textContent = message;
  elements.modelSettingsStatus.className = `story-status ${tone}`;
}
function readModelOverrides() {
  try {
    const value = JSON.parse(localStorage.getItem("directorModelOverrides") || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? sanitizeStoredModelOverrides(value) : {};
  } catch {
    return {};
  }
}
function withModelOverrides(body = {}) {
  const overrides = sanitizedModelOverrides();
  return Object.keys(overrides).length ? { ...body, modelOverrides: overrides } : body;
}
function sanitizedModelOverrides() {
  const allowedStages = new Set(MODEL_STAGE_DEFS.map((stage) => stage.key));
  return Object.fromEntries(Object.entries(state.modelOverrides || {}).filter(([stage, value]) => (
    allowedStages.has(stage)
    && value?.provider
    && value?.model
    && modelAllowedForStage(value.model, value.provider, stage)
  )));
}
function sanitizeStoredModelOverrides(overrides = {}) {
  const allowedStages = new Set(MODEL_STAGE_DEFS.map((stage) => stage.key));
  return Object.fromEntries(Object.entries(overrides).filter(([stage, value]) => {
    if (!allowedStages.has(stage)) return false;
    if (!value?.provider || !value?.model) return false;
    return modelAllowedForStage(value.model, value.provider, stage);
  }));
}
function isKnownQwenTextOnlyModel(model = "") {
  return /^qwen(?:\d+(?:\.\d+)?)?-max(?:-|$)/iu.test(String(model).trim());
}
function applyEffectiveModelState() {
  const analysis = effectiveStageSetting("analysis");
  const story = effectiveStageSetting("fullStory");
  const animation = effectiveStageSetting("animationPlan");
  const staticFrameCompiler = effectiveStageSetting("staticFrameCompiler");
  state.analysisProvider = analysis.provider || "MiMo";
  state.analysisModel = analysis.model || "mimo-v2.5";
  state.storyProvider = story.provider || state.analysisProvider;
  state.storyModel = story.model || state.analysisModel;
  state.animationProvider = animation.provider || state.storyProvider;
  state.animationModel = animation.model || state.storyModel;
  state.staticFrameCompilerProvider = staticFrameCompiler.provider || "";
  state.staticFrameCompilerModel = staticFrameCompiler.model || "";
  const media = analysisMediaSettings();
  state.mediaMode = media.mediaMode;
  state.nativeVideoMaxBytes = media.nativeVideoMaxBytes;
}
function effectiveStageSetting(stage) {
  return normalizeStageSetting(stage, {
    ...(state.modelStages[stage] || {}),
    ...(state.modelOverrides[stage] || {})
  });
}
function normalizeStageSetting(stage, setting = {}) {
  return setting;
}
function availableModelProviders() {
  const llmProviders = new Set(["Qwen", "MiMo", "DeepSeek"]);
  const configured = Object.entries(state.providers || {})
    .filter(([provider, value]) => llmProviders.has(provider) && value?.configured)
    .map(([provider]) => provider);
  const fromStages = MODEL_STAGE_DEFS
    .filter((stage) => !stage.providerLocked)
    .map((stage) => state.modelStages?.[stage.key]?.provider)
    .filter((provider) => llmProviders.has(provider));
  return [...new Set([...configured, ...fromStages, "Qwen", "MiMo", "DeepSeek"])];
}
function renderModelOptions(stage, provider, selectedModel, defaultSetting = {}) {
  const options = modelOptionsForStage(stage, provider, selectedModel, defaultSetting);
  return options.map((model) => `<option value="${escape(model)}"${model === selectedModel ? " selected" : ""}>${escape(model)}</option>`).join("");
}
function modelOptionsForStage(stage, provider, selectedModel = "", defaultSetting = {}) {
  const key = typeof stage === "string" ? stage : stage.key;
  if (!providerAllowedForStage(provider, key)) return [];
  const catalog = modelCatalogFor(provider, key);
  const providerModels = Array.isArray(state.providers?.[provider]?.modelIds) ? state.providers[provider].modelIds : [];
  const candidates = [
    selectedModel,
    defaultSetting.provider === provider ? defaultSetting.model : "",
    state.providers?.[provider]?.defaultModel || "",
    ...catalog,
    ...providerModels
  ];
  const filtered = uniqueModels(candidates)
    .filter((model) => modelAllowedForStage(model, provider, key))
    .slice(0, 120);
  return filtered.length ? filtered : uniqueModels(catalog);
}
function modelCatalogFor(provider, stageKey) {
  const catalog = MODEL_OPTION_CATALOG[provider] || {};
  if (catalog[stageKey]) return catalog[stageKey];
  if (MEDIA_INPUT_MODEL_STAGES.has(stageKey)) return catalog.media || catalog.text || [];
  return catalog.text || catalog.media || [];
}
function providerDefaultModel(provider, stageKey) {
  const catalog = modelCatalogFor(provider, stageKey);
  return catalog[0] || state.providers?.[provider]?.defaultModel || "";
}
function modelAllowedForStage(model, provider, stageKey) {
  if (!model) return false;
  if (!providerAllowedForStage(provider, stageKey)) return false;
  if (stageKey === "shotVideo") {
    return provider === "VideoHTTP" || modelCatalogFor(provider, stageKey).includes(model);
  }
  if (provider !== "Qwen" || !MEDIA_INPUT_MODEL_STAGES.has(stageKey)) return true;
  return !isKnownQwenTextOnlyModel(model) && /(?:plus|vl|omni)/iu.test(model);
}
function providerAllowedForStage(provider, stageKey) {
  return !(provider === "DeepSeek" && MEDIA_INPUT_MODEL_STAGES.has(stageKey));
}
function uniqueModels(values = []) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const model = String(value || "").trim();
    if (!model || seen.has(model)) continue;
    seen.add(model);
    result.push(model);
  }
  return result;
}
function analysisMediaSettings() {
  const provider = effectiveStageSetting("analysis").provider || state.analysisProvider || "MiMo";
  const source = state.providers?.[provider] || {};
  return {
    mediaMode: source.mediaMode || state.mediaMode || "auto",
    nativeVideoMaxBytes: Number(source.nativeVideoMaxBytes || state.nativeVideoMaxBytes || 0)
  };
}
function modelStagesReady() {
  return MODEL_STAGE_DEFS.every((stage) => {
    if (stage.optional) return true;
    const setting = effectiveStageSetting(stage.key);
    const provider = state.providers?.[setting.provider];
    if (!provider?.configured) return false;
    if (state.modelOverrides?.[stage.key]) return true;
    const health = state.stageHealth?.[stage.key];
    return !health || health.modelAvailable !== false;
  });
}
function updateModelStateLabel() {
  elements.modelState.lastElementChild.textContent = modelStateSummary();
}
function modelStateSummary() {
  const compiler = staticFrameCompilerModelLabel();
  return `${modelDisplayLabel(state.analysisProvider, state.analysisModel)} 解析 · 剧情 ${modelDisplayLabel(state.storyProvider, state.storyModel)} · 动画 ${modelDisplayLabel(state.animationProvider, state.animationModel)}${compiler ? ` · 静态帧 ${compiler}` : ""}`;
}
function updateModelActionLabels() {
  if (!state.storyRunning) elements.storyGenerate.querySelector("span").textContent = `用 ${storyModelLabel()} 生成完整剧情`;
  if (!state.animationRunning) elements.animationGenerate.textContent = "生成动画镜头生产包";
  updateShotVideoProviderUi();
}
function updateShotVideoProviderUi() {
  const setting = shotVideoSetting();
  const label = shotVideoProviderLabel(setting.provider);
  if (elements.shotVideoEyebrow) elements.shotVideoEyebrow.textContent = SHOT_VIDEO_PROVIDER_EYEBROWS[setting.provider] || String(setting.provider || "VIDEO").toUpperCase();
  if (!state.shotVideoGeneration.running) elements.confirmGenerateShotVideo.querySelector("span").textContent = `用 ${label} 生成`;
  elements.animationPlan.querySelectorAll("[data-generate-shot-video]").forEach((button) => {
    button.textContent = `用 ${label} 生成此镜头视频`;
  });
  if (state.shotVideoGeneration.open) {
    updateShotVideoGeneratorPreview({ preservePrompt: true });
  }
}
function modelDisplayLabel(provider, model) {
  const name = modelName(model);
  if (!name) return String(provider || "");
  return provider && !name.toLowerCase().includes(String(provider).toLowerCase()) ? `${provider} ${name}` : name;
}
function modelName(model) { return String(model || "").split("/").pop(); }
function validateReady() { if (!state.running) elements.run.disabled = !(state.frames.length >= 3 && elements.fixedCharacter.value.trim() && elements.vertical.value.trim()); }
function showError(message) { elements.error.textContent = message; }
function profile() { return { fixedCharacter: elements.fixedCharacter.value.trim(), vertical: elements.vertical.value.trim(), constraints: elements.constraints.value.trim() }; }
function handleProfileInput() {
  const currentProfile = profile();
  if (
    state.production.runId
    && (!state.characterBoundaryProfile || JSON.stringify(currentProfile) !== JSON.stringify(state.characterBoundaryProfile))
  ) {
    invalidateGlobalCharacterBoundary();
  }
  saveProfile();
  validateReady();
}
function invalidateGlobalCharacterBoundary(message = "固定角色或创作设定已修改；旧的全局角色边界已失效，请重新运行工作流。") {
  abandonActiveProductionRun();
  state.characterBoundaryProfile = null;
  state.output = {};
  state.selectedVariantId = null;
  state.fullStories = {};
  state.animationPlans = {};
  state.animationPlanMetadata = {};
  state.animationAspectRatioDrafts = {};
  state.shotFrameResults = {};
  state.shotVideoResults = {};
  [elements.analysis, elements.script, elements.brief, elements.guardrails, elements.variants].forEach((element) => {
    element.innerHTML = "";
    element.classList.add("hidden");
  });
  elements.export.classList.add("hidden");
  showError(message);
}
function globalCharacterBoundaryContext() {
  return {
    creatorProfile: profile(),
    referenceAnalysis: state.output.referenceAnalysis,
    sourceScriptReconstruction: state.output.sourceScriptReconstruction,
    creativeBrief: state.output.creativeBrief,
    visualGuardrails: state.output.visualGuardrails
  };
}
function saveProfile() { localStorage.setItem("directorProfile", JSON.stringify(profile())); }
function restoreProfile() { try { const data = JSON.parse(localStorage.getItem("directorProfile")); if (data) { elements.fixedCharacter.value = data.fixedCharacter || ""; elements.vertical.value = data.vertical || ""; elements.constraints.value = data.constraints || ""; } } catch {} }

function persistActiveProductionRun() {
  if (!state.production.projectId || !state.production.runId) return;
  localStorage.setItem(ACTIVE_PRODUCTION_RUN_STORAGE_KEY, JSON.stringify({
    projectId: state.production.projectId,
    runId: state.production.runId
  }));
}

function abandonActiveProductionRun() {
  state.production = emptyProductionState();
  localStorage.removeItem(ACTIVE_PRODUCTION_RUN_STORAGE_KEY);
}

async function restoreActiveProductionRun() {
  let active;
  try {
    active = JSON.parse(localStorage.getItem(ACTIVE_PRODUCTION_RUN_STORAGE_KEY) || "null");
  } catch {
    localStorage.removeItem(ACTIVE_PRODUCTION_RUN_STORAGE_KEY);
    return false;
  }
  if (!active?.projectId || !active?.runId) return false;
  try {
    const run = await api("/api/production/run/load", {
      projectId: active.projectId,
      runId: active.runId,
      includeContent: true
    });
    state.production = productionStateFromRun(run);
    restoreRunMetadata(run.metadata || {});
    restoreRunArtifacts(run.latestArtifacts || {});
    persistActiveProductionRun();
    return true;
  } catch {
    abandonActiveProductionRun();
    return false;
  }
}

function restoreRunMetadata(metadata = {}) {
  state.metadata = metadata.sourceVideo || null;
  if (metadata.creatorProfile && typeof metadata.creatorProfile === "object") {
    elements.fixedCharacter.value = metadata.creatorProfile.fixedCharacter || "";
    elements.vertical.value = metadata.creatorProfile.vertical || "";
    elements.constraints.value = metadata.creatorProfile.constraints || "";
    saveProfile();
  }
  if (typeof metadata.transcript === "string") elements.transcript.value = metadata.transcript;
}

function restoreRunArtifacts(latestArtifacts = {}) {
  const currentContent = (artifactId) => {
    const entry = latestArtifacts[artifactId];
    return entry?.lineage?.status === "current" ? entry.content : null;
  };
  state.output = {
    referenceAnalysis: currentContent("referenceAnalysis"),
    sourceScriptReconstruction: currentContent("sourceScriptReconstruction"),
    creativeBrief: currentContent("creativeBrief"),
    visualGuardrails: currentContent("visualGuardrails"),
    themeVariants: currentContent("themeVariants")
  };
  state.characterBoundaryProfile = state.output.visualGuardrails ? { ...profile() } : null;
  state.fullStories = {};
  state.animationPlans = {};
  state.animationPlanMetadata = {};
  state.animationAspectRatioDrafts = {};
  state.shotFrameResults = {};
  state.shotVideoResults = {};
  const currentEntries = Object.entries(latestArtifacts)
    .filter(([, entry]) => entry?.lineage?.status === "current")
    .sort((left, right) => String(left[1].lineage.createdAt || "").localeCompare(String(right[1].lineage.createdAt || "")));
  for (const [artifactId, entry] of currentEntries) {
    if (artifactId.startsWith("fullStory:")) state.fullStories[artifactId.slice("fullStory:".length)] = entry.content;
    else if (artifactId.startsWith("animationPlan:")) {
      const variantId = artifactId.slice("animationPlan:".length);
      state.animationPlans[variantId] = entry.content;
      state.animationAspectRatioDrafts[variantId] = normalizeAnimationPlanAspectRatio(entry.content?.productionStrategy?.targetAspectRatio);
    }
    else if (artifactId.startsWith("shotVideo:")) {
      const parts = artifactId.split(":");
      const variantId = parts[1] || "";
      const shotId = parts.slice(2).join(":");
      state.shotVideoResults[shotVideoResultKey(variantId, shotId)] = entry.content;
    } else if (artifactId.startsWith("shotFrame:")) {
      const parts = artifactId.split(":");
      const variantId = parts[1] || "";
      const frameKind = parts.at(-1);
      const shotId = parts.slice(2, -1).join(":");
      state.shotFrameResults[shotFrameKey(shotId, frameKind, variantId)] = entry.content;
    }
  }
  state.output.fullStories = state.fullStories;
  state.output.animationPlans = state.animationPlans;
  state.selectedVariantId = resolveRestoredVariantId(latestArtifacts);
  if (state.selectedVariantId) {
    state.output.fullStory = state.fullStories[state.selectedVariantId] || null;
    state.output.animationPlan = state.animationPlans[state.selectedVariantId] || null;
  }
  renderCurrentMainOutputs();
}

function renderCurrentMainOutputs() {
  const rendered = [
    [state.output.referenceAnalysis, renderAnalysis, "analysis"],
    [state.output.sourceScriptReconstruction, renderScript, "script"],
    [state.output.creativeBrief, renderBrief, "brief"],
    [state.output.visualGuardrails, renderVisualGuardrails, "guardrails"],
    [state.output.themeVariants, renderVariants, "variants"]
  ];
  resetPipeline();
  for (const element of [elements.analysis, elements.script, elements.brief, elements.guardrails, elements.variants]) {
    element.innerHTML = "";
    element.classList.add("hidden");
  }
  if (rendered.some(([value]) => Boolean(value))) {
    elements.empty.classList.add("hidden");
    elements.resultStack.classList.remove("hidden");
    for (const [value, render, stage] of rendered) {
      if (!value) continue;
      render(value);
      setStage(stage, "done");
    }
    elements.export.classList.remove("hidden");
  } else {
    elements.empty.classList.remove("hidden");
    elements.resultStack.classList.add("hidden");
    elements.export.classList.add("hidden");
  }
}
function selectedVariant() { return (state.output.themeVariants?.variants || []).find((variant) => String(variant.id) === String(state.selectedVariantId)); }
function currentFullStory() {
  const variant = selectedVariant();
  return variant ? state.fullStories[variant.id] || state.output.fullStory || null : state.output.fullStory || null;
}
function currentModelInfo() {
  return {
    stages: Object.fromEntries(MODEL_STAGE_DEFS.map((stage) => [stage.key, effectiveStageSetting(stage.key)])),
    overrides: sanitizedModelOverrides(),
    analysisProvider: state.analysisProvider,
    analysisModel: state.analysisModel,
    storyProvider: state.storyProvider,
    storyModel: state.storyModel,
    animationProvider: state.animationProvider,
    animationModel: state.animationModel,
    staticFrameCompilerProvider: state.staticFrameCompilerProvider,
    staticFrameCompilerModel: state.staticFrameCompilerModel
  };
}

function selectedStoryPackage() {
  const variant = selectedVariant();
  if (!variant) return null;
  const animationMetadata = state.animationPlanMetadata[variant.id] || {};
  const staticFrameCompiler = animationMetadata.staticFrameCompiler;
  const characterFeatureCompiler = animationMetadata.characterFeatureCompiler;
  const privateSidecars = animationMetadata.privateSidecars;
  const compilerMetadata = {
    ...(staticFrameCompiler ? { staticFrameCompiler } : {}),
    ...(characterFeatureCompiler ? { characterFeatureCompiler } : {})
  };
  const pack = {
    packageType: "story-production-test-package",
    packageVersion: "3.0",
    exportedAt: new Date().toISOString(),
    mode: state.mode,
    modelInfo: currentModelInfo(),
    sourceVideo: state.metadata,
    creatorProfile: profile(),
    referenceAnalysis: state.output.referenceAnalysis || null,
    sourceScriptReconstruction: state.output.sourceScriptReconstruction || null,
    selectedVariant: variant,
    themeVariants: state.output.themeVariants || { variants: [variant] },
    creativeBrief: state.output.creativeBrief,
    visualGuardrails: state.output.visualGuardrails,
    fullStory: state.fullStories[variant.id] || state.output.fullStory || null,
    animationPlan: state.animationPlans[variant.id] || state.output.animationPlan || null,
    ...(Object.keys(compilerMetadata).length ? { metadata: compilerMetadata } : {}),
    ...(privateSidecars && typeof privateSidecars === "object" && !Array.isArray(privateSidecars)
      ? { privateSidecars: structuredClone(privateSidecars) }
      : {}),
    shotFrameResults: state.shotFrameResults || {},
    shotVideoResults: state.shotVideoResults || {}
  };
  return pack;
}

function updateStoryExportActions() {
  const pack = selectedStoryPackage();
  const hasStory = Boolean(pack?.fullStory);
  const hasAnimation = Boolean(pack?.animationPlan);
  elements.exportStoryPackage.disabled = !hasStory;
  elements.exportStoryTestPackage.disabled = !hasStory;
  elements.copyAnimationPack.disabled = !hasAnimation;
}

function exportJson() {
  const payload = { exportedAt: new Date().toISOString(), mode: state.mode, modelInfo: currentModelInfo(), sourceVideo: state.metadata, creatorProfile: profile(), ...state.output };
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `短视频创意方案-${Date.now()}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

async function exportCurrentStoryPackage() {
  const pack = selectedStoryPackage();
  if (!pack?.fullStory) return setStoryStatus("请先生成完整剧情，再导出当前生产包。", "error");
  try {
    const sealed = await sealProductionPackage(pack);
    const suffix = sealed.animationPlan ? "动画生产包" : "完整剧情";
    downloadJson(sealed, `短视频${suffix}-${sealed.selectedVariant?.id || "variant"}-${Date.now()}.json`);
  } catch (error) {
    setStoryStatus(error.message || "生产包签发失败。", "error");
  }
}

async function exportStoryTestPackage() {
  const pack = selectedStoryPackage();
  if (!pack?.fullStory) return setStoryPackageStatus("请先生成或导入完整剧情，再导出测试包。", "error");
  try {
    const sealed = await sealProductionPackage(pack);
    const suffix = sealed.animationPlan ? "完整剧情-动画测试包" : "完整剧情测试包";
    downloadJson(sealed, `短视频${suffix}-${sealed.selectedVariant?.id || "variant"}-${Date.now()}.json`);
    setStoryPackageStatus(`已导出签名的 ${sealed.animationPlan ? "完整剧情 + 动画生产包" : "完整剧情"} 测试包。`, "ready");
  } catch (error) {
    setStoryPackageStatus(error.message || "测试包签发失败。", "error");
  }
}

function sealProductionPackage(payload) {
  assertActiveProductionRun();
  return api("/api/production/package/seal", {
    projectId: state.production.projectId,
    runId: state.production.runId,
    payload
  });
}

async function importStoryTestPackage(file) {
  try {
    setStoryPackageStatus("正在导入测试包…", "");
    const payload = JSON.parse(await file.text());
    const imported = await api("/api/production/package/import", { package: payload });
    const restored = restoreStoryPackage(imported.payload, imported.production);
    setStoryPackageStatus(`已校验并隔离导入 ${restored.id}：${restored.hasStory ? "完整剧情" : "未含完整剧情"}${restored.hasAnimation ? " + 动画生产包" : ""}；旧媒体未混入。`, "ready");
  } catch (error) {
    setStoryPackageStatus(error.message || "测试包导入失败", "error");
  }
}

function restoreStoryPackage(payload, production) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("测试包 JSON 格式无效。");
  if (!production?.projectId || !production?.runId || !production?.artifacts) throw new Error("服务端没有返回隔离后的生产 Run。");
  const variant = resolveImportedVariant(payload);
  if (!variant?.id) throw new Error("测试包缺少 selectedVariant 或主题变体 id。");
  const id = String(variant.id);
  const fullStory = payload.fullStory || payload.fullStories?.[id] || payload.output?.fullStory || null;
  const animationPlan = payload.animationPlan || payload.animationPlans?.[id] || payload.output?.animationPlan || null;

  if (payload.creatorProfile && typeof payload.creatorProfile === "object") {
    elements.fixedCharacter.value = payload.creatorProfile.fixedCharacter || "";
    elements.vertical.value = payload.creatorProfile.vertical || "";
    elements.constraints.value = payload.creatorProfile.constraints || "";
    saveProfile();
    validateReady();
  }
  if (payload.modelInfo) {
    if (payload.modelInfo.overrides && typeof payload.modelInfo.overrides === "object") {
      state.modelOverrides = sanitizeStoredModelOverrides(payload.modelInfo.overrides);
      localStorage.setItem("directorModelOverrides", JSON.stringify(state.modelOverrides));
    } else {
      state.storyProvider = payload.modelInfo.storyProvider || state.storyProvider;
      state.storyModel = payload.modelInfo.storyModel || state.storyModel;
      state.animationProvider = payload.modelInfo.animationProvider || state.animationProvider;
      state.animationModel = payload.modelInfo.animationModel || state.animationModel;
      state.staticFrameCompilerProvider = payload.modelInfo.staticFrameCompilerProvider || state.staticFrameCompilerProvider;
      state.staticFrameCompilerModel = payload.modelInfo.staticFrameCompilerModel || state.staticFrameCompilerModel;
    }
    applyEffectiveModelState();
    elements.storyModelName.textContent = modelDisplayLabel(state.storyProvider, state.storyModel);
    renderModelSettings();
  }

  state.production = {
    ...emptyProductionState(),
    schemaVersion: production.lineageSchemaVersion || "1.0",
    projectId: production.projectId,
    runId: production.runId,
    artifacts: structuredClone(production.artifacts || {}),
    stages: structuredClone(production.stages || {}),
    checkpoint: structuredClone(production.checkpoint || { sequence: 0, updatedAt: "" })
  };
  persistActiveProductionRun();
  state.metadata = payload.sourceVideo || legacySourceVideoMetadata(payload.metadata) || null;
  state.output = {
    referenceAnalysis: payload.referenceAnalysis || payload.output?.referenceAnalysis || null,
    sourceScriptReconstruction: payload.sourceScriptReconstruction || payload.output?.sourceScriptReconstruction || null,
    creativeBrief: payload.creativeBrief || payload.output?.creativeBrief || null,
    visualGuardrails: payload.visualGuardrails || payload.output?.visualGuardrails || null
  };
  state.characterBoundaryProfile = state.output.visualGuardrails ? { ...profile() } : null;
  state.output.themeVariants = mergeImportedThemeVariants(payload.themeVariants || payload.output?.themeVariants, variant);
  state.selectedVariantId = id;

  state.fullStories = {};
  state.animationPlans = {};
  state.animationPlanMetadata = structuredClone(payload.animationPlanMetadata || payload.output?.animationPlanMetadata || {});
  state.animationAspectRatioDrafts = {};
  state.shotFrameResults = {};
  state.shotVideoResults = {};
  state.characterReferenceStatuses = {};
  if (fullStory) {
    state.fullStories[id] = fullStory;
    state.output.fullStory = fullStory;
  }
  if (animationPlan) {
    state.animationPlans[id] = animationPlan;
    state.animationAspectRatioDrafts[id] = normalizeAnimationPlanAspectRatio(animationPlan.productionStrategy?.targetAspectRatio);
    state.output.animationPlan = animationPlan;
  }
  const staticFrameCompiler = payload.metadata?.staticFrameCompiler
    || payload.output?.metadata?.staticFrameCompiler
    || payload.animationPlanMetadata?.[id]?.staticFrameCompiler
    || payload.output?.animationPlanMetadata?.[id]?.staticFrameCompiler;
  if (staticFrameCompiler && typeof staticFrameCompiler === "object" && !Array.isArray(staticFrameCompiler)) {
    state.animationPlanMetadata[id] = {
      ...(state.animationPlanMetadata[id] || {}),
      staticFrameCompiler
    };
  }
  const characterFeatureCompiler = payload.metadata?.characterFeatureCompiler
    || payload.output?.metadata?.characterFeatureCompiler
    || payload.animationPlanMetadata?.[id]?.characterFeatureCompiler
    || payload.output?.animationPlanMetadata?.[id]?.characterFeatureCompiler;
  const privateSidecars = payload.privateSidecars
    || payload.metadata?.privateSidecars
    || payload.output?.privateSidecars
    || payload.animationPlanMetadata?.[id]?.privateSidecars
    || payload.output?.animationPlanMetadata?.[id]?.privateSidecars;
  if (
    (characterFeatureCompiler && typeof characterFeatureCompiler === "object" && !Array.isArray(characterFeatureCompiler))
    || (privateSidecars && typeof privateSidecars === "object" && !Array.isArray(privateSidecars))
  ) {
    state.animationPlanMetadata[id] = {
      ...(state.animationPlanMetadata[id] || {}),
      ...(characterFeatureCompiler ? { characterFeatureCompiler } : {}),
      ...(privateSidecars ? { privateSidecars } : {})
    };
  }
  state.output.fullStories = state.fullStories;
  state.output.animationPlans = state.animationPlans;
  state.output.animationPlanMetadata = state.animationPlanMetadata;
  state.characterImageGeneration.results = [];
  state.characterImageGeneration.referenceImageDataUrl = "";
  state.characterImageGeneration.referenceImageName = "";
  state.shotVideoGeneration.referenceAssets = [];
  renderCurrentMainOutputs();
  elements.export.classList.remove("hidden");
  history.replaceState({ storyVariantId: id }, "", `/story/${encodeURIComponent(id)}`);
  renderStoryPage({ autoGenerate: false });
  return { id, hasStory: Boolean(fullStory), hasAnimation: Boolean(animationPlan) };
}

function legacySourceVideoMetadata(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) || metadata.staticFrameCompiler) return null;
  const videoKeys = ["name", "size", "type", "duration", "width", "height"];
  return videoKeys.some((key) => metadata[key] !== undefined) ? metadata : null;
}

function mergeImportedThemeVariants(themeVariants, variant) {
  const imported = Array.isArray(themeVariants?.variants) ? themeVariants.variants : [];
  const merged = [...imported, variant].filter(Boolean).reduce((acc, item) => {
    if (!item?.id || acc.some((entry) => String(entry.id) === String(item.id))) return acc;
    acc.push(item);
    return acc;
  }, []);
  return { ...(themeVariants || {}), variants: merged };
}

function setStoryPackageStatus(message, tone = "") {
  elements.storyPackageStatus.textContent = message;
  elements.storyPackageStatus.className = tone;
}

async function copyAnimationProductionPack() {
  const pack = selectedStoryPackage();
  if (!pack?.animationPlan) return setAnimationStatus("请先生成动画生产包，再复制给供应商程序使用。", "error");
  const text = formatAnimationPackMarkdown(pack);
  try {
    await navigator.clipboard.writeText(text);
    setAnimationStatus("已复制动画生产包 Markdown，可直接粘贴到供应商程序。", "ready");
  } catch {
    setAnimationStatus("浏览器拒绝访问剪贴板，请使用“导出当前生产包 JSON”。", "error");
  }
}

function downloadJson(payload, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function formatAnimationPackMarkdown(pack) {
  const plan = pack.animationPlan || {};
  const strategy = plan.productionStrategy || {};
  const visual = plan.visualBible || {};
  const guardrails = pack.visualGuardrails || {};
  const boundary = guardrails.fixedCharacterBoundary || {};
  const runtimeSummary = animationPlanRuntimeSummary(plan);
  const lines = [
    `# ${plan.title || pack.fullStory?.title || "动画镜头生产包"}`,
    "",
    `- 画幅：${strategy.targetAspectRatio || "9:16"}`,
    `- 镜头计划合计时长：${runtimeSummary.valid ? `${runtimeSummary.plannedSeconds} 秒` : `待确认（${runtimeSummary.reason}）`}`,
    `- 上游目标时长：${runtimeSummary.targetSeconds || pack.fullStory?.targetDurationSeconds || "待确认"} 秒`,
    ...(runtimeSummary.valid && runtimeSummary.deltaSeconds !== null
      ? [`- 时长偏差：${runtimeSummary.deltaSeconds > 0 ? "+" : ""}${runtimeSummary.deltaSeconds} 秒`]
      : []),
    `- 单镜头时长：${formatAnimationShotDurationRange(plan)}`,
    `- 工作流：${strategy.format || "first_last_frame_video"}`,
    `- Prompt Schema：${plan.promptSchemaVersion || "legacy"}`,
    "",
    "## 角色身份锁定与允许特征",
    ...formatObjectMarkdown(boundary),
    ...formatAllowedTraitsMarkdown(guardrails.allowedPositiveTraits),
    "",
    "## 四类约束",
    "",
    "### 1. 正向提示词边界",
    ...formatRuleCollectionMarkdown(guardrails.positivePromptBoundary),
    "",
    "### 2. 原片表面表达来源记录",
    ...formatRuleCollectionMarkdown(guardrails.sourceSimilarityRules),
    "",
    "### 3. 台词与行为规则",
    ...formatRuleCollectionMarkdown(guardrails.dialogueRules),
    "",
    "### 4. 实际渲染负面提示词（逐镜）"
  ];
  for (const shot of plan.shotPlan || []) {
    lines.push(
      "",
      `#### ${shot.shotId || "镜头"}`,
      "图片：",
      ...formatShotNegativeEntriesMarkdown(shot, "image"),
      "",
      "视频：",
      ...formatShotNegativeEntriesMarkdown(shot, "video")
    );
  }
  lines.push(
    "",
    "## 视觉圣经",
    `- 整体风格：${visual.overallStyle || ""}`,
    `- 动画风格：${visual.animationStyle || ""}`,
    `- 色彩：${(visual.colorPalette || []).join(" / ")}`,
    `- 光线：${visual.lighting || ""}`,
    `- 镜头语言：${visual.cameraLanguage || ""}`,
    `- 角色一致性：${(visual.characterConsistencyRules || []).join("；")}`,
    "",
    "## 角色参考图 Prompt"
  );
  for (const item of plan.characterReferencePrompts || []) {
    lines.push(
      "",
      `### ${item.characterName || "角色"}`,
      item.referenceImageAdded ? `参考图：已添加人物参考图${item.referenceImageName ? `（${item.referenceImageName}）` : ""}` : "参考图：未添加",
      item.appearancePrompt || "",
      item.referenceImageNotes ? `参考图吸收：${item.referenceImageNotes}` : "",
      `一致性标签：${(item.consistencyTags || []).join(" / ")}`
    );
  }
  lines.push("", "## 关键资产 Prompt");
  for (const item of plan.assetPrompts || []) {
    lines.push("", `### ${item.assetName || "资产"}`, item.imagePrompt || "", `功能：${item.storyFunction || ""}`, `一致性标签：${(item.consistencyTags || []).join(" / ")}`);
  }
  lines.push("", "## 场景参考 Prompt");
  for (const item of plan.sceneReferencePrompts || []) {
    lines.push(
      "",
      `### ${item.sceneName || item.sceneId || "场景"}`,
      `场景 ID：${item.sceneId || ""}`,
      item.environmentPrompt || "",
      `功能：${item.storyFunction || ""}`,
      `连续性锚点：${(item.continuityAnchors || []).join(" / ")}`,
      `关联镜头：${(item.relatedShotIds || []).join(" / ")}`
    );
  }
  lines.push("", "## 镜头生产任务");
  for (const shot of plan.shotPlan || []) {
    const endpointPromptLines = hasPlannedEndpoints(shot) ? [
      "",
      "首帧 prompt：",
      shot.startFramePrompt || "",
      "",
      "尾帧 prompt：",
      shot.endFramePrompt || ""
    ] : [];
    lines.push(
      "",
      `### ${shot.shotId || "镜头"} · ${shot.sourceSceneId || ""} · ${formatShotDurationSeconds(shot)}`,
      `场景 ID：${shot.sceneId || ""}`,
      `剧情功能：${shot.storyPurpose || ""}`,
      `情绪目标：${shot.emotionalTarget || ""}`,
      ...endpointPromptLines,
      "",
      "视频 prompt：",
      shot.videoPrompt || "",
      "",
      `镜头运动：${shot.cameraMotion || ""}`,
      `角色动作：${shot.characterAction || ""}`,
      `对白/字幕：${shot.dialogueOrSubtitle || ""}`,
      `声音设计：${shot.soundDesign || ""}`,
      `连续性备注：${shot.continuityNotes || ""}`,
      `验收标准：${(shot.acceptanceCriteria || []).join("；")}`
    );
  }
  lines.push("", "## 生成检查清单");
  for (const item of plan.generationChecklist || []) lines.push(`- ${item.check || ""}：${item.passCriteria || ""}`);
  return lines.join("\n");
}

function formatObjectMarkdown(value = {}) {
  const entries = Object.entries(value || {}).filter(([, item]) => item !== null && item !== undefined && item !== "");
  return entries.length ? entries.map(([key, item]) => `- ${key}：${structuredValue(item)}`) : ["- 无"];
}

function formatAllowedTraitsMarkdown(value = []) {
  const entries = Array.isArray(value) ? value : [];
  if (!entries.length) return ["- 允许特征：无额外允许项"];
  return entries.map((item) => {
    if (typeof item === "string") return `- 允许特征：${item}`;
    const text = item?.term || item?.text || item?.rule || "未命名特征";
    const details = [item?.scope ? `scope=${item.scope}` : "", item?.reason ? `reason=${item.reason}` : ""].filter(Boolean).join("；");
    return `- 允许特征：${text}${details ? `（${details}）` : ""}`;
  });
}

function formatRuleCollectionMarkdown(value) {
  const items = normalizeRuleItems(value);
  if (!items.length) return ["- 无"];
  return items.map((item) => {
    if (typeof item === "string") return `- ${item}`;
    const title = firstRuleValue(item, ["text", "rule", "term", "name", "requirement", "boundary", "prohibition", "category"]) || "规则";
    const details = ruleDetailPairs(item).map(([label, detail]) => `${label}=${structuredValue(detail)}`).join("；");
    return `- ${title}${details ? `（${details}）` : ""}`;
  });
}

function formatShotNegativeEntriesMarkdown(shot = {}, target = "image") {
  const compiled = compileShotNegativePrompt(shot, target);
  if (!compiled.negativePromptEntries.length) return ["- 无"];
  return compiled.negativePromptEntries.map((entry) => (
    `- [${entry.priority}] ${entry.text}（appliesTo=${entry.appliesTo}；reasonCode=${entry.reasonCode}；triggerEvidence=${structuredValue(entry.triggerEvidence)}）`
  ));
}

function escape(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}
function formatDialogue(items = []) {
  if (!Array.isArray(items) || !items.length) return "无对白，以动作和声画推进";
  return items.map((item) => `${escape(item.speaker || "角色")}：${escape(item.line || "")}${item.deliveryOrSubtext ? `（${escape(item.deliveryOrSubtext)}）` : ""}`).join("<br>");
}
function formatBytes(bytes) { if (!bytes) return "0 B"; const unit = Math.min(3, Math.floor(Math.log(bytes) / Math.log(1024))); return `${(bytes / (1024 ** unit)).toFixed(unit ? 1 : 0)} ${["B", "KB", "MB", "GB"][unit]}`; }
function formatTime(seconds) { const value = Math.max(0, Math.floor(Number(seconds) || 0)); return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`; }
function skeletonFrames(count) { return Array.from({ length: count }, () => `<div class="frame"></div>`).join(""); }
