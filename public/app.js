import { buildVideoGenerationQueue, formatQueueJsonl } from "./animation-queue.js";
import { syncShotCharacterReference } from "./character-reference-sync.js";
import { buildShotFrameImagePrompt } from "./shot-frame-prompt.js";
import { shotRelatedCharacterReferences, uploadedReferenceImages } from "./shot-reference-images.js";

const state = {
  file: null,
  previewUrl: null,
  videoDataUrl: null,
  frames: [],
  metadata: null,
  output: {},
  selectedVariantId: null,
  fullStories: {},
  animationPlans: {},
  shotVideoResults: {},
  shotFrameResults: {},
  characterReferenceStatuses: {},
  characterImageGeneration: {
    open: false,
    running: false,
    selectedIndex: 0,
    count: 1,
    referenceImageDataUrl: "",
    referenceImageName: "",
    results: []
  },
  shotFrameImageGeneration: {
    open: false,
    running: false,
    shotId: "",
    frameKind: "start",
    count: 4
  },
  shotVideoGeneration: {
    open: false,
    running: false,
    shotId: "",
    count: 1
  },
  mode: "demo",
  mediaMode: "auto",
  storyModel: "mimo-v2.5-pro",
  animationModel: "mimo-v2.5-pro",
  storyProvider: "MiMo",
  animationProvider: "MiMo",
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
  openModelSettings: $("#openModelSettings"), modelSettingsModal: $("#modelSettingsModal"), closeModelSettings: $("#closeModelSettings"),
  modelStageList: $("#modelStageList"), resetModelSettings: $("#resetModelSettings"), saveModelSettings: $("#saveModelSettings"),
  modelSettingsStatus: $("#modelSettingsStatus"),
  empty: $("#emptyResults"), resultStack: $("#resultStack"), export: $("#exportButton"),
  analysis: $("#analysisResult"), script: $("#scriptResult"), brief: $("#briefResult"), guardrails: $("#guardrailsResult"), variants: $("#variantsResult"),
  mainPage: $("#top"), storyPage: $("#storyPage"), storyModelName: $("#storyModelName"),
  selectedVariantSummary: $("#selectedVariantSummary"), storyStatus: $("#storyStatus"),
  storyGenerate: $("#generateFullStory"), fullStory: $("#fullStoryResult"), backToResults: $("#backToResults"),
  animationGenerate: $("#generateAnimationPlan"), animationStatus: $("#animationStatus"), animationPlan: $("#animationPlanResult"),
  exportStoryPackage: $("#exportStoryPackage"), copyAnimationPack: $("#copyAnimationPack"), exportVideoQueue: $("#exportVideoQueue"),
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
  shotFrameImagePromptPreview: $("#shotFrameImagePromptPreview"), shotFrameImageStatus: $("#shotFrameImageStatus"),
  confirmGenerateShotFrameImage: $("#confirmGenerateShotFrameImage"), confirmGenerateShotFrameImageLabel: $("#confirmGenerateShotFrameImageLabel"),
  shotFrameImageResults: $("#shotFrameImageResults"),
  shotVideoModal: $("#shotVideoModal"), closeShotVideoModal: $("#closeShotVideoModal"),
  shotVideoModalTitle: $("#shotVideoModalTitle"), shotVideoMeta: $("#shotVideoMeta"),
  shotVideoReferenceList: $("#shotVideoReferenceList"), shotVideoCount: $("#shotVideoCount"),
  shotVideoPromptPreview: $("#shotVideoPromptPreview"), shotVideoStatus: $("#shotVideoStatus"),
  confirmGenerateShotVideo: $("#confirmGenerateShotVideo"), shotVideoResults: $("#shotVideoResults"),
  generatedImagePreview: $("#generatedImagePreview"), generatedImagePreviewImage: $("#generatedImagePreviewImage"),
  generatedImagePreviewCaption: $("#generatedImagePreviewCaption"), closeGeneratedImagePreview: $("#closeGeneratedImagePreview")
};

const MODEL_STAGE_DEFS = [
  { key: "analysis", label: "参考片分析", hint: "视频解析、定位、人物、节奏" },
  { key: "reconstruction", label: "脚本还原", hint: "分场、动作、镜头、转折" },
  { key: "brief", label: "创意简报", hint: "保留价值、受控变量" },
  { key: "visualGuardrails", label: "视觉规则", hint: "固定角色边界、负面联想" },
  { key: "variants", label: "主题变体", hint: "新故事方向" },
  { key: "fullStory", label: "完整剧情", hint: "可拍分场剧本" },
  { key: "animationPlan", label: "动画生产包", hint: "首尾帧、镜头与视频提示词" },
  { key: "characterReference", label: "人物图修正", hint: "根据上传图片修正角色描述" },
  { key: "imageGeneration", label: "图片生成", hint: "角色参考图、镜头首尾帧图片", providerLocked: true, optional: true },
  { key: "shotVideo", label: "首尾帧视频", hint: "单镜头图生视频候选", providerLocked: true, optional: true }
];
const MEDIA_INPUT_MODEL_STAGES = new Set(["analysis", "reconstruction", "visualGuardrails", "characterReference"]);
const MODEL_OPTION_CATALOG = {
  Qwen: {
    media: ["qwen3.7-plus", "qwen-vl-max-latest", "qwen-vl-plus-latest", "qwen-omni-turbo-latest"],
    text: ["qwen3.7-max", "qwen3.7-plus", "qwen-max-latest", "qwen-plus-latest", "qwen-turbo-latest"]
  },
  MiMo: {
    media: ["mimo-v2.5", "mimo-v2.5-pro"],
    text: ["mimo-v2.5", "mimo-v2.5-pro"]
  },
  Jimeng: {
    imageGeneration: ["doubao-seedream-5-0-260128", "seedream-5-0-lite-260128"]
  },
  VideoHTTP: {
    shotVideo: ["kling-v2-1", "dreamina-seedance-2-0-260128", "seedance-1-0-lite-i2v-250428", "seedance-1-0-pro-i2v-250528"]
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
      ? `${modelDisplayLabel(state.analysisProvider, state.analysisModel)} 解析 · 剧情 ${modelDisplayLabel(state.storyProvider, state.storyModel)} · 动画 ${modelDisplayLabel(state.animationProvider, state.animationModel)}`
      : health.mode !== "demo"
        ? "模型已配置，但部分阶段不可用"
        : "演示模式 · 配置模型后启用真实分析";
    renderModelSettings();
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
  });
  elements.backToResults.addEventListener("click", backToMainResults);
  elements.storyGenerate.addEventListener("click", () => generateFullStory({ force: true }));
  elements.animationGenerate.addEventListener("click", () => generateAnimationPlan({ force: true }));
  elements.exportStoryPackage.addEventListener("click", exportCurrentStoryPackage);
  elements.copyAnimationPack.addEventListener("click", copyAnimationProductionPack);
  elements.exportVideoQueue.addEventListener("click", exportVideoGenerationQueue);
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
  elements.closeShotFrameImageModal.addEventListener("click", closeShotFrameImageGenerator);
  elements.shotFrameImageModal.addEventListener("click", (event) => {
    if (event.target === elements.shotFrameImageModal) closeShotFrameImageGenerator();
    const previewButton = event.target.closest("[data-preview-modal-shot-frame]");
    if (previewButton) return openShotFramePreview(previewButton.dataset.previewModalShotFrame, previewButton.dataset.frameKind, previewButton.dataset.candidateIndex);
    const selectButton = event.target.closest("[data-select-modal-shot-frame]");
    if (selectButton) return useModalShotFrameCandidate(selectButton.dataset.selectModalShotFrame, selectButton.dataset.frameKind, selectButton.dataset.candidateIndex);
  });
  elements.shotFrameImageKind.addEventListener("change", () => updateShotFrameImageGeneratorPreview());
  elements.confirmGenerateShotFrameImage.addEventListener("click", confirmGenerateShotFrameImage);
  elements.closeShotVideoModal.addEventListener("click", closeShotVideoGenerator);
  elements.shotVideoModal.addEventListener("click", (event) => {
    if (event.target === elements.shotVideoModal) closeShotVideoGenerator();
    const useButton = event.target.closest("[data-use-shot-video]");
    if (useButton) return selectShotVideoCandidate(useButton.dataset.useShotVideo, useButton.dataset.candidateIndex);
  });
  elements.shotVideoCount.addEventListener("change", () => {
    state.shotVideoGeneration.count = Number(elements.shotVideoCount.value) || 1;
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
  [elements.fixedCharacter, elements.vertical, elements.constraints].forEach((element) => element.addEventListener("input", () => { saveProfile(); validateReady(); }));
}

async function handleFile(file) {
  if (!file.type.startsWith("video/")) return showError("请选择视频文件。支持 MP4、MOV、WebM 等浏览器可播放格式。");
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
  state.output = {};
  state.fullStories = {};
  state.animationPlans = {};
  state.shotVideoResults = {};
  state.shotFrameResults = {};
  state.characterReferenceStatuses = {};
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
    setStage("analysis", "active");
    state.output.referenceAnalysis = await api("/api/analyze", shared);
    renderAnalysis(state.output.referenceAnalysis);
    setStage("analysis", "done");

    setStage("script", "active");
    state.output.sourceScriptReconstruction = await api("/api/reconstruct", { ...shared, referenceAnalysis: state.output.referenceAnalysis });
    renderScript(state.output.sourceScriptReconstruction);
    setStage("script", "done");

    setStage("brief", "active");
    state.output.creativeBrief = await api("/api/brief", { referenceAnalysis: state.output.referenceAnalysis, sourceScriptReconstruction: state.output.sourceScriptReconstruction, creatorProfile });
    renderBrief(state.output.creativeBrief);
    setStage("brief", "done");

    setStage("guardrails", "active");
    state.output.visualGuardrails = await api("/api/visual-guardrails", {
      ...shared,
      referenceAnalysis: state.output.referenceAnalysis,
      sourceScriptReconstruction: state.output.sourceScriptReconstruction,
      creativeBrief: state.output.creativeBrief
    });
    renderVisualGuardrails(state.output.visualGuardrails);
    setStage("guardrails", "done");

    setStage("variants", "active");
    state.output.themeVariants = await api("/api/variants", {
      creativeBrief: state.output.creativeBrief,
      visualGuardrails: state.output.visualGuardrails,
      creatorProfile,
      count: Number(elements.variantCount.value)
    });
    renderVariants(state.output.themeVariants);
    setStage("variants", "done");
    elements.export.classList.remove("hidden");
    elements.variants.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    const active = document.querySelector(".pipeline li.active");
    if (active) setStage(active.dataset.stage, "error");
    showError(error.message || "工作流执行失败");
  } finally {
    state.running = false;
    setRunning(false);
    validateReady();
  }
}

async function api(path, body) {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(withModelOverrides(body)) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.detail ? `${data.error}：${data.detail.slice(0, 240)}` : data.error || `请求失败（${response.status}）`);
  return data.result;
}

async function streamJsonEvents(path, body, onEvent) {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(withModelOverrides(body)) });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.detail ? `${data.error}：${data.detail.slice(0, 240)}` : data.error || `请求失败（${response.status}）`);
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
      if (event) onEvent(event);
    }
  }
  buffer += decoder.decode();
  const tail = parseEventStreamBlock(buffer);
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
  elements.script.innerHTML = `${resultHeader("SOURCE SCRIPT RECONSTRUCTION", "原片完整脚本还原")}
    <div class="summary-strip">${escape(data.relationshipPattern)}</div>
    <div class="timeline">${(data.scenes || []).map((scene) => `<div class="scene">
      <span class="scene-id">${escape(scene.sceneId)}</span>
      <div class="scene-head"><strong>${escape(scene.location)}</strong><span>${escape(scene.timeRange)}</span></div>
      <p>${escape((scene.visibleActions || []).join(" → "))}</p>
      <p><b>对白大意：</b>${escape(scene.dialogueGist || "无可确认对白")}</p>
      <div class="scene-meta"><span>${escape(scene.emotionNode)}</span><span>${escape(scene.dramaticFunction)}</span><span>置信度 ${escape(scene.confidence)}%</span>${(scene.keyProps || []).map((prop) => `<span>${escape(prop)}</span>`).join("")}</div>
    </div>`).join("")}</div>
    ${block("核心事件顺序", `<div class="tag-row">${(data.coreEventSequence || []).map((item) => `<span class="tag orange">${escape(item.order)} · ${escape(item.event)}</span>`).join("")}</div>`)}
    ${block("结尾动作", `<div class="beat"><strong>${escape(data.endingAction?.action)}</strong><p>${escape(data.endingAction?.emotionalMeaning)}</p></div>`)}
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
  elements.guardrails.innerHTML = `${resultHeader("VISUAL GUARDRAILS", "AI 视觉负面提示词", "通用规则")}
    <div class="summary-strip">${escape(data.rationale || boundary.doNotInfer || "已生成固定角色外观边界与通用负面提示词。")}</div>
    <div class="data-grid">
      ${cell("角色锁定", boundary.identityLock || boundary.characterName)}
      ${cell("允许身份", boundary.allowedIdentity)}
      ${cell("允许外观", boundary.allowedAppearance)}
      ${cell("允许身体特征", (boundary.allowedBodyFeatures || []).join(" / ") || "无额外身体特征")}
      ${cell("风格说明", boundary.styleNotes)}
      ${cell("禁止推导", boundary.doNotInfer)}
    </div>
    ${block("允许正向使用", `<div class="tag-row">${(data.allowedPositiveTraits || []).map((item) => `<span class="tag">${escape(item.term)} · ${escape(item.scope || "")}</span>`).join("") || "<span class=\"tag\">无额外允许项</span>"}</div>`)}
    ${block("禁止写进正向内容", `<div class="rule-list">${(data.forbiddenPositiveTraits || []).map((item) => `<div class="rule"><strong>${escape(item.term)} · ${escape(item.severity || "block")}</strong><p>${escape(item.reason)}</p></div>`).join("") || "<p class=\"long-copy\">无额外禁止项。</p>"}</div>`)}
    ${block("原片表面表达", `<div class="rule-list">${(data.sourceSurfaceExpressions || []).map((item) => `<div class="rule"><strong>${escape(item.term)}${item.mustAvoid === false ? " · 可说明但不正向复用" : " · 禁止正向复用"}</strong><p>${escape(item.reason)}<br><b>来源：</b>${escape(item.source)}</p></div>`).join("") || "<p class=\"long-copy\">无。</p>"}</div>`)}
    ${block("通用负面 Prompt", `<div class="warning-box">${escape((data.commonNegativePrompt || []).join("；") || "无")}</div>`)}
    ${block("阶段使用说明", `<div class="data-grid">
      ${cell("主题变体", data.stageInstructions?.themeVariants)}
      ${cell("完整剧情", data.stageInstructions?.fullStory)}
      ${cell("首尾帧动画", data.stageInstructions?.animationPlan)}
    </div>`)}
    ${uncertainties(data.uncertainties)}`;
  reveal(elements.guardrails);
}

function renderVariants(data) {
  elements.variants.innerHTML = `${resultHeader("THEME VARIANTS", "可拍摄的具体主题变体")}
    <div class="variant-grid">${(data.variants || []).map((variant) => `<div class="variant">
      <div class="variant-top"><div><span class="variant-number">${escape(variant.id)} · NEW EPISODE</span><h4>${escape(variant.title)}</h4></div><span class="risk">相似风险 ${escape(variant.originalityRiskCheck?.riskLevel || "-")}</span></div>
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
      setAnimationStatus("可以继续生成首尾帧动画生产包。", "");
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
  setStoryStatus(`正在调用 ${storyModelLabel()} 生成完整剧情…`, "active");
  try {
    const fullStory = await api("/api/full-story", {
      referenceAnalysis: state.output.referenceAnalysis,
      sourceScriptReconstruction: state.output.sourceScriptReconstruction,
      creativeBrief: state.output.creativeBrief,
      visualGuardrails: state.output.visualGuardrails,
      themeVariants: state.output.themeVariants,
      variant,
      creatorProfile: profile()
    });
    state.fullStories[variant.id] = fullStory;
    state.output.fullStories = state.fullStories;
    state.output.fullStory = fullStory;
    renderFullStory(fullStory);
    setStoryStatus(`完整剧情已生成 · ${storyModelLabel()}`, "ready");
    elements.animationGenerate.disabled = false;
    setAnimationStatus("可以继续生成首尾帧动画生产包。", "");
    updateStoryExportActions();
    elements.export.classList.remove("hidden");
  } catch (error) {
    setStoryStatus(error.message || "完整剧情生成失败", "error");
  } finally {
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
  if (!force && state.animationPlans[variant.id]) {
    renderAnimationPlan(state.animationPlans[variant.id]);
    return;
  }
  state.animationRunning = true;
  if (force) {
    state.shotVideoResults = {};
    state.shotFrameResults = {};
    state.characterReferenceStatuses = {};
  }
  setAnimationRunning(true);
  setAnimationStatus(`正在调用 ${animationModelLabel()} 生成首尾帧动画生产包…`, "active");
  try {
    const animationPlan = await api("/api/animation-plan", {
      creativeBrief: state.output.creativeBrief,
      variant,
      fullStory,
      creatorProfile: profile()
    });
    state.animationPlans[variant.id] = animationPlan;
    state.output.animationPlans = state.animationPlans;
    state.output.animationPlan = animationPlan;
    renderAnimationPlan(animationPlan);
    setAnimationStatus(`动画生产包已生成 · ${animationModelLabel()}`, "ready");
    updateStoryExportActions();
    elements.export.classList.remove("hidden");
  } catch (error) {
    setAnimationStatus(error.message || "动画生产包生成失败", "error");
  } finally {
    state.animationRunning = false;
    setAnimationRunning(false);
  }
}

function renderAnimationPlan(data) {
  const strategy = data.productionStrategy || {};
  const visual = data.visualBible || {};
  const queue = buildVideoGenerationQueue({
    exportedAt: new Date().toISOString(),
    selectedVariant: selectedVariant() || {},
    fullStory: currentFullStory(),
    animationPlan: data
  });
  elements.animationPlan.innerHTML = `${resultHeader("ANIMATION PLAN", data.title || "首尾帧动画生产包", strategy.format || "first_last_frame_video")}
    <div class="summary-strip">${escape(strategy.whyThisWorkflow || "按首尾帧拆镜头，逐镜生成短视频，优先控制角色一致性。")}</div>
    <div class="data-grid">
      ${cell("画幅", strategy.targetAspectRatio || "9:16")}
      ${cell("目标时长", `${strategy.targetRuntimeSeconds || 60} 秒`)}
      ${cell("单镜头", `${strategy.recommendedShotDurationSeconds?.min || 3}-${strategy.recommendedShotDurationSeconds?.max || 6} 秒`)}
      ${cell("动画风格", visual.animationStyle)}
      ${cell("色彩", (visual.colorPalette || []).join(" / "))}
      ${cell("镜头语言", visual.cameraLanguage)}
    </div>
    ${block("生产顺序", `<div class="tag-row">${(strategy.generationOrder || []).map((item, index) => `<span class="tag orange">${index + 1} · ${escape(item)}</span>`).join("")}</div>`)}
    ${block("视觉圣经", `<div class="rule-list">
      <div class="rule"><strong>整体风格</strong><p>${escape(visual.overallStyle)}<br><b>光线：</b>${escape(visual.lighting)}</p></div>
      <div class="rule"><strong>世界规则</strong><p>${escape((visual.worldRules || []).join("；"))}</p></div>
      <div class="rule"><strong>角色一致性</strong><p>${escape((visual.characterConsistencyRules || []).join("；"))}</p></div>
      <div class="rule"><strong>负面视觉规则</strong><p>${escape((visual.negativeVisualRules || []).join("；"))}</p></div>
    </div>`)}
    ${actionBlock("角色参考提示词", renderCharacterReferencePrompts(data.characterReferencePrompts || []), `<button class="round-add-button" type="button" data-open-character-image-generator aria-label="用即梦生成角色参考图">+</button>`)}
    ${block("场景参考提示词", `<div class="rule-list">${(data.sceneReferencePrompts || []).map((item) => `<div class="rule">
      <strong>${escape(item.sceneName || item.sceneId)}<br><small>${escape(item.sceneId)}</small></strong>
      <p>${escape(item.environmentPrompt)}<br><b>功能：</b>${escape(item.storyFunction)}<br><b>连续性锚点：</b>${escape((item.continuityAnchors || []).join(" / "))}<br><b>禁止：</b>${escape((item.negativeSceneRules || []).join(" / "))}</p>
    </div>`).join("") || "<p class=\"long-copy\">无单独场景参考提示词。</p>"}</div>`)}
    ${block("关键资产提示词", `<div class="rule-list">${(data.assetPrompts || []).map((item) => `<div class="rule">
      <strong>${escape(item.assetName)}</strong>
      <p>${escape(item.imagePrompt)}<br><b>功能：</b>${escape(item.storyFunction)}<br><b>一致性：</b>${escape((item.consistencyTags || []).join(" / "))}</p>
    </div>`).join("") || "<p class=\"long-copy\">无单独资产提示词。</p>"}</div>`)}
    ${block("首尾帧镜头计划", `<div class="shot-list">${(data.shotPlan || []).map((shot) => `<div class="shot-card">
      <div class="scene-head"><strong>${escape(shot.shotId)} · ${escape(shot.sourceSceneId)} · ${escape(shot.sceneId || "")}</strong><span>${escape(shot.durationSeconds)} 秒 · ${escape(shot.emotionalTarget)}</span></div>
      <p><b>剧情功能：</b>${escape(shot.storyPurpose)}</p>
      <div class="prompt-grid">
        ${renderShotFramePromptCard(shot.shotId, "start", "首帧 prompt", shot.startFramePrompt)}
        ${renderShotFramePromptCard(shot.shotId, "end", "尾帧 prompt", shot.endFramePrompt)}
        <div class="prompt-card"><span class="prompt-label">视频 prompt</span><p>${escape(shot.videoPrompt)}</p></div>
        <div class="prompt-card"><span class="prompt-label">负面 prompt</span><p>${escape(shot.negativePrompt)}</p></div>
      </div>
      <p><b>镜头运动：</b>${escape(shot.cameraMotion)}<br><b>动作：</b>${escape(shot.characterAction)}<br><b>对白/字幕：</b>${escape(shot.dialogueOrSubtitle)}<br><b>声音：</b>${escape(shot.soundDesign)}</p>
      <div class="tag-row">${(shot.acceptanceCriteria || []).map((item) => `<span class="tag">${escape(item)}</span>`).join("")}</div>
      <div class="shot-video-action">
        <div class="shot-action-row">
          <button class="outline-button shot-video-button" type="button" data-generate-shot-video="${escape(shot.shotId)}"${state.shotVideoResults[shot.shotId]?.status === "running" ? " disabled" : ""}>生成此镜头视频</button>
          <button class="outline-button shot-video-button" type="button" data-open-shot-frame-generator="${escape(shot.shotId)}"${shotFrameIsRunning(shot.shotId) ? " disabled" : ""}>生成首尾帧</button>
        </div>
        <div class="shot-frame-result" data-shot-frame-result="${escape(shot.shotId)}">${renderShotFrameResult(shot.shotId)}</div>
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
    ${block("视频生成任务队列", renderQueueSummary(queue))}
    ${block("本地制作步骤", renderLocalProductionGuide(queue))}
    ${block("生成验收清单", `<div class="rule-list">${(data.generationChecklist || []).map((item) => `<div class="rule"><strong>${escape(item.check)}</strong><p>${escape(item.passCriteria)}</p></div>`).join("")}</div>`)}
    <div class="warning-box"><b>动画连续性检查：</b> ${escape(Object.values(data.continuityAndSafetyCheck || {}).filter(Boolean).join("；")) || "已通过结构校验"}</div>
    ${uncertainties(data.uncertainties)}`;
  reveal(elements.animationPlan);
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
  const label = status === "ready" ? "已添加参考图" : status === "pending" ? "待选择" : status === "running" ? "生成中" : status === "error" ? "生成失败" : "";
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
      visualGuardrails: state.output.visualGuardrails,
      selectedVariant: variant,
      fullStory: currentFullStory(),
      animationPlan: {
        title: plan.title,
        productionStrategy: plan.productionStrategy,
        visualBible: plan.visualBible
      }
    });
    const updated = {
      ...item,
      ...refined,
      referenceImageAdded: true,
      referenceImageName: file.name,
      referenceImageDataUrl: imageDataUrl
    };
    plan.characterReferencePrompts[index] = updated;
    const syncedShots = syncShotCharacterReference(plan, item, updated);
    state.animationPlans[variant.id] = plan;
    state.output.animationPlans = state.animationPlans;
    state.output.animationPlan = plan;
    state.characterReferenceStatuses[key] = { status: "ready", message: syncedShots ? `已更新人物描述，并同步 ${syncedShots} 个镜头` : "已更新人物描述" };
    renderAnimationPlan(plan);
    setAnimationStatus(`${updated.characterName || "角色"} 已添加人物参考图，并更新了角色描述${syncedShots ? `，同步了 ${syncedShots} 个镜头提示词` : ""}。`, "ready");
    updateStoryExportActions();
  } catch (error) {
    state.characterReferenceStatuses[key] = { status: "error", message: error.message || "人物参考图分析失败" };
    renderAnimationPlan(plan);
    setAnimationStatus(error.message || "人物参考图分析失败", "error");
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
    elements.characterImageDropHint.textContent = "已载入参考图。生成时会参考它，但会移除水果摊和无关背景。";
    setCharacterImageStatus("参考图片已载入。", "ready");
  } catch (error) {
    setCharacterImageStatus(error.message || "参考图片读取失败。", "error");
  }
}

function renderCharacterImagePromptPreview() {
  const item = currentCharacterImageReference();
  const count = Number(elements.characterImageCount.value) || state.characterImageGeneration.count || 1;
  const base = item?.appearancePrompt || item?.identity || item?.characterName || "";
  const countNote = count > 1 ? `\n本次需要输出 ${count} 张候选图，每张都保持同一个角色设定，但姿态和细节可以轻微变化。` : "";
  elements.characterImagePromptPreview.value = base
    ? `参考我上传的这张图片，不要水果摊，生成一张${base}\n注意：人物必须是站立姿态的全身图。\n画面只保留人物主体，干净浅色背景，适合作为后续动画角色参考图。\n不要生成摊位、水果、杂乱街景、路人或与角色无关的物体。${countNote}`
    : "当前角色没有可用的角色参考提示词。";
}

async function generateCharacterReferenceImages() {
  if (state.characterImageGeneration.running) return;
  const item = currentCharacterImageReference();
  if (!item) return setCharacterImageStatus("请选择要生成参考图的角色。", "error");
  if (!state.characterImageGeneration.referenceImageDataUrl) return setCharacterImageStatus("请先上传一张参考图片。", "error");
  const count = Math.max(1, Math.min(6, Number(elements.characterImageCount.value) || 1));
  const prompt = elements.characterImagePromptPreview.value.trim();
  if (!prompt) return setCharacterImageStatus("生成提示词不能为空。", "error");
  state.characterImageGeneration.running = true;
  state.characterImageGeneration.count = count;
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
      selectedVariant: selectedVariant()
    }, handleCharacterImageStreamEvent);
    const readyCount = state.characterImageGeneration.results.filter((result) => result.status === "ready").length;
    setCharacterImageStatus(readyCount ? `已生成 ${readyCount} 张参考图，可选择一张设为人物参考图。` : "生成结束，但没有返回可用图片。", readyCount ? "ready" : "error");
  } catch (error) {
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
  if (event.type === "completed") {
    const generated = event.usage?.generated_images;
    if (generated) setCharacterImageStatus(`即梦生成完成：${generated} 张。`, "ready");
    return;
  }
  if (event.type === "error") throw new Error(event.error || "角色参考图生成失败。");
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
  try {
    setCharacterImageStatus("正在写入角色参考图并同步镜头提示词…", "active");
    const imageDataUrl = await urlToDataUrl(result.url);
    const updated = {
      ...previous,
      referenceImageAdded: true,
      referenceImageName: result.filename || `jimeng-reference-${Number(resultIndexValue) + 1}.png`,
      referenceImageDataUrl: imageDataUrl,
      referenceImageNotes: `由 ${state.imageProvider} ${modelName(result.model || state.imageModel)} 根据上传参考图生成；已要求去掉水果摊，保留站立全身角色。`
    };
    plan.characterReferencePrompts[roleIndex] = updated;
    const syncedShots = syncShotCharacterReference(plan, previous, updated);
    state.animationPlans[variant.id] = plan;
    state.output.animationPlans = state.animationPlans;
    state.output.animationPlan = plan;
    state.characterReferenceStatuses[characterReferenceStatusKey(roleIndex)] = {
      status: "ready",
      message: syncedShots ? `已使用即梦生成图，并同步 ${syncedShots} 个镜头` : "已使用即梦生成图"
    };
    renderAnimationPlan(plan);
    setAnimationStatus(`${updated.characterName || "角色"} 已使用即梦生成的人物参考图${syncedShots ? `，同步了 ${syncedShots} 个镜头提示词` : ""}。`, "ready");
    setCharacterImageStatus("已设为人物参考图。", "ready");
    updateStoryExportActions();
  } catch (error) {
    setCharacterImageStatus(error.message || "写入人物参考图失败。", "error");
  }
}

function currentCharacterImageReference() {
  const variant = selectedVariant();
  const plan = variant ? state.animationPlans[variant.id] || state.output.animationPlan : state.output.animationPlan;
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

function shotFrameKey(shotId, frameKind) {
  return `${shotId}:${frameKind === "end" ? "end" : "start"}`;
}

function shotFrameStatus(shotId, frameKind) {
  return state.shotFrameResults[shotFrameKey(shotId, frameKind)]?.status || "";
}

function shotFrameIsRunning(shotId) {
  return shotFrameStatus(shotId, "start") === "running" || shotFrameStatus(shotId, "end") === "running";
}

function selectedShotFrameCandidate(shotId, frameKind) {
  const stateItem = state.shotFrameResults[shotFrameKey(shotId, frameKind)];
  if (stateItem?.status !== "ready") return null;
  const images = stateItem?.result?.images || [];
  const index = Number(stateItem?.selectedIndex || stateItem?.result?.selectedIndex || 0);
  return images[index] || stateItem?.result || null;
}

function selectShotFrameCandidate(shotId, frameKindValue, candidateIndexValue) {
  const frameKind = frameKindValue === "end" ? "end" : "start";
  const key = shotFrameKey(shotId, frameKind);
  const stateItem = state.shotFrameResults[key];
  const images = stateItem?.result?.images || [];
  const selectedIndex = Number(candidateIndexValue);
  if (!images[selectedIndex]) return;
  stateItem.status = "ready";
  stateItem.selectedIndex = selectedIndex;
  stateItem.result.selectedIndex = selectedIndex;
  stateItem.result.url = images[selectedIndex].url;
  stateItem.result.dataUrl = images[selectedIndex].dataUrl;
  state.shotFrameResults[key] = stateItem;
  updateShotFrameResult(shotId);
  setAnimationStatus(`${shotId} ${frameKind === "end" ? "尾帧" : "首帧"}已切换为第 ${selectedIndex + 1} 张，并添加到镜头。`, "ready");
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

function chineseNumber(value) {
  return ["零", "一", "二", "三", "四", "五", "六"][Number(value)] || String(value);
}

function openShotFrameImageGenerator(shotId, frameKindValue = "start") {
  const frameKind = frameKindValue === "end" ? "end" : "start";
  state.shotFrameImageGeneration.open = true;
  state.shotFrameImageGeneration.running = false;
  state.shotFrameImageGeneration.shotId = String(shotId);
  state.shotFrameImageGeneration.frameKind = frameKind;
  state.shotFrameImageGeneration.count = Number(elements.shotFrameImageCount.value) || 4;
  elements.shotFrameImageKind.value = frameKind;
  if (!updateShotFrameImageGeneratorPreview()) return;
  setShotFrameImageStatus("", "");
  setShotFrameImageGeneratorRunning(false);
  elements.shotFrameImageModal.classList.remove("hidden");
  elements.shotFrameImageModal.setAttribute("aria-hidden", "false");
  renderShotFrameImageResults();
  elements.shotFrameImagePromptPreview.focus();
}

function updateShotFrameImageGeneratorPreview() {
  if (!state.shotFrameImageGeneration.open) return true;
  const shotId = state.shotFrameImageGeneration.shotId;
  const frameKind = elements.shotFrameImageKind.value === "end" ? "end" : "start";
  const context = shotFrameContext(shotId);
  if (!context) {
    setAnimationStatus("没有找到对应镜头。", "error");
    return false;
  }
  const { shot, plan } = context;
  const label = frameKind === "end" ? "尾帧" : "首帧";
  const characterReferences = shotRelatedCharacterReferences(shot, plan.characterReferencePrompts || []);
  const sceneReference = sceneReferenceForShot(plan, shot);
  state.shotFrameImageGeneration.frameKind = frameKind;
  elements.shotFrameImageModalTitle.textContent = `生成${label}镜头`;
  elements.confirmGenerateShotFrameImageLabel.textContent = `生成${label}`;
  elements.shotFrameImageMeta.textContent = `${shot.shotId || "镜头"} · ${shot.sourceSceneId || "未标注场次"} · ${shot.durationSeconds || ""} 秒 · 自动锁定相关角色参考图`;
  elements.shotFrameReferenceList.innerHTML = renderShotFrameReferenceUploadList(characterReferences);
  elements.shotFrameImagePromptPreview.value = buildShotFrameImagePrompt({
    frameKind,
    shot,
    visualBible: plan.visualBible || {},
    characterReferences,
    sceneReference
  });
  renderShotFrameImageResults();
  return true;
}

function shotFrameContext(shotId) {
  const variant = selectedVariant();
  const plan = variant ? state.animationPlans[variant.id] || state.output.animationPlan : state.output.animationPlan;
  const shot = (plan?.shotPlan || []).find((item) => String(item.shotId) === String(shotId));
  return shot && plan ? { variant, plan, shot } : null;
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
  elements.shotFrameImageModal.classList.add("hidden");
  elements.shotFrameImageModal.setAttribute("aria-hidden", "true");
}

async function confirmGenerateShotFrameImage() {
  if (state.shotFrameImageGeneration.running) return;
  const prompt = elements.shotFrameImagePromptPreview.value.trim();
  if (!prompt) return setShotFrameImageStatus("提示词不能为空。", "error");
  const shotId = state.shotFrameImageGeneration.shotId;
  const frameKind = elements.shotFrameImageKind.value === "end" ? "end" : "start";
  state.shotFrameImageGeneration.frameKind = frameKind;
  setShotFrameImageGeneratorRunning(true);
  setShotFrameImageStatus(`正在用即梦生成${frameKind === "end" ? "尾帧" : "首帧"}图片…`, "active");
  try {
    const count = Math.max(1, Math.min(6, Number(elements.shotFrameImageCount.value) || 1));
    state.shotFrameImageGeneration.count = count;
    await generateShotFrameImage(shotId, frameKind, prompt, { count, throwOnError: true });
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
  elements.shotFrameImagePromptPreview.disabled = running;
  elements.shotFrameImageCount.disabled = running;
  elements.confirmGenerateShotFrameImage.disabled = running;
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
  elements.shotFrameImageResults.innerHTML = images.map((image, index) => `<div class="generated-reference-card shot-frame-candidate${index === selectedIndex ? " selected" : ""}">
    <button class="generated-reference-preview-button" type="button" data-preview-modal-shot-frame="${escape(shotId)}" data-frame-kind="${escape(frameKind)}" data-candidate-index="${escape(index)}" aria-label="放大预览 ${escape(shotId)} ${label}第 ${escape(index + 1)} 张">
      <img src="${escape(image.url)}" alt="${escape(shotId)} ${label}候选 ${index + 1}">
    </button>
    <small>${escape(label)}候选 ${escape(index + 1)} · ${escape(image.size || stateItem.result?.size || "")} · ${escape(modelName(image.model || stateItem.result?.model || state.imageModel))}${escape(referenceCountText)}</small>
    <button class="outline-button" type="button" data-select-modal-shot-frame="${escape(shotId)}" data-frame-kind="${escape(frameKind)}" data-candidate-index="${escape(index)}">${index === selectedIndex ? `已设为${label}参考图` : `设为${label}参考图`}</button>
  </div>`).join("");
}

function renderShotFrameReferenceUploadList(characterReferences = []) {
  const images = uploadedReferenceImages(characterReferences);
  if (!images.length) {
    return "<p>当前镜头没有可上传的人物参考图；这次只会使用文字角色描述生成。请先在角色列表添加人物参考图。</p>";
  }
  return `<div>
    <span class="block-label">角色参考匹配 · ${escape(images.length)} 张图片</span>
    <div class="shot-frame-reference-grid">
      ${images.map((item, index) => `<div class="shot-frame-reference-card">
        <strong>${escape(item.characterName || "角色")}</strong>
        <small>已匹配 @图${escape(chineseNumber(index + 1))}</small>
      </div>`).join("")}
    </div>
  </div>`;
}

function openShotVideoGenerator(shotId) {
  state.shotVideoGeneration.open = true;
  state.shotVideoGeneration.running = false;
  state.shotVideoGeneration.shotId = String(shotId);
  state.shotVideoGeneration.count = Number(elements.shotVideoCount.value) || 1;
  setShotVideoGeneratorRunning(false);
  if (!updateShotVideoGeneratorPreview()) return;
  elements.shotVideoModal.classList.remove("hidden");
  elements.shotVideoModal.setAttribute("aria-hidden", "false");
  renderShotVideoModalResults();
  elements.shotVideoPromptPreview.focus();
}

function updateShotVideoGeneratorPreview() {
  if (!state.shotVideoGeneration.open) return true;
  const shotId = state.shotVideoGeneration.shotId;
  const context = shotFrameContext(shotId);
  if (!context) {
    setAnimationStatus("没有找到对应镜头。", "error");
    return false;
  }
  const { shot } = context;
  const count = Math.max(1, Math.min(4, Number(state.shotVideoGeneration.count) || Number(elements.shotVideoCount.value) || 1));
  elements.shotVideoCount.value = String(count);
  elements.shotVideoModalTitle.textContent = `生成 ${shot.shotId || "镜头"} 视频`;
  elements.shotVideoMeta.textContent = `${shot.shotId || "镜头"} · ${shot.sourceSceneId || "未标注场次"} · ${shot.durationSeconds || 4} 秒 · 自动锁定已添加的首帧/尾帧`;
  elements.shotVideoReferenceList.innerHTML = renderShotVideoReferenceList(shotId);
  elements.shotVideoPromptPreview.value = buildShotVideoPromptPreview(shot);
  const hasFrames = Boolean(selectedShotFrameCandidate(shotId, "start") && selectedShotFrameCandidate(shotId, "end"));
  setShotVideoStatus(hasFrames ? "确认提示词和数量后即可生成视频。" : "请先生成并选择该镜头的首帧和尾帧参考图。", hasFrames ? "" : "error");
  elements.confirmGenerateShotVideo.disabled = !hasFrames;
  return true;
}

function closeShotVideoGenerator() {
  if (state.shotVideoGeneration.running) return setShotVideoStatus("镜头视频仍在生成中，完成后再关闭。", "active");
  state.shotVideoGeneration.open = false;
  elements.shotVideoModal.classList.add("hidden");
  elements.shotVideoModal.setAttribute("aria-hidden", "true");
}

async function confirmGenerateShotVideo() {
  if (state.shotVideoGeneration.running) return;
  const prompt = elements.shotVideoPromptPreview.value.trim();
  if (!prompt) return setShotVideoStatus("视频提示词不能为空。", "error");
  const shotId = state.shotVideoGeneration.shotId;
  const count = Math.max(1, Math.min(4, Number(elements.shotVideoCount.value) || 1));
  state.shotVideoGeneration.count = count;
  setShotVideoGeneratorRunning(true);
  setShotVideoStatus(`正在生成 ${count} 条视频候选…`, "active");
  try {
    await generateShotVideo(shotId, prompt, { count, throwOnError: true });
    const actualCount = state.shotVideoResults[shotId]?.result?.videos?.length || count;
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
  elements.shotVideoPromptPreview.disabled = running;
  elements.confirmGenerateShotVideo.disabled = running;
  elements.closeShotVideoModal.disabled = running;
  elements.confirmGenerateShotVideo.classList.toggle("running", running);
  elements.confirmGenerateShotVideo.querySelector("span").textContent = running ? "视频生成中…" : "生成视频";
}

function setShotVideoStatus(message, tone = "") {
  elements.shotVideoStatus.textContent = message;
  elements.shotVideoStatus.className = `story-status ${tone}`;
}

function renderShotVideoReferenceList(shotId) {
  const start = selectedShotFrameCandidate(shotId, "start");
  const end = selectedShotFrameCandidate(shotId, "end");
  const frame = (label, item) => item?.url
    ? `<figure class="shot-video-reference-frame"><img src="${escape(item.url)}" alt="${escape(label)}"><figcaption>${escape(label)} · 已锁定参考图</figcaption></figure>`
    : `<figure class="shot-video-reference-frame empty"><span>${escape(label)}</span><p>未添加参考图</p></figure>`;
  return `<div>
    <span class="block-label">首尾帧参考图</span>
    <div class="shot-video-reference-grid">
      ${frame("首帧", start)}
      ${frame("尾帧", end)}
    </div>
    <p class="shot-video-reference-note">生成视频时会把这两张图片连同右侧视频提示词一起上传给视频模型。</p>
  </div>`;
}

function buildShotVideoPromptPreview(shot = {}) {
  const noTextRule = "禁止新增字幕、对白文字、标题、说明字、Logo、水印、UI 文本或漫画拟声词；对白只用于理解动作和情绪，不要渲染成画面文字。";
  return [
    shot.videoPrompt || "",
    shot.cameraMotion ? `镜头运动：${shot.cameraMotion}` : "",
    shot.characterAction ? `角色动作：${shot.characterAction}` : "",
    shot.continuityNotes ? `连续性：${shot.continuityNotes}` : "",
    noTextRule
  ].filter(Boolean).join("\n");
}

async function generateShotVideo(shotId, promptOverride = "", options = {}) {
  const variant = selectedVariant();
  const plan = variant ? state.animationPlans[variant.id] || state.output.animationPlan : state.output.animationPlan;
  const shot = (plan?.shotPlan || []).find((item) => String(item.shotId) === String(shotId));
  if (!shot) return setAnimationStatus("没有找到对应镜头。", "error");
  const count = Math.max(1, Math.min(4, Number(options.count) || 1));
  state.shotVideoResults[shotId] = { status: "running", message: `正在调用视频生成服务 · ${count} 条…`, expectedCount: count };
  updateShotVideoResult(shotId);
  renderShotVideoModalResults();
  setAnimationStatus(`正在生成 ${shotId} 镜头视频 · ${count} 条候选…`, "active");
  try {
    const startFrame = selectedShotFrameCandidate(shotId, "start");
    const endFrame = selectedShotFrameCandidate(shotId, "end");
    if (!startFrame || !endFrame) throw new Error("请先生成并选择首帧和尾帧参考图。");
    const [startFrameDataUrl, endFrameDataUrl] = await Promise.all([
      frameCandidateDataUrl(startFrame),
      frameCandidateDataUrl(endFrame)
    ]);
    const globalNegativePrompt = buildGlobalNegativePrompt(plan?.visualBible || {});
    const result = await api("/api/generate-shot-video", {
      selectedVariantId: variant?.id || "",
      count,
      shot: {
        ...shot,
        videoPrompt: promptOverride || shot.videoPrompt || "",
        negativePrompt: joinPromptParts([globalNegativePrompt, shot.negativePrompt])
      },
      startFrameDataUrl,
      endFrameDataUrl
    });
    const videos = Array.isArray(result.videos) && result.videos.length ? result.videos : result.outputUrl ? [result] : [];
    if (videos.length !== count) throw new Error(`视频数量不足：请求 ${count} 条，实际返回 ${videos.length} 条。`);
    const selectedIndex = 0;
    state.shotVideoResults[shotId] = {
      status: "ready",
      result: { ...result, videos, selectedIndex, outputUrl: videos[selectedIndex]?.outputUrl || result.outputUrl || "" },
      selectedIndex
    };
    setAnimationStatus(`${shotId} 镜头视频已生成 ${videos.length} 条候选。`, "ready");
  } catch (error) {
    state.shotVideoResults[shotId] = { status: "error", message: error.message || "镜头视频生成失败" };
    setAnimationStatus(error.message || "镜头视频生成失败", "error");
    updateShotVideoResult(shotId);
    renderShotVideoModalResults();
    if (options.throwOnError) throw error;
    return false;
  }
  updateShotVideoResult(shotId);
  renderShotVideoModalResults();
  return true;
}

function buildGlobalNegativePrompt(visualBible = {}) {
  return joinPromptParts(Array.isArray(visualBible.negativeVisualRules) ? visualBible.negativeVisualRules : []);
}

function joinPromptParts(parts = []) {
  const seen = new Set();
  return parts
    .flatMap((item) => String(item || "").split(/[；;\n]+/u))
    .map((item) => item.trim())
    .filter((item) => {
      if (!item || seen.has(item)) return false;
      seen.add(item);
      return true;
    })
    .join("；");
}

async function frameCandidateDataUrl(candidate = {}) {
  if (candidate.dataUrl) return candidate.dataUrl;
  if (candidate.url) return urlToDataUrl(candidate.url);
  throw new Error("首尾帧参考图缺少可上传的图片数据。");
}

function renderShotVideoModalResults() {
  if (!state.shotVideoGeneration.open) return;
  const shotId = state.shotVideoGeneration.shotId;
  const stateItem = state.shotVideoResults[shotId];
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
    <small>候选 ${escape(index + 1)} · ${escape(video.model || stateItem.result?.model || "视频模型")} · ${escape(video.generatedAt || stateItem.result?.generatedAt || "")}</small>
    <button class="outline-button" type="button" data-use-shot-video="${escape(shotId)}" data-candidate-index="${escape(index)}">${index === selectedIndex ? "已设为当前镜头视频" : "设为当前镜头视频"}</button>
  </div>`).join("");
}

function selectShotVideoCandidate(shotId, candidateIndexValue) {
  const stateItem = state.shotVideoResults[shotId];
  const videos = stateItem?.result?.videos || [];
  const selectedIndex = Number(candidateIndexValue);
  if (!videos[selectedIndex]) return;
  stateItem.status = "ready";
  stateItem.selectedIndex = selectedIndex;
  stateItem.result.selectedIndex = selectedIndex;
  stateItem.result.outputUrl = videos[selectedIndex].outputUrl || videos[selectedIndex].url || "";
  stateItem.result.outputPath = videos[selectedIndex].outputPath || "";
  state.shotVideoResults[shotId] = stateItem;
  updateShotVideoResult(shotId);
  renderShotVideoModalResults();
  setShotVideoStatus(`已将第 ${selectedIndex + 1} 条设为当前镜头视频。`, "ready");
  setAnimationStatus(`${shotId} 已切换为第 ${selectedIndex + 1} 条视频候选。`, "ready");
}

async function generateShotFrameImage(shotId, frameKindValue, promptOverride = "", options = {}) {
  const frameKind = frameKindValue === "end" ? "end" : "start";
  const variant = selectedVariant();
  const plan = variant ? state.animationPlans[variant.id] || state.output.animationPlan : state.output.animationPlan;
  const shot = (plan?.shotPlan || []).find((item) => String(item.shotId) === String(shotId));
  if (!shot || !plan) return setAnimationStatus("没有找到对应镜头。", "error");
  const key = shotFrameKey(shotId, frameKind);
  const count = Math.max(1, Math.min(6, Number(options.count) || 1));
  state.shotFrameResults[key] = { status: "running", frameKind, message: `正在生成${frameKind === "end" ? "尾帧" : "首帧"}镜头 · ${count} 张…` };
  updateShotFrameResult(shotId);
  renderShotFrameImageResults();
  setAnimationStatus(`${shotId} ${frameKind === "end" ? "尾帧" : "首帧"}正在用即梦生成…`, "active");
  try {
    const characterReferences = shotRelatedCharacterReferences(shot, plan.characterReferencePrompts || []);
    const result = await api("/api/generate-shot-frame-image", {
      selectedVariantId: variant?.id || "",
      frameKind,
      count,
      ...(promptOverride ? { prompt: promptOverride } : {}),
      shot,
      visualBible: plan.visualBible || {},
      characterReferences,
      sceneReference: sceneReferenceForShot(plan, shot)
    });
    const images = Array.isArray(result.images) && result.images.length ? result.images : [result];
    result.images = await Promise.all(images.map(async (image) => ({ ...image, dataUrl: await urlToDataUrl(image.url) })));
    result.selectedIndex = -1;
    result.url = "";
    result.dataUrl = "";
    state.shotFrameResults[key] = { status: options.autoSelectFirst ? "ready" : "pending", frameKind, result, selectedIndex: options.autoSelectFirst ? 0 : -1, message: `已生成 ${result.images.length} 张候选图，请选择一张添加到镜头。` };
    if (options.autoSelectFirst) {
      selectShotFrameCandidate(shotId, frameKind, 0);
    } else {
      setAnimationStatus(`${shotId} ${frameKind === "end" ? "尾帧" : "首帧"}镜头已生成 ${result.images.length} 张候选图，等待选择。`, "ready");
    }
  } catch (error) {
    state.shotFrameResults[key] = { status: "error", frameKind, message: error.message || "镜头帧图片生成失败" };
    setAnimationStatus(error.message || "镜头帧图片生成失败", "error");
    updateShotFrameResult(shotId);
    renderShotFrameImageResults();
    if (options.throwOnError) throw error;
    return false;
  }
  updateShotFrameResult(shotId);
  renderShotFrameImageResults();
  return true;
}

function updateShotVideoResult(shotId) {
  const resultBox = [...elements.animationPlan.querySelectorAll("[data-shot-video-result]")]
    .find((item) => String(item.dataset.shotVideoResult) === String(shotId));
  if (resultBox) resultBox.innerHTML = renderShotVideoResult(shotId);
  const button = [...elements.animationPlan.querySelectorAll("[data-generate-shot-video]")]
    .find((item) => String(item.dataset.generateShotVideo) === String(shotId));
  if (button) button.disabled = state.shotVideoResults[shotId]?.status === "running";
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
  const stateItem = state.shotVideoResults[shotId];
  if (!stateItem) return "<p>配置视频供应商后，可直接生成该镜头视频。</p>";
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
  const videos = Array.isArray(stateItem.result?.videos) && stateItem.result.videos.length ? stateItem.result.videos : stateItem.result?.outputUrl ? [stateItem.result] : [];
  const selectedIndex = Number.isFinite(Number(stateItem.selectedIndex ?? stateItem.result?.selectedIndex)) ? Number(stateItem.selectedIndex ?? stateItem.result?.selectedIndex) : 0;
  const videoHtml = videos.length
    ? `<div class="shot-video-candidate-list">${videos.map((video, index) => {
        const url = video.outputUrl || video.url || "";
        return `<div class="shot-video-result-card${index === selectedIndex ? " selected" : ""}">
          <span>${index === selectedIndex ? "当前镜头视频" : `候选 ${index + 1}`}</span>
          <video src="${escape(url)}" controls playsinline></video>
          <a href="${escape(url)}" download>下载视频</a>
        </div>`;
      }).join("")}</div>`
    : "";
  return videoHtml
    ? `${frameHtml}${videoHtml}`
    : `${frameHtml}<p>视频已生成，但未返回可播放地址。</p>`;
}

function resultHeader(kicker, title, badge = "") {
  return `<div class="result-title"><div><p>${kicker}</p><h3>${title}</h3></div>${badge ? `<span class="confidence">${escape(badge)}</span>` : ""}</div>`;
}
function block(label, content) { return `<div class="result-block"><span class="block-label">${label}</span>${content}</div>`; }
function actionBlock(label, content, action = "") { return `<div class="result-block"><div class="result-block-head"><span class="block-label">${label}</span>${action}</div>${content}</div>`; }
function cell(label, value) { return `<div class="data-cell"><span>${label}</span><strong>${escape(value || "待确认")}</strong></div>`; }
function uncertainties(items = []) { return items.length ? `<div class="warning-box"><b>待确认：</b> ${items.map((item) => escape(item.reason || item.unknown)).join("；")}</div>` : ""; }
function joinParts(object = {}, keys = []) { return keys.map((key) => object?.[key]).filter(Boolean).join(" · "); }
function reveal(element) { element.classList.remove("hidden"); }

function renderQueueSummary(queue) {
  const counts = countBy(queue.jobs || [], "type");
  const typeLabels = {
    reference_image: "角色参考图",
    asset_image: "关键资产图",
    start_frame_image: "首帧图",
    end_frame_image: "尾帧图",
    first_last_frame_video: "首尾帧视频",
    quality_check: "质检",
    final_edit: "最终剪辑"
  };
  const chips = Object.entries(typeLabels)
    .map(([type, label]) => `<span class="queue-chip"><b>${escape(counts[type] || 0)}</b>${escape(label)}</span>`)
    .join("");
  const orderedJobs = (queue.jobs || []).filter((job) => ["reference_image", "asset_image", "first_last_frame_video", "quality_check", "final_edit"].includes(job.type));
  return `<div class="queue-panel">
    <div class="queue-overview">${chips}</div>
    <div class="queue-meta">
      <span>队列版本 ${escape(queue.version)}</span>
      <span>${escape(queue.common?.aspectRatio || "9:16")}</span>
      <span>${escape(queue.common?.targetRuntimeSeconds || 60)} 秒</span>
      <span>${escape(queue.providerMode || "provider_agnostic")}</span>
    </div>
    <div class="queue-job-list">${orderedJobs.map((job) => `<div class="queue-job">
      <strong>${escape(job.taskId)} · ${escape(typeLabels[job.type] || job.type)}</strong>
      <p>${escape(job.inputType)} → ${escape(job.outputKey)}${job.requiredInputs?.length ? `<br>依赖：${escape(job.requiredInputs.join(" / "))}` : ""}</p>
    </div>`).join("")}</div>
  </div>`;
}

function renderLocalProductionGuide(queue = {}) {
  const runId = localRunId(queue.selectedVariantId || "V1");
  const queueFilename = `视频任务队列-${runId}.jsonl`;
  const productionRoot = `./production/${runId}`;
  const commandWorker = "./workers/generic-http-worker.mjs";
  const postprocessWorker = "./workers/local-postprocess-worker.mjs";
  const steps = [
    {
      label: "1",
      title: "导出任务队列",
      body: `点击“导出视频任务队列 JSONL”，然后把下载文件改名为 ${queueFilename} 并放到项目根目录。`,
      command: null
    },
    {
      label: "2",
      title: "生成本地制作工作区",
      body: "把每个图像、视频、质检、最终剪辑任务拆成 request JSON、prompt card 和输出目录。",
      command: `npm run plan:video -- ./${queueFilename} --root ${productionRoot} --workspace`
    },
    {
      label: "3",
      title: "先跑 mock 验证链路",
      body: "只验证依赖、输出路径、收据和最终剪辑链路；不会生成真实视频。",
      command: `npm run exec:video -- ${productionRoot} --provider mock --all`
    },
    {
      label: "4",
      title: "真实执行前预检",
      body: "检查是否还残留 mock/占位产物、ready 任务是否会吃到 mock 输入，以及 HTTP worker endpoint/key 是否已配置。",
      command: `npm run preflight:video -- ${productionRoot} --strict`
    },
    {
      label: "5",
      title: "一键制作到最终视频",
      body: "配置 provider config 后，一条命令串起预检、图像/首尾帧视频生成、本地质检和 ffmpeg 合成。",
      command: `npm run make:video -- ${productionRoot} --config ./provider.json`
    },
    {
      label: "6",
      title: "分段调试命令",
      body: "如果某一段失败，可以拆开执行：先生成素材和视频片段，再本地质检和合成。",
      command: `npm run exec:video -- ${productionRoot} --provider command --command node --command-arg ${commandWorker} --all --capability image_generation --capability first_last_frame_video_generation\nnpm run exec:video -- ${productionRoot} --provider command --command node --command-arg ${postprocessWorker} --all --capability video_quality_review --capability video_assembly`
    },
    {
      label: "7",
      title: "查看进度或重试失败任务",
      body: "失败任务会留下 .error.json，修好 worker 或模型参数后可以只重试失败项。",
      command: `npm run report:video -- ${productionRoot}\nnpm run preflight:video -- ${productionRoot} --strict\nnpm run exec:video -- ${productionRoot} --provider command --command node --command-arg ${commandWorker} --all --retry-failed --capability image_generation --capability first_last_frame_video_generation\nnpm run exec:video -- ${productionRoot} --provider command --command node --command-arg ${postprocessWorker} --all --retry-failed --capability video_quality_review --capability video_assembly`
    }
  ];
  return `<div class="production-guide">
    <p class="long-copy">这一步把浏览器生成的首尾帧计划落到本地制作流水线。当前项目已经支持 mock 执行和 command worker；真实视频生成需要把 worker 接到你选定的图像/视频模型。</p>
    <div class="production-step-list">${steps.map((step) => `<div class="production-step">
      <span class="step-badge">${escape(step.label)}</span>
      <div>
        <strong>${escape(step.title)}</strong>
        <p>${escape(step.body)}</p>
        ${step.command ? `<pre class="command-box"><code>${escape(step.command)}</code></pre>` : ""}
      </div>
    </div>`).join("")}</div>
  </div>`;
}

function localRunId(value) {
  return String(value || "V1")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^\p{L}\p{N}_-]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32) || "V1";
}

function countBy(items, key) {
  return items.reduce((acc, item) => {
    const value = item?.[key] || "";
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

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
  elements.animationGenerate.textContent = running ? "动画生产包生成中…" : "生成首尾帧动画生产包";
  const variant = selectedVariant();
  const fullStory = variant ? state.fullStories[variant.id] || state.output.fullStory : null;
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
    const defaultSetting = state.modelStages[stage.key] || {};
    const providerOptions = stage.providerLocked ? [current.provider || defaultSetting.provider].filter(Boolean) : providers;
    return `<div class="model-stage-row" data-model-stage="${escape(stage.key)}">
      <div class="model-stage-label"><strong>${escape(stage.label)}</strong><small>默认：${escape(modelDisplayLabel(defaultSetting.provider, defaultSetting.model))}<br>${escape(stage.hint)}</small></div>
      <select data-model-provider="${escape(stage.key)}"${stage.providerLocked ? " disabled" : ""}>
        ${providerOptions.map((provider) => `<option value="${escape(provider)}"${provider === current.provider ? " selected" : ""}>${escape(provider)}</option>`).join("")}
      </select>
      <select data-model-name="${escape(stage.key)}">
        ${renderModelOptions(stage, current.provider, current.model, defaultSetting)}
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
  const defaultSetting = state.modelStages[stage.key] || {};
  const selectedModel = defaultSetting.provider === provider ? defaultSetting.model : providerDefaultModel(provider, stage.key);
  modelSelect.innerHTML = renderModelOptions(stage, provider, selectedModel, defaultSetting);
}
function saveModelSettings() {
  const next = {};
  for (const stage of MODEL_STAGE_DEFS) {
    const row = elements.modelStageList.querySelector(`[data-model-stage="${stage.key}"]`);
    if (!row) continue;
    const defaults = state.modelStages[stage.key] || {};
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
}
function resetModelSettings() {
  state.modelOverrides = {};
  localStorage.removeItem("directorModelOverrides");
  applyEffectiveModelState();
  renderModelSettings();
  updateModelStateLabel();
  updateModelActionLabels();
  elements.storyModelName.textContent = modelDisplayLabel(state.storyProvider, state.storyModel);
  setModelSettingsStatus("已恢复后端默认模型。", "ready");
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
  return Object.fromEntries(Object.entries(state.modelOverrides || {}).filter(([, value]) => value?.provider && value?.model));
}
function sanitizeStoredModelOverrides(overrides = {}) {
  return Object.fromEntries(Object.entries(overrides).filter(([stage, value]) => {
    if (!value?.provider || !value?.model) return false;
    return !(MEDIA_INPUT_MODEL_STAGES.has(stage) && value.provider === "Qwen" && isKnownQwenTextOnlyModel(value.model));
  }));
}
function isKnownQwenTextOnlyModel(model = "") {
  return /^qwen(?:\d+(?:\.\d+)?)?-max(?:-|$)/iu.test(String(model).trim());
}
function applyEffectiveModelState() {
  const analysis = effectiveStageSetting("analysis");
  const story = effectiveStageSetting("fullStory");
  const animation = effectiveStageSetting("animationPlan");
  state.analysisProvider = analysis.provider || "MiMo";
  state.analysisModel = analysis.model || "mimo-v2.5";
  state.storyProvider = story.provider || state.analysisProvider;
  state.storyModel = story.model || state.analysisModel;
  state.animationProvider = animation.provider || state.storyProvider;
  state.animationModel = animation.model || state.storyModel;
  const media = analysisMediaSettings();
  state.mediaMode = media.mediaMode;
  state.nativeVideoMaxBytes = media.nativeVideoMaxBytes;
}
function effectiveStageSetting(stage) {
  return {
    ...(state.modelStages[stage] || {}),
    ...(state.modelOverrides[stage] || {})
  };
}
function availableModelProviders() {
  const llmProviders = new Set(["Qwen", "MiMo"]);
  const configured = Object.entries(state.providers || {})
    .filter(([provider, value]) => llmProviders.has(provider) && value?.configured)
    .map(([provider]) => provider);
  const fromStages = MODEL_STAGE_DEFS
    .filter((stage) => !stage.providerLocked)
    .map((stage) => state.modelStages?.[stage.key]?.provider)
    .filter((provider) => llmProviders.has(provider));
  return [...new Set([...configured, ...fromStages, "Qwen", "MiMo"])];
}
function renderModelOptions(stage, provider, selectedModel, defaultSetting = {}) {
  const options = modelOptionsForStage(stage, provider, selectedModel, defaultSetting);
  return options.map((model) => `<option value="${escape(model)}"${model === selectedModel ? " selected" : ""}>${escape(model)}</option>`).join("");
}
function modelOptionsForStage(stage, provider, selectedModel = "", defaultSetting = {}) {
  const key = typeof stage === "string" ? stage : stage.key;
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
  if (provider !== "Qwen" || !MEDIA_INPUT_MODEL_STAGES.has(stageKey)) return true;
  return !isKnownQwenTextOnlyModel(model) && /(?:plus|vl|omni)/iu.test(model);
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
  elements.modelState.lastElementChild.textContent = `${modelDisplayLabel(state.analysisProvider, state.analysisModel)} 解析 · 剧情 ${modelDisplayLabel(state.storyProvider, state.storyModel)} · 动画 ${modelDisplayLabel(state.animationProvider, state.animationModel)}`;
}
function updateModelActionLabels() {
  if (!state.storyRunning) elements.storyGenerate.querySelector("span").textContent = `用 ${storyModelLabel()} 生成完整剧情`;
  if (!state.animationRunning) elements.animationGenerate.textContent = "生成首尾帧动画生产包";
}
function modelDisplayLabel(provider, model) {
  const name = modelName(model);
  return provider && !name.toLowerCase().includes(String(provider).toLowerCase()) ? `${provider} ${name}` : name;
}
function modelName(model) { return String(model || "").split("/").pop(); }
function validateReady() { if (!state.running) elements.run.disabled = !(state.frames.length >= 3 && elements.fixedCharacter.value.trim() && elements.vertical.value.trim()); }
function showError(message) { elements.error.textContent = message; }
function profile() { return { fixedCharacter: elements.fixedCharacter.value.trim(), vertical: elements.vertical.value.trim(), constraints: elements.constraints.value.trim() }; }
function saveProfile() { localStorage.setItem("directorProfile", JSON.stringify(profile())); }
function restoreProfile() { try { const data = JSON.parse(localStorage.getItem("directorProfile")); if (data) { elements.fixedCharacter.value = data.fixedCharacter || ""; elements.vertical.value = data.vertical || ""; elements.constraints.value = data.constraints || ""; } } catch {} }
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
    animationModel: state.animationModel
  };
}

function selectedStoryPackage() {
  const variant = selectedVariant();
  if (!variant) return null;
  const pack = {
    packageType: "story-production-test-package",
    packageVersion: "1.0",
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
    shotFrameResults: state.shotFrameResults || {},
    shotVideoResults: state.shotVideoResults || {}
  };
  if (pack.animationPlan) pack.videoGenerationQueue = buildVideoGenerationQueue(pack);
  return pack;
}

function updateStoryExportActions() {
  const pack = selectedStoryPackage();
  const hasStory = Boolean(pack?.fullStory);
  const hasAnimation = Boolean(pack?.animationPlan);
  elements.exportStoryPackage.disabled = !hasStory;
  elements.exportStoryTestPackage.disabled = !hasStory;
  elements.copyAnimationPack.disabled = !hasAnimation;
  elements.exportVideoQueue.disabled = !hasAnimation;
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

function exportCurrentStoryPackage() {
  const pack = selectedStoryPackage();
  if (!pack?.fullStory) return setStoryStatus("请先生成完整剧情，再导出当前生产包。", "error");
  const suffix = pack.animationPlan ? "动画生产包" : "完整剧情";
  downloadJson(pack, `短视频${suffix}-${pack.selectedVariant?.id || "variant"}-${Date.now()}.json`);
}

function exportStoryTestPackage() {
  const pack = selectedStoryPackage();
  if (!pack?.fullStory) return setStoryPackageStatus("请先生成或导入完整剧情，再导出测试包。", "error");
  const suffix = pack.animationPlan ? "完整剧情-动画测试包" : "完整剧情测试包";
  downloadJson(pack, `短视频${suffix}-${pack.selectedVariant?.id || "variant"}-${Date.now()}.json`);
  setStoryPackageStatus(`已导出 ${pack.animationPlan ? "完整剧情 + 动画生产包" : "完整剧情"} 测试包。`, "ready");
}

async function importStoryTestPackage(file) {
  try {
    setStoryPackageStatus("正在导入测试包…", "");
    const payload = JSON.parse(await file.text());
    const restored = restoreStoryPackage(payload);
    setStoryPackageStatus(`已导入 ${restored.id}：${restored.hasStory ? "完整剧情" : "未含完整剧情"}${restored.hasAnimation ? " + 动画生产包" : ""}。`, "ready");
  } catch (error) {
    setStoryPackageStatus(error.message || "测试包导入失败", "error");
  }
}

function restoreStoryPackage(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("测试包 JSON 格式无效。");
  const variant = normalizeImportedVariant(payload);
  if (!variant?.id) throw new Error("测试包缺少 selectedVariant 或主题变体 id。");
  const id = String(variant.id);
  const fullStory = payload.fullStory || payload.fullStories?.[id] || payload.output?.fullStory || null;
  const animationPlan = payload.animationPlan || payload.animationPlans?.[id] || payload.output?.animationPlan || null;

  if (payload.creatorProfile && typeof payload.creatorProfile === "object") {
    elements.fixedCharacter.value = payload.creatorProfile.fixedCharacter || elements.fixedCharacter.value;
    elements.vertical.value = payload.creatorProfile.vertical || elements.vertical.value;
    elements.constraints.value = payload.creatorProfile.constraints || elements.constraints.value;
    saveProfile();
    validateReady();
  }
  if (payload.modelInfo) {
    if (payload.modelInfo.overrides && typeof payload.modelInfo.overrides === "object") {
      state.modelOverrides = payload.modelInfo.overrides;
      localStorage.setItem("directorModelOverrides", JSON.stringify(state.modelOverrides));
    } else {
      state.storyProvider = payload.modelInfo.storyProvider || state.storyProvider;
      state.storyModel = payload.modelInfo.storyModel || state.storyModel;
      state.animationProvider = payload.modelInfo.animationProvider || state.animationProvider;
      state.animationModel = payload.modelInfo.animationModel || state.animationModel;
    }
    applyEffectiveModelState();
    elements.storyModelName.textContent = modelDisplayLabel(state.storyProvider, state.storyModel);
    renderModelSettings();
  }

  state.metadata = payload.sourceVideo || payload.metadata || state.metadata;
  state.output.referenceAnalysis = payload.referenceAnalysis || payload.output?.referenceAnalysis || state.output.referenceAnalysis;
  state.output.sourceScriptReconstruction = payload.sourceScriptReconstruction || payload.output?.sourceScriptReconstruction || state.output.sourceScriptReconstruction;
  state.output.creativeBrief = payload.creativeBrief || payload.output?.creativeBrief || state.output.creativeBrief;
  state.output.visualGuardrails = payload.visualGuardrails || payload.output?.visualGuardrails || state.output.visualGuardrails;
  state.output.themeVariants = mergeImportedThemeVariants(payload.themeVariants || payload.output?.themeVariants, variant);
  state.selectedVariantId = id;

  state.fullStories = { ...(payload.fullStories || {}), ...state.fullStories };
  state.animationPlans = { ...(payload.animationPlans || {}), ...state.animationPlans };
  state.shotFrameResults = { ...(payload.shotFrameResults || payload.output?.shotFrameResults || {}), ...state.shotFrameResults };
  state.shotVideoResults = { ...(payload.shotVideoResults || payload.output?.shotVideoResults || {}), ...state.shotVideoResults };
  if (fullStory) {
    state.fullStories[id] = fullStory;
    state.output.fullStory = fullStory;
  }
  if (animationPlan) {
    state.animationPlans[id] = animationPlan;
    state.output.animationPlan = animationPlan;
  }
  state.output.fullStories = state.fullStories;
  state.output.animationPlans = state.animationPlans;
  elements.export.classList.remove("hidden");
  history.replaceState({ storyVariantId: id }, "", `/story/${encodeURIComponent(id)}`);
  renderStoryPage({ autoGenerate: false });
  return { id, hasStory: Boolean(fullStory), hasAnimation: Boolean(animationPlan) };
}

function normalizeImportedVariant(payload) {
  const variant = payload.selectedVariant || payload.variant || payload.output?.selectedVariant || null;
  if (variant?.id) return variant;
  const variants = payload.themeVariants?.variants || payload.output?.themeVariants?.variants || [];
  const fullStory = payload.fullStory || payload.output?.fullStory || null;
  const animationPlan = payload.animationPlan || payload.output?.animationPlan || null;
  const id = fullStory?.selectedVariantId || animationPlan?.selectedVariantId || variants[0]?.id || "";
  if (id) return variants.find((item) => String(item.id) === String(id)) || { id, title: fullStory?.title || animationPlan?.title || id, characterSetup: { protagonist: payload.creatorProfile?.fixedCharacter || "" } };
  return variant;
}

function mergeImportedThemeVariants(themeVariants, variant) {
  const imported = Array.isArray(themeVariants?.variants) ? themeVariants.variants : [];
  const existing = Array.isArray(state.output.themeVariants?.variants) ? state.output.themeVariants.variants : [];
  const merged = [...imported, ...existing, variant].filter(Boolean).reduce((acc, item) => {
    if (!item?.id || acc.some((entry) => String(entry.id) === String(item.id))) return acc;
    acc.push(item);
    return acc;
  }, []);
  return { ...(themeVariants || state.output.themeVariants || {}), variants: merged };
}

function setStoryPackageStatus(message, tone = "") {
  elements.storyPackageStatus.textContent = message;
  elements.storyPackageStatus.className = tone;
}

function exportVideoGenerationQueue() {
  const pack = selectedStoryPackage();
  if (!pack?.videoGenerationQueue) return setAnimationStatus("请先生成动画生产包，再导出视频任务队列。", "error");
  const jsonl = formatQueueJsonl(pack.videoGenerationQueue);
  const url = URL.createObjectURL(new Blob([jsonl], { type: "application/x-ndjson" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `视频任务队列-${pack.selectedVariant?.id || "variant"}-${Date.now()}.jsonl`;
  link.click();
  URL.revokeObjectURL(url);
}

async function copyAnimationProductionPack() {
  const pack = selectedStoryPackage();
  if (!pack?.animationPlan) return setAnimationStatus("请先生成动画生产包，再复制给视频模型使用。", "error");
  const text = formatAnimationPackMarkdown(pack);
  try {
    await navigator.clipboard.writeText(text);
    setAnimationStatus("已复制视频模型生产包，可直接粘贴到图像/视频生成工具。", "ready");
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
  const lines = [
    `# ${plan.title || pack.fullStory?.title || "首尾帧动画生产包"}`,
    "",
    `- 画幅：${strategy.targetAspectRatio || "9:16"}`,
    `- 目标时长：${strategy.targetRuntimeSeconds || pack.fullStory?.targetDurationSeconds || 60} 秒`,
    `- 单镜头时长：${strategy.recommendedShotDurationSeconds?.min || 3}-${strategy.recommendedShotDurationSeconds?.max || 6} 秒`,
    `- 工作流：${strategy.format || "first_last_frame_video"}`,
    "",
    "## 视觉圣经",
    `- 整体风格：${visual.overallStyle || ""}`,
    `- 动画风格：${visual.animationStyle || ""}`,
    `- 色彩：${(visual.colorPalette || []).join(" / ")}`,
    `- 光线：${visual.lighting || ""}`,
    `- 镜头语言：${visual.cameraLanguage || ""}`,
    `- 角色一致性：${(visual.characterConsistencyRules || []).join("；")}`,
    `- 负面视觉规则：${(visual.negativeVisualRules || []).join("；")}`,
    "",
    "## 角色参考图 Prompt"
  ];
  for (const item of plan.characterReferencePrompts || []) {
    lines.push(
      "",
      `### ${item.characterName || "角色"}`,
      item.referenceImageAdded ? `参考图：已添加人物参考图${item.referenceImageName ? `（${item.referenceImageName}）` : ""}` : "参考图：未添加",
      item.appearancePrompt || "",
      item.referenceImageNotes ? `参考图吸收：${item.referenceImageNotes}` : "",
      `一致性标签：${(item.consistencyTags || []).join(" / ")}`,
      `禁止变化：${(item.forbiddenChanges || []).join(" / ")}`
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
      `场景负面规则：${(item.negativeSceneRules || []).join(" / ")}`,
      `关联镜头：${(item.relatedShotIds || []).join(" / ")}`
    );
  }
  lines.push("", "## 镜头生产任务");
  for (const shot of plan.shotPlan || []) {
    lines.push(
      "",
      `### ${shot.shotId || "镜头"} · ${shot.sourceSceneId || ""} · ${shot.durationSeconds || 4} 秒`,
      `场景 ID：${shot.sceneId || ""}`,
      `剧情功能：${shot.storyPurpose || ""}`,
      `情绪目标：${shot.emotionalTarget || ""}`,
      "",
      "首帧 prompt：",
      shot.startFramePrompt || "",
      "",
      "尾帧 prompt：",
      shot.endFramePrompt || "",
      "",
      "视频 prompt：",
      shot.videoPrompt || "",
      "",
      "负面 prompt：",
      shot.negativePrompt || "",
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
