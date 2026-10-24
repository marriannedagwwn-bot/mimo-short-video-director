import {
  isStoryboardPlan, legacyAnimationPlanMessage, legacyAnimationPlanVersion, STORYBOARD_PLAN_VERSION,
  storyboardPromptArtifactId, storyboardPromptMatches, storyboardUsesPreviousFrames
} from "./storyboard-plan.js";
import { renderStoryboard } from "./storyboard-render.js";
import { dotList, factSheet } from "./fact-sheet.js";
const storyboardPromptRequests = new Map();
import { formatStageUsageSuffix, mergeStageUsage } from "./token-usage-format.js";
import { storyPackageFilename } from "./export-filename.js";
import { isNarrativeFullStory } from "./full-story-format.js";
import { downloadProductionPackage } from "./production-package-download.js";
import {
  CANDIDATE_REVIEW_CONFIDENCE_LABELS,
  CANDIDATE_REVIEW_DIMENSION_LABELS,
  CANDIDATE_REVIEW_LITERAL_DEPENDENCY_LABELS,
  CANDIDATE_REVIEW_OVERRIDE_LABELS,
  CANDIDATE_REVIEW_SPECIAL_DEFECT_LABELS,
  CANDIDATE_REVIEW_TIERS,
  FULL_STORY_PRECHECK_REASON_LABELS,
  PROMISE_CHECK_STATUS_LABELS,
  PROMISE_SOURCE_LABELS,
  SOURCE_SCAFFOLD_COPY_SCORE,
  STORY_QUALITY_ISSUE_TYPE_LABELS,
  candidateReviewHeadline,
  storyQualityRepairableItems,
  storyReviewHeadline,
  storyReviewMetrics
} from "./story-review-metrics.js";
import {
  createDirectorArtifactSynchronizer,
  directorControlView,
  directorTaskView,
  storyPipelineTaskView
} from "./director-pipeline-ui.js";
import {
  STORY_ENTRY_MODE,
  STORY_ENTRY_VARIANT_ID,
  STORY_MODE_CHARACTER_ONLY,
  STORY_MODE_FULL_TEXT,
  STORY_SOURCE_TEXT_MAX_CHARS,
  normalizeStorySource,
  normalizeStoryText,
  storyTextLength
} from "./story-entry.js";
import { fullStoryControlView, fullStoryTaskView } from "./full-story-control-ui.js";
import {
  REFERENCE_REWRITE_ARTIFACT_ID,
  REFERENCE_REWRITE_PROVIDERS,
  REFERENCE_REWRITE_STAGE,
  REFERENCE_REWRITE_TASK_KIND,
  referenceRewriteDraftStoryText,
  referenceRewriteMarkdown
} from "./reference-rewrite.js";
import {
  referenceRewriteDraftPickerHtml,
  referenceRewriteHint,
  referenceRewriteProgressText,
  referenceRewriteResultHtml,
  referenceRewriteTextIsDraft
} from "./reference-rewrite-ui.js";
import {
  isActiveTask, latestTaskForTarget, rememberTaskSnapshot, taskStatusView, taskErrorMessage
} from "./task-status-ui.js";
import { buildCharacterReferenceImagePrompt } from "./character-reference-prompt.js";
import {
  characterReferenceAudioClips,
  shotRelatedCharacterAudioClips,
  validateCharacterReferenceAudioClips
} from "./character-reference-audio.js";
import {
  ALL_REFERENCE_MAX_AUDIOS,
  ALL_REFERENCE_MAX_IMAGES,
  ALL_REFERENCE_MAX_VIDEO_BYTES,
  ALL_REFERENCE_MAX_VIDEOS,
  ALL_REFERENCE_MEDIA_MAX_SECONDS,
  ALL_REFERENCE_MEDIA_MIN_SECONDS,
  ALL_REFERENCE_MEDIA_TOTAL_SECONDS
} from "./all-reference-limits.js";
import {
  SHOT_VIDEO_RESOLUTION_STORAGE_KEY,
  isShotVideoResolutionOption,
  shotVideoResolutionOptions
} from "./shot-video-resolutions.js";
import { shotRelatedCharacterReferences } from "./shot-reference-images.js";
import { fullStoryShapeWarnings } from "./full-story-shape-metrics.js";
import {
  STORY_DURATION_SOURCE,
  resolveStoryDurationTarget,
  storyDurationOptions,
  storyDurationWindow,
  storyOutlineTotalSeconds
} from "./story-duration.js";
import { CHARACTER_EXPRESSION_RULES_STORAGE_KEY } from "./character-expression-rules.js";
import { CHARACTER_ART_STYLE_PRESETS, CHARACTER_ART_STYLE_STORAGE_KEY, DEFAULT_CHARACTER_ART_STYLE, normalizeCharacterArtStyle } from "./character-art-style.js";
import { deriveDirectorProgress, directorAgentChosenVariant } from "./director-agent-progress.js";
import { createDirectorAgentController } from "./director-agent-controller.js";
import { renderDirectorAgentMessages, renderDirectorAgentStatus } from "./director-agent-panel.js";
import { directorAgentEditTarget } from "./director-agent-actions.js";
import { oneSentenceEditConfirmText, oneSentenceEditTargetLabel, oneSentenceEditWhere, renderOneSentenceEditPreview } from "./one-sentence-edit-ui.js";
import {
  createBrowserWorkspaceClient, creationPreferences, CREATION_PREFERENCES_STORAGE_KEY
} from "./browser-workspace-client.js";
import { createApiRequestError } from "./compiler-observability.js";
import {
  ACTIVE_PRODUCTION_RUN_STORAGE_KEY,
  beginArtifactRequest,
  durableTaskTargetContext,
  emptyProductionState,
  finishArtifactRequest,
  isArtifactRequestCurrent,
  lineageDependency,
  matchingCurrentArtifactLineage,
  planProductionContext,
  productionRequestHeaders,
  productionStateFromRun,
  taskResultIsCurrent
} from "./production-lineage-client.js";
import { normalizeAnimationPlanAspectRatio } from "./animation-plan-settings.js";
import {
  dropStaleMediaResults,
  previousShotReferenceFrameCount,
  previousShotInPlan,
  selectedShotVideoCandidate,
  SHOT_VIDEO_CONTINUITY_NONE,
  SHOT_VIDEO_CONTINUITY_PREVIOUS_SHOT_FRAMES,
  shouldIncludePreviousShotFrames,
  shotVideoArtifactIdFor,
  shotVideoResultKey
} from "./shot-video-continuity.js";
import {
  resolveImportedVariant,
  resolveRestoredVariantId
} from "./variant-restore.js";
import { runtimePromptOverride } from "./video-prompt-profile-ui.js";

const state = {
  // 「从剧情开始」还是「从参考视频开始」。没有 Run 时由首页切换决定；有 Run 时与 Run 元数据一致
  // （切换入口会先清掉当前 Run）。故事草稿只留在输入框里，不进任何浏览器存储。
  entryMode: "video",
  storyMode: STORY_MODE_FULL_TEXT,
  // 参考片仿写（2026-10-24）：referenceRewrite 是当前 Run 的 Artifact 内容；referenceRewriteDrafts 是切到
  // 剧情入口时复制下来的四稿，只在页面内存里（刷新即清），不进任何浏览器存储。
  referenceRewrite: null,
  referenceRewriteRunning: false,
  referenceRewriteHealth: { available: false, reason: "正在检查参考片仿写要用的本机工具…" },
  referenceRewriteDrafts: null,
  referenceRewriteStatus: { text: "", tone: "" },
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
  storyDurationTarget: STORY_DURATION_SOURCE,
  backgroundMusicDrafts: {},
  shotVideoResults: {},
  characterReferenceStatuses: {},
  characterAudioStatuses: {},
  taskSnapshots: {},
  directorTaskId: "",
  directorControlRequest: null,
  storyGenerationRequest: null,
  storyControlRequests: {},
  storyTaskStatusVisible: false,
  production: emptyProductionState(),
  characterImageGeneration: {
    open: false,
    running: false,
    selectedIndex: 0,
    resultsTarget: "",
    count: 1,
    referenceImageDataUrl: "",
    referenceImageName: "",
    boundaryWarning: "",
    results: []
  },
  shotVideoGeneration: {
    open: false,
    running: false,
    shotId: "",
    count: 1,
    validationRevision: 0,
    includePreviousShotFrames: false,
    includeCharacterReferences: true,
    referenceAssets: []
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
  // 展开前体检占用的是「生成完整剧情」这个按钮，但它不是 durable task，
  // 所以与 storyRunning 分开记——混用会让终止/暂停那组控件误以为有任务在跑。
  storyPrecheckRunning: false,
  animationRunning: false
};

const emptyMediaDialogs = Object.fromEntries(
  ["characterImageGeneration", "shotVideoGeneration"].map((key) => [key, structuredClone(state[key])])
);
const browserWorkspace = createBrowserWorkspaceClient({
  storage: sessionStorage,
  fetch: (...args) => fetch(...args),
  sendBeacon: (...args) => navigator.sendBeacon(...args)
});
let sourceLoading = true;
const STORY_PACKAGE_HELP = "可导入/导出完整剧情与动画镜头生产包，避免重复请求模型。";
let storyPackageFeedbackRevision = 0;
let storyPackageFeedbackContext = "";

function assertWorkspaceCurrent(epoch) {
  if (browserWorkspace.isCurrent(epoch)) return;
  const error = new Error("参考视频已切换，已忽略旧页面数据的迟到响应。");
  error.code = "BROWSER_WORKSPACE_STALE";
  throw error;
}

const $ = (selector) => document.querySelector(selector);
const elements = {
  input: $("#videoInput"), dropzone: $("#dropzone"), uploadTitle: $("#uploadTitle"), uploadHint: $("#uploadHint"),
  videoInfo: $("#videoInfo"), preview: $("#videoPreview"), fileName: $("#fileName"), fileMeta: $("#fileMeta"),
  frames: $("#frames"), frameStatus: $("#frameStatus"), replace: $("#replaceVideo"), transcript: $("#transcript"),
  fixedCharacter: $("#fixedCharacter"), vertical: $("#vertical"), constraints: $("#constraints"), characterArtStyle: $("#characterArtStyle"), characterArtStylePresets: $("#characterArtStylePresets"), variantCount: $("#variantCount"),
  run: $("#runWorkflow"), error: $("#errorMessage"), modelState: $("#modelState"),
  runReferenceRewrite: $("#runReferenceRewrite"), referenceRewriteHint: $("#referenceRewriteHint"),
  referenceRewriteSection: $("#referenceRewriteSection"), referenceRewriteStatus: $("#referenceRewriteStatus"),
  referenceRewriteResult: $("#referenceRewriteResult"), referenceRewritePicker: $("#referenceRewritePicker"),
  entryModeVideo: $("#entryModeVideo"), entryModeStory: $("#entryModeStory"),
  storyModeFullText: $("#storyModeFullText"), storyModeCharacterOnly: $("#storyModeCharacterOnly"),
  storySourceField: $("#storySourceField"), storySourceText: $("#storySourceText"), storySourceCounter: $("#storySourceCounter"),
  storyDialogueCheck: $("#storyDialogueCheck"),
  directorControls: $("#directorControls"), directorStartArrow: $("#directorStartArrow"),
  terminateDirector: $("#terminateDirector"), pauseDirector: $("#pauseDirector"), directorControlHint: $("#directorControlHint"),
  openModelSettings: $("#openModelSettings"), modelSettingsModal: $("#modelSettingsModal"), closeModelSettings: $("#closeModelSettings"),
  directorAgentPanel: $("#directorAgentPanel"), directorAgentToggle: $("#directorAgentToggle"), closeDirectorAgent: $("#closeDirectorAgent"),
  directorAgentEntry: $("#directorAgentEntry"), directorAgentSteps: $("#directorAgentSteps"), directorAgentBusy: $("#directorAgentBusy"),
  directorAgentMessages: $("#directorAgentMessages"), directorAgentComposer: $("#directorAgentComposer"),
  directorAgentInput: $("#directorAgentInput"), directorAgentSend: $("#directorAgentSend"),
  storyEditPreview: $("#storyEditPreview"), storyboardEditPreview: $("#storyboardEditPreview"), shotPromptEditPreview: $("#shotPromptEditPreview"),
  modelStageList: $("#modelStageList"), resetModelSettings: $("#resetModelSettings"), saveModelSettings: $("#saveModelSettings"),
  modelSettingsStatus: $("#modelSettingsStatus"),
  empty: $("#emptyResults"), resultStack: $("#resultStack"), export: $("#exportButton"),
  analysis: $("#analysisResult"), script: $("#scriptResult"), brief: $("#briefResult"), guardrails: $("#guardrailsResult"), variants: $("#variantsResult"),
  mainPage: $("#top"), storyPage: $("#storyPage"), storyModelName: $("#storyModelName"),
  selectedVariantSummary: $("#selectedVariantSummary"), storyStatus: $("#storyStatus"),
  storyGenerate: $("#generateFullStory"), fullStory: $("#fullStoryResult"), backToResults: $("#backToResults"),
  fullStoryPrecheck: $("#fullStoryPrecheckPanel"),
  fullStoryControls: $("#fullStoryControls"), fullStoryStartArrow: $("#fullStoryStartArrow"),
  terminateFullStory: $("#terminateFullStory"), pauseFullStory: $("#pauseFullStory"), fullStoryControlHint: $("#fullStoryControlHint"),
  animationGenerate: $("#generateAnimationPlan"), animationStatus: $("#animationStatus"), animationPlan: $("#animationPlanResult"),
  storyMusicControl: $("#storyMusicControl"),
  animationAspectRatio: $("#animationAspectRatio"),
  storyDurationTarget: $("#storyDurationTarget"),
  exportStoryPackage: $("#exportStoryPackage"),
  importStoryPackage: $("#importStoryPackage"), exportStoryTestPackage: $("#exportStoryTestPackage"),
  storyPackageFile: $("#storyPackageFile"), storyPackageStatus: $("#storyPackageStatus"),
  characterImageModal: $("#characterImageModal"), closeCharacterImageModal: $("#closeCharacterImageModal"),
  characterImageRole: $("#characterImageRole"), characterImageCount: $("#characterImageCount"),
  characterImageDrop: $("#characterImageDrop"), characterImageInput: $("#characterImageInput"),
  characterImageDropTitle: $("#characterImageDropTitle"), characterImageDropHint: $("#characterImageDropHint"),
  characterImagePreviewWrap: $("#characterImagePreviewWrap"), characterImagePreview: $("#characterImagePreview"),
  replaceCharacterImage: $("#replaceCharacterImage"), removeCharacterImage: $("#removeCharacterImage"), characterImagePromptPreview: $("#characterImagePromptPreview"),
  characterImageStatus: $("#characterImageStatus"), generateCharacterImages: $("#generateCharacterImages"),
  characterImageResults: $("#characterImageResults"),
  shotVideoModal: $("#shotVideoModal"), closeShotVideoModal: $("#closeShotVideoModal"),
  shotVideoEyebrow: $("#shotVideoModal .eyebrow"),
  shotVideoModalTitle: $("#shotVideoModalTitle"), shotVideoMeta: $("#shotVideoMeta"),
  shotVideoReferenceList: $("#shotVideoReferenceList"), shotVideoCount: $("#shotVideoCount"),
  shotVideoResolutionField: $("#shotVideoResolutionField"), shotVideoResolution: $("#shotVideoResolution"),
  shotVideoResolutionHint: $("#shotVideoResolutionHint"),
  shotVideoIncludePreviousShotFrames: $("#shotVideoIncludePreviousShotFrames"),
  shotVideoIncludeCharacterReferences: $("#shotVideoIncludeCharacterReferences"),
  shotVideoReferenceDrop: $("#shotVideoReferenceDrop"), shotVideoReferenceInput: $("#shotVideoReferenceInput"),
  shotVideoPromptPreview: $("#shotVideoPromptPreview"), shotVideoStatus: $("#shotVideoStatus"),
  confirmGenerateShotVideo: $("#confirmGenerateShotVideo"), shotVideoResults: $("#shotVideoResults"),
  generatedImagePreview: $("#generatedImagePreview"), generatedImagePreviewImage: $("#generatedImagePreviewImage"),
  generatedImagePreviewCaption: $("#generatedImagePreviewCaption"), closeGeneratedImagePreview: $("#closeGeneratedImagePreview")
};

const directorArtifactSynchronizer = createDirectorArtifactSynchronizer({
  reloadRun: (task) => reloadActiveProductionRun(task),
  renderCompletedStages: ({ previousCompletedStages, completedStages }) => {
    renderRestoredDirectorArtifacts({
      fromStage: previousCompletedStages,
      toStage: completedStages
    });
  },
  onReloadError: (error) => {
    // 一次临时 fetch 失败不应打断 Durable Task attach；checkpoint 不前移，
    // 下一次轮询会对同一个 completedStages 再尝试一次。
    console.warn("已完成阶段暂时无法同步，等待下一次任务轮询重试", error);
  }
});

const MODEL_STAGE_DEFS = [
  { key: "analysis", label: "参考片分析", hint: "视频解析、定位、人物、节奏", capability: "视觉模型", capabilityKind: "vision" },
  { key: "reconstruction", label: "脚本还原", hint: "分场、动作、镜头、转折", capability: "视觉模型", capabilityKind: "vision" },
  { key: "brief", label: "创意简报", hint: "原片驱动结构、换角测试", capability: "文本模型", capabilityKind: "text" },
  { key: "visualGuardrails", label: "视觉规则", hint: "角色边界、原片来源记录、台词规则", capability: "视觉模型", capabilityKind: "vision" },
  { key: "variants", label: "主题变体", hint: "新故事方向", capability: "文本模型", capabilityKind: "text" },
  { key: "storyCandidateReview", label: "候选对照评审", hint: "横向比对候选动作链，只出报告", capability: "文本模型", capabilityKind: "text", optional: true },
  { key: "storyCandidateRevision", label: "命题定向修订", hint: "按评审报出的因果断裂只改一个命题，只出修订稿", capability: "文本模型", capabilityKind: "text", optional: true },
  { key: "fullStory", label: "完整剧情", hint: "可拍分场剧本", capability: "文本模型", capabilityKind: "text" },
  // 四个验收阶段。服务端从一开始就在 modelStages / stageHealth 里上报它们，
  // 只是这张表漏了登记，于是面板选不到、sanitizedModelOverrides 也会把覆盖过滤掉——
  // 这张表就是 override 白名单。都是纯文本阶段（不在 requiresMediaModel 里）。
  // optional：它们由用户手动触发、不属于必经链路，不该参与 modelStagesReady 的就绪判定。
  { key: "storyQualityReview", label: "剧情体检", hint: "核对候选承诺 + 编辑诊断，只出报告", capability: "文本模型", capabilityKind: "text", optional: true },
  { key: "storyQualityRepair", label: "剧情按问题修改", hint: "按体检里选中的问题写局部修改，只出修订稿", capability: "文本模型", capabilityKind: "text", optional: true },
  { key: "animationPlan", label: "动画生产包", hint: "自主分镜与单镜视频提示词", capability: "文本模型", capabilityKind: "text" },
  // 一句话修改（2026-10-11）：按你在导演助手里说的话写修改稿，只出修改稿，点「采纳」才生效。
  { key: "oneSentenceEdit", label: "一句话修改", hint: "按你在导演助手里说的话写修改稿，只出修改稿", capability: "文本模型", capabilityKind: "text", optional: true },
  // 导演助手（2026-10-09）：理解对话栏里打的字，只提议下一步；每次调用都关闭思考。用户点对话栏才调用。
  { key: "directorAgent", label: "导演助手", hint: "理解对话栏里打的字，只提议下一步（思考关闭）", capability: "文本模型", capabilityKind: "text", optional: true },
  // 参考片仿写（2026-10-24）：看接触表与去配乐后的转写写四稿。默认 Claude Opus 5.5（effort xhigh，页面不能改），
  // 只能选 Claude 或 MiMo；这是 Claude 唯一能收图的一步。用户点「参考片仿写」才调用。
  { key: REFERENCE_REWRITE_STAGE, label: "参考片仿写", hint: "看抽帧图和去配乐后的台词，写原片拆解和四篇剧本", capability: "看图写稿", capabilityKind: "vision", optional: true },
  { key: "characterReference", label: "人物图修正", hint: "根据上传图片修正角色描述", capability: "视觉模型", capabilityKind: "vision" },
  { key: "imageGeneration", label: "图片生成", hint: "角色参考图", capability: "图片生成", capabilityKind: "image", providerLocked: true, optional: true },
  { key: "shotVideo", label: "镜头视频", hint: "全能参考单镜头视频候选", capability: "视频生成", capabilityKind: "video", providers: ["Seedance", "MiniMax"], optional: true }
];
const MEDIA_INPUT_MODEL_STAGES = new Set(["analysis", "reconstruction", "visualGuardrails", "characterReference"]);
// 在本工作流只接纯文本的文本供应商：要看图或视频的阶段不列出它们（服务端与客户端各有一道同样的关）。
const TEXT_ONLY_MODEL_PROVIDERS = new Set(["DeepSeek", "Claude"]);
const SHOT_VIDEO_PROVIDER_LABELS = {
  Seedance: "Seedance 2.0",
  MiniMax: "MiniMax H3"
};
const SHOT_VIDEO_PROVIDER_EYEBROWS = {
  Seedance: "SEEDANCE 2.0",
  MiniMax: "MINIMAX H3"
};
const MODEL_OPTION_CATALOG = {
  Qwen: {
    media: ["qwen3.7-plus", "qwen-vl-max-latest", "qwen-vl-plus-latest", "qwen-omni-turbo-latest"],
    text: ["qwen3.7-max", "qwen3.7-plus", "qwen-max-latest", "qwen-plus-latest", "qwen-turbo-latest"]
  },
  MiMo: {
    // Official Chat Completions IDs; all three V2.6 models accept image/video input.
    // https://mimo.mi.com/docs/en-US/api/chat/openai-api (verified 2026-09-22)
    media: ["mimo-v2.5", "mimo-v2.5-pro", "mimo-v2.6-flash", "mimo-v2.6-pro", "mimo-v2.6-pro-ultraspeed"],
    text: ["mimo-v2.5", "mimo-v2.5-pro", "mimo-v2.6-flash", "mimo-v2.6-pro", "mimo-v2.6-pro-ultraspeed"]
  },
  DeepSeek: {
    text: ["deepseek-v4-flash", "deepseek-v4-pro"]
  },
  Claude: {
    // 只登记这四个型号（src/claude-client.js 的 CLAUDE_MODELS）；第一个是选 Claude 时的默认型号。
    // https://platform.claude.com/docs/en/about-claude/models/overview（2026-10-19 核对）
    text: ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5", "claude-fable-5-1"]
  },
  Jimeng: {
    imageGeneration: ["doubao-seedream-5-0-260128", "seedream-5-0-lite-260128"]
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
  }
};

// 导演助手（2026-10-09）的对话状态。必须声明在 init() 调用之前：init 的同步部分会经由
// resetDirectorClientState 等钩子用到它们，声明在后面就是暂时性死区。对话只在页面内存里，刷新即清空。
const directorAgent = createDirectorAgentController();
let directorAgentRefreshTimer = null;
let directorAgentStarted = false;
// 导入剧情包（2026-10-10）先设上新 Run、再从服务端读回内容；读回之前页面是半截的（新 Run 已设上，
// 原文和剧情还没读回）。这段时间导演助手不观察，免得把半截状态报成「原文改过了」「刚拆好」。
let storyRunImporting = false;
let directorAgentMessagesSignature = "";
let directorAgentLastMessageId = "";
// 一句话修改（2026-10-11）：修改稿只放在页面内存里，不进任何浏览器存储，刷新即丢（已经花的那次调用不退）。
// 同一时间只有一份：{ id, status: "writing" | "ready" | "failed", target, variantId, shotId, artifactId,
// runId, baseRevision, instruction, result, error, usage, adopting }。
let oneSentenceEdit = null;
// 最近一次的结果（写好、没改成、采纳、放弃、过期、失败），导演助手据此报一句。
let oneSentenceEditEvent = null;
let oneSentenceEditLastUsage = null;
let oneSentenceEditSequence = 0;

init();

async function init() {
  // Historical unscoped Runs are never silently adopted or deleted by this tab.
  localStorage.removeItem(ACTIVE_PRODUCTION_RUN_STORAGE_KEY);
  localStorage.removeItem("directorModelOverrides");
  // 「角色表情规则」那一栏已由「角色画风」接替（2026-10-09），旧存档不再有人读，删掉，
  // 长期设置仍是七项。
  localStorage.removeItem(CHARACTER_EXPRESSION_RULES_STORAGE_KEY);
  restoreProfile();
  restoreCharacterArtStyle();
  restoreCreationPreferences();
  applyEntryModeUi();
  elements.frames.innerHTML = skeletonFrames(10);
  elements.characterArtStyle.addEventListener("input", saveCharacterArtStyle);
  bindEvents();
  bindDirectorAgentEvents();
  bindOneSentenceEditEvents();
  validateReady();
  // Run/Task 恢复不依赖供应商健康检查。图片或视频 provider 的 /models
  // 即使很慢，也不能阻塞刷新后的 Durable Task 重新接管。
  const restorePromise = restoreBrowserWorkspace();
  window.addEventListener("pagehide", () => browserWorkspace.close());
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) void resumeBrowserWorkspace();
  });
  window.setInterval(() => { void touchBrowserWorkspace(); }, 20_000);
  try {
    const health = await fetch("/api/health").then((response) => response.json());
    state.mode = health.mode;
    state.mediaMode = health.mediaMode || "auto";
    state.modelStages = health.modelStages || {};
    state.stageHealth = health.stageHealth || {};
    state.providers = health.providers || {};
    state.referenceRewriteHealth = health.referenceRewrite || { available: false, reason: "服务端没有报告参考片仿写的状态，请重启服务。" };
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
        ? health.networkProxy?.error?.message || "模型已配置，但部分阶段不可用"
        : "演示模式 · 配置模型后启用真实分析";
    renderModelSettings();
  } catch {
    elements.modelState.lastElementChild.textContent = "服务连接失败";
  }
  await restorePromise;
  renderRoute();
  startDirectorAgent();
}

function bindEvents() {
  for (const radio of [elements.entryModeVideo, elements.entryModeStory]) {
    radio.addEventListener("change", () => { if (radio.checked) void handleEntryModeChange(radio.value); });
  }
  for (const radio of [elements.storyModeFullText, elements.storyModeCharacterOnly]) {
    radio.addEventListener("change", () => { if (radio.checked) void handleStoryModeChange(radio.value); });
  }
  elements.storySourceText.addEventListener("input", () => { void handleStorySourceInput(); });
  elements.input.addEventListener("change", (event) => {
    const file = event.target.files[0];
    event.target.value = "";
    if (file) void handleFile(file);
  });
  ["dragenter", "dragover"].forEach((name) => elements.dropzone.addEventListener(name, (event) => { event.preventDefault(); elements.dropzone.classList.add("dragging"); }));
  ["dragleave", "drop"].forEach((name) => elements.dropzone.addEventListener(name, (event) => { event.preventDefault(); elements.dropzone.classList.remove("dragging"); }));
  elements.dropzone.addEventListener("drop", (event) => event.dataTransfer.files[0] && handleFile(event.dataTransfer.files[0]));
  elements.replace.addEventListener("click", () => elements.input.click());
  elements.run.addEventListener("click", runWorkflow);
  elements.runReferenceRewrite.addEventListener("click", () => { void runReferenceRewrite(); });
  elements.referenceRewriteResult.addEventListener("click", (event) => {
    const use = event.target.closest("[data-reference-draft-use]");
    if (use) { void useReferenceRewriteDraft(Number(use.dataset.referenceDraftUse)); return; }
    if (event.target.closest("[data-reference-rewrite-download]")) downloadReferenceRewrite();
  });
  elements.referenceRewritePicker.addEventListener("click", (event) => {
    const fill = event.target.closest("[data-reference-draft-fill]");
    if (fill) fillReferenceRewriteDraft(Number(fill.dataset.referenceDraftFill));
  });
  elements.terminateDirector.addEventListener("click", () => controlDirectorPipeline("terminate"));
  elements.pauseDirector.addEventListener("click", () => {
    const task = state.taskSnapshots[state.directorTaskId];
    void controlDirectorPipeline(directorControlView(task).pauseAction);
  });
  elements.export.addEventListener("click", exportJson);
  elements.openModelSettings.addEventListener("click", openModelSettings);
  elements.closeModelSettings.addEventListener("click", closeModelSettings);
  elements.modelSettingsModal.addEventListener("click", (event) => {
    if (event.target === elements.modelSettingsModal) closeModelSettings();
  });
  elements.resetModelSettings.addEventListener("click", resetModelSettings);
  elements.saveModelSettings.addEventListener("click", saveModelSettings);
  elements.modelStageList.addEventListener("change", handleModelStageListChange);
  elements.modelStageList.addEventListener("click", handleModelPickerTriggerClick);
  elements.modelStageList.addEventListener("keydown", handleModelPickerTriggerKeydown);
  document.addEventListener("pointerdown", (event) => {
    if (!modelPicker.root) return;
    const target = event.target;
    if (modelPicker.root.contains(target) || modelPicker.submenu?.contains(target) || modelPicker.trigger?.contains(target)) return;
    closeModelPicker();
  }, true);
  window.addEventListener("resize", () => closeModelPicker());
  // 弹窗本身会滚动，菜单是 fixed 定位，滚动后会和按钮错位，所以直接收起；菜单自己的滚动不算。
  window.addEventListener("scroll", (event) => {
    if (!modelPicker.root || modelPicker.root.contains(event.target) || modelPicker.submenu?.contains(event.target)) return;
    closeModelPicker();
  }, true);
  elements.variants.addEventListener("click", (event) => {
    const button = event.target.closest("[data-story-variant]");
    if (button) navigateToStory(button.dataset.storyVariant);
    if (event.target.closest("[data-regenerate-variants]")) regenerateThemeVariants();
  });
  elements.backToResults.addEventListener("click", backToMainResults);
  elements.storyGenerate.addEventListener("click", () => startFullStory({ force: true }));
  elements.terminateFullStory.addEventListener("click", () => controlFullStory("terminate"));
  elements.pauseFullStory.addEventListener("click", () => {
    void controlFullStory(fullStoryControlView(selectedFullStoryTask()).pauseAction);
  });
  elements.animationGenerate.addEventListener("click", () => generateAnimationPlan({ force: true }));
  elements.animationAspectRatio.addEventListener("change", () => handleDefaultAspectRatioChange(elements.animationAspectRatio.value));
  elements.storyDurationTarget.addEventListener("change", () => {
    state.storyDurationTarget = elements.storyDurationTarget.value;
    saveCreationPreferences();
  });
  elements.variantCount.addEventListener("change", saveCreationPreferences);
  renderStoryDurationOptions();
  elements.exportStoryPackage.addEventListener("click", exportCurrentStoryPackage);
  elements.importStoryPackage.addEventListener("click", () => elements.storyPackageFile.click());
  $("#importStoryPackageHome").addEventListener("click", () => elements.storyPackageFile.click());
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
  // 粘贴完整故事没有候选卡，配乐开关放在分场页的「生成分镜」旁边。
  elements.storyMusicControl.addEventListener("change", (event) => {
    const toggle = event.target.closest("[data-background-music]");
    if (toggle) handleBackgroundMusicToggle(toggle.dataset.backgroundMusic, toggle.checked);
  });
  elements.closeShotVideoModal.addEventListener("click", closeShotVideoGenerator);
  elements.shotVideoModal.addEventListener("click", (event) => {
    if (event.target === elements.shotVideoModal) closeShotVideoGenerator();
    const useButton = event.target.closest("[data-use-shot-video]");
    if (useButton) return selectShotVideoCandidate(useButton.dataset.useShotVideo, useButton.dataset.candidateIndex);
    const removeButton = event.target.closest("[data-remove-shot-video-reference]");
    if (removeButton) return removeShotVideoReferenceAsset(removeButton.dataset.removeShotVideoReference);
  });
  elements.shotVideoCount.addEventListener("change", () => {
    state.shotVideoGeneration.count = Number(elements.shotVideoCount.value) || 1;
  });
  elements.shotVideoResolution.addEventListener("change", handleShotVideoResolutionChange);
  elements.shotVideoIncludePreviousShotFrames.addEventListener("change", () => {
    state.shotVideoGeneration.includePreviousShotFrames = elements.shotVideoIncludePreviousShotFrames.checked;
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
  $("#regenerateShotVideoPrompt").addEventListener("click", () => {
    if (oneSentenceEditBlocksShot(state.shotVideoGeneration.shotId)) {
      return setShotVideoStatus("这一镜的提示词修改稿还没处理：先采纳或放弃，再重新生成提示词。", "error");
    }
    return updateShotVideoGeneratorPreview({ regeneratePrompt: true });
  });
  elements.generatedImagePreview.addEventListener("click", (event) => {
    if (event.target === elements.generatedImagePreview) closeGeneratedImagePreview();
  });
  elements.closeGeneratedImagePreview.addEventListener("click", closeGeneratedImagePreview);
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !elements.generatedImagePreview.classList.contains("hidden")) closeGeneratedImagePreview();
    else if (event.key === "Escape" && !elements.modelSettingsModal.classList.contains("hidden")) closeModelSettings();
    else if (event.key === "Escape" && !elements.shotVideoModal.classList.contains("hidden")) closeShotVideoGenerator();
    else if (event.key === "Escape" && !elements.characterImageModal.classList.contains("hidden")) closeCharacterImageGenerator();
  });
  elements.characterImageRole.addEventListener("change", () => {
    state.characterImageGeneration.selectedIndex = Number(elements.characterImageRole.value) || 0;
    const variantId = String(selectedVariant()?.id || "");
    if (state.characterImageGeneration.resultsTarget !== `${variantId}:${state.characterImageGeneration.selectedIndex}`) {
      state.characterImageGeneration.results = [];
      state.characterImageGeneration.boundaryWarning = "";
      renderCharacterImageResults();
    }
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
  elements.removeCharacterImage.addEventListener("click", () => {
    resetCharacterImageReference();
    renderCharacterImagePromptPreview();
    setCharacterImageStatus("已移除参考图，将只按文字设定出图。", "ready");
  });
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
    // 旧版分镜卡片上的「重新生成分镜」：与「生成分镜」按钮同一个入口，强制重新生成。
    if (event.target.closest("[data-regenerate-storyboard]")) return generateAnimationPlan({ force: true });
    const button = event.target.closest("[data-generate-shot-video]");
    if (button) return openShotVideoGenerator(button.dataset.generateShotVideo);
    const referenceUploadButton = event.target.closest("[data-character-reference-upload]");
    if (referenceUploadButton) return openCharacterReferenceInput(referenceUploadButton.dataset.characterReferenceUpload);
    const audioUploadButton = event.target.closest("[data-character-audio-upload]");
    if (audioUploadButton) return openCharacterAudioInput(audioUploadButton.dataset.characterAudioUpload);
    const audioRemoveButton = event.target.closest("[data-character-audio-remove]");
    if (audioRemoveButton) {
      return removeCharacterReferenceAudio(
        audioRemoveButton.dataset.characterAudioIndex,
        audioRemoveButton.dataset.characterAudioRemove
      );
    }
    if (event.target.closest("[data-character-audio-clips]")) return;
    // 两个隐藏 file input 都必须在这里挡掉：openCharacterAudioInput / openCharacterReferenceInput
    // 是用 input.click() 打开选择器的，那次原生 click 会冒泡回这个委托监听器。音频 input 少了这道
    // 守卫时会一路落到下面的整卡兜底，于是「上传音色/叫声」在打开音频选择器之后又打开了图片选择器，
    // 图片框盖在上面——用户看到的就是让他传图片。
    if (event.target.closest("[data-character-audio-input]")) return;
    if (event.target.closest("[data-character-reference-input]")) return;
    const card = event.target.closest("[data-character-reference-card]");
    if (card) return openCharacterReferenceInput(card.dataset.characterReferenceCard);
  });
  elements.animationPlan.addEventListener("change", (event) => {
    const audioInput = event.target.closest("[data-character-audio-input]");
    if (audioInput) {
      const files = [...(audioInput.files || [])];
      audioInput.value = "";
      if (files.length) addCharacterReferenceAudioFiles(audioInput.dataset.characterAudioInput, files);
      return;
    }
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
  elements.transcript.addEventListener("input", async () => {
    if (state.characterBoundaryProfile || state.production.runId) await invalidateGlobalCharacterBoundary("字幕或台词文本已修改；旧的生产 Run 与全局角色边界已失效，请重新运行工作流。");
  });
}

async function resumeBrowserWorkspace() {
  try {
    if (await browserWorkspace.resume()) {
      clearVideoWorkspaceUi();
      sourceLoading = true;
      await restoreBrowserWorkspace();
    }
  } catch (error) {
    showError(error.message || "页面会话暂时无法重新连接，请刷新重试。", "notice");
  }
}

async function touchBrowserWorkspace() {
  try {
    if (await browserWorkspace.touch()) {
      clearVideoWorkspaceUi();
      sourceLoading = false;
      validateReady();
      showError("上次页面会话已结束，视频与生成结果已清理；创作宇宙设置已保留。", "notice");
    }
  } catch { /* A temporary outage does not discard this tab's workspace identity. */ }
}

async function restoreBrowserWorkspace() {
  const epoch = browserWorkspace.epoch;
  try {
    const workspace = await browserWorkspace.start();
    assertWorkspaceCurrent(epoch);
    if (workspace.source) {
      const source = workspace.source;
      const response = await fetch(source.url, { cache: "no-store" });
      if (!response.ok) throw new Error("保存的原视频无法读取，请重新选择视频。");
      const file = new File([await response.blob()], source.name, {
        type: source.type, lastModified: source.lastModified
      });
      if (await sourceFileSha256(file) !== source.digest) throw new Error("保存的原视频校验失败，请重新选择视频。");
      assertWorkspaceCurrent(epoch);
      await loadSourceVideo(file, epoch);
    }
    assertWorkspaceCurrent(epoch);
    if (workspace.run) {
      await restoreActiveProductionRun(workspace.run, epoch);
      assertWorkspaceCurrent(epoch);
      if (!workspace.source && !isStoryEntryMode()) showError("已恢复导入包的生成结果，但该包未包含原视频。重新选择视频会清除这些结果。", "notice");
    }
  } catch (error) {
    if (browserWorkspace.isCurrent(epoch)) showError(error.message || "页面数据暂时无法恢复，请稍后刷新重试。", "notice");
  } finally {
    if (browserWorkspace.isCurrent(epoch)) {
      sourceLoading = false;
      validateReady();
    }
  }
}

function clearVideoWorkspaceUi({ keepSource = false } = {}) {
  resetDirectorClientState();
  if (!keepSource) {
    state.file = null;
    state.videoDataUrl = null;
    state.frames = [];
    state.metadata = null;
  }
  state.backgroundMusicDrafts = {};
  state.running = false;
  state.storyRunning = false;
  // 体检进行中换了工作区时，体检流程看到 epoch 已变会直接返回、不复位这个标记；
  // 漏掉它会让「生成完整剧情」此后永远静默不响应（2026-10-05 修复）。面板属于旧命题，一并清掉。
  state.storyPrecheckRunning = false;
  clearFullStoryPrecheck();
  state.animationRunning = false;
  state.variantsRegenerating = false;
  if (!keepSource) {
    if (state.previewUrl?.startsWith("blob:")) URL.revokeObjectURL(state.previewUrl);
    state.previewUrl = null;
    elements.preview.pause();
    elements.preview.removeAttribute("src");
    elements.preview.load();
    elements.transcript.value = "";
    elements.frames.innerHTML = skeletonFrames(10);
    elements.frameStatus.textContent = "等待抽帧";
    elements.fileName.textContent = "";
    elements.fileMeta.textContent = "";
    elements.dropzone.classList.remove("hidden");
    elements.videoInfo.classList.add("hidden");
  }
  for (const element of [elements.analysis, elements.script, elements.brief, elements.guardrails, elements.variants,
    elements.fullStory, elements.animationPlan, elements.selectedVariantSummary, elements.characterImageResults,
    elements.shotVideoResults]) {
    element.innerHTML = "";
  }
  for (const element of [elements.storyStatus, elements.animationStatus,
    elements.characterImageStatus, elements.shotVideoStatus]) element.textContent = "";
  for (const key of Object.keys(emptyMediaDialogs)) state[key] = structuredClone(emptyMediaDialogs[key]);
  for (const element of [elements.characterImageModal, elements.shotVideoModal,
    elements.generatedImagePreview, elements.export,
    elements.resultStack]) element.classList.add("hidden");
  elements.generatedImagePreviewImage.removeAttribute("src");
  resetCharacterImageReference();
  elements.characterImagePromptPreview.value = "";
  elements.shotVideoPromptPreview.value = "";
  elements.saveModelSettings.disabled = false;
  elements.resetModelSettings.disabled = false;
  setCharacterImageRunning(false);
  setShotVideoGeneratorRunning(false);
  document.body.classList.remove("modal-open");
  elements.empty.classList.remove("hidden");
  setRunning(false);
  setStoryRunning(false);
  setAnimationRunning(false);
  resetPipeline();
  renderStoryDurationOptions();
  history.replaceState({}, "", window.location.pathname);
  renderRoute();
}

async function handleFile(file) {
  if (!file.type.startsWith("video/")) return showError("请选择视频文件。支持 MP4、MOV、WebM 等浏览器可播放格式。");
  const epoch = browserWorkspace.beginChange();
  sourceLoading = true;
  clearVideoWorkspaceUi();
  showError("");
  elements.run.disabled = true;
  elements.uploadHint.textContent = "正在清理上一段视频并保存新视频…";
  try {
    const workspace = await browserWorkspace.replaceSource(file, epoch);
    if (!workspace) return;
    assertWorkspaceCurrent(epoch);
    await loadSourceVideo(file, epoch);
  } catch (error) {
    if (browserWorkspace.isCurrent(epoch)) showError(error.message || "视频保存失败，请重新选择视频。");
  } finally {
    if (browserWorkspace.isCurrent(epoch)) {
      sourceLoading = false;
      elements.uploadHint.textContent = "或点击选择文件 · MP4 / MOV / WebM";
      validateReady();
    }
  }
}

async function loadSourceVideo(file, epoch) {
  assertWorkspaceCurrent(epoch);
  const media = analysisMediaSettings();
  if (state.mode !== "demo" && media.mediaMode === "video" && file.size > media.nativeVideoMaxBytes) {
    throw new Error(`当前强制使用原生视频，文件不能超过 ${formatBytes(media.nativeVideoMaxBytes)}。请压缩视频或改用 auto 模式。`);
  }
  state.file = file;
  state.frames = [];
  state.videoDataUrl = null;
  elements.dropzone.classList.add("hidden");
  elements.videoInfo.classList.remove("hidden");
  elements.fileName.textContent = file.name;
  elements.fileMeta.textContent = `${formatBytes(file.size)} · 正在读取视频`;
  if (state.previewUrl?.startsWith("blob:")) URL.revokeObjectURL(state.previewUrl);
  // The persisted source endpoint stays the same across replacements. Bind the
  // player to this exact File, as sampling does, so it cannot reuse old media.
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
    assertWorkspaceCurrent(epoch);
    state.frames = sampled.frames;
    state.videoDataUrl = videoDataUrl;
    state.metadata = sampled.metadata;
    renderStoryDurationOptions();
    elements.fileMeta.textContent = `${formatBytes(file.size)} · ${formatTime(sampled.metadata.duration)} · ${sampled.metadata.width}×${sampled.metadata.height}`;
    elements.frames.innerHTML = sampled.frames.map((frame, index) => `<div class="frame"><img src="${frame.dataUrl}" alt="采样画面 ${index + 1}"><span>F${index + 1} · ${formatTime(frame.timestamp)}</span></div>`).join("");
    const mediaNote = videoDataUrl
      ? "原生视频已就绪"
      : state.mode !== "demo" && media.mediaMode !== "frames" && file.size > media.nativeVideoMaxBytes
        ? "视频较大，使用关键帧"
        : "关键帧模式";
    elements.frameStatus.textContent = `已抽取 ${sampled.frames.length} 帧 · ${mediaNote}`;
  } catch (error) {
    assertWorkspaceCurrent(epoch);
    state.file = null;
    elements.frameStatus.textContent = "抽帧失败";
    throw new Error(`无法读取视频：${error.message}`);
  }
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
  if (isStoryEntryMode()) return runStoryEntryWorkflow();
  const workspaceEpoch = browserWorkspace.epoch;
  if (state.running || sourceLoading || !browserWorkspace.workspace) return;
  const creatorProfile = profile();
  if (!creatorProfile.fixedCharacter || !creatorProfile.vertical) return showError("请填写固定角色和垂直赛道。 ");
  state.running = true;
  state.directorTaskId = "";
  state.directorControlRequest = null;
  showError("");
  setRunning(true);
  elements.empty.classList.add("hidden");
  elements.resultStack.classList.remove("hidden");
  try {
    const active = await activeProductionTasks();
    const activePipeline = active.find((task) => task.kind === "directorPipeline");
    let task = activePipeline || null;
    if (!task && active.length) {
      const confirmed = window.confirm(
        "当前 Run 还有正在执行的任务。是否明确放弃这些任务并开始新的 Run？\n\n"
        + "放弃不等于取消远端调用，供应商任务仍可能继续并产生费用。"
      );
      if (!confirmed) throw new Error("已保留当前任务，未创建新的 Run。");
      await abandonProductionTasks(active);
    }
    if (!task) {
      // 即使 Analyze 在首个 Artifact 落盘前就被 Node 重启打断，也必须继续原 Run；
      // 是否从第几阶段开始只由服务端 current Artifact 链决定。显式 abandon 会先
      // 清空 state.production，因此不会误复用已经放弃的 Run。
      const continuingInterruptedRun = Boolean(
        state.production.projectId
        && state.production.runId
        && !state.output.themeVariants
      );
      const resumeNeedsMedia = !continuingInterruptedRun || [
        "referenceAnalysis",
        "sourceScriptReconstruction",
        "visualGuardrails"
      ].some((artifactId) => state.production.artifacts?.[artifactId]?.status !== "current");
      if (resumeNeedsMedia && state.frames.length < 3) {
        throw new Error("请重新上传当前 Run 的同一源视频；服务端会先校验 SHA-256，再从首个未完成阶段继续。");
      }
      if (!continuingInterruptedRun) resetDirectorClientState();
      resetPipeline();
      [elements.analysis, elements.script, elements.brief, elements.guardrails, elements.variants]
        .forEach((element) => { element.innerHTML = ""; element.classList.add("hidden"); });
      if (continuingInterruptedRun) renderRestoredDirectorArtifacts();
      const media = analysisMediaSettings();
      if (!state.videoDataUrl && state.file && state.mode !== "demo" && media.mediaMode !== "frames"
        && state.file.size <= media.nativeVideoMaxBytes) {
        const videoDataUrl = await readFileAsDataUrl(state.file);
        assertWorkspaceCurrent(workspaceEpoch);
        state.videoDataUrl = videoDataUrl;
      }
      if (state.mode !== "demo" && media.mediaMode === "video" && state.file?.size > media.nativeVideoMaxBytes) {
        throw new Error(`当前强制使用原生视频，文件不能超过 ${formatBytes(media.nativeVideoMaxBytes)}。`);
      }
      const canSendNativeVideo = Boolean(state.videoDataUrl)
        && state.mode !== "demo"
        && media.mediaMode !== "frames"
        && state.file?.size <= media.nativeVideoMaxBytes;
      const sourceVideoDigest = await sourceFileSha256(state.file);
      assertWorkspaceCurrent(workspaceEpoch);
      const shared = withModelOverrides({
        frames: state.frames,
        ...(canSendNativeVideo ? { video: { dataUrl: state.videoDataUrl, mimeType: state.file.type, size: state.file.size } } : {}),
        metadata: state.metadata,
        transcript: elements.transcript.value.trim(),
        creatorProfile,
        count: Number(elements.variantCount.value),
        // 候选阶段的时长目标必须从这里就带上。§2.10 写着「浏览器请求体、server.js 入口校验、
        // Durable buildInput 白名单三处缺一不可」，而实际漏的正是这一处：白名单读的是
        // raw.targetDurationSeconds，一键 AI 导演送进 directorPipeline 的 shared 里却没有这个键，
        // 于是 variantsPrompt 取不到目标、durationRule 整段省略——**静默降级**。只有手动点
        //「换一批」那条路送到了，所以现象是「换一批有效、一键跑无效」。
        //
        // 实测代价（2026-09-09 六份真实导出包）：五个带 lineage 的 run 全部生成于 09-05 修复之后，
        // 候选 estimatedSeconds 合计 20/20 落在窗口外——原片 33 秒的写成 56-60 秒、原片 122 秒的
        // 写成 60-90 秒；唯一 4/4 落在窗口内的那份，四个候选精确等于窗口下界。而下游 Full Story
        // 6/6 命中 Math.round(原片时长)，于是候选估的 60 秒要么被压进 33 秒、要么被摊到 122 秒，
        // 正是 docs/待解决项.md 第 1 条「单场动作过载」的上游。
        targetDurationSeconds: resolveStoryDurationTarget(state.storyDurationTarget, {
          metadata: state.metadata,
          sourceScriptReconstruction: state.output.sourceScriptReconstruction
        }),
        sourceVideoDigest
      });
      if (!continuingInterruptedRun) {
        const productionRun = await api("/api/production/run/start", {
          ...browserWorkspace.reference(),
          metadata: {
            sourceVideo: state.metadata,
            sourceVideoDigest,
            creatorProfile,
            transcript: shared.transcript
          }
        });
        state.production = productionStateFromRun(productionRun);
        persistActiveProductionRun();
      }
      assertWorkspaceCurrent(workspaceEpoch);
      const created = await createDurableTask("directorPipeline", shared);
      task = created.task;
    }
    const completedTask = await waitForDurableTask(task, updateDirectorTaskProgress);
    recordStageUsage(completedTask.usage);
    await directorArtifactSynchronizer.sync(completedTask);
    assertWorkspaceCurrent(workspaceEpoch);
    renderDirectorTaskStatus(completedTask);
    elements.export.classList.remove("hidden");
    elements.variants.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    if (!browserWorkspace.isCurrent(workspaceEpoch)) return;
    if (isTaskCapacityError(error)) {
      showError(taskCapacityMessage(error), "notice");
      return;
    }
    renderDirectorTaskError(error, "工作流执行失败");
  } finally {
    if (!browserWorkspace.isCurrent(workspaceEpoch)) return;
    state.running = false;
    setRunning(false);
    validateReady();
  }
}

// ---------------------------------------------------------------------------
// 参考片仿写（2026-10-24）
//
// 在参考视频入口里点「参考片仿写」：服务端在本机抽帧、去配乐、转写，再让模型写「原片拆解＋四篇剧本」，
// 提交 Artifact referenceRewrite。选中的一稿填进「从剧情开始 · 粘贴完整故事」，用户看过再点「开始拆镜头」。
// 切过去时当前 Run（含四稿）会被删掉；四稿另复制一份在页面内存里，刷新即清，不进任何浏览器存储。

function referenceRewriteReadiness() {
  if (isStoryEntryMode()) return { ready: false, reason: "" };
  if (sourceLoading || !browserWorkspace.workspace) return { ready: false, reason: "页面还在恢复上一次的进度。" };
  if (state.referenceRewriteRunning) return { ready: false, reason: "参考片仿写正在进行。" };
  const health = state.referenceRewriteHealth || {};
  if (!health.available) return { ready: false, reason: health.reason || "参考片仿写现在用不了。" };
  const setting = effectiveStageSetting(REFERENCE_REWRITE_STAGE);
  if (state.mode !== "demo" && !REFERENCE_REWRITE_PROVIDERS.includes(setting.provider)) {
    return { ready: false, reason: `参考片仿写只能用 ${REFERENCE_REWRITE_PROVIDERS.join(" 或 ")}，请在模型设置里改回来。` };
  }
  if (state.mode !== "demo" && !state.providers?.[setting.provider]?.configured) {
    return { ready: false, reason: `参考片仿写用的是 ${setting.provider}，但服务端没有配置它。` };
  }
  if (!state.file || state.frames.length < 3) {
    return { ready: false, reason: state.production.runId ? "要在这个 Run 上仿写，需要重新上传同一个参考视频。" : "先上传参考视频。" };
  }
  if (!elements.fixedCharacter.value.trim() || !elements.vertical.value.trim()) return { ready: false, reason: "先在左边填好固定角色和垂直赛道。" };
  return { ready: true, reason: "" };
}

function renderReferenceRewriteControls() {
  if (!elements.runReferenceRewrite) return;
  const readiness = referenceRewriteReadiness();
  elements.runReferenceRewrite.disabled = !readiness.ready;
  const setting = effectiveStageSetting(REFERENCE_REWRITE_STAGE);
  const health = state.referenceRewriteHealth || {};
  elements.referenceRewriteHint.textContent = health.available && readiness.ready
    ? referenceRewriteHint({ available: true, demo: state.mode === "demo", provider: setting.provider, model: setting.model })
    : readiness.reason || referenceRewriteHint(health);
}

function setReferenceRewriteStatus(text, tone = "") {
  state.referenceRewriteStatus = { text, tone };
  renderReferenceRewritePanel();
}

function renderReferenceRewritePanel() {
  if (!elements.referenceRewriteSection) return;
  const result = state.referenceRewrite;
  const status = state.referenceRewriteStatus || {};
  const visible = Boolean(result || state.referenceRewriteRunning || status.text);
  elements.referenceRewriteSection.classList.toggle("hidden", !visible);
  elements.referenceRewriteStatus.textContent = status.text || "";
  elements.referenceRewriteStatus.classList.toggle("error", status.tone === "error");
  elements.referenceRewriteResult.innerHTML = result ? referenceRewriteResultHtml(result, { escape }) : "";
}

function renderReferenceRewritePicker() {
  if (!elements.referenceRewritePicker) return;
  const drafts = state.referenceRewriteDrafts?.drafts;
  const visible = Boolean(drafts?.length && isStoryEntryMode() && state.storyMode === STORY_MODE_FULL_TEXT && !state.production.runId);
  elements.referenceRewritePicker.classList.toggle("hidden", !visible);
  elements.referenceRewritePicker.innerHTML = visible
    ? referenceRewriteDraftPickerHtml(drafts, { escape, currentText: elements.storySourceText.value })
    : "";
}

// 没有 Run 时照「启动 AI 导演」的写法先建一个参考视频 Run；之后点 AI 导演会接着用这个 Run。
async function ensureVideoProductionRun(workspaceEpoch) {
  if (state.production.projectId && state.production.runId) return;
  const sourceVideoDigest = await sourceFileSha256(state.file);
  assertWorkspaceCurrent(workspaceEpoch);
  const productionRun = await api("/api/production/run/start", {
    ...browserWorkspace.reference(),
    metadata: {
      sourceVideo: state.metadata,
      sourceVideoDigest,
      creatorProfile: profile(),
      transcript: elements.transcript.value.trim()
    }
  });
  assertWorkspaceCurrent(workspaceEpoch);
  state.production = productionStateFromRun(productionRun);
  persistActiveProductionRun();
}

async function runReferenceRewrite() {
  const readiness = referenceRewriteReadiness();
  if (!readiness.ready) { if (readiness.reason) showError(readiness.reason); return; }
  const setting = effectiveStageSetting(REFERENCE_REWRITE_STAGE);
  const hint = referenceRewriteHint({ available: true, demo: state.mode === "demo", provider: setting.provider, model: setting.model });
  const confirmed = window.confirm(`${hint}\n\n会先在本机抽帧、去配乐、转写（几分钟），再调用模型写稿。继续吗？`);
  if (!confirmed) return;
  const workspaceEpoch = browserWorkspace.epoch;
  state.referenceRewriteRunning = true;
  showError("");
  setReferenceRewriteStatus("正在建任务…");
  renderReferenceRewriteControls();
  elements.referenceRewriteSection.scrollIntoView({ behavior: "smooth", block: "start" });
  try {
    await ensureVideoProductionRun(workspaceEpoch);
    const created = await createDurableTask(REFERENCE_REWRITE_TASK_KIND, withModelOverrides({
      targetDurationSeconds: resolveStoryDurationTarget(state.storyDurationTarget, {
        metadata: state.metadata,
        sourceScriptReconstruction: state.output.sourceScriptReconstruction
      })
    }));
    await finishReferenceRewriteTask(created.task, workspaceEpoch);
  } catch (error) {
    if (!browserWorkspace.isCurrent(workspaceEpoch)) return;
    setReferenceRewriteStatus(isTaskCapacityError(error) ? taskCapacityMessage(error) : `参考片仿写没有完成：${error.message || "未知错误"}`, "error");
  } finally {
    if (browserWorkspace.isCurrent(workspaceEpoch)) {
      state.referenceRewriteRunning = false;
      renderReferenceRewriteControls();
    }
  }
}

// 新建与刷新后重新接管共用：等任务结束、读回 Run、显示四稿。
async function finishReferenceRewriteTask(task, workspaceEpoch = browserWorkspace.epoch) {
  const completed = await waitForDurableTask(task, (current) => setReferenceRewriteStatus(referenceRewriteProgressText(current)));
  assertWorkspaceCurrent(workspaceEpoch);
  recordStageUsage(completed.usage);
  await reloadActiveProductionRun(state.production, { preserveSelectedVariant: true });
  setReferenceRewriteStatus(`四稿写好了${formatStageUsageSuffix(completed.usage)}。挑一稿点「用这一稿开拍」。`);
}

async function useReferenceRewriteDraft(index) {
  const result = state.referenceRewrite;
  const draft = result?.drafts?.[index];
  if (!draft || state.running || state.referenceRewriteRunning) return;
  const confirmed = window.confirm(
    `用「${draft.title}」开拍：会切到「从剧情开始 · 粘贴完整故事」，把这一稿填进输入框，你看过、改好再点「开始拆镜头」。\n\n`
    + "切过去时服务端会删掉当前 Run（包括这四稿），参考视频副本会在开始拆镜头时删掉。"
    + "四稿会在这个页面里留到刷新为止，要长期留着请先点「下载四稿」。继续吗？"
  );
  if (!confirmed) return;
  const drafts = structuredClone(result.drafts);
  const videoTitle = String(state.metadata?.name || "");
  if (state.production.runId && !await invalidateGlobalCharacterBoundary("已切到「从剧情开始」，原来的参考视频 Run 已清空。")) return;
  state.referenceRewriteDrafts = { drafts, videoTitle, original: structuredClone(result.original) };
  state.referenceRewrite = null;
  state.referenceRewriteStatus = { text: "", tone: "" };
  state.entryMode = STORY_ENTRY_MODE;
  state.storyMode = STORY_MODE_FULL_TEXT;
  elements.storySourceText.value = referenceRewriteDraftStoryText(draft);
  applyEntryModeUi();
  renderReferenceRewritePanel();
  validateReady();
  elements.storySourceText.scrollIntoView({ behavior: "smooth", block: "center" });
}

function fillReferenceRewriteDraft(index) {
  const drafts = state.referenceRewriteDrafts?.drafts;
  const draft = drafts?.[index];
  if (!draft || state.production.runId) return;
  if (!referenceRewriteTextIsDraft(drafts, elements.storySourceText.value)
    && !window.confirm("输入框里的字改过了，换成这一稿会覆盖你的修改。继续吗？")) return;
  elements.storySourceText.value = referenceRewriteDraftStoryText(draft);
  updateStorySourceCounter();
  renderReferenceRewritePicker();
  validateReady();
}

function downloadReferenceRewrite() {
  const result = state.referenceRewrite;
  if (!result) return;
  const videoTitle = String(state.metadata?.name || "").replace(/\.[A-Za-z0-9]{1,5}$/u, "");
  const blob = new Blob([referenceRewriteMarkdown(result, { videoTitle })], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `参考片仿写-${(videoTitle || "四稿").slice(0, 40).replace(/[\\/:*?"<>|]/gu, "_")}.md`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------------
// 「从剧情开始」（2026-10-09）
//
// 没有参考视频：服务端先建一个剧情 Run 并写入 storySource，再跑两步。
// - 只给角色设定：角色边界 → 单个故事候选，最后由服务端签发选中记录 variant:V1；
// - 粘贴完整故事：角色边界 → 可翻拍镜头（原文直接拆场，fullStory:V1），没有候选这一步，
//   V1 是「故事位」。
// 之后的 4.0 分镜、角色参考图和镜头视频沿用原有页面与任务，只是请求体不带参考视频那三份上游。
// 故事原文只存在服务端的 storySource 里。

function isStoryEntryMode() {
  return state.entryMode === STORY_ENTRY_MODE;
}

// 「粘贴完整故事」的剧情 Run：没有故事候选，原文直接拆成可翻拍镜头。
function isStorySourceRun() {
  return isStoryEntryMode() && state.storyMode === STORY_MODE_FULL_TEXT;
}

// 故事位：只在页面内部代替「选中的候选」，让只认 id 的地方照常工作。它不是候选，
// 从不当成候选发给服务端（见 candidateCopy）。
function storySourceSlot() {
  return {
    id: STORY_ENTRY_VARIANT_ID,
    title: state.fullStories[STORY_ENTRY_VARIANT_ID]?.title || "你的故事",
    storySourceSlot: true
  };
}

// 请求体里的候选副本：故事位只发 variantId；其余照旧发候选，由服务端逐字核对。
function candidateCopy(variant, key = "variant") {
  return variant?.storySourceSlot ? { variantId: variant.id } : { [key]: variant };
}

// 页面叫法：剧情入口的 4.0 计划叫「分镜」，粘贴完整故事的 fullStory 叫「可翻拍镜头」；
// 参考视频入口的文字一律不变。
function planLabel() { return isStoryEntryMode() ? "分镜" : "动画镜头生产包"; }
function planShortLabel() { return isStoryEntryMode() ? "分镜" : "动画生产包"; }
function fullStoryLabel() { return isStorySourceRun() ? "可翻拍镜头" : "完整剧情"; }

function storyPipelineLabels() {
  return isStorySourceRun()
    ? { start: "开始拆镜头", queued: "拆镜头排队中…", running: "拆镜头中…", continue: "继续拆镜头", restart: "重新开始拆镜头", failed: "拆镜头失败", interrupted: "拆镜头未能继续", noun: "拆镜头" }
    : { start: "开始剧情准备", queued: "剧情准备排队中…", running: "剧情准备中…", continue: "继续剧情准备", restart: "重新开始剧情准备", failed: "剧情准备失败", interrupted: "剧情准备未能继续", noun: "剧情准备" };
}

// 剧情准备走完的标志：粘贴完整故事是可翻拍镜头，只给角色设定是服务端签发的选中记录。
function storyPipelineDoneArtifactId() {
  return isStorySourceRun() ? `fullStory:${STORY_ENTRY_VARIANT_ID}` : `variant:${STORY_ENTRY_VARIANT_ID}`;
}

// 任务状态里的叫法：剧情入口的 animationPlan 叫「分镜」、storyPipeline 叫「拆镜头 / 剧情准备」；
// 其余返回空串，沿用 task-status-ui.js 的默认叫法。
function storyEntryTaskKindLabel(kind) {
  if (!isStoryEntryMode()) return "";
  if (kind === "animationPlan") return planShortLabel();
  if (kind === "storyPipeline") return storyPipelineLabels().noun;
  return "";
}

// 参考视频那三份上游的浏览器副本。剧情 Run 没有它们，请求体里整个键都不能出现
// （null 也不行：服务端会把出现的键当成副本去核对）。
function videoUpstreamCopies() {
  if (isStoryEntryMode()) return {};
  return {
    referenceAnalysis: state.output.referenceAnalysis,
    sourceScriptReconstruction: state.output.sourceScriptReconstruction,
    creativeBrief: state.output.creativeBrief
  };
}

function currentStorySourceDraft() {
  return state.storyMode === STORY_MODE_FULL_TEXT
    ? { storyMode: STORY_MODE_FULL_TEXT, storyText: elements.storySourceText.value }
    : { storyMode: STORY_MODE_CHARACTER_ONLY };
}

function updateStorySourceCounter() {
  const length = storyTextLength(normalizeStoryText(elements.storySourceText.value));
  elements.storySourceCounter.textContent = `${length} / ${STORY_SOURCE_TEXT_MAX_CHARS}`;
  elements.storySourceCounter.classList.toggle("over-limit", length > STORY_SOURCE_TEXT_MAX_CHARS);
}

function applyEntryModeUi() {
  const storyEntry = isStoryEntryMode();
  document.body.classList.toggle("story-entry-mode", storyEntry);
  document.body.classList.toggle("story-source-mode", isStorySourceRun());
  elements.entryModeStory.checked = storyEntry;
  elements.entryModeVideo.checked = !storyEntry;
  elements.storyModeFullText.checked = state.storyMode === STORY_MODE_FULL_TEXT;
  elements.storyModeCharacterOnly.checked = state.storyMode === STORY_MODE_CHARACTER_ONLY;
  elements.storySourceField.classList.toggle("hidden", state.storyMode !== STORY_MODE_FULL_TEXT);
  updateStorySourceCounter();
  renderStoryDurationOptions();
  renderDirectorControls();
  renderReferenceRewritePicker();
}

// 切换入口会作废当前 Run：两种 Run 的上游完全不同，不能混在一页里。
async function handleEntryModeChange(mode) {
  const next = mode === STORY_ENTRY_MODE ? STORY_ENTRY_MODE : "video";
  if (next === state.entryMode) return;
  if (state.running) { applyEntryModeUi(); return; }
  if (state.production.runId) {
    const confirmed = window.confirm("切换入口会清空当前页面的生成结果（服务端会删除当前 Run）。继续吗？");
    if (!confirmed || !await invalidateGlobalCharacterBoundary("已切换入口，原来的生成结果已清空。")) {
      applyEntryModeUi();
      return;
    }
  }
  state.entryMode = next;
  applyEntryModeUi();
  validateReady();
}

async function handleStoryModeChange(mode) {
  const next = mode === STORY_MODE_CHARACTER_ONLY ? STORY_MODE_CHARACTER_ONLY : STORY_MODE_FULL_TEXT;
  if (next === state.storyMode) return;
  const previous = state.storyMode;
  state.storyMode = next;
  applyEntryModeUi();
  // 两种模式的 Run 结构不同（有没有候选）：没能作废旧 Run 时，模式也要退回去，不能和 Run 对不上。
  if (await invalidateIfStorySourceChanged() === false) {
    state.storyMode = previous;
    applyEntryModeUi();
  }
  validateReady();
}

async function handleStorySourceInput() {
  updateStorySourceCounter();
  renderReferenceRewritePicker();
  await invalidateIfStorySourceChanged();
  validateReady();
}

// 剧情 Run 已经按开始时的原文签过角色边界；原文或模式一改，就和固定角色设定被修改一样作废 Run。
// 返回值：没有需要作废的 Run 时是 undefined，否则是作废是否成功。
async function invalidateIfStorySourceChanged() {
  if (!isStoryEntryMode() || !state.production.runId || !state.output.storySource || state.running) return undefined;
  let draft = null;
  try { draft = normalizeStorySource(currentStorySourceDraft()); } catch { draft = null; }
  if (draft && JSON.stringify(draft) === JSON.stringify(state.output.storySource)) return undefined;
  return invalidateGlobalCharacterBoundary("故事原文或剧情模式已修改；当前剧情 Run 已失效，请重新开始。");
}

function storyEntryRunLabel(task) {
  const labels = storyPipelineLabels();
  if (isActiveTask(task)) return task.status === "queued" ? labels.queued : labels.running;
  if (state.running) return "正在开始…";
  if (!state.production.runId || !state.output.storySource) return labels.start;
  return state.production.artifacts?.[storyPipelineDoneArtifactId()]?.status === "current"
    ? labels.restart
    : labels.continue;
}

// 同一个剧情 Run 停在半路（可翻拍镜头或选中记录还没出来）、原文也没改时继续它；否则开新的剧情 Run。
// runStoryEntryWorkflow 与导演助手共用这一处判断。
function storyEntryContinuing(storySource) {
  return Boolean(state.production.runId && state.output.storySource
    && JSON.stringify(state.output.storySource) === JSON.stringify(storySource)
    && state.production.artifacts?.[storyPipelineDoneArtifactId()]?.status !== "current");
}

async function runStoryEntryWorkflow() {
  let workspaceEpoch = browserWorkspace.epoch;
  if (state.running || sourceLoading || !browserWorkspace.workspace) return;
  const creatorProfile = profile();
  if (!creatorProfile.fixedCharacter || !creatorProfile.vertical) return showError("请填写固定角色和垂直赛道。");
  let storySource;
  try {
    storySource = normalizeStorySource(currentStorySourceDraft());
  } catch (error) {
    return showError(error.message);
  }
  state.running = true;
  state.directorTaskId = "";
  showError("");
  setRunning(true);
  try {
    const active = await activeProductionTasks();
    let task = active.find((item) => item.kind === "storyPipeline") || null;
    if (!task && active.length) {
      const confirmed = window.confirm(
        "当前 Run 还有正在执行的任务。是否明确放弃这些任务并开始新的剧情 Run？\n\n"
        + "放弃不等于取消远端调用，供应商任务仍可能继续并产生费用。"
      );
      if (!confirmed) throw new Error("已保留当前任务，未开始新的剧情 Run。");
      await abandonProductionTasks(active);
    }
    if (!task) {
      const continuing = storyEntryContinuing(storySource);
      if (!continuing) {
        if (state.file || state.production.runId) {
          const confirmed = window.confirm(`${storyPipelineLabels().start}会清空当前页面已上传的视频和已有的生成结果。继续吗？`);
          if (!confirmed) throw new Error("已保留当前页面内容，没有开始新的剧情 Run。");
        }
        const started = await startStoryEntryRun(creatorProfile, storySource, workspaceEpoch);
        if (!started) return;
        workspaceEpoch = started.epoch;
      }
      elements.empty.classList.add("hidden");
      elements.resultStack.classList.remove("hidden");
      assertWorkspaceCurrent(workspaceEpoch);
      const created = await createDurableTask("storyPipeline", withModelOverrides({
        creatorProfile,
        targetDurationSeconds: resolveStoryDurationTarget(state.storyDurationTarget, { entryMode: STORY_ENTRY_MODE })
      }));
      task = created.task;
    }
    state.directorTaskId = task.taskId;
    const completed = await waitForDurableTask(task, renderStoryPipelineTaskStatus);
    recordStageUsage(completed.usage);
    await reloadActiveProductionRun();
    assertWorkspaceCurrent(workspaceEpoch);
    renderStoryPipelineTaskStatus(completed);
    elements.export.classList.remove("hidden");
    // 粘贴完整故事：拆好就直接进分场页给用户看；只给角色设定：先看首页的故事候选。
    if (isStorySourceRun() && state.fullStories[STORY_ENTRY_VARIANT_ID]) navigateToStory(STORY_ENTRY_VARIANT_ID);
    else elements.variants.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    if (!browserWorkspace.isCurrent(workspaceEpoch)) return;
    if (isTaskCapacityError(error)) {
      showError(taskCapacityMessage(error), "notice");
      return;
    }
    if (error.task) renderStoryPipelineTaskStatus(error.task);
    showError(error.message || storyPipelineLabels().failed, error.task && error.task.status !== "failed" ? "notice" : "error");
  } finally {
    if (browserWorkspace.isCurrent(workspaceEpoch)) {
      state.running = false;
      setRunning(false);
      validateReady();
    }
  }
}

// 建剧情 Run。服务端在建之前会清空本页的视频和旧 Run，所以成功后页面也换成新的生命周期。
// 故事里找不到固定角色的名字时，服务端先拒绝并说明原因；用户确认后再带着确认重发一次。
async function startStoryEntryRun(creatorProfile, storySource, workspaceEpoch) {
  const send = (acknowledgeProtagonistName) => browserWorkspace.startStoryRun({
    metadata: { creatorProfile },
    storySource,
    ...(acknowledgeProtagonistName ? { acknowledgeProtagonistName: true } : {})
  }, workspaceEpoch);
  let started;
  try {
    started = await send(false);
  } catch (error) {
    if (error.code !== "STORY_ENTRY_PROTAGONIST_NAME_MISSING") throw error;
    if (!window.confirm(`${error.message}\n\n确定这样继续吗？`)) {
      throw new Error("没有开始：可以在故事里写上固定角色的名字，或者把固定角色改成故事主角。");
    }
    started = await send(true);
  }
  if (!started) return null;
  const epoch = browserWorkspace.beginChange();
  clearVideoWorkspaceUi();
  sourceLoading = false;
  state.running = true;
  setRunning(true);
  state.production = productionStateFromRun({
    projectId: started.production.projectId,
    runId: started.production.runId,
    lineageSchemaVersion: started.production.lineageSchemaVersion
  });
  persistActiveProductionRun();
  await reloadActiveProductionRun();
  assertWorkspaceCurrent(epoch);
  return { epoch };
}

function renderStoryPipelineTaskStatus(task) {
  task = state.taskSnapshots[task.taskId] || task;
  state.directorTaskId = task.taskId;
  const order = ["guardrails", "variants"];
  // 第二步在页面上占同一格：只给角色设定是故事候选，粘贴完整故事是可翻拍镜头。
  const artifactToStage = {
    visualGuardrails: "guardrails",
    themeVariants: "variants",
    [`fullStory:${STORY_ENTRY_VARIANT_ID}`]: "variants"
  };
  const view = storyPipelineTaskView(task);
  const completed = task.status === "completed" ? order.length : Number(task.progress?.completedStages) || 0;
  order.forEach((stage, index) => setStage(stage, index < completed ? "done" : ""));
  const current = artifactToStage[String(task.progress?.currentStage || "")];
  if (current && order.indexOf(current) >= completed) setStage(current, view.stageStatus);
  renderDirectorControls(task);
}

async function attachRestoredStoryPipeline(task) {
  const workspaceEpoch = browserWorkspace.epoch;
  try {
    const completed = await waitForDurableTask(task, renderStoryPipelineTaskStatus);
    await reloadActiveProductionRun();
    assertWorkspaceCurrent(workspaceEpoch);
    renderStoryPipelineTaskStatus(completed);
  } catch (error) {
    if (!browserWorkspace.isCurrent(workspaceEpoch)) return;
    if (error.task) renderStoryPipelineTaskStatus(error.task);
    showError(error.message || storyPipelineLabels().interrupted, "notice");
  } finally {
    if (browserWorkspace.isCurrent(workspaceEpoch)) {
      state.running = false;
      setRunning(false);
      validateReady();
    }
  }
}

// 「粘贴完整故事」的台词核对：服务端现算现给，只提示、不拦截、不落盘。
let storyDialogueCheckRequest = 0;
async function refreshStoryDialogueCheck() {
  const panel = elements.storyDialogueCheck;
  const variant = selectedVariant();
  const applicable = isStoryEntryMode()
    && state.output.storySource?.storyMode === STORY_MODE_FULL_TEXT
    && variant && state.production.runId && state.fullStories[variant.id];
  const requestId = ++storyDialogueCheckRequest;
  if (!applicable) {
    panel.classList.add("hidden");
    panel.innerHTML = "";
    return;
  }
  try {
    const report = await api("/api/production/story-entry/dialogue-check", {
      projectId: state.production.projectId,
      runId: state.production.runId,
      variantId: variant.id
    });
    if (requestId !== storyDialogueCheckRequest) return;
    renderStoryDialogueCheck(report);
  } catch (error) {
    if (requestId !== storyDialogueCheckRequest) return;
    panel.className = "result-card story-result story-dialogue-check warn";
    panel.innerHTML = `<p>台词核对暂时不可用：${escape(error.message || "请求失败")}</p>`;
  }
}

function renderStoryDialogueCheck(report) {
  const panel = elements.storyDialogueCheck;
  if (!report?.applicable) {
    panel.classList.add("hidden");
    panel.innerHTML = "";
    return;
  }
  const missing = Array.isArray(report.missing) ? report.missing : [];
  // 台词核对只在粘贴完整故事的 Run 上出现，那里 fullStory 叫「可翻拍镜头」。
  const where = (item) => (item.artifact === "animationPlan" ? `分镜 ${item.location}` : `可翻拍镜头 ${item.location}`);
  panel.className = `result-card story-result story-dialogue-check${missing.length ? " warn" : ""}`;
  panel.innerHTML = missing.length
    ? `<h3>台词核对：${missing.length} 句在原文里找不到</h3>
      <p>只是提示，不拦截。这些台词可能被改写或新增了；需要的话可以重新拆分镜头或重新生成分镜。比对时忽略标点和空格。</p>
      <ul>${missing.map((item) => `<li><span>${escape(where(item))}</span> · ${escape(item.speaker || "未标注")}：${escape(item.text)}</li>`).join("")}</ul>`
    : `<h3>台词核对：${escape(report.checked)} 句台词都能在原文里找到</h3>
      <p>可翻拍镜头${state.output.animationPlan ? "和分镜" : ""}里的台词去掉标点后都与原文一致。</p>`;
}

async function requestProductionArtifact({
  endpoint,
  requestBody,
  artifactId,
  artifactType: _artifactType,
  dependencyIds: _dependencyIds = [],
  dependencyRefs: _dependencyRefs = null,
  createMediaNamespace: _createMediaNamespace = false,
  contentForArtifact: _contentForArtifact = (value) => value,
  onTaskCreated = null
}) {
  assertActiveProductionRun();
  const kind = durableTaskKindForEndpoint(endpoint);
  const input = withModelOverrides({
    ...requestBody,
    ...(requestBody?.variant?.id ? { variantId: requestBody.variant.id } : {}),
    ...(artifactId.startsWith("fullStory:") || artifactId.startsWith("animationPlan:")
      ? { variantId: artifactId.split(":").slice(1).join(":") }
      : {})
  });
  const created = await createDurableTask(kind, input);
  if (onTaskCreated) onTaskCreated(created.task);
  const task = await waitForDurableTask(created.task);
  state.productionTasks ||= {};
  state.productionTasks[artifactId] = task;
  recordStageUsage(task.usage);
  const run = await reloadActiveProductionRun(state.production, { preserveSelectedVariant: kind === "fullStory" });
  const entry = run.latestArtifacts?.[artifactId];
  if (!entry?.lineage || entry.lineage.status !== "current") {
    throw new Error(`任务完成后没有找到 current Artifact：${artifactId}`);
  }
  return entry.content;
}

function durableTaskKindForEndpoint(endpoint) {
  const kinds = {
    "/api/variants": "variants",
    "/api/full-story": "fullStory",
    "/api/animation-plan": "animationPlan"
  };
  const kind = kinds[endpoint];
  if (!kind) throw new Error(`该操作尚未接入 Durable Task：${endpoint}`);
  return kind;
}

async function createDurableTask(kind, input) {
  return api("/api/tasks/create", {
    projectId: state.production.projectId,
    runId: state.production.runId,
    kind,
    input
  });
}

async function readDurableTask(taskId) {
  const workspaceEpoch = browserWorkspace.epoch;
  const query = new URLSearchParams({
    projectId: state.production.projectId,
    runId: state.production.runId
  });
  const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}?${query}`);
  const data = await response.json().catch(() => ({}));
  assertWorkspaceCurrent(workspaceEpoch);
  if (!response.ok || !data.ok) throw createApiRequestError(data, response.status, `任务查询失败（${response.status}）`);
  return data.task || data.result;
}

async function waitForDurableTask(initialTask, onProgress = null) {
  const workspaceEpoch = browserWorkspace.epoch;
  let task = initialTask;
  while (["queued", "running"].includes(task.status)) {
    assertWorkspaceCurrent(workspaceEpoch);
    updateTaskSnapshot(task);
    if (onProgress) await onProgress(task);
    await new Promise((resolve) => window.setTimeout(resolve, 1500));
    assertWorkspaceCurrent(workspaceEpoch);
    task = await readDurableTask(task.taskId);
    assertWorkspaceCurrent(workspaceEpoch);
  }
  assertWorkspaceCurrent(workspaceEpoch);
  updateTaskSnapshot(task);
  if (onProgress) await onProgress(task);
  assertWorkspaceCurrent(workspaceEpoch);
  if (task.status !== "completed") {
    const error = new Error(taskErrorMessage(task, `任务以 ${task.status} 结束`));
    error.code = task.error?.code || `TASK_${String(task.status || "failed").toUpperCase()}`;
    error.category = task.error?.category || "task";
    error.details = task.error?.details || [];
    error.task = task;
    throw error;
  }
  return task;
}

async function activeProductionTasks() {
  const workspaceEpoch = browserWorkspace.epoch;
  if (!state.production.projectId || !state.production.runId) return [];
  const query = new URLSearchParams({
    projectId: state.production.projectId,
    runId: state.production.runId,
    active: "1"
  });
  const response = await fetch(`/api/tasks?${query}`);
  const data = await response.json().catch(() => ({}));
  assertWorkspaceCurrent(workspaceEpoch);
  if (!response.ok || !data.ok) {
    throw createApiRequestError(data, response.status, `任务列表读取失败（${response.status}）`);
  }
  return Array.isArray(data.tasks) ? data.tasks : Array.isArray(data.result) ? data.result : [];
}

function isTaskCapacityError(error) {
  return error?.code === "TASK_CAPACITY_EXCEEDED" || Number(error?.status) === 429;
}

function taskCapacityMessage(error) {
  return error?.message || "服务器任务队列已满，请稍后重试。";
}

async function abandonProductionTasks(tasks) {
  const released = [];
  for (const task of tasks.filter((item) => !item.parentTaskId)) {
    const terminal = await api(`/api/tasks/${encodeURIComponent(task.taskId)}/release`, {
      projectId: task.projectId,
      runId: task.runId
    });
    if (["queued", "running"].includes(terminal?.status)) {
      throw new Error(`任务 ${task.taskId} 尚未释放，已阻止创建新 Run。`);
    }
    released.push(terminal);
  }
  return released;
}

async function reloadActiveProductionRun(expectedProduction = state.production, { preserveSelectedVariant = false } = {}) {
  const projectId = String(expectedProduction?.projectId || "");
  const runId = String(expectedProduction?.runId || "");
  if (!projectId || !runId) throw new Error("当前没有可重新加载的 Production Run");
  const run = await api("/api/production/run/load", {
    projectId,
    runId,
    includeContent: true
  });
  if (state.production.projectId !== projectId || state.production.runId !== runId) {
    const error = new Error("Production Run 已切换，已忽略旧任务的迟到同步结果");
    error.code = "DIRECTOR_RUN_SYNC_STALE";
    throw error;
  }
  state.production = productionStateFromRun(run);
  restoreRunArtifacts(run.latestArtifacts || {}, { selectedVariantId: preserveSelectedVariant ? state.selectedVariantId : null });
  persistActiveProductionRun();
  scheduleDirectorAgentRefresh();
  return run;
}

async function updateDirectorTaskProgress(task) {
  // Loading newly committed Artifacts re-renders the stage list. Apply the
  // task snapshot afterwards so that render cannot reset the active stage.
  await directorArtifactSynchronizer.sync(task);
  renderDirectorTaskStatus(task);
}

function renderDirectorTaskStatus(task) {
  // A control response may be newer than the poll which is still synchronizing
  // completed Artifacts. Always render the accepted snapshot for this task.
  task = state.taskSnapshots[task.taskId] || task;
  state.directorTaskId = task.taskId;
  const artifactToStage = {
    referenceAnalysis: "analysis",
    sourceScriptReconstruction: "script",
    creativeBrief: "brief",
    visualGuardrails: "guardrails",
    themeVariants: "variants"
  };
  const currentArtifact = String(task.progress?.currentStage || "");
  const completedCount = Number(task.progress?.completedStages) || 0;
  const order = ["analysis", "script", "brief", "guardrails", "variants"];
  order.forEach((stage, index) => setStage(stage, index < completedCount ? "done" : ""));
  const view = directorTaskView(task);
  // currentStage can still refer to the stage just committed at a boundary.
  // A pause/stop must not erase its completed presentation.
  if (artifactToStage[currentArtifact] && order.indexOf(artifactToStage[currentArtifact]) >= completedCount) {
    setStage(artifactToStage[currentArtifact], view.stageStatus);
  }
  renderDirectorControls(task);
}

function renderDirectorTaskError(error, fallback) {
  if (error.task) {
    renderDirectorTaskStatus(error.task);
    showError(error.task.status === "cancelled" ? "" : error.message || fallback,
      ["interrupted", "conflicted", "abandoned"].includes(error.task.status) ? "notice" : "error");
    return;
  }
  const active = document.querySelector(".pipeline li.active");
  if (active?.dataset.stage) setStage(active.dataset.stage, "error");
  showError(error.message || fallback);
}

function renderDirectorControls(task = state.taskSnapshots[state.directorTaskId]) {
  const view = directorControlView(task, {
    starting: state.running && !task,
    pendingAction: state.directorControlRequest?.action || ""
  });
  // 剧情入口的两步流水线第一期不支持暂停或终止：只换按钮文字，不显示那两个控制。
  const storyEntry = isStoryEntryMode();
  elements.directorControls.classList.toggle("active", view.visible && !storyEntry);
  elements.run.classList.toggle("running", view.visible);
  elements.run.querySelector("span").textContent = storyEntry ? storyEntryRunLabel(task) : view.label;
  elements.directorStartArrow.classList.toggle("hidden", view.visible);
  elements.directorControlHint.classList.toggle("hidden", !view.visible || storyEntry);
  elements.run.disabled = state.running || isActiveTask(task);
  if (!elements.run.disabled) validateReady();
  for (const button of [elements.terminateDirector, elements.pauseDirector]) button.classList.toggle("hidden", !view.visible || storyEntry);
  elements.terminateDirector.disabled = view.stopDisabled;
  elements.pauseDirector.disabled = view.pauseDisabled;
  elements.pauseDirector.setAttribute("aria-label", view.pauseLabel);
  elements.pauseDirector.setAttribute("title", view.pauseLabel);
  elements.pauseDirector.innerHTML = view.paused
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7Z"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6v12M16 6v12"/></svg>';
}

async function controlDirectorPipeline(action) {
  const task = state.taskSnapshots[state.directorTaskId];
  if (!task || state.directorControlRequest) return;
  const view = directorControlView(task);
  if (action === "terminate" ? view.stopDisabled : view.pauseDisabled || action !== view.pauseAction) return;
  const request = { taskId: task.taskId, action, epoch: browserWorkspace.epoch };
  state.directorControlRequest = request;
  renderDirectorControls(task);
  showError("");
  try {
    const updated = await controlDurableTask(task.taskId, action);
    if (!browserWorkspace.isCurrent(request.epoch) || state.directorTaskId !== request.taskId) return;
    updateTaskSnapshot(updated);
    await updateDirectorTaskProgress(updated);
  } catch (error) {
    if (!browserWorkspace.isCurrent(request.epoch) || state.directorTaskId !== request.taskId) return;
    showError(error.message || "AI 导演控制失败，请重试。");
  } finally {
    if (state.directorControlRequest === request) {
      state.directorControlRequest = null;
      renderDirectorControls();
    }
  }
}

function renderRestoredDirectorArtifacts({ fromStage = 0, toStage = 5 } = {}) {
  const stages = [
    ["referenceAnalysis", "analysis", renderAnalysis],
    ["sourceScriptReconstruction", "script", renderScript],
    ["creativeBrief", "brief", renderBrief],
    ["visualGuardrails", "guardrails", renderVisualGuardrails],
    ["themeVariants", "variants", renderVariants]
  ];
  stages.slice(Math.max(0, fromStage), Math.max(0, toStage)).forEach(([artifactId, stage, render]) => {
    if (!state.output[artifactId]) return;
    render(state.output[artifactId]);
    setStage(stage, "done");
  });
}

function renderedDirectorStageCount() {
  const artifactIds = [
    "referenceAnalysis",
    "sourceScriptReconstruction",
    "creativeBrief",
    "visualGuardrails",
    "themeVariants"
  ];
  let count = 0;
  while (count < artifactIds.length && state.output[artifactIds[count]]) count += 1;
  return count;
}

function resetDirectorClientState() {
  directorArtifactSynchronizer.reset();
  state.output = {};
  state.characterBoundaryProfile = null;
  state.fullStories = {};
  state.animationPlans = {};
  state.animationPlanMetadata = {};
  state.animationAspectRatioDrafts = {};
  state.shotVideoResults = {};
  state.characterReferenceStatuses = {};
  state.characterAudioStatuses = {};
  state.productionTasks = {};
  state.taskSnapshots = {};
  state.directorTaskId = "";
  state.directorControlRequest = null;
  state.production = emptyProductionState();
  state.storyGenerationRequest = null;
  state.storyControlRequests = {};
  state.storyTaskStatusVisible = false;
  localStorage.removeItem(ACTIVE_PRODUCTION_RUN_STORAGE_KEY);
  state.selectedVariantId = null;
  state.referenceRewrite = null;
  state.referenceRewriteRunning = false;
  state.referenceRewriteStatus = { text: "", tone: "" };
  renderReferenceRewritePanel();
  renderReferenceRewritePicker();
  resetStoryPackageStatus();
  scheduleDirectorAgentRefresh();
}

async function sourceFileSha256(file) {
  if (!file || typeof file.arrayBuffer !== "function") return "";
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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
  if (requestToken) assertCurrentProductionRequest(requestToken);
  const dependencies = dependencyRefs ? structuredClone(dependencyRefs) : productionDependencies(dependencyIds);
  const current = await matchingCurrentArtifactLineage(state.production, {
    artifactId,
    content,
    dependencies
  });
  if (current && (!createMediaNamespace || current.mediaNamespace)) return current;
  const ownsToken = !requestToken;
  const token = requestToken || beginArtifactRequest(state.production, artifactId, crypto.randomUUID());
  try {
    assertCurrentProductionRequest(token);
    const committed = await api("/api/production/artifact/commit", {
      ...token,
      artifactType,
      content,
      dependencies,
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
  scheduleDirectorAgentRefresh();
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
      if (String(state.selectedVariantId || "") === variantId) {
        state.characterReferenceStatuses = {};
        state.characterAudioStatuses = {};
      }
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
    } else if (artifactId.startsWith("shotVideo:")) {
      dropStaleMediaResults(state, artifactId);
    }
  }
  state.output.fullStories = state.fullStories;
  state.output.animationPlans = state.animationPlans;
  state.output.animationPlanMetadata = state.animationPlanMetadata;
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
  const workspaceEpoch = browserWorkspace.epoch;
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...productionRequestHeaders(productionToken || {})
    },
    body: JSON.stringify(withModelOverrides(body))
  });
  const data = await response.json().catch(() => ({}));
  assertWorkspaceCurrent(workspaceEpoch);
  // 先记账再判成败：失败响应上的 usage 是失败前真实花掉的钱，抛错前必须收进合计。
  recordStageUsage(data.usage);
  if (!response.ok || !data.ok) {
    throw createApiRequestError(data, response.status, `请求失败（${response.status}）`);
  }
  return data.result;
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

// turningMechanism 2026-09-10 由字符串改成 {before, after}：它写的是**观众对人物关系的理解
// 怎样改变**，混在一个字符串里时读不出哪一半描述哪一端。
//
// 两种形状都要能显示——新校验只在 createBrief 的生成路径跑，下游对 creativeBrief 只做裸
// requireObject，所以已签发的旧简报（字符串）照常加载，页面不能把它显示成空白。
function storyEngineShift(storyEngine) {
  const turning = storyEngine?.turningMechanism;
  if (typeof turning === "string") return turning;
  if (!turning || typeof turning !== "object") return "";
  return [turning.before, turning.after].filter(Boolean).join(" → ");
}

// 换角测试：上面那一排格子写的是这部片子「发生了什么」，这一块写的是
// 「为什么是这个角色做这件事才好看」。collapses 那一侧就是换个人来演就没了的东西。
// 旧简报没有这个键——整块不显示，不留空白（与 storyEngineShift 同一条理由）。
function recastTestBlock(recastTest) {
  const collapses = Array.isArray(recastTest?.collapses) ? recastTest.collapses.filter(Boolean) : [];
  const survives = Array.isArray(recastTest?.survives) ? recastTest.survives.filter(Boolean) : [];
  if (!collapses.length && !survives.length) return "";
  const list = (items, cls) => `<ul class="recast-list ${cls}">${items.map((item) => `<li>${escape(item)}</li>`).join("")}</ul>`;
  return block("换个角色来演，什么会塌掉", `
    <p class="recast-premise"><b>假设换成：</b>${escape(recastTest?.recastAs || "—")}</p>
    <div class="recast-split">
      <div>
        <b>塌掉的 · 只有这个角色才给得了</b>
        ${collapses.length ? list(collapses, "collapses") : "<p class=\"muted-note\">—</p>"}
      </div>
      <div>
        <b>不塌的 · 换谁来做都一样</b>
        ${survives.length ? list(survives, "survives") : "<p class=\"muted-note\">—</p>"}
      </div>
    </div>`);
}

// creative_brief/2.0（2026-09-23）起简报只写原片：storyEngine 与 recastTest。
// 旧卡片把 mustRetain 标成「必须保留」、把 protectedExpressions 标成「禁止直接复制」、给七项构件
// 一律打 ✓——三处都与契约相反（下游不收、不是禁词、多数是【原片没有】）。旧简报里的这些字段
// 下游已经不读，所以不再显示，只留一行说明；storyEngine / recastTest 两种形状照常显示。
const BRIEF_DISPLAYED_KEYS = new Set(["schemaVersion", "storyEngine", "recastTest"]);

function renderBrief(data) {
  const legacyFields = Object.keys(data || {}).filter((key) => !BRIEF_DISPLAYED_KEYS.has(key));
  elements.brief.innerHTML = `${resultHeader("CREATIVE BRIEF", "创意简报 · 原片解读")}
    <div class="summary-strip">这里写的全是原片：它靠什么驱动，以及为什么非得是这个角色来做。定位、受众和情绪曲线由后续阶段直接读原片分析。</div>
    <div class="data-grid">
      ${cell("原片主角想要", data.storyEngine?.desire)}${cell("原片的阻力", data.storyEngine?.obstacle)}${cell("压力怎么升高", data.storyEngine?.escalation)}${cell("原片怎么兑现", data.storyEngine?.payoff)}${cell("关系理解转变", storyEngineShift(data.storyEngine))}
    </div>
    ${recastTestBlock(data.recastTest)}
    ${legacyFields.length ? `<p class="muted-note">这是旧版简报，其余 ${legacyFields.length} 个字段下游已不再使用，未显示。</p>` : ""}`;
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
    ${isStoryEntryMode() ? "" : block("原片表面表达来源记录", renderGuardrailRuleList(data.sourceSimilarityRules, "无原片表面表达来源记录。"))}
    ${block("台词与行为规则", renderGuardrailRuleList(data.dialogueRules, "无额外台词或行为规则。"))}
    <div class="warning-box"><b>这里的「禁止出现」是角色边界，不是渲染负面提示词。</b> 4.0 分镜和镜头视频请求都不带负面提示词。</div>
    ${uncertainties(data.uncertainties)}`;
  reveal(elements.guardrails);
}

// 边界条目的 scope / evidenceLevel 是枚举（取值见 src/validation.js 的两份 Set），只做展示翻译，认不出的照原样显示。
const TRAIT_SCOPE_LABELS = { identity: "身份", appearance: "外观", personality: "性格", occupation: "职业", storyFunction: "剧情功能" };
const TRAIT_EVIDENCE_LABELS = { explicit: "原文明确写出", inferred: "推断" };

function renderBoundaryTraits(value = []) {
  const items = Array.isArray(value) ? value : [];
  if (!items.length) return `<div class="tag-row"><span class="tag">无</span></div>`;
  return `<div class="rule-list">${items.map((item) => `<div class="rule"><strong>${escape(item.canonicalName || "未命名事实")}</strong><p>${escape(TRAIT_SCOPE_LABELS[item.scope] || item.scope || "")} · ${escape(TRAIT_EVIDENCE_LABELS[item.evidenceLevel] || item.evidenceLevel || "")}<br>${escape(item.reason || "")}</p></div>`).join("")}</div>`;
}

function renderAllowedPositiveTraits(value = []) {
  const items = Array.isArray(value) ? value : [];
  if (!items.length) return `<div class="tag-row"><span class="tag">无额外允许项</span></div>`;
  return `<div class="tag-row">${items.map((item) => {
    if (typeof item === "string") return `<span class="tag">${escape(item)}</span>`;
    const text = item?.term || item?.text || item?.rule || "未命名特征";
    return `<span class="tag">${escape(text)}${item?.scope ? ` · ${escape(TRAIT_SCOPE_LABELS[item.scope] || item.scope)}` : ""}</span>`;
  }).join("")}</div>`;
}

function renderGuardrailRuleList(value, emptyText) {
  const items = normalizeRuleItems(value);
  if (!items.length) return `<div class="rule-list"><p class="long-copy">${escape(emptyText)}</p></div>`;
  return `<div class="rule-list stacked">${items.map((item) => {
    if (typeof item === "string") return `<div class="rule"><strong>${escape(item)}</strong></div>`;
    const title = firstRuleValue(item, ["text", "rule", "term", "name", "requirement", "boundary", "prohibition", "category"]) || "规则";
    const details = ruleDetailPairs(item).map(([label, detail]) => `<dt>${escape(label)}</dt><dd>${escape(structuredValue(detail))}</dd>`).join("");
    return `<div class="rule"><strong>${escape(title)}</strong>${details ? `<dl class="kv">${details}</dl>` : ""}</div>`;
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
    scope: "范围", reason: "原因", source: "来源", triggerEvidence: "触发证据", evidenceLevel: "证据", terms: "写法",
    priority: "优先级", appliesTo: "适用目标", severity: "级别", allowed: "允许",
    forbidden: "禁止", behavior: "行为", note: "说明", description: "说明"
  };
  const titleKeys = new Set(["text", "rule", "term", "name", "requirement", "boundary", "prohibition", "category"]);
  return Object.entries(item)
    .filter(([key, value]) => !titleKeys.has(key) && value !== null && value !== undefined && value !== "")
    .map(([key, value]) => [labels[key] || key,
      key === "scope" ? TRAIT_SCOPE_LABELS[value] || value : key === "evidenceLevel" ? TRAIT_EVIDENCE_LABELS[value] || value : value]);
}

// 触发证据是 {sourcePath, evidence}：显示成「固定角色「原文」」，不再是 sourcePath=creatorProfile.fixedCharacter；evidence=…。
// 路径前缀只翻译已知的几个上游，其余照原样显示，不猜。
const EVIDENCE_SOURCE_LABELS = [
  ["creatorProfile.fixedCharacter", "固定角色"], ["creatorProfile.constraints", "创作限制"], ["creatorProfile.vertical", "垂直赛道"],
  ["sourceScriptReconstruction", "原片脚本还原"], ["referenceAnalysis", "参考片分析"], ["creativeBrief", "创意简报"], ["storySource", "故事原文"]
];

function evidenceSourceLabel(path) {
  const text = String(path ?? "");
  const hit = EVIDENCE_SOURCE_LABELS.find(([prefix]) => text === prefix || text.startsWith(`${prefix}.`) || text.startsWith(`${prefix}[`));
  if (!hit) return text;
  const rest = text.slice(hit[0].length).replace(/^\./, "");
  return rest ? `${hit[1]}（${rest}）` : hit[1];
}

function structuredValue(value) {
  if (Array.isArray(value)) return value.map(structuredValue).filter(Boolean).join(" / ");
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length && keys.every((key) => key === "sourcePath" || key === "evidence")) {
      return `${evidenceSourceLabel(value.sourcePath)}${value.evidence ? `「${structuredValue(value.evidence)}」` : ""}`;
    }
    return Object.entries(value).map(([key, item]) => `${key}=${structuredValue(item)}`).join("；");
  }
  return String(value ?? "");
}

const REGENERATE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-.9 4.5"/><polyline points="20 4 20 11 13 11"/></svg>`;

function renderVariants(data) {
  // 剧情入口只有一个候选：没有「换一批」、没有对照原片的体检和相似风险。
  const storyEntry = isStoryEntryMode();
  const regenerating = Boolean(state.variantsRegenerating);
  const regenerateButton = storyEntry ? "" : `<button class="round-add-button${regenerating ? " is-busy" : ""}" type="button" data-regenerate-variants aria-label="换一批主题变体" title="${regenerating ? "正在重新生成主题变体…" : "换一批：用同一份上游证据重新生成主题变体"}"${regenerating ? " disabled" : ""}>${REGENERATE_ICON}</button>`;
  elements.variants.innerHTML = `${storyEntry
    ? resultHeader("STORY", state.output.storySource?.storyMode === STORY_MODE_CHARACTER_ONLY ? "按角色设定写出的故事" : "按原文整理的故事", "", "")
    : resultHeader("THEME VARIANTS", "可拍摄的具体主题变体", "", regenerateButton)}
    <div class="variant-grid">${(data.variants || []).map((variant) => `<div class="variant">
      <div class="variant-top">
        <div><span class="variant-number">${escape(variant.id)} · ${storyEntry ? "STORY" : "NEW EPISODE"}</span><h4>${escape(variant.title)}</h4></div>
        <div class="variant-top-meta">
          <label class="variant-switch" title="${backgroundMusicEnabled(variant.id) ? "开启：允许为该主题生成背景音乐" : "关闭：成片只保留现场环境声与动作声"}">
            <input type="checkbox" data-background-music="${escape(variant.id)}" aria-label="${escape(variant.title)} 的背景音乐"${backgroundMusicEnabled(variant.id) ? " checked" : ""}${regenerating ? " disabled" : ""}>
            <span class="variant-switch-track" aria-hidden="true"></span>
            <span class="variant-switch-label">配乐</span>
          </label>
          ${variantDurationBadge(variant.storyOutline)}
          ${narrativeModeBadge(variant.narrativeMode)}
          ${storyEntry ? "" : `<span class="risk">相似风险 ${escape(variant.originalityRiskCheck?.riskLevel || "-")}</span>`}
        </div>
      </div>
      <p class="variant-hook">${escape(variant.oneLineHook)}</p>
      <p class="variant-logline">${escape(variant.logline)}</p>
      <div class="variant-cast">
        <span><b>主角</b>${escape(variant.characterSetup?.protagonist || "待确认")}</span>
        ${optionalCastSpan("被关爱对象", variant.characterSetup?.careRecipient)}
        ${optionalCastSpan("帮助者", variant.characterSetup?.helper)}
      </div>
      <ul class="mini-beats">${(variant.storyOutline || []).map((beat) => `<li><b>${escape(beat.beat)}</b><span><strong>${escape(beat.phase)}</strong> · ${escape(beat.action)}</span></li>`).join("")}</ul>
      ${variant.endingRitual ? `<div class="variant-ending"><b>结尾仪式：</b>${escape(variant.endingRitual)}</div>` : ""}
      <button class="outline-button variant-story-button" type="button" data-story-variant="${escape(variant.id)}"${regenerating ? " disabled" : ""}>进入完整剧情 →</button>
    </div>`).join("")}</div>
    ${storyEntry ? "" : `<div class="story-review">
      <button type="button" class="outline-button" data-candidate-review${regenerating ? " disabled" : ""}>对照原片体检候选</button>
      <span class="story-review-hint">只看动作链，不看候选的自我评价——评审拿不到新颖性、保留价值和体验保真这些字段。只出报告，不改候选、不淘汰、不影响后续。</span>
      <div class="story-review-body" data-candidate-review-body></div>
    </div>`}`;
  reveal(elements.variants);
  const reviewButton = elements.variants.querySelector("[data-candidate-review]");
  if (reviewButton) reviewButton.addEventListener("click", () => runStoryCandidateReview(data, reviewButton));
}

// 粘贴完整故事：首页没有候选卡，只有一张通往分场页的入口卡。
function renderStorySourceShots(fullStory) {
  const scenes = Array.isArray(fullStory?.sceneScript) ? fullStory.sceneScript : [];
  const seconds = Number(fullStory?.targetDurationSeconds) || 0;
  elements.variants.innerHTML = `${resultHeader("SHOTS", "可翻拍镜头", "", "")}
    <div class="variant-grid"><div class="variant">
      <div class="variant-top">
        <div><span class="variant-number">${escape(STORY_ENTRY_VARIANT_ID)} · 你的故事</span><h4>${escape(fullStory?.title || "你的故事")}</h4></div>
        <div class="variant-top-meta"><span class="duration-badge">${escape(scenes.length)} 场 · 约 ${escape(seconds)} 秒</span></div>
      </div>
      <p class="variant-logline">已按原文拆好分场：时间、地点、画面动作、声音和原台词。情节、人物、结局和台词都按原文。</p>
      <button class="outline-button variant-story-button" type="button" data-story-variant="${escape(STORY_ENTRY_VARIANT_ID)}">查看可翻拍镜头 →</button>
    </div></div>`;
  reveal(elements.variants);
}

// 候选对照评审：手动触发，只出报告。不改候选、不签发 Artifact、不改变候选数量、
// 不 stale 任何东西、不阻断后续阶段。报告不落盘，刷新页面即失。
async function runStoryCandidateReview(themeVariants, button) {
  const workspaceEpoch = browserWorkspace.epoch;
  const body = elements.variants.querySelector("[data-candidate-review-body]");
  if (!body || button.disabled) return;
  if (!state.output.sourceScriptReconstruction) {
    body.innerHTML = `<p class="story-review-status error">缺少原片脚本还原，无法做对照评审。</p>`;
    return;
  }
  button.disabled = true;
  const original = button.textContent;
  button.textContent = "体检中…";
  body.innerHTML = `<p class="story-review-status">正在逐个候选核对动作链与原片机制，通常十几秒…</p>`;
  try {
    // 响应是 { review, metadata } 两层：metadata 是服务端的调用记录，**不属于**
    // 模型输出契约（schema 是 additionalProperties: false），混进去会让这份报告
    // 送不回服务端——而命题定向修订要拿它当输入。
    const result = await api("/api/story-candidate-review", {
      themeVariants,
      sourceScriptReconstruction: state.output.sourceScriptReconstruction,
      visualGuardrails: state.output.visualGuardrails,
      // 三份上游（2026-09-12）：角色是硬事实、简报是**可以质疑的创作假设**、
      // 参考分析只用来理解参考片为什么留得住人。服务端按允许清单投影后才进提示词，
      // **它们都不会成为原片事实基准**——机制与骨架对照仍然只认脚本还原。
      // 缺任何一份都不阻断评审，只是少一节判断依据。
      creatorProfile: profile(),
      creativeBrief: state.output.creativeBrief,
      referenceAnalysis: state.output.referenceAnalysis
    });
    // 报告连同它评的那一份 themeVariants 一起留在内存里，给定向修订当输入。
    // 与评审本身同规格：只在页面上活着，刷新即失，不进 Artifact、不进 lineage。
    // 连 themeVariants 一起存是为了在修订时复核报告评的还是不是当前这一批。
    lastCandidateReview = { review: result.review, themeVariants };
    storyCandidateRevisions.clear();
    body.innerHTML = renderStoryCandidateReview(result.review, themeVariants, result.metadata);
    bindCandidateReviewActions(body);
  } catch (error) {
    if (!browserWorkspace.isCurrent(workspaceEpoch)) return;
    // 覆盖率核验拦下的漏检要完整显示：用户需要看到是哪个候选没被评到。
    body.innerHTML = `<p class="story-review-status error">${escape(error?.message || "候选体检失败")}</p>`;
  } finally {
    if (!browserWorkspace.isCurrent(workspaceEpoch)) return;
    button.disabled = false;
    button.textContent = original;
  }
}

// 最近一次评审报告，连同它评的那一份 themeVariants。定向修订拿它当输入，
// 并在发请求前复核这一批命题有没有换过。刷新即失，与评审同规格。
let lastCandidateReview = null;

// 修订按钮在这个命题被报出**因果断裂**或**有原片机制没接住**时出现。
//
// 驱动信号刻意不是 verdict：2026-09-10 实测同一份命题三次回放，verdict 与
// recommendedOrder 每次都不同（2 pass/2 revise → 2 revise/2 drop → 2 revise/2 drop），
// 而这两类都逐条锚定——断裂锚到拍号，机制锚到清单 id。拿不稳的信号当修订入口只会让人白花钱。
//
// 机制未迁移是 2026-09-11 补上的第二个信号。此前只看因果断裂，实测代价：V4 被判 drop 的
// 主因是三条机制全部 not_depicted，而修订只收到那条最轻的空间断裂，于是只把「小木箱」
// 换成了「高脚木凳」——评审自己的 summary 写着「最该先改的是补充转赠长辈的动作」，那条没送到。
function reviseAction(check) {
  const breaks = Array.isArray(check?.coherenceChecks) ? check.coherenceChecks : [];
  const unmigrated = (Array.isArray(check?.mechanismChecks) ? check.mechanismChecks : [])
    .filter((entry) => entry?.verdict === "not_depicted" || entry?.verdict === "partially_depicted");
  if (!breaks.length && !unmigrated.length) return "";
  const parts = [];
  if (breaks.length) parts.push(`${breaks.length} 处因果问题`);
  if (unmigrated.length) parts.push(`${unmigrated.length} 条没接住的原片机制`);
  return `
    <div class="candidate-revision-action">
      <button type="button" class="outline-button" data-revise-candidate="${escape(check.candidateId)}">
        按评审意见修订（${parts.join(" + ")}）
      </button>
      <span class="muted-note">只出修订稿供对照，<b>不会</b>改动当前命题；采纳与否由你决定。机制接不接由修订模型判断，它可以明确拒绝并说明理由。</span>
    </div>`;
}

// 定向修订结果按命题 id 隔离：只在页面上活着，
// 真正签发只发生在用户点「采纳」的那一刻。
const storyCandidateRevisions = new Map();

const CANDIDATE_VERDICT_LABEL = { pass: "可展开", revise: "需修改", drop: "建议淘汰" };

// 五档质量等级与降级理由的中文标签都从共用常量取（`public/story-review-metrics.js`），
// **浏览器里不再写第二份数字或第二套档位**。
const CANDIDATE_TIER_LABEL = Object.fromEntries(
  CANDIDATE_REVIEW_TIERS.map((tier) => [tier.id, tier.label])
);

const DEFECT_SEVERITY_LABEL = { BLOCKER: "致命", MAJOR: "重要", MINOR: "轻微", NONE: "无" };

const BRIEF_ALIGNMENT_LABEL = { PASS: "不冲突", WARN: "需注意", FAIL: "违反硬约束" };

const SUGGESTION_KIND_LABEL = {
  strengthen: "强化已有",
  replace: "替换",
  remove: "删除",
  recycle: "回收伏笔",
  add: "新增"
};

// 因果自洽问题的五种形状，与 schema 的 kind 枚举逐字一一对应。
// 枚举值本身是英文标识，直接显示等于让人对着 purpose_nullified 猜它指什么。
const COHERENCE_KIND_LABEL = {
  contradiction: "前后互相否定",
  tool_misuse: "手上已有更好的办法",
  purpose_nullified: "目的被当场抵消",
  space_or_time: "空间或时间说不通",
  other: "其它"
};

// 事件链逐环的接法，与 schema 的 linkage 枚举逐字一一对应。
// same 是这里唯一的坏消息：因果接法与顺序都照搬，就是换皮的形状。
const SCAFFOLD_LINKAGE_LABEL = {
  same: "同一条因果接法、同一顺序",
  reordered: "有对应事件但顺序或接法变了",
  different: "这个位置做的是另一件事",
  absent: "候选里没有这件事"
};

// 五个辅助观察的取值。not_applicable 是 2026-09-12 补的：原片或候选根本没有
// 任务、没有奖励时（生活片段型很常见），逼模型在 same/partial/different 里三选一
// 只会得到一个编出来的值。
const SCAFFOLD_DIMENSION_LABEL = {
  same: "同类",
  partial: "部分相同",
  different: "不同",
  not_applicable: "不适用"
};

const SCAFFOLD_DIMENSION_TITLE = {
  taskType: "任务性质",
  midSection: "中段怎么推进",
  rewardSource: "获得的东西从哪来",
  rewardHandling: "拿到之后怎么处置",
  endingShape: "结尾形状"
};

// 评审结论与候选**自己的说辞**并排显示。
// 模型看不到右边那一栏（服务端按允许清单剥掉了），你看得见——差在哪一眼就知道。
function renderStoryCandidateReview(review, themeVariants, metadata = null) {
  const byId = new Map((themeVariants?.variants || []).map((variant) => [String(variant.id), variant]));
  const headline = candidateReviewHeadline(review);
  // 服务端拦过一次就必须说出来，不能让用户以为模型一次就写对了。
  // 这一档现在允许「第一次做错」：被确定性闸门拦下时带诊断重做一次，预算封在 2 次。
  // metadata 是**外挂的一层**，不在 review 对象里——review 的 schema 是
  // additionalProperties: false，混进去它就送不回服务端，而定向修订要拿它当输入。
  const call = metadata?.storyCandidateReview || null;
  const rejectionReasons = (call?.rejections || [])
    .flatMap((rejection) => (rejection?.details || []))
    .map((detail) => String(detail?.reason || detail?.message || "").trim())
    .filter(Boolean);
  const retryNote = call && call.providerCalls > 1 ? `
    <p class="story-review-status warn">这份报告是第 ${escape(call.providerCalls)} 次调用的结果——第一次被确定性校验拦下并按诊断重做了一次${rejectionReasons.length ? `：${escape(rejectionReasons.join("；"))}` : "。"}</p>` : "";
  // 原片机制是**全批共享的一份清单**，候选只按 id 引用（§2.12b ⑥）。
  // 不把清单显示出来，下面每条 mechanismCheck 就只剩一个孤零零的 id，
  // 而「这批候选到底在对照原片的哪几条机制」正是这份报告最该先说清的事。
  const mechanismById = new Map((review.sourceMechanisms || []).map((entry) => [String(entry.id), entry]));
  const sourceMechanisms = (review.sourceMechanisms || []).length ? `
    <div class="candidate-review-mechanisms">
      <b>原片机制清单（全部候选共用这一份，最多 4 条）</b>
      ${(review.sourceMechanisms || []).map((entry) => `
        <div class="review-check">
          <div class="review-check-head">
            <span class="scene-id">${escape(entry.id)}</span>
            <b>${escape(entry.mechanism)}</b>
            ${entry.requiresCause === true ? `<span class="review-verdict verdict-partially_depicted">需要前因</span>` : ""}
          </div>
          <p><b>原片在哪兑现：</b>${escape(entry.whereInSource)}</p>
        </div>`).join("")}
    </div>` : "";
  const cards = (review.candidateChecks || []).map((check) => {
    const candidate = byId.get(String(check.candidateId));
    const interaction = check.coreInteraction || {};
    const mechanisms = (check.mechanismChecks || []).map((entry) => {
      // 校验器已保证这个 id 在清单里（CANDIDATE_REVIEW_UNKNOWN_MECHANISM），
      // 取不到时仍只显示 id，不编一句解释。
      const source = mechanismById.get(String(entry.sourceMechanismId));
      return `
      <div class="review-check">
        <div class="review-check-head">
          <span class="scene-id">${escape(entry.sourceMechanismId)}</span>
          ${source ? `<b>${escape(source.mechanism)}</b>` : ""}
          <span class="review-verdict verdict-${escape(entry.verdict)}">${escape(REVIEW_VERDICT_LABEL[entry.verdict] || entry.verdict)}</span>
        </div>
        <p><b>本候选在哪兑现：</b>${escape(entry.actionEvidence)}${(entry.beatIndexes || []).length ? `（第 ${escape((entry.beatIndexes || []).join("、"))} 拍）` : ""}</p>
        ${source?.requiresCause === true ? `
        <p><b>前因：</b>${entry.causeEvidence ? escape(entry.causeEvidence) : "<span class=\"muted-note\">这条机制标了需要前因，而评审没有写出前因</span>"}</p>` : ""}
      </div>`;
    }).join("");
    // 骨架对照（2026-09-12）。评审此前只比候选**之间**的差异，从来没比过候选与原片——
    // 四个候选彼此完全不同，仍然可能各自都在复刻原片，那是两个独立的问题。
    // 事件链是判据，五个维度只是辅助观察；不渲染事件链就只剩一个没有依据的分数。
    const scaffold = check.sourceScaffoldOverlap;
    const scaffoldBlock = scaffold ? `
      <div class="candidate-review-scaffold">
        <b>与原片的故事链重合：${escape(scaffold.score)} / 100${Number.isInteger(scaffold.score) && scaffold.score >= SOURCE_SCAFFOLD_COPY_SCORE ? "（疑似换皮）" : ""}</b>
        <p class="review-why">${escape(scaffold.why)}</p>
        ${(scaffold.eventChain || []).map((link) => `
          <div class="review-check">
            <div class="review-check-head">
              <span class="review-verdict verdict-${link.linkage === "same" ? "not_depicted" : link.linkage === "reordered" ? "partially_depicted" : "depicted"}">${escape(SCAFFOLD_LINKAGE_LABEL[link.linkage] || link.linkage)}</span>
              ${(link.beatIndexes || []).length ? `<span class="scene-id">第 ${escape((link.beatIndexes || []).join("、"))} 拍</span>` : ""}
            </div>
            <p><b>原片：</b>${escape(link.sourceEvent)}</p>
            <p><b>本候选：</b>${escape(link.candidateEvent)}</p>
          </div>`).join("")}
        <div class="data-grid">
          ${Object.keys(SCAFFOLD_DIMENSION_TITLE).map((key) => cell(
            SCAFFOLD_DIMENSION_TITLE[key],
            SCAFFOLD_DIMENSION_LABEL[scaffold[key]] || scaffold[key]
          )).join("")}
        </div>
        <span class="muted-note">任务同类、结尾相似、都是两个人一起做事，本身都不足以判换皮；判据是那条因果链。</span>
      </div>` : "";
    // 因果自洽检查是这份报告里唯一「呈现 vs 呈现」的一档（§2.12b ⑤），
    // 它的全部意义就是把动作链里的断裂摆出来给人看——不渲染等于这一档没做。
    const coherence = (check.coherenceChecks || []).length ? `
      <div class="candidate-review-coherence">
        <b>因果自洽问题（${(check.coherenceChecks || []).length} 处）</b>
        ${(check.coherenceChecks || []).map((entry) => `
          <div class="review-check">
            <div class="review-check-head">
              <span class="review-verdict verdict-not_depicted">${escape(COHERENCE_KIND_LABEL[entry.kind] || entry.kind)}</span>
              <span class="scene-id">第 ${escape((entry.beatIndexes || []).join("、"))} 拍</span>
            </div>
            <p>${escape(entry.problem)}</p>
          </div>`).join("")}
      </div>` : "";
    const claims = candidate ? `
      <div class="candidate-review-claim">
        <b>候选自己的说辞（评审看不到这一栏）</b>
        <p><b>新颖性：</b>${escape(candidate.novelty || "—")}</p>
        <p><b>保留价值：</b>${escape((candidate.highValueBeatMapping || []).map((entry) => entry.retainedValue).filter(Boolean).join("；") || "—")}</p>
        <p><b>体验保真：</b>${escape(candidate.experienceFidelity?.plotDriver || "—")}</p>
      </div>` : "";
    // 分数与放行决定是**两件事**，界面上必须分开显示（2026-09-12）：
    // 一个 9.2 分、最高档的候选，可能因为动作链有因果断裂而暂时不能晋级。
    // 把它显示成「7 分」或只显示「需修改」，都会让人以为这个故事不好。
    const verdict = check.effectiveVerdict || check.verdict;
    const overrides = Array.isArray(check.verdictOverrideReasons) ? check.verdictOverrideReasons : [];
    const scoreBlock = Number.isFinite(Number(check.overallScore)) ? `
      <div class="candidate-review-score">
        <b>${escape(Number(check.overallScore).toFixed(2))} / 10</b>
        <span class="scene-id">${escape(CANDIDATE_TIER_LABEL[check.tier] || check.tier || "")}</span>
        ${overrides.length ? `<span class="review-verdict verdict-not_depicted">${escape(
          `按分数本可${CANDIDATE_VERDICT_LABEL[check.scoreBasedVerdict] || check.scoreBasedVerdict}，现降为${CANDIDATE_VERDICT_LABEL[verdict] || verdict}`
        )}</span>` : ""}
        ${overrides.length ? `<p class="muted-note">降级原因：${escape(
          overrides.map((reason) => CANDIDATE_REVIEW_OVERRIDE_LABELS[reason] || reason).join("；")
        )}（质量分与等级不因此改变）</p>` : ""}
        <div class="data-grid">
          ${(check.dimensions || []).map((dim) => cell(
            CANDIDATE_REVIEW_DIMENSION_LABELS[dim.id] || dim.id,
            `${Number(dim.score).toFixed(1)} · ${dim.evidence || ""}`
          )).join("")}
        </div>
      </div>` : "";
    const defect = check.dominantDefect;
    // 缺陷类型要显示中文：十一个维度复用维度标签，另外四个特殊值单列——
    // 让人对着 ownership_or_authority 猜是这套报告最容易犯的可读性错误。
    const defectTypeLabel = defect
      ? (CANDIDATE_REVIEW_DIMENSION_LABELS[defect.type]
        || CANDIDATE_REVIEW_SPECIAL_DEFECT_LABELS[defect.type]
        || defect.type)
      : "";
    const defectBlock = defect && defect.type && defect.type !== "none" ? `
      <p class="review-why"><b>主要缺陷 · ${escape(defectTypeLabel)}（${escape(DEFECT_SEVERITY_LABEL[defect.severity] || defect.severity)}）：</b>${escape(defect.description || defect.type)}</p>` : "";
    // 物理机制：**不是「可行 / 不可行」二选一**，中间那档才是常态——
    // 「换个条件就成立」的土办法要把依赖的条件摆出来，下游才知道正文里该补哪一句。
    const assumptions = (check.physicalAssumptions || []).length ? `
      <div class="candidate-review-assumptions">
        <b>物理机制的可信度</b>
        ${(check.physicalAssumptions || []).map((row) => `
          <div class="review-check">
            <div class="review-check-head">
              <span class="review-verdict verdict-${row.confidence === "established" ? "depicted" : row.confidence === "conditional" ? "partially_depicted" : "not_depicted"}">${escape(CANDIDATE_REVIEW_CONFIDENCE_LABELS[row.confidence] || row.confidence)}</span>
              ${(row.beatIndexes || []).length ? `<span class="scene-id">第 ${escape((row.beatIndexes || []).join("、"))} 拍</span>` : ""}
            </div>
            <p>${escape(row.mechanism)}</p>
            <p><b>故事依赖程度：</b>${escape(CANDIDATE_REVIEW_LITERAL_DEPENDENCY_LABELS[row.literalDependency] || row.literalDependency || "—")}${row.literalDependency === "make_believe" ? "（物理上立不住不算缺陷）" : ""}</p>
            ${(row.necessaryAssumptions || []).length ? `<p><b>依赖但没交代的条件：</b>${escape((row.necessaryAssumptions || []).join("；"))}</p>` : ""}
            ${row.failureRisk ? `<p><b>不成立时：</b>${escape(row.failureRisk)}</p>` : ""}
          </div>`).join("")}
      </div>` : "";
    const brief = check.briefAlignment;
    // 简报合规**不进质量分**，所以单独一块显示：一个不听简报但更好看的故事，
    // 该改的是简报，不是这个候选。
    const briefBlock = brief && brief.status ? `
      <div class="candidate-review-brief">
        <b>创意简报：${escape(BRIEF_ALIGNMENT_LABEL[brief.status] || brief.status)}</b>
        ${brief.conflict ? `<p>${escape(brief.conflict)}</p>` : ""}
        ${brief.suggestBriefChange ? `<p><b>建议改简报：</b>${escape(brief.suggestBriefChange)}</p>` : ""}
        <span class="muted-note">仅供参考：不参与分数、等级与放行决定。实测同一份候选三次回放，这一格的判定会互相翻转，跨包时改简报的方向甚至相反——请人工判断。</span>
      </div>` : "";
    const suggestions = (check.top3RevisionSuggestions || []).length ? `
      <div class="candidate-review-suggestions">
        <b>最高价值的 ${escape((check.top3RevisionSuggestions || []).length)} 处修改（先换再加）</b>
        ${(check.top3RevisionSuggestions || []).map((row) => `
          <div class="review-check">
            <div class="review-check-head">
              <span class="review-verdict verdict-${row.kind === "add" ? "not_depicted" : "partially_depicted"}">${escape(SUGGESTION_KIND_LABEL[row.kind] || row.kind)}</span>
            </div>
            <p>${escape(row.suggestion)}</p>
            ${row.replacesOrStrengthens ? `<p><b>换掉或强化：</b>${escape(row.replacesOrStrengthens)}</p>` : ""}
            ${row.whyOnlyHere ? `<p><b>为什么只能发生在这个故事里：</b>${escape(row.whyOnlyHere)}</p>` : ""}
          </div>`).join("")}
      </div>` : "";
    return `
      <details class="candidate-review-card" ${verdict === "pass" ? "" : "open"}>
        <summary>
          <span class="scene-id">${escape(check.candidateId)}</span>
          <b>${escape(check.title)}</b>
          ${Number.isFinite(Number(check.overallScore)) ? `<span class="scene-id">${escape(Number(check.overallScore).toFixed(2))}</span>` : ""}
          <span class="review-verdict verdict-${verdict === "pass" ? "depicted" : verdict === "revise" ? "partially_depicted" : "not_depicted"}">${escape(CANDIDATE_VERDICT_LABEL[verdict] || verdict)}</span>
        </summary>
        <p class="review-why">${escape(check.why)}</p>
        ${check.strongestReason ? `<p class="review-keep"><b>最强的一处：</b>${escape(check.strongestReason)}</p>` : ""}
        ${defectBlock}
        ${scoreBlock}
        <div class="data-grid">
          ${cell("具体困境", interaction.setback)}${cell("主角介入", interaction.intervention)}
          ${cell("对方回应", interaction.response)}${cell("可见前后变化", interaction.visibleChange)}
        </div>
        ${mechanisms}
        ${coherence}
        ${scaffoldBlock}
        ${assumptions}
        ${briefBlock}
        ${suggestions}
        <p class="review-keep"><b>别改掉：</b>${escape(check.keepThis)}</p>
        ${claims}
        ${reviseAction(check)}
        <div class="candidate-revision-slot" data-revision-slot="${escape(check.candidateId)}"></div>
      </details>`;
  }).join("");
  // 批次模板收敛是**集合属性**，不属于任何单个候选：逐个看每一个都可以声称自己原创，
  // 只有横着看才会发现四个故事其实是同一套机制换了四套布景。所以它置顶显示。
  const convergence = review.batchTemplateConvergence;
  const convergenceBlock = convergence && convergence.converged === true ? `
    <div class="candidate-review-convergence">
      <b>这一批共用同一套深层机制（${escape((convergence.affectedCandidateIds || []).join("、"))}）</b>
      <p>${escape(convergence.sharedMechanism)}</p>
      ${convergence.evidence ? `<p class="muted-note">${escape(convergence.evidence)}</p>` : ""}
    </div>` : "";
  const briefProblems = (review.briefProblemsDetected || []).length ? `
    <div class="candidate-review-brief">
      <b>这一批暴露出的创意简报问题</b>
      ${(review.briefProblemsDetected || []).map((entry) => `<p>${escape(entry)}</p>`).join("")}
      <span class="muted-note">简报是上一阶段的创作假设，不是硬事实——这里说的是该改简报，不是该改候选。</span>
    </div>` : "";
  // winner / runnerUp / 淘汰名单都是服务端从推荐顺序与派生等级算出来的，
  // 不是模型另写的一份，所以不会出现「判了淘汰却不在名单里」。
  const winner = String(review.recommendedWinner || "");
  const rejects = Array.isArray(review.rejectOrRegenerate) ? review.rejectOrRegenerate : [];
  return `
    <p class="story-review-status">${escape(headline)}</p>
    <p class="story-review-status">按评分排序：${escape((review.scoreOrder || []).join(" → "))}</p>
    ${(review.holisticPreferenceOrder || []).length ? `<p class="story-review-status">模型整体偏好：${escape((review.holisticPreferenceOrder || []).join(" → "))}${(review.scoreOrder || []).join() !== (review.holisticPreferenceOrder || []).join() ? "　<b>（与评分排序不一致——两套判断在这一批上看法不同，值得看一眼为什么）</b>" : ""}</p>` : ""}
    ${winner ? `<p class="story-review-status">首选 <b>${escape(winner)}</b>${review.runnerUp ? ` · 次选 ${escape(review.runnerUp)}` : ""}${rejects.length ? ` · 建议淘汰或重做 ${escape(rejects.join("、"))}` : ""}</p>` : ""}
    ${retryNote}
    ${convergenceBlock}
    ${briefProblems}
    ${sourceMechanisms}
    ${cards}
    <p class="story-review-summary">${escape(review.summary)}</p>`;
}

// 评审面板是整块 innerHTML 渲染的，按钮只能在渲染之后绑。
function bindCandidateReviewActions(root) {
  for (const button of root.querySelectorAll("[data-revise-candidate]")) {
    button.addEventListener("click", () => requestStoryCandidateRevision(button.dataset.reviseCandidate, button));
  }
}

// 定向修订：按评审报出的因果断裂只改这一个命题。**返回结果不写回任何东西**——
// 签发只发生在用户点「采纳」的那一刻。
async function requestStoryCandidateRevision(candidateId, button) {
  const workspaceEpoch = browserWorkspace.epoch;
  if (!candidateId || button.disabled) return;
  const entry = lastCandidateReview;
  if (!entry) {
    showError("评审报告已失效，请重新体检后再修订。");
    return;
  }
  // 报告是针对**当时那一批命题**算出来的。中途换过一批就必须重新体检，
  // 不能把基于旧内容的修订意见套到新命题上。
  if (JSON.stringify(state.output.themeVariants) !== JSON.stringify(entry.themeVariants)) {
    lastCandidateReview = null;
    showError("主题命题在体检之后已经换过一批，这份评审报告已作废，请重新体检。");
    return;
  }
  const slot = document.querySelector(`[data-revision-slot="${CSS.escape(candidateId)}"]`);
  button.disabled = true;
  const original = button.textContent;
  button.textContent = "修订中…";
  if (slot) slot.innerHTML = `<p class="story-review-status">正在按评审意见改这一个命题，通常一两分钟…</p>`;
  try {
    const result = await api("/api/story-candidate-revision", {
      themeVariants: entry.themeVariants,
      review: entry.review,
      candidateId,
      creatorProfile: profile(),
      // 边界验签比对整份上游的 sourceDigest，这几份必须一起送；
      // 它们只用于验签与合并后的复验，**不进修订提示词**。
      visualGuardrails: state.output.visualGuardrails,
      creativeBrief: state.output.creativeBrief,
      referenceAnalysis: state.output.referenceAnalysis,
      sourceScriptReconstruction: state.output.sourceScriptReconstruction,
      targetDurationSeconds: resolveStoryDurationTarget(state.storyDurationTarget, {
        metadata: state.metadata,
        sourceScriptReconstruction: state.output.sourceScriptReconstruction
      })
    });
    if (!browserWorkspace.isCurrent(workspaceEpoch)) return;
    storyCandidateRevisions.set(String(candidateId), {
      ...result,
      sourceThemeVariants: entry.themeVariants
    });
    if (slot) {
      slot.innerHTML = renderStoryCandidateRevision(candidateId, storyCandidateRevisions.get(String(candidateId)));
      const adopt = slot.querySelector("[data-adopt-candidate-revision]");
      if (adopt) adopt.addEventListener("click", () => adoptStoryCandidateRevision(candidateId, adopt));
    }
  } catch (error) {
    if (!browserWorkspace.isCurrent(workspaceEpoch)) return;
    if (slot) slot.innerHTML = `<p class="story-review-status error">${escape(error?.message || "定向修订失败")}</p>`;
  } finally {
    if (!browserWorkspace.isCurrent(workspaceEpoch)) return;
    button.disabled = false;
    button.textContent = original;
  }
}

// 原文与修订版并排。执行者反转、以及「一换一但复杂度暴涨」都没有确定性兜底，
// 只能靠人在这里看，所以界面上明写这一句。
// `withAdoptButton: false` 给展开前体检用：那个面板有自己的「采纳修订并展开」按钮，
// 把这里的采纳按钮也渲染出来会多一个没绑事件的死按钮，两个采纳并排还会让人不知道点哪个。
function renderStoryCandidateRevision(candidateId, entry, { withAdoptButton = true } = {}) {
  // entry 是服务端响应展开后再加一个 sourceThemeVariants：
  // { candidateId, revision, themeVariants（已合并）, metadata, sourceThemeVariants（原始） }。
  const before = (entry?.sourceThemeVariants?.variants || []).find((v) => String(v.id) === String(candidateId));
  const after = (entry?.themeVariants?.variants || []).find((v) => String(v.id) === String(candidateId));
  if (!before || !after) return `<p class="story-review-status error">修订结果里找不到命题 ${escape(candidateId)}。</p>`;
  const revision = entry?.revision || {};
  const call = entry?.metadata?.storyCandidateRevision || null;

  const fieldRow = (label, a, b) => (String(a || "") === String(b || "") ? "" : `
    <div class="revision-diff">
      <b>${escape(label)}</b>
      <p class="revision-before">${escape(a || "—")}</p>
      <p class="revision-after">${escape(b || "—")}</p>
    </div>`);

  const beats = (before.storyOutline || []).map((beat, index) => {
    const next = (after.storyOutline || [])[index] || {};
    const same = String(beat.action || "") === String(next.action || "");
    return `
      <div class="revision-diff ${same ? "revision-unchanged" : ""}">
        <b>第 ${escape(beat.beat)} 拍 · ${escape(beat.dramaticFunction)} · ${escape(beat.estimatedSeconds)}${
  Number(beat.estimatedSeconds) === Number(next.estimatedSeconds) ? "" : ` → ${escape(next.estimatedSeconds)}`} 秒</b>
        ${same
    ? `<p class="revision-same">${escape(beat.action)}</p>`
    : `<p class="revision-before">${escape(beat.action)}</p><p class="revision-after">${escape(next.action)}</p>`}
      </div>`;
  }).join("");

  const totalBefore = (before.storyOutline || []).reduce((sum, b) => sum + Number(b.estimatedSeconds || 0), 0);
  const totalAfter = (after.storyOutline || []).reduce((sum, b) => sum + Number(b.estimatedSeconds || 0), 0);
  const charsBefore = (before.storyOutline || []).reduce((sum, b) => sum + String(b.action || "").length, 0);
  const charsAfter = (after.storyOutline || []).reduce((sum, b) => sum + String(b.action || "").length, 0);

  return `
    <div class="candidate-revision">
      <p class="story-review-status">修订稿（还没有生效）${call && call.providerCalls > 1
    ? ` · 第 ${escape(call.providerCalls)} 次调用的结果，第一次被确定性校验拦下` : ""}</p>
      <p class="review-why">${escape(revision.changeSummary || "")}</p>
      ${fieldRow("任务", before.newTask, after.newTask)}
      ${fieldRow("环境压力", before.environmentPressure, after.environmentPressure)}
      ${fieldRow("一句话概括", before.logline, after.logline)}
      ${beats}
      <p class="muted-note">
        合计时长 ${escape(totalBefore)} → ${escape(totalAfter)} 秒 ·
        动作链字数 ${escape(charsBefore)} → ${escape(charsAfter)}
        ${charsAfter > charsBefore * 1.2 ? "（明显变长了，多半是在靠加戏解决问题——下游镜头会更挤）" : ""}
      </p>
      <p class="muted-note warn">
        自己看两件事，程序判不了：①执行者有没有被调换（「甲替乙做某事」不能变成乙替甲）；
        ②有没有一换一但复杂度暴涨。
      </p>
      ${withAdoptButton ? `<div class="candidate-revision-action">
        <button type="button" class="outline-button" data-adopt-candidate-revision>采纳并签发新的命题版本</button>
        <span class="muted-note warn">
          采纳会签发新的 themeVariants 版本。**这一批全部命题**的下游（完整剧情、镜头计划、
          已生成的图片与视频）都会失效——即使别的命题一个字没改，因为它们同属一份 Artifact。
          还没选中命题、还没往下做时采纳，代价为零。
        </span>
      </div>` : ""}
    </div>`;
}

// 采纳：这才是唯一签发新 themeVariants 版本的地方。
async function adoptStoryCandidateRevision(candidateId, button) {
  const workspaceEpoch = browserWorkspace.epoch;
  const entry = storyCandidateRevisions.get(String(candidateId));
  if (!entry || button.disabled) return;
  button.disabled = true;
  const original = button.textContent;
  button.textContent = "签发中…";
  try {
    const outcome = await adoptThemeVariantsRevision(entry, workspaceEpoch);
    if (outcome === "stale") storyCandidateRevisions.delete(String(candidateId));
    if (outcome !== "adopted") {
      button.disabled = false;
      button.textContent = original;
      return;
    }
    showError(`命题 ${candidateId} 的修订已采纳，已签发新的主题命题版本。`, "notice");
  } catch (error) {
    if (!browserWorkspace.isCurrent(workspaceEpoch)) return;
    showError(error.message || "修订签发失败；原命题保持不变。");
    button.disabled = false;
    button.textContent = original;
  }
}

// 签发一份修订过的 themeVariants。**评审面板与展开前体检共用这一份**——
// 采纳的语义（过期复核、下游征求同意、递归 stale、作废旧报告）只能有一处定义，
// 两处各写一遍必然漂移。返回 false 表示这次没有签发（已过期或用户拒绝），
// 提交失败照旧抛错，由调用方恢复按钮。
async function adoptThemeVariantsRevision(entry, workspaceEpoch) {
  // 修订是针对**当时那一批命题**算出来的，中途换过就必须作废，
  // 绝不能把基于旧内容的改写盖到新命题上。
  if (JSON.stringify(state.output.themeVariants) !== JSON.stringify(entry.sourceThemeVariants)) {
    showError("主题命题在修订期间已经变化，这次修订结果已作废，请重新体检并修订。");
    return "stale";
  }
  const downstream = [
    ...Object.keys(state.fullStories || {}).map((variantId) => `${variantId} 的完整剧情`),
    ...Object.keys(state.animationPlans || {}).map((variantId) => `${variantId} 的镜头计划`)
  ];
  if (downstream.length) {
    const confirmed = window.confirm(
      `采纳会签发新的主题命题版本。已生成的下游内容会全部失效——**包括没有被修订的那些命题**，`
      + "因为整批命题是同一份 Artifact：\n"
      + `${downstream.join("、")}，以及它们下面已生成的镜头媒体。\n\n是否继续？`
    );
    if (!confirmed) return "declined";
  }
  assertWorkspaceCurrent(workspaceEpoch);
  const nextThemeVariants = entry.result?.themeVariants || entry.themeVariants;
  await commitProductionArtifact({
    artifactId: "themeVariants",
    artifactType: "themeVariants",
    content: nextThemeVariants,
    dependencyRefs: productionDependencies([
      "referenceAnalysis", "sourceScriptReconstruction", "creativeBrief", "visualGuardrails"
    ])
  });
  state.output.themeVariants = nextThemeVariants;
  // 命题内容变了，之前基于旧内容的评审报告与其余修订稿一并作废。
  lastCandidateReview = null;
  storyCandidateRevisions.clear();
  renderVariants(nextThemeVariants);
  renderSelectedVariantSummary(selectedVariant());
  return "adopted";
}

// 换一批：用同一份已签发的上游证据（referenceAnalysis / sourceScriptReconstruction /
// creativeBrief / visualGuardrails）重新调用一次 /api/variants，不重跑前四个阶段。
//
// 新的 themeVariants revision 会让服务端 propagateStale 递归作废下游的
// variant / fullStory / animationPlan / 镜头媒体——这是 P0 的状态隔离要求，
// 不是可选项。所以下游已经有产出时必须先明确征求同意，拒绝就什么都不动。
async function regenerateThemeVariants() {
  const workspaceEpoch = browserWorkspace.epoch;
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

  resetStoryPackageStatus();
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
        count: Number(elements.variantCount.value),
        // 只是给模型的目标，与 Full Story 那处同一个调用形状：不写入 Artifact、
        // 不参与派生。候选的 estimatedSeconds 合计会决定下游成片长度，所以目标
        // 必须在这一阶段就送到，否则模型只能凭空估。
        targetDurationSeconds: resolveStoryDurationTarget(state.storyDurationTarget, {
          metadata: state.metadata,
          sourceScriptReconstruction: state.output.sourceScriptReconstruction
        })
      },
      artifactId: "themeVariants",
      artifactType: "themeVariants",
      dependencyIds: ["referenceAnalysis", "sourceScriptReconstruction", "creativeBrief", "visualGuardrails"]
    });
    state.output.themeVariants = themeVariants;
    // 旧的选中项已经不存在了，别让它继续指向一个已作废的 variant。
    state.selectedVariantId = null;
    state.backgroundMusicDrafts = {};
    setStage("variants", "done");
    endStageUsage();
  } catch (error) {
    if (!browserWorkspace.isCurrent(workspaceEpoch)) return;
    setStage("variants", isTaskCapacityError(error) ? "" : "error");
    failedStageUsageSuffix();
    showError(
      isTaskCapacityError(error) ? taskCapacityMessage(error) : error.message || "重新生成主题变体失败",
      isTaskCapacityError(error) ? "notice" : "error"
    );
  } finally {
    if (!browserWorkspace.isCurrent(workspaceEpoch)) return;
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
    renderBackgroundMusicControls();
    return;
  }
  if ((currentMode !== "none") === enabled) {
    state.backgroundMusicDrafts[variantId] = enabled;
    renderBackgroundMusicControls();
    return;
  }
  // 已有 Plan：切换必须重生整包，不能只改提示词末尾。明确征求同意。
  const confirmed = window.confirm(
    `切换背景音乐需要用模型重新生成整个 Animation Plan。\n`
    + `新 Plan 会签发新的 revision 和媒体目录，该变体已生成的镜头视频将全部失效。\n\n是否继续？`
  );
  if (!confirmed) {
    renderBackgroundMusicControls();
    return;
  }
  state.backgroundMusicDrafts[variantId] = enabled;
  renderBackgroundMusicControls();
  state.selectedVariantId = variantId;
  await generateAnimationPlan({ force: true });
}

// 配乐开关在哪：候选卡上（参考视频入口、只给角色设定），或分场页上（粘贴完整故事没有候选卡）。
function renderBackgroundMusicControls() {
  if (isStorySourceRun()) renderStoryMusicControl();
  else renderVariants(state.output.themeVariants);
}

function renderStoryMusicControl() {
  const container = elements.storyMusicControl;
  if (!isStorySourceRun()) {
    container.innerHTML = "";
    return;
  }
  const enabled = backgroundMusicEnabled(STORY_ENTRY_VARIANT_ID);
  container.innerHTML = `<label class="variant-switch" title="${enabled ? "开启：允许为分镜生成背景音乐" : "关闭：成片只保留现场环境声与动作声"}">
      <input type="checkbox" data-background-music="${escape(STORY_ENTRY_VARIANT_ID)}" aria-label="分镜的背景音乐"${enabled ? " checked" : ""}${state.animationRunning ? " disabled" : ""}>
      <span class="variant-switch-track" aria-hidden="true"></span>
      <span class="variant-switch-label">配乐</span>
    </label>`;
}

function navigateToStory(variantId) {
  if (!variantId) return;
  state.selectedVariantId = variantId;
  history.pushState({ storyVariantId: variantId }, "", `/story/${encodeURIComponent(variantId)}`);
  // 粘贴完整故事的可翻拍镜头由「开始拆镜头」那一步生成，进分场页不自动发起计费调用。
  renderStoryPage({ autoGenerate: !isStorySourceRun() });
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
  resetStoryPackageStatus();
  elements.storyPage.classList.add("hidden");
  elements.mainPage.classList.remove("hidden");
  scheduleDirectorAgentRefresh();
}

function renderStoryPage({ autoGenerate = false } = {}) {
  syncStoryPackageStatusContext();
  elements.mainPage.classList.add("hidden");
  elements.storyPage.classList.remove("hidden");
  window.scrollTo({ top: 0, behavior: "instant" });
  const variant = selectedVariant();
  renderSelectedVariantSummary(variant);
  renderStoryMusicControl();
  // 展开前体检面板只在它所属的命题页上显示（另一个命题的面板隐藏，状态保留）。
  syncFullStoryPrecheckVisibility();
  const existing = variant ? state.fullStories[variant.id] : null;
  const animationExisting = variant ? state.animationPlans[variant.id] : null;
  syncAnimationAspectRatioControls();
  if (existing) {
    renderFullStory(existing);
    setStoryStatus(`已生成${fullStoryLabel()} · ${storyModelLabel()}`, "ready");
    elements.animationGenerate.disabled = state.animationRunning;
    updateStoryExportActions();
    const legacyPlanVersion = legacyAnimationPlanVersion(animationExisting);
    if (legacyPlanVersion) {
      renderAnimationPlan(animationExisting);
      setAnimationStatus(legacyAnimationPlanMessage(legacyPlanVersion), "warn");
    } else if (animationExisting) {
      renderAnimationPlan(animationExisting);
      setAnimationStatus(`已生成${planShortLabel()} · ${animationModelLabel()}`, "ready");
    } else {
      elements.animationPlan.classList.add("hidden");
      elements.animationPlan.innerHTML = "";
      setAnimationStatus(`可以继续生成${planLabel()}。`, "");
    }
  } else {
    elements.fullStory.classList.add("hidden");
    elements.fullStory.innerHTML = "";
    elements.animationPlan.classList.add("hidden");
    elements.animationPlan.innerHTML = "";
    setAnimationStatus("", "");
    elements.animationGenerate.disabled = true;
    updateStoryExportActions();
    if (variant?.storySourceSlot) {
      setStoryStatus("还没有可翻拍镜头。点下面的按钮按原文拆分，或回到首页点「继续拆镜头」。", "");
    } else if (variant) {
      setStoryStatus("准备生成完整剧情。", "");
      if (autoGenerate) startFullStory();
    } else {
      setStoryStatus(isStoryEntryMode()
        ? "这个页面没有对应的故事。请返回首页重新开始。"
        : "当前页面没有可用主题变体。请先返回工作台，完成视频分析并选择一个主题变体。", "error");
    }
  }
  elements.storyGenerate.disabled = !variant || state.storyRunning;
  syncStoryTaskStatus({ includeTerminal: true });
  updateStoryExportActions();
  void refreshStoryDialogueCheck();
  renderOneSentenceEditHosts();
  scheduleDirectorAgentRefresh();
}

function renderSelectedVariantSummary(variant) {
  if (!variant) {
    elements.selectedVariantSummary.innerHTML = `<div class="warning-box"><b>缺少选中主题。</b> 当前浏览器状态里没有主题变体结果，无法继续生成完整剧情。</div>`;
    return;
  }
  // 粘贴完整故事：左侧显示用户原文本身，而不是一张由模型整理出来的候选摘要。
  if (variant.storySourceSlot) {
    const text = state.output.storySource?.storyText || "";
    elements.selectedVariantSummary.innerHTML = `
      <span class="variant-number">${escape(variant.id)} · 你的故事</span>
      <h3>你的故事（原文）</h3>
      <p class="story-source-original">${escape(text)}</p>
      <small class="story-source-note">共 ${escape(storyTextLength(text))} 字 · 情节、人物、结局和台词都按原文</small>`;
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
      ${optionalCastSpan("媒介", variant.emotionalMedium)}
    </div>`;
}

// 「与原片对齐」的标签带上实际秒数，让用户在生成前就知道会得到多长。
// 上传参考片后与恢复旧 run 后都要刷新一次。
function renderStoryDurationOptions() {
  const options = storyDurationOptions({
    metadata: state.metadata,
    sourceScriptReconstruction: state.output?.sourceScriptReconstruction,
    entryMode: state.entryMode
  });
  elements.storyDurationTarget.innerHTML = options
    .map((option) => `<option value="${escape(option.value)}">${escape(option.label)}</option>`)
    .join("");
  elements.storyDurationTarget.value = state.storyDurationTarget;
}

// ---------------------------------------------------------------------------
// 展开前体检（2026-09-17）
//
// 点「生成完整剧情」时先跑一次体检，**在签发 `variant:<id>` 之前**——体检只出报告，
// 这一刻还什么都没签发，所以判出要修订时改候选的代价为零。三条路：
//   直接展开 → 原样走 generateFullStory，多花的只有体检那一次调用；
//   需修订   → 立刻做一次 scope:root 修订并**只展示差异**，签发只发生在用户点采纳那一刻；
//   体检失败 → 如实显示原因，给「按原候选展开」与「重试体检」，**绝不静默跳过**。
//
// 判定依据见 docs/full-story-precheck-ab-2026-09-16.md：三个样本各 2/2 达到事前登记的
// 通过线。**它不保证判得对**——承诺清单写得准不准、定位读得对不对都需要语义判断，
// 没有确定性兜底；评审那一路本身也会整次失败（6 次里 2 次），这是体检可用率的上限。
let fullStoryPrecheckState = null;
// 体检失败的原因。原来只写进体检面板的 HTML，导演助手读不到；与 fullStoryPrecheckState 同规格，
// 只活在页面上，新的一次体检或「按原候选展开」时清掉。
let fullStoryPrecheckFailure = null;

// 体检与修订都只活在页面上：不进 Artifact、不进 lineage、刷新即失，与评审同规格。
function clearFullStoryPrecheck() {
  fullStoryPrecheckState = null;
  fullStoryPrecheckFailure = null;
  elements.fullStoryPrecheck.innerHTML = "";
  delete elements.fullStoryPrecheck.dataset.variantId;
  elements.fullStoryPrecheck.classList.add("hidden");
}

// 面板只属于一个命题，只在那个命题的页面上显示（2026-10-05 修复）。此前切换命题时面板原样留着，
// 「采纳修订并展开」会签发 A 的修订、却为当前选中的 B 付费展开。切走时只隐藏、不丢状态：
// 回到原命题仍能看到已经付费生成的修订稿。
function renderFullStoryPrecheckPanel(html, variantId = fullStoryPrecheckState?.variantId || state.selectedVariantId) {
  elements.fullStoryPrecheck.innerHTML = html;
  elements.fullStoryPrecheck.dataset.variantId = String(variantId || "");
  bindFullStoryPrecheckActions(elements.fullStoryPrecheck);
  syncFullStoryPrecheckVisibility();
}

function syncFullStoryPrecheckVisibility() {
  const panel = elements.fullStoryPrecheck;
  const visible = Boolean(panel.innerHTML) && panel.dataset.variantId === String(state.selectedVariantId || "");
  panel.classList.toggle("hidden", !visible);
}

// 按面板上记的命题判断，而不是按体检状态：体检失败时状态已清空，但失败面板上的「重试体检」
// 「按原候选展开」仍然只该作用于它自己那个命题。
function precheckBelongsToSelectedVariant() {
  const owner = elements.fullStoryPrecheck.dataset.variantId;
  return Boolean(owner) && owner === String(state.selectedVariantId || "");
}

// 面板与当前命题不符时一律作废：不签发、不展开，宁可让用户对当前命题重新体检。
function discardForeignPrecheck() {
  clearFullStoryPrecheck();
  setStoryStatus("这份展开前体检属于另一个命题，已作废；没有签发或展开任何东西，请对当前命题重新生成。", "warn");
}

function bindFullStoryPrecheckActions(root) {
  for (const button of root.querySelectorAll("[data-precheck-expand]")) {
    button.addEventListener("click", () => {
      if (!precheckBelongsToSelectedVariant()) return discardForeignPrecheck();
      clearFullStoryPrecheck();
      // 用户明确选择按原候选展开，就照原候选展开——体检只出报告，不是闸门。
      void generateFullStory({ force: true });
    });
  }
  for (const button of root.querySelectorAll("[data-precheck-retry]")) {
    button.addEventListener("click", () => {
      if (!precheckBelongsToSelectedVariant()) return discardForeignPrecheck();
      void startFullStory({ force: true });
    });
  }
  for (const button of root.querySelectorAll("[data-precheck-adopt]")) {
    button.addEventListener("click", () => void adoptPrecheckRevisionAndExpand(button));
  }
}

// 体检入口。**只有这里会调体检**；generateFullStory 仍是纯展开路径，
// 采纳之后的续跑与既有的 durable task 恢复都直接走它，不会再体检第二次。
async function startFullStory({ force = false } = {}) {
  const workspaceEpoch = browserWorkspace.epoch;
  const variant = selectedVariant();
  if (!variant) return setStoryStatus("请先选择一个可拍摄主题变体。", "error");
  // 已有剧情且不是强制重生成时沿用原行为：直接展示，不体检、不花钱。
  if (!force && state.fullStories[variant.id]) return generateFullStory({ force });
  if (state.storyRunning || state.storyPrecheckRunning) return;
  if (activeTaskForKinds(["fullStory"], { rootOnly: true })) return;
  // 展开前体检要对照原片脚本还原，剧情入口没有原片：直接展开。
  if (isStoryEntryMode()) {
    // 重新拆分按原文重来：用一句话改过的地方会被覆盖（2026-10-11），已有分镜时分镜和镜头视频也会过期。
    // 只要已经拆过就先问一句，与拨配乐开关同规格。
    if (variant.storySourceSlot && state.fullStories[variant.id] && !window.confirm(state.animationPlans[variant.id]
      ? "重新拆分会按原文重新拆一遍：现在的可翻拍镜头（包括用一句话改过的地方）会被替换，已经生成的分镜和镜头视频也会失效，需要重新生成。继续吗？"
      : "重新拆分会按原文重新拆一遍：现在的可翻拍镜头（包括用一句话改过的地方）会被替换。继续吗？")) return undefined;
    return generateFullStory({ force });
  }

  const sourceThemeVariants = state.output?.themeVariants;
  if (!sourceThemeVariants) return generateFullStory({ force });
  // 上一次体检已判「直接展开」、命题又一字没改：直接展开，不再花钱重跑。体检只看候选，
  // 候选没变，再跑一次没有新信息，只是重掷一次骰子。起因（2026-09-18）：展开失败之后
  // 每点一次生成就重新体检一次，当天白跑了两次（每次约 ¥0.8）。候选一变（采纳修订、换一批）或页面刷新，照常体检。
  if (precheckPassStillValid(variant.id, sourceThemeVariants)) return generateFullStory({ force: true });
  clearFullStoryPrecheck();
  state.storyPrecheckRunning = true;
  elements.storyGenerate.disabled = true;
  beginStageUsage();
  // 体检与随后的修订共用一次记账，在交棒给展开之前结掉：展开自己会重开一次，
  // 不结掉就等于把体检花的钱算进展开、或者干脆丢掉。
  let usageClosed = false;
  const closeUsage = () => {
    if (usageClosed) return "";
    usageClosed = true;
    return formatStageUsageSuffix(endStageUsage());
  };
  setStoryStatus("正在做展开前体检：这个命题现在展开合不合适…（约 1–3 分钟）", "active");
  try {
    const result = await api("/api/full-story-precheck", {
      themeVariants: sourceThemeVariants,
      candidateId: variant.id,
      creatorProfile: profile(),
      // 与既有评审逐字同一组上游：缺任何一份都不阻断，只是少一节判断依据。
      sourceScriptReconstruction: state.output.sourceScriptReconstruction,
      visualGuardrails: state.output.visualGuardrails,
      creativeBrief: state.output.creativeBrief,
      referenceAnalysis: state.output.referenceAnalysis
    });
    if (!browserWorkspace.isCurrent(workspaceEpoch)) return;
    assertSelectedVariant(variant.id);
    fullStoryPrecheckState = {
      variantId: variant.id,
      sourceThemeVariants,
      route: result.route,
      reasons: result.reasons || [],
      review: result.review,
      promiseCheck: result.promiseCheck,
      metadata: result.metadata || null
    };
    if (result.route === "expand") {
      const suffix = closeUsage();
      renderFullStoryPrecheckPanel(renderPrecheckPassed(result, suffix));
      state.storyPrecheckRunning = false;
      // await 而不是直接 return：展开自己会接管按钮与状态，
      // 不等它结束就跑 finally 会把按钮在生成中途重新点亮。
      await generateFullStory({ force: true });
      return;
    }
    setStoryStatus("体检报出问题，正在改这一个命题…（还没有签发任何东西）", "active");
    renderFullStoryPrecheckPanel(renderPrecheckFindings(fullStoryPrecheckState));
    await requestPrecheckRevision(workspaceEpoch, closeUsage);
  } catch (error) {
    if (!browserWorkspace.isCurrent(workspaceEpoch)) return;
    fullStoryPrecheckState = null;
    fullStoryPrecheckFailure = { id: `precheck:${variant.id}:${Date.now()}`, variantId: variant.id, message: error?.message || "未知原因" };
    // 失败前调用过的模型照样计费，必须显示出来，不能显示成没花钱。
    setStoryStatus(`展开前体检失败：${error?.message || "未知原因"}${closeUsage()}`, "error");
    // 状态已清空，面板归属必须显式给出：用户中途切走时，这块失败面板仍属于原命题。
    renderFullStoryPrecheckPanel(renderPrecheckFailure(error), variant.id);
  } finally {
    if (!browserWorkspace.isCurrent(workspaceEpoch)) return;
    closeUsage();
    state.storyPrecheckRunning = false;
    elements.storyGenerate.disabled = !selectedVariant() || state.storyRunning;
  }
}

function precheckPassStillValid(variantId, themeVariants) {
  const entry = fullStoryPrecheckState;
  return Boolean(entry && entry.route === "expand" && entry.variantId === variantId
    && JSON.stringify(entry.sourceThemeVariants) === JSON.stringify(themeVariants));
}

// 修订：把体检判出的信号原样交给 scope:root。**结果不写回任何东西**，
// 与命题定向修订同规格——签发只发生在用户点采纳那一刻。
async function requestPrecheckRevision(workspaceEpoch, closeUsage) {
  const entry = fullStoryPrecheckState;
  if (!entry) return;
  try {
    const result = await api("/api/story-candidate-revision", {
      themeVariants: entry.sourceThemeVariants,
      review: entry.review,
      promiseCheck: entry.promiseCheck,
      candidateId: entry.variantId,
      scope: "root",
      creatorProfile: profile(),
      // 边界验签比对整份上游的 sourceDigest，这几份必须一起送；
      // 只用于验签与合并后的复验，**不进修订提示词**。
      visualGuardrails: state.output.visualGuardrails,
      creativeBrief: state.output.creativeBrief,
      referenceAnalysis: state.output.referenceAnalysis,
      sourceScriptReconstruction: state.output.sourceScriptReconstruction,
      targetDurationSeconds: resolveStoryDurationTarget(state.storyDurationTarget, {
        metadata: state.metadata,
        sourceScriptReconstruction: state.output.sourceScriptReconstruction
      })
    });
    if (!browserWorkspace.isCurrent(workspaceEpoch)) return;
    if (fullStoryPrecheckState !== entry) return;
    entry.revision = { ...result, sourceThemeVariants: entry.sourceThemeVariants };
    // 用户这 1–3 分钟里可能已经切到别的命题：修订稿照样留给原命题（已经付费），只是不在别的命题页上显示。
    const message = `修订稿已生成，还没有生效——看过差异后再决定。${closeUsage()}`;
    if (entry.variantId === String(state.selectedVariantId || "")) setStoryStatus(message, "warn");
    renderFullStoryPrecheckPanel(
      renderPrecheckFindings(entry)
      + renderStoryCandidateRevision(entry.variantId, entry.revision, { withAdoptButton: false })
      + renderPrecheckDecision(),
      entry.variantId
    );
  } catch (error) {
    if (!browserWorkspace.isCurrent(workspaceEpoch)) return;
    if (fullStoryPrecheckState !== entry) return;
    const message = `修订失败：${error?.message || "未知原因"}${closeUsage()}`;
    if (entry.variantId === String(state.selectedVariantId || "")) setStoryStatus(message, "error");
    renderFullStoryPrecheckPanel(
      renderPrecheckFindings(entry)
      + `<p class="story-review-status error">${escape(error?.message || "定向修订失败")}</p>`
      + renderPrecheckDecision({ withoutAdopt: true }),
      entry.variantId
    );
  }
}

// 采纳：这才是签发新 themeVariants 版本的地方，之后立刻续跑展开。
// **续跑走 generateFullStory，不会再体检一次**——改完再体检一遍只会没完没了地花钱。
async function adoptPrecheckRevisionAndExpand(button) {
  const entry = fullStoryPrecheckState;
  if (!entry?.revision || button.disabled) return;
  // 修订稿必须属于当前命题才能签发（2026-10-05 修复：此前会签发 A 的修订、再为 B 付费展开）。
  if (!precheckBelongsToSelectedVariant() || entry.variantId !== String(state.selectedVariantId || "")) {
    return discardForeignPrecheck();
  }
  const workspaceEpoch = browserWorkspace.epoch;
  button.disabled = true;
  const original = button.textContent;
  button.textContent = "签发中…";
  try {
    const outcome = await adoptThemeVariantsRevision(entry.revision, workspaceEpoch);
    // 过期意味着这份体检与修订都是对旧命题算的，整块作废；拒绝则原样留着。
    if (outcome === "stale") clearFullStoryPrecheck();
    if (outcome !== "adopted") {
      button.disabled = false;
      button.textContent = original;
      return;
    }
    clearFullStoryPrecheck();
    // 签发期间用户切到了别的命题：修订已经生效，但不替用户展开另一个命题。
    if (entry.variantId !== String(state.selectedVariantId || "")) {
      setStoryStatus("修订已签发；当前选中的是另一个命题，没有自动展开。回到原命题后再点「生成完整剧情」。", "warn");
      return;
    }
    await generateFullStory({ force: true });
  } catch (error) {
    if (!browserWorkspace.isCurrent(workspaceEpoch)) return;
    showError(error.message || "修订签发失败；原命题保持不变。");
    button.disabled = false;
    button.textContent = original;
  }
}

function renderPrecheckPassed(result, usageSuffix = "") {
  const call = result?.metadata?.fullStoryPromiseCheck || null;
  return `${resultHeader("PRECHECK", "展开前体检：通过", `直接展开${escape(usageSuffix)}`)}
    <p class="story-review-status">因果断裂、换皮、BLOCKER 硬伤与标题/钩子的承诺都没有报出问题，
      已直接开始展开。${call && call.providerCalls > 2 ? "（承诺核对第一次被确定性校验拦下，用的是重做的结果）" : ""}</p>
    <p class="muted-note warn">体检只出报告，判得对不对没有确定性兜底：承诺清单写得准不准、
      定位读得对不对都要靠人看。通过不等于这个命题一定好。</p>`;
}

function renderPrecheckFindings(entry) {
  const reasons = (entry.reasons || [])
    .map((reason) => `<li>${escape(FULL_STORY_PRECHECK_REASON_LABELS[reason] || reason)}</li>`)
    .join("");
  const gaps = (entry.promiseCheck?.promises || [])
    .filter((promise) => promise.verdict !== "realized")
    .map((promise) => {
      const missing = (promise.findings || [])
        .filter((finding) => finding.found !== true)
        .map((finding) => `<li>${escape(promise.mustSee?.[finding.mustSeeIndex] || "")}
          <br><b>动作链里实际写的是：</b>${escape(finding.why || "")}</li>`)
        .join("");
      return `<div class="rule">
        <strong>${escape(promise.source === "title" ? "标题" : "一句话钩子")}「${escape(promise.quote)}」</strong>
        <p>${escape(promise.promise)}</p>
        <ul class="precheck-missing">${missing}</ul>
      </div>`;
    }).join("");
  const breaks = (candidateReviewCheck(entry)?.coherenceChecks || [])
    .map((check) => `<div class="rule"><strong>第 ${escape((check.beatIndexes || []).join("、"))} 拍</strong>
      <p>${escape(check.problem)}</p></div>`).join("");
  return `${resultHeader("PRECHECK", "展开前体检：建议先改这个命题", `${escape((entry.reasons || []).length)} 类问题`)}
    <div class="summary-strip">还没有签发任何东西。修订稿会并排显示，你点采纳才生效。</div>
    <ul class="precheck-reasons">${reasons}</ul>
    ${gaps ? block("标题或钩子许诺了、动作链没演出来", `<div class="rule-list stacked">${gaps}</div>`) : ""}
    ${breaks ? block("动作链的因果断裂", `<div class="rule-list">${breaks}</div>`) : ""}`;
}

function candidateReviewCheck(entry) {
  const checks = entry?.review?.candidateChecks;
  if (!Array.isArray(checks)) return null;
  return checks.find((check) => String(check.candidateId) === String(entry.variantId)) || null;
}

function renderPrecheckDecision({ withoutAdopt = false } = {}) {
  return `<div class="candidate-revision-action">
    ${withoutAdopt ? "" : `<button type="button" class="primary-button" data-precheck-adopt>采纳修订并展开</button>`}
    <button type="button" class="outline-button" data-precheck-expand>按原候选展开</button>
    <span class="muted-note warn">采纳会签发新的主题命题版本，这一批<b>全部命题</b>的下游都会失效
      （即使别的命题一个字没改，因为它们同属一份 Artifact）。还没往下做时代价为零。</span>
  </div>`;
}

function renderPrecheckFailure(error) {
  return `${resultHeader("PRECHECK", "展开前体检失败", "没有判定")}
    <p class="story-review-status error">${escape(error?.message || "未知原因")}</p>
    <p class="muted-note warn">体检把现有候选评审当作必需的一路，而<b>评审自己会整次失败</b>
      （2026-09-17 的实测里 6 次有 2 次），失败时没有任何路由判定，不是「体检通过」。
      可以重试，也可以直接按原候选展开。</p>
    <div class="candidate-revision-action">
      <button type="button" class="outline-button" data-precheck-retry>重试体检</button>
      <button type="button" class="outline-button" data-precheck-expand>按原候选展开</button>
    </div>`;
}

// 完整剧情签发时依赖的上游。**生成与「按问题修改」的采纳共用这一份**：
// 两处各列一遍，迟早出现一边多绑、一边少绑，lineage 就对不上了。
function fullStoryDependencyIds(variantId) {
  return [
    "referenceAnalysis",
    "sourceScriptReconstruction",
    "creativeBrief",
    "visualGuardrails",
    "themeVariants",
    `variant:${variantId}`
  ];
}

async function generateFullStory({ force = false } = {}) {
  const workspaceEpoch = browserWorkspace.epoch;
  if (state.storyRunning || activeTaskForKinds(["fullStory"], { rootOnly: true })) return;
  const variant = selectedVariant();
  if (!variant) return setStoryStatus("请先选择一个可拍摄主题变体。", "error");
  if (!force && state.fullStories[variant.id]) {
    renderFullStory(state.fullStories[variant.id]);
    return;
  }
  const request = { variantId: variant.id, epoch: workspaceEpoch, taskId: "" };
  state.storyGenerationRequest = request;
  state.storyRunning = true;
  setStoryRunning(true);
  beginStageUsage();
  setStoryStatus(`正在调用 ${storyModelLabel()} ${variant.storySourceSlot ? "按原文拆分镜头" : "生成完整剧情"}…`, "active");
  try {
    const candidateLineage = await ensureSelectedVariantArtifact(variant);
    assertWorkspaceCurrent(workspaceEpoch);
    const fullStory = await requestProductionArtifact({
      endpoint: "/api/full-story",
      requestBody: {
        fullStorySchemaVersion: "full_story/1.2",
        ...videoUpstreamCopies(),
        visualGuardrails: state.output.visualGuardrails,
        // 粘贴完整故事没有候选：只告诉服务端故事位，原文由服务端从 storySource 取。
        ...(variant.storySourceSlot ? { variantId: variant.id } : {
          themeVariants: state.output.themeVariants,
          variant,
          candidateBinding: lineageDependency(candidateLineage)
        }),
        creatorProfile: profile(),
        // 只是给模型的目标；Artifact 里的 targetDurationSeconds 仍由服务端从
        // sceneScript 时间轴派生，模型没打准时页面显示的也是派生出的真实值。
        targetDurationSeconds: resolveStoryDurationTarget(state.storyDurationTarget, {
          metadata: state.metadata,
          sourceScriptReconstruction: state.output.sourceScriptReconstruction,
          entryMode: state.entryMode
        })
      },
      artifactId: `fullStory:${variant.id}`,
      artifactType: "fullStory",
      onTaskCreated(task) {
        assertWorkspaceCurrent(workspaceEpoch);
        if (state.storyGenerationRequest === request) request.taskId = task.taskId;
      },
      dependencyIds: fullStoryDependencyIds(variant.id)
    });
    assertSelectedVariant(variant.id);
    state.fullStories[variant.id] = fullStory;
    state.output.fullStories = state.fullStories;
    state.output.fullStory = fullStory;
    renderFullStory(fullStory);
    void refreshStoryDialogueCheck();
    setStoryStatus(`${fullStoryLabel()}已生成 · ${persistedTaskModelLabel(`fullStory:${variant.id}`, "fullStory", storyModelLabel())}${formatStageUsageSuffix(endStageUsage())}`, "ready");
    elements.animationGenerate.disabled = false;
    setAnimationStatus(`可以继续生成${planLabel()}。`, "");
    updateStoryExportActions();
    elements.export.classList.remove("hidden");
  } catch (error) {
    if (!browserWorkspace.isCurrent(workspaceEpoch)) return;
    renderFullStoryTaskError(error, `${fullStoryLabel()}生成失败`, variant.id);
  } finally {
    if (!browserWorkspace.isCurrent(workspaceEpoch)) return;
    endStageUsage();
    if (state.storyGenerationRequest === request) {
      state.storyGenerationRequest = null;
      state.storyRunning = false;
      setStoryRunning(false);
      if (request.taskId || state.storyTaskStatusVisible) syncStoryTaskStatus({ includeTerminal: true });
    }
  }
}

function renderFullStory(data) {
  const narrativeStory = isNarrativeFullStory(data);
  // 形状提示只统计结构化字段（地点+出镜角色、说话者分布），不做语义判断，
  // 也不阻断任何操作——目的是让画面单调和台词集中在生成视频之前就被看见。
  const shapeWarnings = fullStoryShapeWarnings(data);
  const shapeStrip = shapeWarnings.length
    ? `<div class="shape-warnings">${shapeWarnings
        .map((w) => `<span class="shape-warning" title="${escape(w.detail)}">${escape(w.label)}</span>`)
        .join("")}</div>`
    : "";
  // 粘贴完整故事的 fullStory 是按原文拆出的可翻拍镜头：换叫法，并且不提供「检查剧情硬伤」
  // （它要拿故事候选核对承诺，这类 Run 没有候选）。
  const storySource = isStorySourceRun();
  elements.fullStory.innerHTML = `${resultHeader(storySource ? "SHOTS" : "FULL STORY", data.title || fullStoryLabel(), `${escape(data.targetDurationSeconds || 60)} 秒`)}
    <div class="summary-strip">${escape(data.oneLinePremise || data.shootingSynopsis)}</div>
    ${shapeStrip}
    <div class="data-grid">
      ${cell("主角锁定", data.characterBible?.protagonist?.identity || data.characterBible?.protagonist?.name)}
      ${data.characterBible?.careRecipient ? cell("被关爱对象", joinParts(data.characterBible.careRecipient, ["identity", "implicitNeed"])) : ""}
      ${cell("对白规则", data.dialogueStyleGuide?.protagonistSpeechRule || data.characterBible?.protagonist?.speechRules)}
    </div>
    ${block("剧情梗概", `<p class="long-copy">${escape(data.shootingSynopsis)}</p>`)}
    ${data.characterBible?.supportingCharacters ? block("完整配角设定", factSheet(data.characterBible.supportingCharacters.map((row) => ({
      name: row.name, note: row.identity,
      facts: [
        { label: "与主角", html: escape(row.relationshipToProtagonist) },
        { label: "剧情作用", html: escape(row.storyRole) },
        dotList(row.appearanceFacts, escape)
          ? { label: "外观", html: dotList(row.appearanceFacts, escape) }
          : { label: "外观", html: "外观未指定，分镜阶段设计", tone: "muted" },
        { label: "性格", html: dotList(row.personalityFacts, escape) },
        { label: "说话", html: dotList(row.speechRules, escape) }
      ]
    })), escape)) : ""}
    ${narrativeStory ? "" : block("剧情节拍", `<div class="beat-list">${(data.beatSheet || []).map((beat) => `<div class="beat"><strong>${escape(beat.timeRange)} · ${escape(beat.emotion)}</strong><p>${escape(beat.storyAction)}<br><b>功能：</b>${escape(beat.dramaticFunction)}<br><b>保留价值：</b>${escape(beat.retainedValueFromBrief)}</p></div>`).join("")}</div>`)}
    ${block(storySource ? "可翻拍镜头（按原文分场）" : "可拍分场剧本", `<div class="timeline">${(data.sceneScript || []).map((scene) => `<div class="scene">
      <span class="scene-id">${escape(scene.sceneId)}</span>
      <div class="scene-head"><strong>${escape(scene.location)}</strong><span>${escape(scene.timeRange)}</span></div>
      <dl class="kv">
        <dt>人物</dt><dd>${escape((scene.characters || []).join("、") || "无人出镜")}</dd>
        <dt>动作</dt><dd>${escape(scene.visibleAction)}</dd>
        <dt>对白</dt><dd>${formatDialogue(scene.dialogue)}</dd>
        <dt>${narrativeStory ? "声音" : "镜头/声音"}</dt><dd>${escape(scene.shotAndSound)}</dd>
        ${scene.shootingNotes ? `<dt>${narrativeStory ? "剧情备注" : "拍摄备注"}</dt><dd>${escape(scene.shootingNotes)}</dd>` : ""}
      </dl>
      <div class="scene-meta">${scene.emotionNode ? `<span><b>情绪</b>${escape(scene.emotionNode)}</span>` : ""}${scene.dramaticFunction ? `<span><b>剧情功能</b>${escape(scene.dramaticFunction)}</span>` : ""}</div>
    </div>`).join("")}</div>`)}
    ${block("关键道具", `<div class="rule-list">${(data.keyProps || []).map((item) => `<div class="rule"><strong>${escape(item.prop)}</strong><p>${escape(item.storyFunction)}<br>${escape(item.visualUse)}${narrativeStory ? "" : `<br><b>避相似：</b>${escape(item.avoidSimilarityNote)}`}</p></div>`).join("")}</div>`)}
    ${narrativeStory ? "" : block("拍摄计划", `<div class="rule-list">${(data.shootingPlan || []).map((item) => `<div class="rule"><strong>${escape(item.unit)}</strong><p>${escape(item.setup)}<br><b>必拍：</b>${escape(item.mustCapture)}<br><b>执行：</b>${escape(item.practicalNote)}</p></div>`).join("")}</div>`)}
    ${narrativeStory ? "" : block("体验保真", `<div class="data-grid">
      ${cell("定位", data.experienceFidelity?.positioning)}${cell("受众", data.experienceFidelity?.audience)}${cell("情绪", data.experienceFidelity?.emotion)}
      ${cell("驱动力", data.experienceFidelity?.plotDriver)}${cell("高价值桥段", data.experienceFidelity?.highValueBeats)}${cell("改写证明", data.transformationProof?.changedVisualExpression)}
    </div>`)}
    ${narrativeStory ? "" : `<div class="warning-box"><b>连续性检查：</b> ${escape(Object.values(data.continuityAndSafetyCheck || {}).filter(Boolean).join("；")) || "已通过结构校验"}</div>`}
    ${uncertainties(data.uncertainties)}
    ${storySource ? "" : `<div class="story-review">
      <button type="button" class="outline-button" data-story-review>检查剧情硬伤</button>
      <span class="story-review-hint">核对候选承诺有没有演出来，并做编辑诊断。可以勾选问题生成局部修改——看过对照、点「采纳」之前不会改动剧情。</span>
      <div class="story-review-body" data-story-review-body></div>
    </div>`}`;
  reveal(elements.fullStory);
  const button = elements.fullStory.querySelector("[data-story-review]");
  if (button) button.addEventListener("click", () => runStoryQualityReview(data, button));
}

// 剧情体检的报告与「按问题修改」的修订稿都只活在页面上：不落盘、不进 lineage，刷新即失。
// 两者都记下它们是针对**哪一份剧情**算出来的——剧情一变，它们就作废。
let lastStoryQualityReview = null;
let storyQualityRepairDraft = null;

// 剧情体检：手动触发，只出报告。不改剧情、不签发 Artifact、不阻断后续阶段。
async function runStoryQualityReview(fullStory, button) {
  const workspaceEpoch = browserWorkspace.epoch;
  const body = elements.fullStory.querySelector("[data-story-review-body]");
  if (!body || button.disabled) return;
  button.disabled = true;
  const original = button.textContent;
  button.textContent = "体检中…";
  lastStoryQualityReview = null;
  storyQualityRepairDraft = null;
  body.innerHTML = `<p class="story-review-status">正在核对候选承诺并做编辑诊断，两次调用约 1–3 分钟…</p>`;
  try {
    // 承诺核对要拿候选当外部参照，所以必须把候选一起送上去；
    // 固定角色设定是编辑诊断判 character_contract 的依据。
    const result = await api("/api/story-quality-review", {
      fullStory,
      themeVariants: state.output?.themeVariants,
      candidateId: fullStory.selectedVariantId,
      creatorProfile: profile()
    });
    if (!browserWorkspace.isCurrent(workspaceEpoch)) return;
    lastStoryQualityReview = {
      variantId: String(fullStory.selectedVariantId || ""),
      fullStory: structuredClone(fullStory),
      review: result.review
    };
    body.innerHTML = renderStoryQualityReview(result.review, result.metadata);
    const repairButton = body.querySelector("[data-story-repair]");
    if (repairButton) repairButton.addEventListener("click", () => requestStoryQualityRepair(body, repairButton));
  } catch (error) {
    if (!browserWorkspace.isCurrent(workspaceEpoch)) return;
    // 评审失败要把原因完整显示出来——它常常是覆盖率核验拦下的漏检，用户需要看到是哪一条。
    body.innerHTML = `<p class="story-review-status error">${escape(error?.message || "体检失败")}</p>`;
  } finally {
    if (!browserWorkspace.isCurrent(workspaceEpoch)) return;
    button.disabled = false;
    button.textContent = original;
  }
}

const REVIEW_VERDICT_LABEL = { depicted: "已兑现", partially_depicted: "只沾边", not_depicted: "画面里没有" };
const REVIEW_SEVERITY_LABEL = { BLOCKER: "严重", MAJOR: "建议", MINOR: "小问题" };

function renderStoryQualityReview(review, metadata = null) {
  const metrics = storyReviewMetrics(review);
  const checks = review.promisePreservation?.checks || [];
  // 可修条目的引用号只有一份（与服务端的选择校验共用），按对象身份对回到每一行上。
  // 「按问题修改」要对照签名的原片脚本还原，剧情入口暂不支持：不给勾选，也不给修改按钮。
  const repairable = isStoryEntryMode() ? [] : storyQualityRepairableItems(review);
  const refOf = new Map(repairable.map((item) => [item.kind === "issue" ? item.issue : item.check, item.ref]));
  const pick = (entry) => (refOf.has(entry)
    ? `<label class="story-repair-pick"><input type="checkbox" data-story-repair-ref="${escape(refOf.get(entry))}" checked> 修这一条</label>`
    : "");
  // 没守住的排在前面：那才是要看的；守住的折叠进一句统计，不占版面。
  const brokenRows = checks.filter((check) => check.status !== "PRESERVED").map((check) => `
    <div class="review-check">
      <div class="review-check-head">
        <span class="scene-id">${escape((check.source || []).map((field) => PROMISE_SOURCE_LABELS[field] || field).join(" / "))}</span>
        <span class="review-verdict verdict-${escape(check.status)}">${escape(PROMISE_CHECK_STATUS_LABELS[check.status] || check.status)}</span>
        ${pick(check)}
      </div>
      <p><b>候选承诺：</b>${escape(check.promise)}</p>
      <p><b>剧情里实际写的：</b>${escape(check.evidence)}</p>
    </div>`);
  const issueRows = (review.issues || []).map((issue) => `
    <div class="review-issue severity-${escape(issue.severity)}">
      <div class="review-check-head">
        <span class="review-severity severity-${escape(issue.severity)}">${escape(REVIEW_SEVERITY_LABEL[issue.severity] || issue.severity)}</span>
        <span class="review-scenes">${escape(STORY_QUALITY_ISSUE_TYPE_LABELS[issue.type] || issue.type)}　${escape((issue.sceneIds || []).join("、") || "全片")}</span>
        ${pick(issue)}
      </div>
      <p>${escape(issue.problem)}</p>
      <p class="review-evidence">原文：${escape(issue.evidence)}</p>
      ${issue.viewerImpact ? `<p><b>对观众：</b>${escape(issue.viewerImpact)}</p>` : ""}
      ${issue.optionalSuggestion
        ? `<p><b>可能的改法：</b>${escape(issue.optionalSuggestion)}
             <span class="muted-note">仅供参考，系统不会自动执行；实测改法会有方向搞反的情况，请自行判断。</span></p>`
        : ""}
      ${issue.evidenceRun ? `<p class="muted-note">这段证据与候选正文最长连续重合 ${Number(issue.evidenceRun)} 字——只是一个事实，不代表问题出在候选。</p>` : ""}
    </div>`);
  // 拦过一次就必须说出来：花掉的钱不能藏起来。
  const retried = Number(metadata?.storyQualityReview?.providerCalls || 0) > 2
    ? `<p class="story-review-status warn">有一次调用被确定性校验拦下，这是重做之后的结果。</p>`
    : "";

  return `
    <div class="review-headline">${escape(storyReviewHeadline(review))}</div>
    ${retried}
    <p class="story-review-status">${escape(review.summary || "")}</p>
    ${brokenRows.length
      ? block("候选承诺没守住的地方", brokenRows.join(""))
      : `<p class="story-review-status">逐条核对了 ${metrics.promisesChecked} 条候选承诺，都能在画面或对白里找到依据。</p>`}
    ${issueRows.length ? block("编辑诊断", issueRows.join("")) : `<p class="story-review-status">编辑诊断没有报出问题。</p>`}
    ${repairable.length ? `
    <div class="story-repair-bar">
      <button type="button" class="outline-button" data-story-repair>按选中的问题生成修改</button>
      <span class="muted-note">另起一次调用写局部修改，这次会对照候选承诺、守住的不许改坏。只出修订稿，看过对照、点「采纳」才会签发新的剧情版本。</span>
    </div>
    <div class="story-repair-slot" data-story-repair-slot></div>` : ""}
    ${isStoryEntryMode() ? `<p class="story-review-status">「从剧情开始」暂不支持按问题自动修改；需要改剧情时，可以调整原文后重新开始。</p>` : ""}
    <p class="story-review-foot">这是一份参考报告，不阻断后续生成；判断有没有道理由你决定。刷新页面后不保留。</p>`;
}

function selectedStoryRepairRefs(root) {
  return [...root.querySelectorAll("[data-story-repair-ref]")]
    .filter((input) => input.checked)
    .map((input) => input.dataset.storyRepairRef);
}

// 按问题修改：只出修订稿。**返回结果不写回任何东西**——与命题修订同规格，
// 签发只发生在用户看过逐字对照、点「采纳」的那一刻。
async function requestStoryQualityRepair(root, button, selectedRefs = selectedStoryRepairRefs(root)) {
  const workspaceEpoch = browserWorkspace.epoch;
  if (!button || button.disabled) return;
  const slot = root.querySelector("[data-story-repair-slot]");
  const entry = lastStoryQualityReview;
  if (!entry) {
    showError("体检报告已失效，请重新体检后再生成修改。");
    return;
  }
  // 报告是针对**当时那一份剧情**算出来的。中途剧情变了就必须作废，
  // 不能把基于旧内容的问题清单套到新剧情上。
  if (JSON.stringify(state.fullStories[entry.variantId]) !== JSON.stringify(entry.fullStory)) {
    lastStoryQualityReview = null;
    storyQualityRepairDraft = null;
    showError("剧情在体检之后已经变了，这份体检报告已作废，请重新体检。");
    return;
  }
  if (!selectedRefs.length) {
    if (slot) slot.innerHTML = `<p class="story-review-status error">先勾选至少一条要修的问题。</p>`;
    return;
  }
  button.disabled = true;
  const original = button.textContent;
  button.textContent = "修改中…";
  storyQualityRepairDraft = null;
  if (slot) slot.innerHTML = `<p class="story-review-status">正在按选中的问题写修改，通常半分钟到一分钟…</p>`;
  try {
    const result = await api("/api/story-quality-repair", {
      fullStory: entry.fullStory,
      review: entry.review,
      selectedRefs,
      themeVariants: state.output.themeVariants,
      creatorProfile: profile(),
      // 这几份只用于验签与修改后的复验——与生成剧情时同一套，**不进修改提示词**。
      creativeBrief: state.output.creativeBrief,
      visualGuardrails: state.output.visualGuardrails,
      referenceAnalysis: state.output.referenceAnalysis,
      sourceScriptReconstruction: state.output.sourceScriptReconstruction
    });
    if (!browserWorkspace.isCurrent(workspaceEpoch)) return;
    storyQualityRepairDraft = { variantId: entry.variantId, sourceFullStory: entry.fullStory, result };
    if (slot) {
      slot.innerHTML = renderStoryQualityRepair(storyQualityRepairDraft);
      const adopt = slot.querySelector("[data-story-repair-adopt]");
      if (adopt) adopt.addEventListener("click", () => adoptStoryQualityRepair(adopt));
    }
  } catch (error) {
    if (!browserWorkspace.isCurrent(workspaceEpoch)) return;
    if (slot) slot.innerHTML = `<p class="story-review-status error">${escape(error?.message || "生成修改失败")}</p>`;
  } finally {
    if (!browserWorkspace.isCurrent(workspaceEpoch)) return;
    button.disabled = false;
    button.textContent = original;
  }
}

const STORY_REPAIR_STATUS_LABELS = { applied: "已改", declined: "没改", rejected: "程序拒绝" };

function dialogueAsText(dialogue) {
  return (Array.isArray(dialogue) ? dialogue : [])
    .map((line) => `${line.speaker}：${line.line}`)
    .join("　/　");
}

// 原文与修订稿逐字并排。「删掉的是不是候选承诺过的细节」「执行者有没有被调换」都没有
// 确定性兜底，只能靠人在这里看——实测唯一一次承诺退化，模型在 note 里如实写了删了什么。
function renderStoryQualityRepair(entry) {
  const result = entry?.result || {};
  const before = entry?.sourceFullStory || {};
  const after = result.fullStory || {};
  const call = result.metadata?.storyQualityRepair || null;
  const rows = (result.results || []).map((row) => `
    <div class="review-check">
      <div class="review-check-head">
        <span class="scene-id">${escape(row.ref)}</span>
        <span class="review-verdict repair-${escape(row.status)}">${escape(STORY_REPAIR_STATUS_LABELS[row.status] || row.status)}</span>
      </div>
      <p class="review-why">${escape(row.note)}</p>
      ${row.reason ? `<p class="muted-note warn">${escape(row.reason)}</p>` : ""}
    </div>`).join("");
  const diffRow = (label, a, b) => `
    <div class="revision-diff">
      <b>${escape(label)}</b>
      <p class="revision-before">${escape(a || "—")}</p>
      <p class="revision-after">${escape(b || "—")}</p>
    </div>`;
  const diffs = (after.sceneScript || []).flatMap((scene, index) => {
    const old = (before.sceneScript || [])[index] || {};
    const out = [];
    if (String(old.visibleAction || "") !== String(scene.visibleAction || "")) {
      out.push(diffRow(`${scene.sceneId} · 动作`, old.visibleAction, scene.visibleAction));
    }
    if (String(old.shotAndSound || "") !== String(scene.shotAndSound || "")) {
      out.push(diffRow(`${scene.sceneId} · 声音`, old.shotAndSound, scene.shotAndSound));
    }
    const oldLines = dialogueAsText(old.dialogue);
    const newLines = dialogueAsText(scene.dialogue);
    if (oldLines !== newLines) out.push(diffRow(`${scene.sceneId} · 台词`, oldLines, newLines));
    return out;
  }).join("");
  const actionChars = (story) => (story.sceneScript || [])
    .reduce((sum, scene) => sum + String(scene.visibleAction || "").length, 0);
  const charsBefore = actionChars(before);
  const charsAfter = actionChars(after);
  const applied = (result.results || []).filter((row) => row.status === "applied").length;
  return `
    <div class="candidate-revision">
      <p class="story-review-status">修订稿（还没有生效）${call && call.providerCalls > 1
    ? ` · 第 ${escape(call.providerCalls)} 次调用的结果，第一次被确定性校验拦下` : ""}</p>
      ${rows}
      ${diffs || `<p class="story-review-status">这次没有可以采纳的修改。</p>`}
      ${diffs ? `<p class="muted-note">
        动作描写字数 ${escape(charsBefore)} → ${escape(charsAfter)}
        ${charsAfter > charsBefore * 1.2 ? "（明显变长了，多半是在靠加戏解决问题——这几场会更挤）" : ""}
      </p>
      <p class="muted-note warn">
        自己看两件事，程序判不了：①有没有把候选写明的细节改掉（note 里会写删了什么）；
        ②动作的执行者有没有被调换。
      </p>
      <div class="candidate-revision-action">
        <button type="button" class="outline-button" data-story-repair-adopt>采纳 ${escape(applied)} 条修改并签发新的剧情版本</button>
        <span class="muted-note warn">采纳会签发新的完整剧情版本；这个命题已经生成的镜头计划、图片与视频都会失效。</span>
      </div>` : ""}
    </div>`;
}

// 采纳：唯一签发新 fullStory 版本的地方。修订稿是针对当时那份剧情算的，
// 中途剧情变了必须作废，绝不把基于旧内容的改写盖到新剧情上。
async function adoptStoryQualityRepair(button) {
  const workspaceEpoch = browserWorkspace.epoch;
  const entry = storyQualityRepairDraft;
  if (!entry || !entry.result?.changed || button.disabled) return;
  const variantId = entry.variantId;
  if (JSON.stringify(state.fullStories[variantId]) !== JSON.stringify(entry.sourceFullStory)) {
    storyQualityRepairDraft = null;
    lastStoryQualityReview = null;
    showError("剧情在修改期间已经变了，这次修订稿已作废，请重新体检。");
    return;
  }
  if (state.storyRunning || state.animationRunning
    || activeTaskForKinds(["fullStory", "animationPlan"], { rootOnly: true })) {
    showError("剧情或镜头计划正在生成，等它结束之后再采纳修改。");
    return;
  }
  const hadPlan = Boolean(state.animationPlans[variantId]);
  if (hadPlan && !window.confirm(
    "采纳会签发新的完整剧情版本。这个命题已经生成的镜头计划，以及它下面已生成的图片与视频都会失效。\n\n是否继续？"
  )) return;
  button.disabled = true;
  const original = button.textContent;
  button.textContent = "签发中…";
  try {
    assertWorkspaceCurrent(workspaceEpoch);
    const next = entry.result.fullStory;
    await commitProductionArtifact({
      artifactId: `fullStory:${variantId}`,
      artifactType: "fullStory",
      content: next,
      dependencyIds: fullStoryDependencyIds(variantId)
    });
    assertWorkspaceCurrent(workspaceEpoch);
    state.fullStories[variantId] = next;
    state.output.fullStories = state.fullStories;
    if (String(state.selectedVariantId || "") === variantId) state.output.fullStory = next;
    const applied = (entry.result.results || []).filter((row) => row.status === "applied").length;
    // 剧情变了，体检报告与这份修订稿一并作废；重新渲染剧情会把旧报告面板一起清掉。
    storyQualityRepairDraft = null;
    lastStoryQualityReview = null;
    renderFullStory(next);
    setStoryStatus(`已采纳 ${applied} 条修改，签发了新的剧情版本。体检报告针对的是旧版本，需要的话请重新体检。`, "ready");
    elements.animationGenerate.disabled = false;
    setAnimationStatus(hadPlan ? "剧情已更新，原来的镜头计划已失效，需要重新生成。" : "可以继续生成动画镜头生产包。", "");
    updateStoryExportActions();
  } catch (error) {
    if (!browserWorkspace.isCurrent(workspaceEpoch)) return;
    showError(error.message || "修改签发失败；原剧情保持不变。");
    button.disabled = false;
    button.textContent = original;
  }
}

async function generateAnimationPlan({ force = false } = {}) {
  const workspaceEpoch = browserWorkspace.epoch;
  if (state.animationRunning) return;
  const variant = selectedVariant();
  if (!variant) return setAnimationStatus("请先选择一个主题变体。", "error");
  const fullStory = state.fullStories[variant.id] || state.output.fullStory;
  if (!fullStory) return setAnimationStatus(`请先生成${fullStoryLabel()}，再生成${planShortLabel()}。`, "error");
  const targetAspectRatio = selectedAnimationAspectRatio(variant.id);
  // 已有 4.0 分镜时只重绘；旧版（2.0/3.0）分镜不再支持，必须允许重新生成。
  if (!force && isStoryboardPlan(state.animationPlans[variant.id])) {
    renderAnimationPlan(state.animationPlans[variant.id]);
    return;
  }
  state.animationRunning = true;
  setAnimationRunning(true);
  beginStageUsage();
  setAnimationStatus(`正在调用 ${animationModelLabel()} 生成分镜…`, "active");
  try {
    await ensureSelectedVariantArtifact(variant);
    const result = await requestProductionArtifact({
      endpoint: "/api/animation-plan",
      requestBody: {
        ...videoUpstreamCopies(),
        visualGuardrails: state.output.visualGuardrails,
        ...candidateCopy(variant),
        fullStory,
        creatorProfile: profile(),
        // 角色画风：服务端写进分镜的 productionStrategy.artStyle，之后单镜提示词与角色参考图都按它来。
        // 「角色表情规则」那一栏已由它接替，页面不再发 characterExpressionRules。
        artStyle: characterArtStyle(),
        animationPlanVersion: STORYBOARD_PLAN_VERSION,
        targetAspectRatio,
        backgroundMusicEnabled: backgroundMusicEnabled(variant.id)
      },
      artifactId: `animationPlan:${variant.id}`,
      artifactType: "animationPlan",
      dependencyIds: [
        ...(isStoryEntryMode() ? ["storySource"] : ["referenceAnalysis", "sourceScriptReconstruction", "creativeBrief"]),
        "visualGuardrails",
        ...(variant.storySourceSlot ? [] : [`variant:${variant.id}`]),
        `fullStory:${variant.id}`
      ],
      createMediaNamespace: true,
      contentForArtifact: (value) => normalizeAnimationPlanResponse(value).animationPlan
    });
    assertSelectedVariant(variant.id);
    const { animationPlan, metadata } = normalizeAnimationPlanResponse(result);
    state.animationPlans[variant.id] = animationPlan;
    if (metadata?.storyboard) state.animationPlanMetadata[variant.id] = metadata;
    else delete state.animationPlanMetadata[variant.id];
    state.output.animationPlans = state.animationPlans;
    state.output.animationPlanMetadata = state.animationPlanMetadata;
    state.output.animationPlan = animationPlan;
    state.animationAspectRatioDrafts[variant.id] = normalizeAnimationPlanAspectRatio(animationPlan.productionStrategy?.targetAspectRatio);
    renderAnimationPlan(animationPlan, metadata);
    void refreshStoryDialogueCheck();
    setAnimationStatus(`${planShortLabel()}已生成 · ${state.animationAspectRatioDrafts[variant.id]} · ${persistedTaskModelLabel(`animationPlan:${variant.id}`, "animationPlan", animationModelLabel())}${formatStageUsageSuffix(endStageUsage())}`, "ready");
    updateStoryExportActions();
    elements.export.classList.remove("hidden");
  } catch (error) {
    if (!browserWorkspace.isCurrent(workspaceEpoch)) return;
    setAnimationStatus(
      isTaskCapacityError(error) ? taskCapacityMessage(error) : `${error.message || `${planShortLabel()}生成失败`}${failedStageUsageSuffix()}`,
      isTaskCapacityError(error) ? "warn" : "error"
    );
  } finally {
    if (!browserWorkspace.isCurrent(workspaceEpoch)) return;
    endStageUsage();
    state.animationRunning = false;
    setAnimationRunning(false);
  }
}

async function ensureSelectedVariantArtifact(variant) {
  if (!variant?.id) throw new Error("选中主题缺少 id。");
  // 粘贴完整故事的故事位不是候选，没有选中记录要核对或提交。
  if (variant.storySourceSlot) return null;
  const artifactId = `variant:${variant.id}`;
  if (isStoryEntryMode()) {
    // 剧情入口的选中记录由服务端在剧情准备的最后一步签发，页面不自己提交。
    const lineage = state.production.artifacts?.[artifactId];
    if (lineage?.status !== "current") throw new Error("剧情准备还没完成，请回到首页点「继续剧情准备」。");
    return structuredClone(lineage);
  }
  const dependencies = productionDependencies(["themeVariants"]);
  return commitProductionArtifact({
    artifactId,
    artifactType: "selectedVariant",
    content: variant,
    dependencyRefs: dependencies
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
// 不因为这里拨一下就重签 revision 或 stale 媒体。要换画幅只能重新生成 Plan。
function handleDefaultAspectRatioChange(value) {
  state.animationAspectRatioDefault = normalizeAnimationPlanAspectRatio(value);
  saveCreationPreferences();
  syncAnimationAspectRatioControls();
}

function syncAnimationAspectRatioControls() {
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

function renderAnimationPlan(data, metadata = selectedAnimationPlanMetadata()) {
  // A Run reload replaces media maps with current Artifacts. Restore task
  // overlays before rendering so in-flight/failed cards do not look idle.
  const mediaTargets = new Set(Object.values(state.taskSnapshots)
    .filter((task) => task.kind === "shotVideo")
    .flatMap((task) => task.targetArtifactIds || []));
  for (const artifactId of mediaTargets) {
    const task = taskForUi({ kinds: ["shotVideo"], artifactId });
    if (task) applyTaskMediaStatus(task);
  }
  // 旧 2.0 / 3.0 分镜（2026-10-11 起不再支持）：不按 4.0 读取，也不显示其中内容，
  // 只说明版本并给出「重新生成分镜」——走的是生成 4.0 分镜的同一个入口。
  const legacyVersion = legacyAnimationPlanVersion(data);
  if (legacyVersion) {
    elements.animationPlan.innerHTML = `${resultHeader("ANIMATION PLAN", "旧版分镜")}
      <div class="warning-box">${escape(legacyAnimationPlanMessage(legacyVersion))}</div>
      <div class="shot-action-row">
        <button class="outline-button" type="button" data-regenerate-storyboard${state.animationRunning ? " disabled" : ""}>重新生成分镜</button>
      </div>`;
    syncAnimationAspectRatioControls();
    reveal(elements.animationPlan);
    syncStoryTaskStatus();
    return;
  }
  elements.animationPlan.innerHTML = renderStoryboard(data, { escape, block, cell, resultHeader,
    renderCharacters: refs => renderCharacterReferencePrompts(refs) + `<button class="outline-button add-character-image-button" type="button" data-open-character-image-generator>＋ 生成角色参考图</button>`,
    // 服务端拦过一次就必须说出来：六个分镜阶段各自允许「第一次做错」，
    // metadata.storyboard.calls 如实记着每个阶段的实际调用次数与被拦诊断。
    renderVideo: renderShotVideoResult, videoLabel: shotVideoProviderLabel(), metadata });
  syncAnimationAspectRatioControls();
  reveal(elements.animationPlan);
  syncStoryTaskStatus();
}

// 时长缺失是契约错误，不是可以静默补 4 秒的显示问题：如实显示缺失。
function formatShotDurationSeconds(shot) {
  const duration = Number(shot?.durationSeconds);
  return Number.isFinite(duration) && duration > 0 ? `${duration} 秒` : "时长缺失";
}

// 候选播放器的画幅跟随当前 Plan 的 targetAspectRatio：16:9 的成片不该被塞进 9:16 的黑框里。
// 只影响播放器外框尺寸，不改任何 Plan 字段。
function shotVideoAspectStyle(aspectRatio) {
  return normalizeAnimationPlanAspectRatio(aspectRatio) === "9:16"
    ? "--shot-video-aspect: 9 / 16; --shot-video-card-max: 165px"
    : "--shot-video-aspect: 16 / 9; --shot-video-card-max: 240px";
}

function shotVideoPlayableCandidates(shotId) {
  const stateItem = shotVideoStateItem(shotId);
  if (!stateItem || stateItem.status === "running" || stateItem.status === "error") return [];
  const result = stateItem.result;
  const videos = Array.isArray(result?.videos) && result.videos.length ? result.videos : result?.outputUrl ? [result] : [];
  return videos.filter((video) => video?.outputUrl || video?.url);
}

function renderCharacterReferencePrompts(items = []) {
  const refineTask = taskForUi({ kinds: ["characterReferenceRefine"], artifactId: `animationPlan:${state.selectedVariantId}` });
  const refineView = isActiveTask(refineTask) ? taskUiView(refineTask) : null;
  return `<div class="character-reference-list">${items.map((item, index) => {
    const key = characterReferenceStatusKey(index);
    const status = state.characterReferenceStatuses[key];
    const hasReference = Boolean(item.referenceImageAdded || item.referenceImageDataUrl);
    // 缩略图直接用 Plan 里已有的参考图（只认 data:image/，那是「设为人物参考图」与精修写进去的唯一形状）。
    const imageUrl = typeof item.referenceImageDataUrl === "string" && item.referenceImageDataUrl.startsWith("data:image/") ? item.referenceImageDataUrl : "";
    const audioClips = characterReferenceAudioClips(item);
    const audioStatus = state.characterAudioStatuses[characterAudioStatusKey(index)];
    const statusText = refineView?.message || status?.message || (hasReference ? "点击或拖入图片可更换人物参考图" : "点击或拖入人物参考图");
    return `<div class="character-reference-card${hasReference ? " has-reference-image" : ""}" data-character-reference-card="${escape(index)}">
      <div class="character-reference-thumb">${imageUrl
        ? `<img src="${escape(imageUrl)}" alt="${escape(item.characterName)} 的人物参考图">`
        : `<span class="character-reference-thumb-empty">+<small>人物参考图</small></span>`}</div>
      <div class="character-reference-main">
        <div class="character-reference-title"><strong>${escape(item.characterName)}</strong>${item.storyRole ? `<span class="note">${escape(item.storyRole)}</span>` : ""}${hasReference && !imageUrl ? `<span class="reference-image-badge">已添加人物参考图</span>` : ""}</div>
        <p class="character-reference-appearance">${escape(item.appearancePrompt)}</p>
        <dl class="kv">
          <dt>一致性标签</dt><dd>${dotList(item.consistencyTags, escape) || "无"}</dd>
          <dt class="no">禁止变化</dt><dd>${dotList(item.forbiddenChanges, escape) || "无"}</dd>
          ${item.referenceImageNotes ? `<dt>参考图吸收</dt><dd>${escape(item.referenceImageNotes)}</dd>` : ""}
        </dl>
        <div class="character-reference-actions">
          <input class="hidden" type="file" accept="image/*" data-character-reference-input="${escape(index)}">
          <button class="character-reference-status ${escape(refineView ? "running" : status?.status || "idle")}" type="button" data-character-reference-upload="${escape(index)}"${refineView ? " disabled" : ""}>${escape(statusText)}</button>
          <input class="hidden" type="file" accept=".mp3,.m4a,.wav,audio/mpeg,audio/mp4,audio/wav,audio/x-wav" multiple data-character-audio-input="${escape(index)}">
          <button class="character-audio-upload-button" type="button" data-character-audio-upload="${escape(index)}"${audioStatus?.status === "running" ? " disabled" : ""}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"/></svg>
            <span>${audioClips.length ? "添加音色/叫声" : "上传音色/叫声"}</span>
          </button>
          ${audioStatus?.message ? `<span class="character-audio-status ${escape(audioStatus.status || "")}">${escape(audioStatus.message)}</span>` : ""}
        </div>
        ${renderCharacterReferenceAudioClips(audioClips, index)}
      </div>
    </div>`;
  }).join("") || "<p class=\"long-copy\">无角色参考提示词。</p>"}</div>`;
}

function renderCharacterReferenceAudioClips(clips, characterIndex) {
  if (!clips.length) return "";
  return `<div class="character-audio-clips" data-character-audio-clips>
    <span class="character-audio-heading">参考音色/叫声 · ${escape(clips.length)} 段</span>
    ${clips.map((clip) => `<div class="character-audio-clip">
      <div class="character-audio-clip-meta">
        <strong title="${escape(clip.fileName)}">${escape(clip.label)}</strong>
        <small>${escape(clip.durationSeconds.toFixed(2))} 秒</small>
      </div>
      <audio controls preload="metadata" src="${escape(clip.dataUrl)}" aria-label="试听 ${escape(clip.label)}"></audio>
      <button class="character-audio-remove-button" type="button" data-character-audio-index="${escape(characterIndex)}" data-character-audio-remove="${escape(clip.id)}" aria-label="删除 ${escape(clip.label)}" title="删除参考声音">×</button>
    </div>`).join("")}
  </div>`;
}

function openCharacterAudioInput(indexValue) {
  if (state.characterAudioStatuses[characterAudioStatusKey(indexValue)]?.status === "running") return;
  const input = [...elements.animationPlan.querySelectorAll("[data-character-audio-input]")]
    .find((item) => String(item.dataset.characterAudioInput) === String(indexValue));
  if (input) input.click();
}

async function addCharacterReferenceAudioFiles(indexValue, files) {
  const workspaceEpoch = browserWorkspace.epoch;
  const index = Number(indexValue);
  const variant = selectedVariant();
  const plan = variant ? state.animationPlans[variant.id] || state.output.animationPlan : state.output.animationPlan;
  const item = plan?.characterReferencePrompts?.[index];
  if (!variant || !plan || !item) return setAnimationStatus("没有找到对应角色参考项。", "error");
  const key = characterAudioStatusKey(index);
  state.characterAudioStatuses[key] = { status: "running", message: "正在保存参考声音…" };
  renderAnimationPlan(plan);

  try {
    const additions = [];
    for (const file of files) {
      const mimeType = characterAudioMimeType(file);
      if (!mimeType) throw new Error(`${file.name} 不是支持的 MP3、M4A 或 WAV 音频。`);
      if (file.size > 8 * 1024 * 1024) throw new Error(`${file.name} 不能超过 8MB。`);
      const durationSeconds = await browserMediaDuration(file, "audio");
      const rawDataUrl = await readFileAsDataUrl(file);
      additions.push({
        id: crypto.randomUUID(),
        label: characterAudioLabel(file.name),
        fileName: file.name,
        mimeType,
        dataUrl: normalizeAudioDataUrlMime(rawDataUrl, mimeType),
        sizeBytes: file.size,
        durationSeconds
      });
    }
    const existingClips = characterReferenceAudioClips(item);
    const seenDataUrls = new Set();
    const clips = [...existingClips, ...additions].filter((clip) => {
      if (seenDataUrls.has(clip.dataUrl)) return false;
      seenDataUrls.add(clip.dataUrl);
      return true;
    });
    if (clips.length === existingClips.length) throw new Error("所选参考声音已经上传过。");
    const issue = validateCharacterReferenceAudioClips(clips);
    if (issue) throw new Error(issue);
    const updatedPlan = structuredClone(plan);
    updatedPlan.characterReferencePrompts[index].referenceAudioClips = clips;
    assertWorkspaceCurrent(workspaceEpoch);
    await commitProductionArtifact({
      artifactId: animationPlanArtifactId(variant.id),
      artifactType: "animationPlan",
      content: updatedPlan,
      dependencyRefs: currentPlanDependencyRefs(variant.id),
      createMediaNamespace: true
    });
    assertSelectedVariant(variant.id);
    state.animationPlans[variant.id] = updatedPlan;
    state.output.animationPlans = state.animationPlans;
    state.output.animationPlan = updatedPlan;
    state.characterAudioStatuses[key] = { status: "ready", message: `已保存 ${clips.length} 段参考声音` };
    renderAnimationPlan(updatedPlan);
    // 上面那道 validateCharacterReferenceAudioClips 判的是「每个角色最多几段」，而供应商
    // 上限是「每个镜头最多几段」——两个角色各传 3 段且在同一镜都明确发声就必然渲染不了。这里按镜头
    // 再数一遍，让问题在上传当场暴露，而不是拖到生成镜头视频时才失败。
    // 只提示不阻断：用户随后完全可能改 Plan、换角色，把它做成硬闸门会误伤合法的中间状态。
    const overloadedShotIds = (updatedPlan.shotPlan || [])
      .filter((shot) => shotRelatedCharacterAudioClips(shot, updatedPlan.characterReferencePrompts || []).length > ALL_REFERENCE_MAX_AUDIOS)
      .map((shot) => shot.shotId)
      .filter(Boolean);
    setAnimationStatus(
      overloadedShotIds.length
        ? `${item.characterName || "角色"} 的参考声音已保存，但镜头 ${overloadedShotIds.join("、")} 的说话人语音合计超过每镜 ${ALL_REFERENCE_MAX_AUDIOS} 段上限，这些镜头目前无法生成视频；请减少说话人的语音段数。`
        : `${item.characterName || "角色"} 的参考声音已保存；仅当该角色在镜头对白中明确发声时，生成该镜头视频才会使用。`,
      overloadedShotIds.length ? "warn" : "ready"
    );
    updateStoryExportActions();
  } catch (error) {
    if (!browserWorkspace.isCurrent(workspaceEpoch)) return;
    state.characterAudioStatuses[key] = { status: "error", message: error.message || "参考声音保存失败" };
    renderAnimationPlan(plan);
    setAnimationStatus(error.message || "参考声音保存失败。", "error");
  }
}

async function removeCharacterReferenceAudio(indexValue, clipId) {
  const workspaceEpoch = browserWorkspace.epoch;
  const index = Number(indexValue);
  const variant = selectedVariant();
  const plan = variant ? state.animationPlans[variant.id] || state.output.animationPlan : state.output.animationPlan;
  const item = plan?.characterReferencePrompts?.[index];
  if (!variant || !plan || !item) return setAnimationStatus("没有找到对应角色参考项。", "error");
  const key = characterAudioStatusKey(index);
  if (state.characterAudioStatuses[key]?.status === "running") return;
  const previousClips = characterReferenceAudioClips(item);
  const clips = previousClips.filter((clip) => String(clip.id) !== String(clipId));
  if (clips.length === previousClips.length) return;
  state.characterAudioStatuses[key] = { status: "running", message: "正在删除参考声音…" };
  renderAnimationPlan(plan);
  try {
    const updatedPlan = structuredClone(plan);
    if (clips.length) updatedPlan.characterReferencePrompts[index].referenceAudioClips = clips;
    else delete updatedPlan.characterReferencePrompts[index].referenceAudioClips;
    assertWorkspaceCurrent(workspaceEpoch);
    await commitProductionArtifact({
      artifactId: animationPlanArtifactId(variant.id),
      artifactType: "animationPlan",
      content: updatedPlan,
      dependencyRefs: currentPlanDependencyRefs(variant.id),
      createMediaNamespace: true
    });
    assertSelectedVariant(variant.id);
    state.animationPlans[variant.id] = updatedPlan;
    state.output.animationPlans = state.animationPlans;
    state.output.animationPlan = updatedPlan;
    state.characterAudioStatuses[key] = { status: "ready", message: clips.length ? `剩余 ${clips.length} 段参考声音` : "参考声音已删除" };
    renderAnimationPlan(updatedPlan);
    setAnimationStatus(`${item.characterName || "角色"} 的参考声音已更新。`, "ready");
    updateStoryExportActions();
  } catch (error) {
    if (!browserWorkspace.isCurrent(workspaceEpoch)) return;
    state.characterAudioStatuses[key] = { status: "error", message: error.message || "参考声音删除失败" };
    renderAnimationPlan(plan);
    setAnimationStatus(error.message || "参考声音删除失败。", "error");
  }
}

function characterAudioStatusKey(index) {
  const variant = selectedVariant();
  return `${variant?.id || "variant"}:${index}`;
}

function characterAudioMimeType(file) {
  const declared = String(file?.type || "").toLowerCase();
  if (["audio/mpeg", "audio/mp4", "audio/wav", "audio/x-wav"].includes(declared)) return declared;
  const extension = String(file?.name || "").toLowerCase().split(".").at(-1);
  return ({ mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav" })[extension] || "";
}

function characterAudioLabel(fileName) {
  return String(fileName || "参考声音").replace(/\.[^.]+$/u, "").trim().slice(0, 40) || "参考声音";
}

function normalizeAudioDataUrlMime(dataUrl, mimeType) {
  return String(dataUrl || "").replace(/^data:[^;,]*;/iu, `data:${mimeType};`);
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
  const workspaceEpoch = browserWorkspace.epoch;
  const index = Number(indexValue);
  const variant = selectedVariant();
  const plan = variant ? state.animationPlans[variant.id] || state.output.animationPlan : state.output.animationPlan;
  const item = plan?.characterReferencePrompts?.[index];
  if (!variant || !plan || !item) return setAnimationStatus("没有找到对应角色参考项。", "error");
  if (!file.type.startsWith("image/")) return setAnimationStatus("请选择人物图片文件。", "error");
  if (file.size > 8 * 1024 * 1024) return setAnimationStatus(`人物参考图不能超过 ${formatBytes(8 * 1024 * 1024)}。`, "error");

  const key = characterReferenceStatusKey(index);
  const planArtifactId = animationPlanArtifactId(variant.id);
  const setting = effectiveStageSetting("characterReference");
  state.characterReferenceStatuses[key] = { status: "running", message: setting?.provider && setting?.model
    ? `正在用 ${setting.provider} · ${setting.model} 分析人物参考图…` : "正在分析人物参考图…" };
  renderAnimationPlan(plan);
  setAnimationStatus(`正在分析 ${item.characterName || "角色"} 的人物参考图…`, "active");

  try {
    const imageDataUrl = await readFileAsDataUrl(file);
    const { referenceImageDataUrl: _referenceImageDataUrl, ...safeCharacterReference } = item;
    assertWorkspaceCurrent(workspaceEpoch);
    const created = await createDurableTask("characterReferenceRefine", withModelOverrides({
      variantId: variant.id,
      roleIndex: index,
      imageName: file.name,
      imageDataUrl,
      characterReference: safeCharacterReference,
      creatorProfile: profile(),
      ...videoUpstreamCopies(),
      visualGuardrails: state.output.visualGuardrails,
      ...candidateCopy(variant, "selectedVariant"),
      fullStory: currentFullStory(),
      animationPlan: {
        title: plan.title,
        productionStrategy: plan.productionStrategy
      }
    }));
    const task = await waitForDurableTask(created.task);
    const run = await reloadActiveProductionRun();
    const updatedPlan = run.latestArtifacts?.[planArtifactId]?.content;
    if (!updatedPlan) throw new Error("人物精修完成后没有找到 current Animation Plan。");
    const refineNotice = (task.notices || []).join("；");
    const updated = updatedPlan.characterReferencePrompts?.[index] || {};
    assertSelectedVariant(variant.id);
    state.animationPlans[variant.id] = updatedPlan;
    state.output.animationPlans = state.animationPlans;
    state.output.animationPlan = updatedPlan;
    state.characterReferenceStatuses[key] = refineNotice
      ? { status: "warn", message: refineNotice }
      : { status: "ready", message: "已更新人物描述" };
    renderAnimationPlan(updatedPlan);
    setAnimationStatus(`${updated.characterName || "角色"} 已添加人物参考图。`, refineNotice ? "warn" : "ready");
    updateStoryExportActions();
  } catch (error) {
    if (!browserWorkspace.isCurrent(workspaceEpoch)) return;
    if (String(selectedVariant()?.id || "") === String(variant.id)) {
      state.characterReferenceStatuses[key] = {
        status: isTaskCapacityError(error) ? "warn" : "error",
        message: isTaskCapacityError(error) ? taskCapacityMessage(error) : error.message || "人物参考图分析失败"
      };
      renderAnimationPlan(plan);
    }
    setAnimationStatus(
      isTaskCapacityError(error) ? taskCapacityMessage(error) : error.message || "人物参考图分析失败",
      isTaskCapacityError(error) ? "warn" : "error"
    );
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
  state.characterImageGeneration.selectedIndex = Math.min(state.characterImageGeneration.selectedIndex || 0, items.length - 1);
  state.characterImageGeneration.count = Number(elements.characterImageCount.value) || 1;
  const resultTarget = `${variant.id}:${state.characterImageGeneration.selectedIndex}`;
  const matchingTask = taskForUi({ kinds: ["characterReferenceImages"], artifactId: `characterImages:${resultTarget}` });
  state.characterImageGeneration.running = isActiveTask(matchingTask)
    || (state.characterImageGeneration.running && state.characterImageGeneration.resultsTarget === resultTarget);
  if (!state.characterImageGeneration.running && state.characterImageGeneration.resultsTarget !== resultTarget) {
    state.characterImageGeneration.results = [];
    state.characterImageGeneration.boundaryWarning = "";
  }
  elements.characterImageRole.innerHTML = items.map((item, index) => `<option value="${escape(index)}">${escape(item.characterName || `角色 ${index + 1}`)} · ${escape(item.storyRole || "角色参考")}</option>`).join("");
  elements.characterImageRole.value = String(state.characterImageGeneration.selectedIndex);
  elements.characterImageCount.value = String(state.characterImageGeneration.count);
  renderCharacterImageResults();
  setCharacterImageStatus(
    state.characterImageGeneration.running
      ? "已重新接管服务端角色参考图任务…"
      : state.characterImageGeneration.results.some((item) => item.status === "ready")
        ? "已恢复上次生成的角色参考图，可继续预览或设为人物参考图。"
        : state.imageProviderConfigured ? "可以直接按文字设定生成，也可以先上传一张参考图片。" : "未检测到 JIMENG_API_KEY，生成时会提示配置错误。",
    state.characterImageGeneration.running
      ? "active"
      : state.characterImageGeneration.results.some((item) => item.status === "ready")
        ? "ready"
        : state.imageProviderConfigured ? "" : "error"
  );
  renderCharacterImagePromptPreview();
  setCharacterImageRunning(state.characterImageGeneration.running);
  syncCharacterImageTaskStatus({ includeTerminal: true });
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
  const workspaceEpoch = browserWorkspace.epoch;
  if (!file.type.startsWith("image/")) return setCharacterImageStatus("请选择图片文件。", "error");
  if (file.size > 30 * 1024 * 1024) return setCharacterImageStatus(`参考图片不能超过 ${formatBytes(30 * 1024 * 1024)}。`, "error");
  try {
    const dataUrl = await readFileAsDataUrl(file);
    assertWorkspaceCurrent(workspaceEpoch);
    state.characterImageGeneration.referenceImageDataUrl = dataUrl;
    state.characterImageGeneration.referenceImageName = file.name;
    elements.characterImagePreview.src = dataUrl;
    elements.characterImagePreviewWrap.classList.remove("hidden");
    elements.characterImageDropTitle.textContent = file.name;
    elements.characterImageDropHint.textContent = "已载入参考图。生成时会参考它，但会移除无关背景。";
    // 提示词第一行要随之变成「参考我上传的这张图片」：预览就是实际发送的。
    renderCharacterImagePromptPreview();
    setCharacterImageStatus("参考图片已载入。", "ready");
  } catch (error) {
    if (!browserWorkspace.isCurrent(workspaceEpoch)) return;
    setCharacterImageStatus(error.message || "参考图片读取失败。", "error");
  }
}

function renderCharacterImagePromptPreview() {
  const count = Number(elements.characterImageCount.value) || state.characterImageGeneration.count || 1;
  // 与服务端回退路径共用同一份模板：用户在这里看到并可编辑的，就是实际发送的。
  const plan = currentCharacterImagePlan();
  const prompt = buildCharacterReferenceImagePrompt({
    characterReference: currentCharacterImageReference() || {},
    count,
    // 上传是可选的：没上传时第一行不能说「参考我上传的这张图片」。
    withReferenceImage: Boolean(state.characterImageGeneration.referenceImageDataUrl),
    // 4.0 分镜签发的角色画风；没有就省略这一行。
    artStyle: plan?.productionStrategy?.artStyle || ""
  });
  // 没有可用提示词时只给占位提示，不把提示文字当成提示词值——否则它会被当成提示词发出去。
  elements.characterImagePromptPreview.placeholder = "当前角色没有可用的角色参考提示词。";
  elements.characterImagePromptPreview.value = prompt || "";
}

// 参考图是可选的：「移除参考图」、页面重置和导入测试包都走这里，界面回到「只按文字出图」。
function resetCharacterImageReference() {
  state.characterImageGeneration.referenceImageDataUrl = "";
  state.characterImageGeneration.referenceImageName = "";
  elements.characterImagePreview.removeAttribute("src");
  elements.characterImagePreviewWrap.classList.add("hidden");
  elements.characterImageInput.value = "";
  elements.characterImageDropTitle.textContent = "点击或拖入图片";
  elements.characterImageDropHint.textContent = "可以不上传，直接按文字设定出图；上传后即梦会参考这张图，只生成干净背景下的角色全身图。";
}

async function generateCharacterReferenceImages() {
  const workspaceEpoch = browserWorkspace.epoch;
  if (state.characterImageGeneration.running) return;
  const item = currentCharacterImageReference();
  if (!item) return setCharacterImageStatus("请选择要生成参考图的角色。", "error");
  const count = Math.max(1, Math.min(6, Number(elements.characterImageCount.value) || 1));
  const prompt = elements.characterImagePromptPreview.value.trim();
  if (!prompt) return setCharacterImageStatus("生成提示词不能为空。", "error");
  const variant = selectedVariant();
  if (!variant) return setCharacterImageStatus("当前没有选中的主题变体。", "error");
  const productionContext = currentPlanProductionContext(variant.id);
  const roleIndex = Number(elements.characterImageRole.value) || 0;
  state.characterImageGeneration.running = true;
  state.characterImageGeneration.selectedIndex = roleIndex;
  state.characterImageGeneration.resultsTarget = `${variant.id}:${roleIndex}`;
  state.characterImageGeneration.count = count;
  state.characterImageGeneration.boundaryWarning = "";
  state.characterImageGeneration.results = Array.from({ length: count }, (_, index) => ({ status: "loading", imageIndex: index }));
  renderCharacterImageResults();
  setCharacterImageRunning(true);
  setCharacterImageStatus(`正在用 ${state.imageProvider} ${modelName(state.imageModel)} 生成 ${count} 张参考图…`, "active");
  try {
    assertWorkspaceCurrent(workspaceEpoch);
    const created = await createDurableTask("characterReferenceImages", withModelOverrides({
      variantId: variant.id,
      roleIndex,
      count,
      prompt,
      // 上传是可选的：没上传就不带这两个键，服务端与即梦都按文字设定出图（不发 image 字段）。
      ...(state.characterImageGeneration.referenceImageDataUrl ? {
        referenceImageDataUrl: state.characterImageGeneration.referenceImageDataUrl,
        referenceImageName: state.characterImageGeneration.referenceImageName
      } : {}),
      characterReference: stripReferenceImageData(item),
      creatorProfile: profile(),
      ...videoUpstreamCopies(),
      visualGuardrails: state.output.visualGuardrails,
      ...candidateCopy(variant, "selectedVariant"),
      productionContext
    }));
    const task = await waitForDurableTask(created.task, (current) => {
      assertPlanProductionContextCurrent(productionContext);
      applyCharacterImageTaskProgress(current);
    });
    assertPlanProductionContextCurrent(productionContext);
    applyCharacterImageTaskProgress(task);
    await reloadActiveProductionRun();
    const readyCount = Number(task.progress?.readyCount) || state.characterImageGeneration.results.filter((result) => result.status === "ready").length;
    const finalMessage = readyCount ? `已生成 ${readyCount} 张参考图，可选择一张设为人物参考图。` : "生成结束，但没有返回可用图片。";
    const finalWarning = (task.notices || []).join("；");
    setCharacterImageStatus(
      finalWarning ? `${finalMessage}${finalWarning}` : finalMessage,
      readyCount ? (finalWarning ? "warn" : "ready") : "error"
    );
  } catch (error) {
    if (!browserWorkspace.isCurrent(workspaceEpoch)) return;
    if (error.code === "STALE_MEDIA_RESULT") {
      state.characterImageGeneration.results = [];
      renderCharacterImageResults();
    }
    setCharacterImageStatus(
      isTaskCapacityError(error) ? taskCapacityMessage(error) : error.message || "角色参考图生成失败。",
      isTaskCapacityError(error) ? "warn" : "error"
    );
  } finally {
    if (!browserWorkspace.isCurrent(workspaceEpoch)) return;
    state.characterImageGeneration.running = false;
    setCharacterImageRunning(false);
  }
}

function applyCharacterImageTaskProgress(task) {
  const target = durableTaskTargetContext(task);
  if (target.variantId && target.variantId !== state.selectedVariantId) return;
  if (state.characterImageGeneration.open && target.roleIndex !== Number(elements.characterImageRole.value)) return;
  const expectedCount = Number(task.progress?.expectedCount) || state.characterImageGeneration.count || 1;
  state.characterImageGeneration.count = expectedCount;
  const next = Array.from({ length: expectedCount }, (_, imageIndex) => ({
    status: isActiveTask(task) ? "loading" : "error", imageIndex,
    ...(!isActiveTask(task) ? { error: taskErrorMessage(task, "任务已结束，未返回该图片。") } : {})
  }));
  for (const result of task.progress?.results || []) {
    const index = Number(result.imageIndex) || 0;
    next[index] = result.status === "error" ? { ...result, status: "error" } : { ...result, status: "ready" };
  }
  state.characterImageGeneration.results = next;
  renderCharacterImageResults();
  const view = taskUiView(task);
  setCharacterImageStatus(view.message, view.tone);
  syncCharacterImageTaskStatus();
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

function closeGeneratedImagePreview() {
  elements.generatedImagePreview.classList.add("hidden");
  elements.generatedImagePreview.setAttribute("aria-hidden", "true");
  elements.generatedImagePreviewImage.removeAttribute("src");
}

async function useGeneratedCharacterReference(resultIndexValue) {
  const workspaceEpoch = browserWorkspace.epoch;
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
    setCharacterImageStatus("正在写入角色参考图…", "active");
    const imageDataUrl = await urlToDataUrl(result.url);
    assertCurrentProductionRequest(planToken);
    const updatedPlan = structuredClone(plan);
    const updated = {
      ...updatedPlan.characterReferencePrompts[roleIndex],
      referenceImageAdded: true,
      referenceImageName: result.filename || `jimeng-reference-${Number(resultIndexValue) + 1}.png`,
      referenceImageDataUrl: imageDataUrl,
      // 上传参考图是可选的，这张图可能是按文字设定出的：说明只写确定的事。
      referenceImageNotes: `由 ${state.imageProvider} ${modelName(result.model || state.imageModel)} 生成；已要求干净背景，保留站立全身角色。`
    };
    updatedPlan.characterReferencePrompts[roleIndex] = updated;
    assertWorkspaceCurrent(workspaceEpoch);
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
      message: "已使用即梦生成图"
    };
    renderAnimationPlan(updatedPlan);
    setAnimationStatus(`${updated.characterName || "角色"} 已使用即梦生成的人物参考图。`, "ready");
    setCharacterImageStatus("已设为人物参考图。", "ready");
    updateStoryExportActions();
  } catch (error) {
    if (!browserWorkspace.isCurrent(workspaceEpoch)) return;
    setCharacterImageStatus(error.message || "写入人物参考图失败。", "error");
  } finally {
    if (!browserWorkspace.isCurrent(workspaceEpoch)) return;
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
  delete safe.referenceAudioClips;
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

async function openShotVideoGenerator(shotId) {
  const openingContext = shotFrameContext(shotId);
  // 旧版（2.0/3.0）分镜已不再支持：不打开镜头弹窗，提示重新生成分镜。
  const legacyVersion = legacyAnimationPlanVersion(openingContext?.plan);
  if (legacyVersion) return setAnimationStatus(legacyAnimationPlanMessage(legacyVersion), "error");
  state.shotVideoGeneration.promptKey = null;
  elements.shotVideoPromptPreview.value = "";
  state.shotVideoGeneration.open = true;
  state.shotVideoGeneration.shotId = String(shotId);
  state.shotVideoGeneration.count = Number(elements.shotVideoCount.value) || 1;
  state.shotVideoGeneration.referenceAssets = [];
  state.shotVideoGeneration.includePreviousShotFrames = shouldIncludePreviousShotFrames({
    requested: storyboardUsesPreviousFrames(openingContext?.shot),
    available: previousShotVideoReferenceContext(shotId).available
  });
  elements.shotVideoIncludePreviousShotFrames.checked = state.shotVideoGeneration.includePreviousShotFrames;
  elements.shotVideoIncludeCharacterReferences.checked = state.shotVideoGeneration.includeCharacterReferences;
  if (!syncShotVideoTaskStatus()) setShotVideoGeneratorRunning(false);
  elements.shotVideoModal.classList.remove("hidden");
  elements.shotVideoModal.setAttribute("aria-hidden", "false");
  renderOneSentenceEditHosts();
  setShotVideoStatus("正在校验视频参考素材…", "active");
  if (!await updateShotVideoGeneratorPreview()) return;
  renderShotVideoModalResults();
  elements.shotVideoPromptPreview.focus();
}

async function updateShotVideoGeneratorPreview(options = {}) {
  const workspaceEpoch = browserWorkspace.epoch;
  if (!state.shotVideoGeneration.open) return true;
  const validationRevision = ++state.shotVideoGeneration.validationRevision;
  const shotId = state.shotVideoGeneration.shotId;
  const context = shotFrameContext(shotId);
  if (!context) {
    setAnimationStatus("没有找到对应镜头。", "error");
    return false;
  }
  const { shot, plan } = context;
  // 旧版（2.0/3.0）分镜已不再支持：不写提示词、不允许生成，明确说明要重新生成分镜。
  const legacyVersion = legacyAnimationPlanVersion(plan);
  if (legacyVersion) {
    elements.confirmGenerateShotVideo.disabled = true;
    setShotVideoStatus(legacyAnimationPlanMessage(legacyVersion), "error");
    return false;
  }
  const previousReference = previousShotVideoReferenceContext(shotId);
  elements.shotVideoIncludePreviousShotFrames.disabled = state.shotVideoGeneration.running || !previousReference.available;
  const count = Math.max(1, Math.min(4, Number(state.shotVideoGeneration.count) || Number(elements.shotVideoCount.value) || 1));
  elements.shotVideoCount.value = String(count);
  renderShotVideoResolutionControl();
  elements.shotVideoModalTitle.textContent = `用 ${shotVideoProviderLabel()} 生成 ${shot.shotId || "镜头"} 视频`;
  elements.shotVideoMeta.textContent = `${shot.shotId || "镜头"} · ${shot.sourceSceneIds?.join("、") || "未标注场次"} · ${formatShotDurationSeconds(shot)} · ${normalizeAnimationPlanAspectRatio(plan.productionStrategy?.targetAspectRatio)} · 按当前模型单独编写本镜提示词 · 多模态参考生成，不锁定精确首尾帧`;
  elements.shotVideoReferenceList.innerHTML = renderShotVideoReferenceList(shotId);
  elements.confirmGenerateShotVideo.disabled = true;
  try {
    const key = currentStoryboardPromptKey(context);
    if (options.regeneratePrompt || state.shotVideoGeneration.promptKey !== key || !elements.shotVideoPromptPreview.value.trim()) {
      setShotVideoStatus("AI 正在编写本镜视频提示词…", "active");
      elements.shotVideoPromptPreview.disabled = true;
      $("#regenerateShotVideoPrompt").disabled = true;
      const result = await requestStoryboardShotPrompt(context, options.regeneratePrompt);
      if (!browserWorkspace.isCurrent(workspaceEpoch) || validationRevision !== state.shotVideoGeneration.validationRevision || !state.shotVideoGeneration.open) return false;
      if (key !== currentStoryboardPromptKey(shotFrameContext(shotId))) throw new Error("分镜或模型设置已变化，请重新生成本镜提示词。");
      elements.shotVideoPromptPreview.value = result.videoPrompt;
      state.shotVideoGeneration.promptKey = key;
    }
  } catch (error) {
    if (browserWorkspace.isCurrent(workspaceEpoch) && validationRevision === state.shotVideoGeneration.validationRevision) setShotVideoStatus(error.message || "提示词生成失败，请重试。", "error");
    return false;
  } finally {
    if (browserWorkspace.isCurrent(workspaceEpoch) && validationRevision === state.shotVideoGeneration.validationRevision) {
      elements.shotVideoPromptPreview.disabled = state.shotVideoGeneration.running;
      $("#regenerateShotVideoPrompt").disabled = state.shotVideoGeneration.running;
    }
  }
  if (syncShotVideoTaskStatus()) return true;
  const validation = await evaluateAllReferenceAssets(shotId);
  if (!browserWorkspace.isCurrent(workspaceEpoch) || validationRevision !== state.shotVideoGeneration.validationRevision) return false;
  if (syncShotVideoTaskStatus()) return true;
  elements.shotVideoReferenceList.innerHTML = renderShotVideoReferenceList(shotId);
  setShotVideoStatus(validation.message, validation.ok ? "" : "error");
  syncShotVideoTaskStatus({ includeTerminal: true });
  elements.confirmGenerateShotVideo.disabled = !validation.ok || state.shotVideoGeneration.running;
  return true;
}

function currentStoryboardPromptKey(context) {
  if (!context?.variant) throw new Error("当前分镜不可用");
  return JSON.stringify({ context: currentPlanProductionContext(context.variant.id), shotId: context.shot.shotId,
    target: shotVideoSetting(), writer: effectiveStageSetting("animationPlan") });
}

async function requestStoryboardShotPrompt(context, regenerate = false) {
  const key = currentStoryboardPromptKey(context);
  if (storyboardPromptRequests.has(key)) return storyboardPromptRequests.get(key);
  const productionContext = currentPlanProductionContext(context.variant.id);
  const artifactId = storyboardPromptArtifactId(context.variant.id, context.shot.shotId);
  const cached = state.shotVideoPrompts?.[artifactId];
  const target = shotVideoSetting(), writer = effectiveStageSetting("animationPlan");
  if (!regenerate && storyboardPromptMatches(cached, { planDigest: productionContext.planDigest,
    provider: target.provider, model: target.model, textProvider: writer.provider, textModel: writer.model })) return cached;
  const pending = (async () => {
    const created = await createDurableTask("shotVideoPrompt", withModelOverrides({
      variantId: context.variant.id, shotId: context.shot.shotId, productionContext,
      videoProvider: target.provider, videoModel: target.model
    }));
    const task = await waitForDurableTask(created.task);
    recordStageUsage(task.usage);
    const run = await reloadActiveProductionRun(productionContext, { preserveSelectedVariant: true });
    assertPlanProductionContextCurrent(productionContext);
    const entry = run.latestArtifacts?.[artifactId];
    if (entry?.lineage?.status !== "current") throw new Error("本镜提示词已失效，请重新生成。");
    return entry.content;
  })();
  storyboardPromptRequests.set(key, pending);
  try { return await pending; } finally { storyboardPromptRequests.delete(key); }
}

async function evaluateAllReferenceAssets(shotId) {
  const context = shotFrameContext(shotId);
  if (!context) return { ok: false, message: "没有找到对应镜头。" };
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

function closeShotVideoGenerator() {
  if (state.shotVideoGeneration.running) return setShotVideoStatus("镜头视频仍在生成中，完成后再关闭。", "active");
  // 一句话修改：写稿和签发期间不能关；修改稿等着决定时，关掉就是放弃，先问一句。
  const edit = oneSentenceEdit;
  if (edit?.target === "shotPrompt" && edit.shotId === state.shotVideoGeneration.shotId) {
    if (edit.status === "writing" || edit.adopting) return setShotVideoStatus("正在按你的话改这一镜的提示词，处理完再关闭。", "active");
    if (oneSentenceEditPending()) {
      if (!window.confirm("这一镜的提示词修改稿还没有采纳，关掉弹窗就是放弃它。确定关掉吗？")) return undefined;
      discardOneSentenceEdit();
    } else {
      oneSentenceEdit = null;
      scheduleDirectorAgentRefresh();
    }
  }
  state.shotVideoGeneration.open = false;
  state.shotVideoGeneration.validationRevision += 1;
  elements.shotVideoModal.classList.add("hidden");
  elements.shotVideoModal.setAttribute("aria-hidden", "true");
  renderOneSentenceEditHosts();
}

async function confirmGenerateShotVideo() {
  const workspaceEpoch = browserWorkspace.epoch;
  if (syncShotVideoTaskStatus() && state.shotVideoGeneration.running) return;
  if (state.shotVideoGeneration.running) return;
  if (oneSentenceEditBlocksShot(state.shotVideoGeneration.shotId)) {
    return setShotVideoStatus("这一镜的提示词修改稿还没处理：先采纳或放弃，再生成视频。", "error");
  }
  const prompt = elements.shotVideoPromptPreview.value.trim();
  if (!prompt) return setShotVideoStatus("视频提示词不能为空。", "error");
  const shotId = state.shotVideoGeneration.shotId;
  const context = shotFrameContext(shotId);
  if (!context) return setShotVideoStatus("没有找到对应镜头。", "error");
  if (state.shotVideoGeneration.promptKey !== currentStoryboardPromptKey(context)) return setShotVideoStatus("分镜或模型已变化，请先重新生成本镜提示词。", "error");
  const promptOverride = runtimePromptOverride(prompt);
  const validation = await evaluateAllReferenceAssets(shotId);
  if (!browserWorkspace.isCurrent(workspaceEpoch)) return;
  if (!validation.ok) return setShotVideoStatus(validation.message, "error");
  const resolution = shotVideoResolutionState();
  if (!resolution.ready) return setShotVideoStatus(shotVideoResolutionNotReadyText(resolution), "error");
  const count = Math.max(1, Math.min(4, Number(elements.shotVideoCount.value) || 1));
  state.shotVideoGeneration.count = count;
  setShotVideoGeneratorRunning(true);
  setShotVideoStatus(`${shotVideoProviderLabel()} 正在生成 ${count} 条视频候选…`, "active");
  try {
    await generateShotVideo(shotId, promptOverride, { count, throwOnError: true });
    assertWorkspaceCurrent(workspaceEpoch);
    const actualCount = shotVideoStateItem(shotId)?.result?.videos?.length || count;
    setShotVideoStatus(`已生成 ${actualCount} 条视频候选，可选择一条设为当前镜头视频。`, "ready");
  } catch (error) {
    if (!browserWorkspace.isCurrent(workspaceEpoch)) return;
    setShotVideoStatus(
      isTaskCapacityError(error) ? taskCapacityMessage(error) : error.message || "镜头视频生成失败",
      isTaskCapacityError(error) ? "warn" : "error"
    );
  } finally {
    if (!browserWorkspace.isCurrent(workspaceEpoch)) return;
    if (state.shotVideoGeneration.running) setShotVideoGeneratorRunning(false);
  }
}

function setShotVideoGeneratorRunning(running) {
  state.shotVideoGeneration.running = running;
  elements.shotVideoCount.disabled = running;
  elements.shotVideoResolution.disabled = running;
  elements.shotVideoIncludePreviousShotFrames.disabled = running
    || !previousShotVideoReferenceContext(state.shotVideoGeneration.shotId).available;
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
    const characterReferences = context.plan.characterReferencePrompts || [];
    const references = shotRelatedCharacterReferences(context.shot, characterReferences);
    for (const reference of references) {
      if (reference?.referenceImageDataUrl) {
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
    for (const { characterName, clip } of shotRelatedCharacterAudioClips(context.shot, characterReferences)) {
      assets.push({
        id: `character-audio-${clip.id}`,
        mediaType: "audio",
        name: `${characterName || "角色"} · ${clip.label}`,
        dataUrl: clip.dataUrl,
        sizeBytes: clip.sizeBytes,
        durationSeconds: clip.durationSeconds,
        source: "character_audio_reference",
        sourceCharacterName: characterName
      });
    }
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
  if (counts.image > ALL_REFERENCE_MAX_IMAGES) return `全能参考图片最多 ${ALL_REFERENCE_MAX_IMAGES} 张，当前 ${counts.image} 张。`;
  if (counts.video > ALL_REFERENCE_MAX_VIDEOS) return `全能参考视频最多 ${ALL_REFERENCE_MAX_VIDEOS} 段，当前 ${counts.video} 段。`;
  if (counts.audio > ALL_REFERENCE_MAX_AUDIOS) return `全能参考音频最多 ${ALL_REFERENCE_MAX_AUDIOS} 段，当前 ${counts.audio} 段。`;
  const videos = assets.filter((asset) => asset.mediaType === "video");
  const audios = assets.filter((asset) => asset.mediaType === "audio");
  const invalidDuration = [...videos, ...audios].find((asset) => (
    asset.durationSeconds < ALL_REFERENCE_MEDIA_MIN_SECONDS
    || asset.durationSeconds > ALL_REFERENCE_MEDIA_MAX_SECONDS
  ));
  if (invalidDuration) return `${invalidDuration.name} 时长必须在 ${ALL_REFERENCE_MEDIA_MIN_SECONDS}–${ALL_REFERENCE_MEDIA_MAX_SECONDS} 秒之间。`;
  if (videos.some((asset) => asset.sizeBytes > ALL_REFERENCE_MAX_VIDEO_BYTES)) return "单段参考视频不得超过 50MB。";
  const videoDuration = videos.reduce((sum, asset) => sum + Number(asset.durationSeconds || 0), 0);
  const audioDuration = audios.reduce((sum, asset) => sum + Number(asset.durationSeconds || 0), 0);
  if (videoDuration > ALL_REFERENCE_MEDIA_TOTAL_SECONDS) return `参考视频总时长不得超过 ${ALL_REFERENCE_MEDIA_MAX_SECONDS} 秒，当前 ${videoDuration.toFixed(2)} 秒。`;
  if (audioDuration > ALL_REFERENCE_MEDIA_TOTAL_SECONDS) return `参考音频总时长不得超过 ${ALL_REFERENCE_MEDIA_MAX_SECONDS} 秒，当前 ${audioDuration.toFixed(2)} 秒。`;
  return "";
}

async function addShotVideoReferenceFiles(files) {
  const workspaceEpoch = browserWorkspace.epoch;
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
    assertWorkspaceCurrent(workspaceEpoch);
    const candidateAssets = [...state.shotVideoGeneration.referenceAssets, ...added];
    const issue = validateAllReferenceAssetDescriptors(candidateAssets);
    if (issue && !/至少需要一张图片或一段视频/u.test(issue)) throw new Error(issue);
    state.shotVideoGeneration.referenceAssets = candidateAssets;
    await updateShotVideoGeneratorPreview({ preservePrompt: true });
  } catch (error) {
    if (!browserWorkspace.isCurrent(workspaceEpoch)) return;
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
  const assets = allReferenceAssetDescriptors(shotId);
  const previousReference = previousShotVideoReferenceContext(shotId);
  if (!assets.length) {
    return `<div>
    <span class="block-label">全能参考素材 · 0 项</span>
    <div class="shot-video-reference-box">
      <p class="shot-video-reference-note">尚未选择参考素材。可加入上个镜头抽帧、角色参考图，或上传图片、视频和音频。${previousReference.available ? `上个镜头 ${escape(previousReference.previousShot.shotId)} 已就绪，勾选后预计抽取 ${escape(previousReference.estimatedFrameCount)} 张。` : `上个镜头不可用：${escape(previousReference.reason)}`}</p>
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
              : escape(["character_reference", "character_audio_reference"].includes(asset.source) ? "角色锁定" : "工作流参考")}</small>
        ${asset.source === "upload" ? `<button class="shot-video-reference-remove" type="button" data-remove-shot-video-reference="${escape(asset.id)}" aria-label="移除 ${escape(asset.name)}">×</button>` : ""}
      </div>`).join("")}
    </div>
    <p class="shot-video-reference-note">这些素材会以 reference_image / reference_video / reference_audio 发送，不会混入 first_frame / last_frame。角色参考声音只在“对白/字幕”明确标出该角色发声时加入。上一镜抽帧只增强一致性，当前镜头的剧情、角色边界与目标场景仍优先。${previousReference.available
      ? state.shotVideoGeneration.includePreviousShotFrames
        ? ""
        : `上个镜头 ${escape(previousReference.previousShot.shotId)} 已就绪，可按需勾选，预计抽取 ${escape(previousReference.estimatedFrameCount)} 张。`
      : `上个镜头不可用：${escape(previousReference.reason)}`}</p>
    </div>
  </div>`;
}

function controlDurableTask(taskId, action) {
  return api(`/api/tasks/${encodeURIComponent(taskId)}/control`, {
    projectId: state.production.projectId,
    runId: state.production.runId,
    action
  });
}

async function generateShotVideo(shotId, promptOverride = "", options = {}) {
  const workspaceEpoch = browserWorkspace.epoch;
  const variant = selectedVariant();
  const plan = variant ? state.animationPlans[variant.id] || state.output.animationPlan : state.output.animationPlan;
  const shot = (plan?.shotPlan || []).find((item) => String(item.shotId) === String(shotId));
  if (!shot) return setAnimationStatus("没有找到对应镜头。", "error");
  const productionContext = currentPlanProductionContext(variant.id);
  const mediaArtifactId = shotVideoArtifactId(variant.id, shotId);
  const count = Math.max(1, Math.min(4, Number(options.count) || 1));
  setShotVideoStateItem(shotId, { status: "running", message: `正在调用 ${shotVideoProviderLabel()} · ${count} 条…`, expectedCount: count }, variant.id);
  updateShotVideoResult(shotId);
  renderShotVideoModalResults();
  setAnimationStatus(`正在用 ${shotVideoProviderLabel()} 生成 ${shotId} 镜头视频 · ${count} 条候选…`, "active");
  try {
    const continuityReferenceMode = state.shotVideoGeneration.includePreviousShotFrames
      ? SHOT_VIDEO_CONTINUITY_PREVIOUS_SHOT_FRAMES
      : SHOT_VIDEO_CONTINUITY_NONE;
    const referenceValidation = await evaluateAllReferenceAssets(shotId);
    if (!referenceValidation.ok) throw new Error(referenceValidation.message);
    const referenceAssets = await collectAllReferenceAssets(shotId);
    assertWorkspaceCurrent(workspaceEpoch);
    const created = await createDurableTask("shotVideo", withModelOverrides({
      ...globalCharacterBoundaryContext(),
      variantId: variant.id,
      selectedVariantId: variant?.id || "",
      count,
      // 镜头视频只有全能参考一种模式（2026-10-11 起首尾帧模式已删除）。
      generationMode: "all_reference",
      continuityReferenceMode,
      aspectRatio: normalizeAnimationPlanAspectRatio(plan.productionStrategy?.targetAspectRatio),
      animationPromptSchemaVersion: plan.promptSchemaVersion || "",
      shotId: shot.shotId,
      promptOverride: promptOverride || "",
      ...shotVideoResolutionRequestFields(),
      referenceAssets,
      productionContext
    }));
    await waitForDurableTask(created.task, (current) => {
      const completed = Number.isInteger(Number(current.progress?.candidateIndex))
        ? Number(current.progress.candidateIndex) + 1
        : Number(current.progress?.completedCandidates) || 0;
      setShotVideoStateItem(shotId, {
        status: "running",
        message: current.status === "queued" ? "镜头视频任务正在排队…" : `镜头视频生成中${completed ? ` · 已完成 ${completed}` : ""}`,
        expectedCount: count
      }, variant.id);
      updateShotVideoResult(shotId);
      renderShotVideoModalResults();
    });
    assertPlanProductionContextCurrent(productionContext);
    const run = await reloadActiveProductionRun();
    const readyResult = run.latestArtifacts?.[mediaArtifactId]?.content;
    if (!readyResult || readyResult.status !== "ready") throw new Error("视频任务完成后没有找到 ready shotVideo Artifact。");
    assertPlanProductionContextCurrent(productionContext);
    setShotVideoStateItem(shotId, readyResult, variant.id);
    setAnimationStatus(`${shotId} 镜头视频已生成 ${readyResult.result?.videos?.length || count} 条候选。`, "ready");
  } catch (error) {
    if (!browserWorkspace.isCurrent(workspaceEpoch)) return;
    if (!["STALE_ASYNC_RESULT", "STALE_MEDIA_RESULT"].includes(error.code)) {
      setShotVideoStateItem(shotId, {
        status: isTaskCapacityError(error) ? "capacity" : "error",
        message: isTaskCapacityError(error) ? taskCapacityMessage(error) : error.message || "镜头视频生成失败"
      }, variant.id);
    }
    setAnimationStatus(
      isTaskCapacityError(error) ? taskCapacityMessage(error) : error.message || "镜头视频生成失败",
      isTaskCapacityError(error) ? "warn" : "error"
    );
    updateShotVideoResult(shotId);
    renderShotVideoModalResults();
    if (options.throwOnError) throw error;
    return false;
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
  if (stateItem.status === "capacity") {
    elements.shotVideoResults.innerHTML = `<div class="generated-reference-card"><strong>服务器任务队列已满</strong><p>${escape(stateItem.message || "请稍后重试。")}</p></div>`;
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
    <small>${escape([`候选 ${index + 1}`, shotVideoResultLabel(video, stateItem.result), shotVideoResolutionText(video), video.generatedAt || stateItem.result?.generatedAt || ""].filter(Boolean).join(" · "))}</small>
    <button class="outline-button" type="button" data-use-shot-video="${escape(shotId)}" data-candidate-index="${escape(index)}">${index === selectedIndex ? "已设为当前镜头视频" : "设为当前镜头视频"}</button>
  </div>`).join("");
}

async function selectShotVideoCandidate(shotId, candidateIndexValue) {
  const workspaceEpoch = browserWorkspace.epoch;
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
    assertWorkspaceCurrent(workspaceEpoch);
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
    if (!browserWorkspace.isCurrent(workspaceEpoch)) return;
    setShotVideoStatus(error.message || "切换镜头视频失败。", "error");
  }
}

function updateShotVideoResult(shotId) {
  const resultBox = [...elements.animationPlan.querySelectorAll("[data-shot-video-result]")]
    .find((item) => String(item.dataset.shotVideoResult) === String(shotId));
  if (resultBox) resultBox.innerHTML = renderShotVideoResult(shotId);
  const button = [...elements.animationPlan.querySelectorAll("[data-generate-shot-video]")]
    .find((item) => String(item.dataset.generateShotVideo) === String(shotId));
  if (button) button.disabled = shotVideoStateItem(shotId)?.status === "running";
}

function renderShotVideoResult(shotId) {
  const stateItem = shotVideoStateItem(shotId);
  if (!stateItem) return "<p>本镜视频尚未生成。</p>";
  if (stateItem.status === "running") return `<p class="active">${escape(stateItem.message || `正在生成 ${stateItem.expectedCount || 1} 条视频候选…`)}</p>`;
  if (stateItem.status === "capacity") return `<p class="capacity">${escape(stateItem.message || "服务器任务队列已满，请稍后重试。")}</p>`;
  if (stateItem.status === "error") return `<p class="error">${escape(stateItem.message)}</p>`;
  // 这里只留连续性回执与异常说明。
  const videos = shotVideoPlayableCandidates(shotId);
  const continuityReceipt = stateItem.result?.continuityReferenceReceipt;
  const continuityHtml = continuityReceipt?.mode === SHOT_VIDEO_CONTINUITY_PREVIOUS_SHOT_FRAMES
    ? `<p class="ready">连续性参考：${escape(continuityReceipt.sourceShotId)} 均匀抽帧，共 ${escape(continuityReceipt.frameCount)} 张普通参考图。</p>`
    : "";
  return videos.length
    ? continuityHtml
    : `${continuityHtml}<p>视频已生成，但未返回可播放地址。</p>`;
}

function resultHeader(kicker, title, badge = "", action = "") {
  // 标题常是模型写的剧情/分镜标题，按文本转义，不当 HTML 拼。
  return `<div class="result-title"><div><p>${kicker}</p><h3>${escape(title)}</h3></div>${badge ? `<span class="confidence">${escape(badge)}</span>` : ""}${action}</div>`;
}
function block(label, content) { return `<div class="result-block"><span class="block-label">${label}</span>${content}</div>`; }
function cell(label, value) { return `<div class="data-cell"><span>${label}</span><strong>${escape(value || "待确认")}</strong></div>`; }
function uncertainties(items = []) { return items.length ? `<div class="warning-box"><b>待确认：</b> ${items.map((item) => escape(item.reason || item.unknown)).join("；")}</div>` : ""; }
function joinParts(object = {}, keys = []) { return keys.map((key) => object?.[key]).filter(Boolean).join(" · "); }
function reveal(element) { element.classList.remove("hidden"); }

function setStage(stage, status) {
  const element = document.querySelector(`[data-stage="${stage}"]`);
  element.className = status;
  element.querySelector("b").textContent = ({ active: "生成中", done: "完成", error: "失败", paused: "已暂停", stopped: "已停止" })[status] || "等待";
}
function resetPipeline() { document.querySelectorAll(".pipeline li").forEach((item) => { item.className = ""; item.querySelector("b").textContent = "等待"; }); }
function setRunning(running) {
  state.running = running;
  renderDirectorControls();
}
function setStoryRunning(running) {
  renderFullStoryControls({ running });
}

function selectedFullStoryTask() {
  const variant = selectedVariant();
  return variant ? taskForUi({ kinds: ["fullStory"], artifactId: `fullStory:${variant.id}`, rootOnly: true }) : null;
}

function renderFullStoryControls({ running = state.storyRunning } = {}) {
  const variant = selectedVariant();
  const request = state.storyGenerationRequest;
  const starting = Boolean(variant && request?.variantId === variant.id && !request.taskId);
  const task = starting ? null : selectedFullStoryTask();
  const active = activeTaskForKinds(["fullStory"], { rootOnly: true });
  const noun = fullStoryLabel();
  const view = fullStoryControlView(task, {
    starting,
    pendingAction: state.storyControlRequests[task?.taskId]?.action || "",
    // 粘贴完整故事：这一步是按原文拆分镜头，拆过之后叫「重新拆分」。
    idleLabel: variant?.storySourceSlot
      ? `用 ${storyModelLabel()} ${state.fullStories[variant.id] ? "重新拆分镜头" : "按原文拆分镜头"}`
      : `用 ${storyModelLabel()} 生成完整剧情`,
    noun
  });
  let label = view.label;
  if (!view.visible && active) {
    label = `${durableTaskTargetContext(active).variantId} · ${fullStoryControlView(active, { noun }).label}`;
  } else if (!view.visible && request && running) {
    label = `${request.variantId} · 正在启动${noun}…`;
  }
  elements.fullStoryControls.classList.toggle("active", view.visible);
  elements.storyGenerate.classList.toggle("running", view.visible);
  elements.storyGenerate.querySelector("span").textContent = label;
  elements.storyGenerate.disabled = running || Boolean(active) || view.visible || !variant;
  elements.fullStoryStartArrow.classList.toggle("hidden", view.visible);
  elements.fullStoryControlHint.classList.toggle("hidden", !view.visible);
  for (const button of [elements.terminateFullStory, elements.pauseFullStory]) button.classList.toggle("hidden", !view.visible);
  elements.terminateFullStory.disabled = view.stopDisabled;
  elements.pauseFullStory.disabled = view.pauseDisabled;
  elements.pauseFullStory.setAttribute("aria-label", view.pauseLabel);
  elements.pauseFullStory.setAttribute("title", view.pauseLabel);
  elements.pauseFullStory.innerHTML = view.paused
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7Z"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6v12M16 6v12"/></svg>';
}

async function controlFullStory(action) {
  const task = selectedFullStoryTask();
  const variant = selectedVariant();
  if (!task || !variant || state.storyControlRequests[task.taskId]
    || (state.storyGenerationRequest?.variantId === variant.id && !state.storyGenerationRequest.taskId)) return;
  const view = fullStoryControlView(task);
  if (action === "terminate" ? view.stopDisabled : view.pauseDisabled || action !== view.pauseAction) return;
  const request = { taskId: task.taskId, variantId: variant.id, action, epoch: browserWorkspace.epoch };
  state.storyControlRequests[task.taskId] = request;
  renderFullStoryControls();
  try {
    const updated = await controlDurableTask(task.taskId, action);
    if (!browserWorkspace.isCurrent(request.epoch)) return;
    if (updated?.taskId !== request.taskId) throw new Error("完整剧情控制返回了不同任务，请刷新后重试。");
    // Keep the scoped server snapshot even if the user has navigated away.
    // Only the currently selected task may update the visible status/controls.
    updateTaskSnapshot(updated, { render: false });
    if (state.selectedVariantId !== request.variantId || selectedFullStoryTask()?.taskId !== request.taskId) return;
    syncStoryTaskStatus({ includeTerminal: true });
  } catch (error) {
    if (!browserWorkspace.isCurrent(request.epoch) || state.selectedVariantId !== request.variantId
      || selectedFullStoryTask()?.taskId !== request.taskId) return;
    setStoryStatus(error.message || "完整剧情控制失败，请重试。", "error");
  } finally {
    if (state.storyControlRequests[request.taskId] === request) {
      delete state.storyControlRequests[request.taskId];
      renderFullStoryControls();
    }
  }
}

function renderFullStoryTaskError(error, fallback, variantId) {
  if (state.selectedVariantId !== variantId) return;
  if (error.task?.kind === "fullStory") {
    const latest = latestTaskForTarget(state.taskSnapshots, {
      kinds: ["fullStory"], artifactId: `fullStory:${variantId}`, rootOnly: true
    });
    if (latest && latest.taskId !== error.task.taskId) return;
    const view = taskUiView(latest || error.task);
    setStoryStatus(view.message, view.tone);
    state.storyTaskStatusVisible = true;
    return;
  }
  setStoryStatus(
    isTaskCapacityError(error) ? taskCapacityMessage(error) : `${error.message || fallback}${failedStageUsageSuffix()}`,
    isTaskCapacityError(error) ? "warn" : "error"
  );
}
function setAnimationRunning(running) {
  elements.animationGenerate.classList.toggle("running", running);
  const variant = selectedVariant();
  const fullStory = variant ? state.fullStories[variant.id] || state.output.fullStory : null;
  const aspectRatio = selectedAnimationAspectRatio(variant?.id);
  elements.animationGenerate.textContent = running
    ? `正在生成 ${aspectRatio} ${planShortLabel()}…`
    : `生成${planLabel()} · ${aspectRatio}`;
  elements.animationGenerate.disabled = running || !variant || !fullStory;
  elements.animationPlan.querySelectorAll("[data-regenerate-storyboard]").forEach((button) => { button.disabled = running; });
  // 分场页上的配乐开关：生成分镜期间不能拨，免得界面显示的和正在生成的那份不一致。
  renderStoryMusicControl();
  updateStoryExportActions();
}
function setStoryStatus(message, tone = "") {
  state.storyTaskStatusVisible = false;
  elements.storyStatus.textContent = message;
  elements.storyStatus.className = `story-status ${tone}`;
}
function setAnimationStatus(message, tone = "") {
  elements.animationStatus.textContent = message;
  elements.animationStatus.className = `story-status ${tone}`;
}

function updateTaskSnapshot(task, { render = true } = {}) {
  if (task?.projectId !== state.production.projectId || task?.runId !== state.production.runId) return;
  if (!rememberTaskSnapshot(state.taskSnapshots, task)) return;
  applyTaskMediaStatus(task, { render });
  if (render) {
    syncDirectorTaskStatus();
    syncStoryTaskStatus();
    syncCharacterImageTaskStatus();
    syncShotVideoTaskStatus();
  }
  scheduleDirectorAgentRefresh();
}

function applyTaskMediaStatus(task, { render = false } = {}) {
  const target = durableTaskTargetContext(task);
  if (task.kind === "shotVideo" && task.status !== "completed") {
    if (taskForUi({ kinds: [task.kind], artifactId: target.artifactId })?.taskId !== task.taskId) return;
    const view = taskStatusView(task);
    setShotVideoStateItem(target.shotId, { status: view.busy ? "running" : "error", message: view.message }, target.variantId);
    if (render && target.variantId === state.selectedVariantId) updateShotVideoResult(target.shotId);
  }
}

function taskForUi(options) {
  const task = latestTaskForTarget(state.taskSnapshots, options);
  // A completed task for an older Artifact revision must not label a new Plan
  // or a different set of media as completed.
  if (!task || isActiveTask(task)) return task;
  if (task.status === "completed") return taskResultIsCurrent(state.production, task) ? task : null;
  // Failures from a superseded Plan/Story are history, not the current target's
  // status. This only selects a UI snapshot; frozen task refs stay untouched.
  if ((task.frozenDependencies || []).some((ref) => {
    const current = state.production.artifacts[ref.artifactId];
    return !current || current.status !== "current" || current.revision !== ref.revision || current.contentDigest !== ref.contentDigest;
  })) return null;
  if (Object.entries(task.targetExpectedRevisions || {}).some(([artifactId, revision]) =>
    (state.production.artifacts[artifactId]?.revision || null) !== revision)) return null;
  return task;
}

function taskUiView(task) {
  const modelLabel = [...new Set(Object.values(task.modelSnapshot || {})
    .map((item) => [modelDisplayLabel(item.provider, item.model), item.resolution].filter(Boolean).join(" · ")).filter(Boolean))].join(" / ");
  if (task.kind === "fullStory") return fullStoryTaskView(task, { modelLabel, noun: fullStoryLabel() });
  const view = taskStatusView(task, { modelLabel, kindLabel: storyEntryTaskKindLabel(task.kind) });
  if (!view.busy) view.message += formatStageUsageSuffix(task.usage);
  return view;
}

function activeTaskForKinds(kinds, { rootOnly = false } = {}) {
  return latestTaskForTarget(Object.fromEntries(Object.entries(state.taskSnapshots)
    .filter(([, task]) => isActiveTask(task))), { kinds, rootOnly });
}

function syncStoryTaskStatus({ includeTerminal = false } = {}) {
  syncFullStoryTaskStatus({ includeTerminal });
  const variant = selectedVariant();
  if (!variant) return;
  const apply = (kinds, artifactId, localRunning, setRunning, setStatus, button, label) => {
    const active = activeTaskForKinds(kinds);
    const task = active || taskForUi({ kinds, artifactId });
    const busy = Boolean(active) || localRunning;
    setRunning(busy);
    if (active || (includeTerminal && task && !localRunning)) {
      const view = taskUiView(task);
      const target = durableTaskTargetContext(task);
      const prefix = target.variantId && target.variantId !== variant.id ? `${target.variantId} · ` : "";
      setStatus(`${prefix}${view.message}`, view.tone);
      if (view.busy) button.textContent = `${prefix}${view.buttonLabel}`;
    } else if (localRunning) {
      setStatus(`正在生成${label}…`, "active");
    }
  };
  apply(["animationPlan", "characterReferenceRefine"], `animationPlan:${variant.id}`, state.animationRunning,
    setAnimationRunning, setAnimationStatus, elements.animationGenerate, "动画生产包");
}

function syncFullStoryTaskStatus({ includeTerminal = false } = {}) {
  const variant = selectedVariant();
  const current = selectedFullStoryTask();
  const active = isActiveTask(current) ? current : activeTaskForKinds(["fullStory"], { rootOnly: true });
  const request = state.storyGenerationRequest;
  const task = active || current;
  setStoryRunning(Boolean(active) || state.storyRunning);
  if (!variant) return;
  if (active || (includeTerminal && task && (!state.storyRunning || task.taskId === request?.taskId))) {
    const view = taskUiView(task);
    const target = durableTaskTargetContext(task);
    const prefix = target.variantId && target.variantId !== variant.id ? `${target.variantId} · ` : "";
    setStoryStatus(`${prefix}${view.message}`, view.tone);
    state.storyTaskStatusVisible = true;
  } else if (state.storyRunning && request) {
    const prefix = request.variantId !== variant.id ? `${request.variantId} · ` : "";
    setStoryStatus(`${prefix}正在启动完整剧情生成…`, "active");
    state.storyTaskStatusVisible = true;
  } else if (state.storyTaskStatusVisible) {
    const story = state.fullStories[variant.id];
    setStoryStatus(story ? `已生成完整剧情 · ${storyModelLabel()}` : "准备生成完整剧情。", story ? "ready" : "");
  }
}

function syncCharacterImageTaskStatus({ includeTerminal = false } = {}) {
  if (!state.characterImageGeneration.open) return false;
  const variant = selectedVariant();
  const index = Number(elements.characterImageRole.value) || 0;
  const task = taskForUi({ kinds: ["characterReferenceImages"], artifactId: `characterImages:${variant?.id}:${index}` });
  if (!task || (!isActiveTask(task) && !includeTerminal)) return false;
  const view = taskUiView(task);
  state.characterImageGeneration.running = view.busy;
  if (Number(task.progress?.expectedCount) > 0) {
    state.characterImageGeneration.count = Number(task.progress.expectedCount);
    elements.characterImageCount.value = String(task.progress.expectedCount);
  }
  setCharacterImageRunning(view.busy);
  setCharacterImageStatus(view.message, view.tone);
  if (view.busy) elements.generateCharacterImages.querySelector("span").textContent = view.buttonLabel;
  return true;
}

function syncShotVideoTaskStatus({ includeTerminal = false } = {}) {
  if (!state.shotVideoGeneration.open) return false;
  const artifactId = `shotVideo:${state.selectedVariantId}:${state.shotVideoGeneration.shotId}`;
  const task = taskForUi({ kinds: ["shotVideo"], artifactId });
  if (!task || (!isActiveTask(task) && !includeTerminal)) return false;
  const view = taskUiView(task);
  setShotVideoGeneratorRunning(view.busy);
  setShotVideoStatus(view.message, view.tone);
  if (view.busy) elements.confirmGenerateShotVideo.querySelector("span").textContent = view.buttonLabel;
  return true;
}

function syncDirectorTaskStatus() {
  if (isStoryEntryMode()) {
    const storyPipeline = latestTaskForTarget(state.taskSnapshots, { kinds: ["storyPipeline"], rootOnly: true });
    if (storyPipeline) renderStoryPipelineTaskStatus(storyPipeline);
    return;
  }
  const pipeline = latestTaskForTarget(state.taskSnapshots, { kinds: ["directorPipeline"], rootOnly: true });
  if (pipeline) renderDirectorTaskStatus(pipeline);
  const variants = latestTaskForTarget(state.taskSnapshots, { kinds: ["variants"], rootOnly: true });
  if (variants && (!pipeline || variants.createdAt > pipeline.createdAt)) {
    const view = taskUiView(variants);
    setStage("variants", view.busy ? "active" : variants.status === "completed" ? "done" : "error");
  }
}
function storyModelLabel() { return modelDisplayLabel(state.storyProvider, state.storyModel); }
function animationModelLabel() { return modelDisplayLabel(state.animationProvider, state.animationModel); }
function shotVideoSetting() {
  const setting = effectiveStageSetting("shotVideo");
  return { ...setting, provider: setting.provider || "Seedance" };
}
function shotVideoProviderLabel(provider = shotVideoSetting().provider) {
  return SHOT_VIDEO_PROVIDER_LABELS[provider] || provider || "视频模型";
}
// ---- 镜头视频的生成分辨率（2026-10-10）----
// 每个视频模型各记一份上次的选择，只存在这个标签页的 sessionStorage 里（与模型选择同一层，不长期保存）。
// 选回服务端默认值就不记：请求里不带 resolution，由服务端按配置决定，与没选完全一样。
function readShotVideoResolutionChoices() {
  try {
    const value = JSON.parse(sessionStorage.getItem(SHOT_VIDEO_RESOLUTION_STORAGE_KEY) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function writeShotVideoResolutionChoice(setting, value) {
  const choices = readShotVideoResolutionChoices();
  const key = `${setting.provider}:${setting.model || ""}`;
  if (value) choices[key] = value;
  else delete choices[key];
  try {
    sessionStorage.setItem(SHOT_VIDEO_RESOLUTION_STORAGE_KEY, JSON.stringify(choices));
  } catch {
    // 存不下只影响刷新后记不记得这次的选择，本次照常按页面上选的发送。
  }
}

// 当前视频模型的分辨率：能选哪些、服务端默认值（来自 /api/health）、这个标签页选了什么、能不能直接生成。
// 服务端配的默认值不适用于这个模型时不替换成别的值，要求先明确选一个（ready=false）。
function shotVideoResolutionState(setting = shotVideoSetting()) {
  const provider = setting.provider;
  const model = setting.model || "";
  const options = shotVideoResolutionOptions(provider, model);
  const defaultInfo = state.providers?.[provider]?.resolutionDefaults?.[model] || null;
  if (!options.length) return { setting, options, defaultInfo, defaultValue: "", selected: "", explicit: false, ready: true };
  const defaultValue = defaultInfo && !defaultInfo.error ? defaultInfo.value || "" : "";
  const remembered = readShotVideoResolutionChoices()[`${provider}:${model}`];
  const explicit = isShotVideoResolutionOption(provider, model, remembered) && remembered !== defaultValue;
  return {
    setting,
    options,
    defaultInfo,
    defaultValue,
    selected: explicit ? remembered : defaultValue,
    explicit,
    ready: explicit || !defaultInfo?.error
  };
}

function shotVideoResolutionRequestFields(resolution = shotVideoResolutionState()) {
  return resolution.explicit ? { resolution: resolution.selected } : {};
}

function shotVideoResolutionNotReadyText(resolution) {
  return `请先在镜头视频弹窗里选一个生成分辨率：服务端配置的默认值不能用于 ${modelName(resolution.setting.model) || "当前视频模型"}（${resolution.defaultInfo?.error || "默认值无效"}）。`;
}

function renderShotVideoResolutionControl(resolution = shotVideoResolutionState()) {
  const hint = elements.shotVideoResolutionHint;
  if (!resolution.options.length) {
    elements.shotVideoResolutionField.classList.add("hidden");
    hint.textContent = "当前视频模型没有分辨率参数，本次请求不发送分辨率。";
    hint.className = "shot-video-resolution-hint";
    return resolution;
  }
  elements.shotVideoResolutionField.classList.remove("hidden");
  const { options, defaultInfo, defaultValue, selected } = resolution;
  const placeholder = defaultInfo?.error
    ? `<option value="" disabled${selected ? "" : " selected"}>请选择分辨率</option>`
    : defaultValue ? "" : `<option value=""${selected ? "" : " selected"}>默认（由服务端配置决定）</option>`;
  elements.shotVideoResolution.innerHTML = placeholder + options.map((value) =>
    `<option value="${escape(value)}"${value === selected ? " selected" : ""}>${escape(value)}${value === defaultValue ? "（默认）" : ""}</option>`).join("");
  elements.shotVideoResolution.value = selected;
  elements.shotVideoResolution.disabled = state.shotVideoGeneration.running;
  if (!resolution.ready) {
    hint.textContent = `服务端配置的默认分辨率不能用于这个模型：${defaultInfo.error}。请先选一个分辨率。`;
    hint.className = "shot-video-resolution-hint warn";
  } else {
    hint.textContent = "分辨率越高，供应商收费越高、生成越慢。";
    hint.className = "shot-video-resolution-hint";
  }
  return resolution;
}

// 只记下选择、刷新下拉框；不碰 4.0 分镜的单镜提示词（分辨率与提示词无关，不重写、不多调模型）。
function handleShotVideoResolutionChange() {
  const resolution = shotVideoResolutionState();
  if (!resolution.options.length) return;
  const provider = resolution.setting.provider;
  const value = elements.shotVideoResolution.value;
  const valid = isShotVideoResolutionOption(provider, resolution.setting.model || "", value);
  writeShotVideoResolutionChoice(resolution.setting, valid && value !== resolution.defaultValue ? value : "");
  renderShotVideoResolutionControl();
}

// 候选视频的分辨率：请求的值与 ffprobe 实测宽高并列，对不上也只是并列显示。
function shotVideoResolutionText(video = {}) {
  const requested = typeof video.resolution === "string" ? video.resolution : "";
  const width = Number(video.measuredWidth) || 0;
  const height = Number(video.measuredHeight) || 0;
  const measured = width > 0 && height > 0 ? `实测 ${width}×${height}` : "";
  if (requested && measured) return `${requested}（${measured}）`;
  return requested || measured;
}

function shotVideoResultLabel(video = {}, result = {}) {
  const setting = shotVideoSetting();
  const provider = video.provider || result.provider || setting.provider;
  const model = video.model || result.model || setting.model || "";
  return model ? `${shotVideoProviderLabel(provider)} ${modelName(model)}` : shotVideoProviderLabel(provider);
}
function openModelSettings() {
  setModelSettingsStatus("");
  renderModelSettings();
  elements.modelSettingsModal.classList.remove("hidden");
  elements.modelSettingsModal.setAttribute("aria-hidden", "false");
}
function closeModelSettings() {
  closeModelPicker();
  elements.modelSettingsModal.classList.add("hidden");
  elements.modelSettingsModal.setAttribute("aria-hidden", "true");
}
function renderModelSettings() {
  if (!elements.modelStageList) return;
  closeModelPicker();
  const providers = availableModelProviders();
  elements.modelStageList.innerHTML = MODEL_STAGE_DEFS.map((stage) => {
    const current = effectiveStageSetting(stage.key);
    const defaultSetting = state.modelStages[stage.key] || {};
    const eligibleProviders = providers.filter((provider) => providerAllowedForStage(provider, stage.key));
    const providerOptions = stage.providers
      ? stage.providers
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
      <div class="model-picker">
        <select data-model-name="${escape(stage.key)}">
          ${renderModelOptions(stage, selectedProvider, selectedModel, defaultSetting)}
        </select>
        <button class="model-picker-trigger" type="button" data-model-picker-trigger aria-haspopup="menu" aria-expanded="false" aria-label="${escape(stage.label)}模型">
          <span class="model-picker-value" data-model-picker-label>${escape(selectedModel)}</span><span class="model-picker-caret" aria-hidden="true"></span>
        </button>
      </div>
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
  closeModelPicker();
  syncModelPickerLabel(row);
}
// 模型级联菜单：第一级是系列（MiMo V2.5 / MiMo V2.6…），悬停或点击系列在右侧展开该系列的型号。
// 隐藏的 <select data-model-name> 仍是唯一的取值来源，保存、校验逻辑不变；菜单只是它的另一张皮，
// 每次打开都按 select 当前的选项现建。菜单挂在 body 上用 fixed 定位，因为弹窗卡片 overflow:auto 会把它裁掉。
const MODEL_SERIES_OTHER_LABEL = "其他型号";
const modelPicker = { root: null, submenu: null, trigger: null, select: null, groups: [], activeSeries: -1, hoverTimer: 0 };
function modelSeriesLabel(provider, model) {
  const id = String(model || "").trim();
  let match;
  // MiMo 的 /models 还会列出 ASR、TTS 语音模型，单独成组，不和对话模型混在同一个系列里。
  if (provider === "MiMo" && (match = id.match(/^mimo-v(\d+(?:\.\d+)?)/iu))) {
    return /-(?:asr|tts)(?:-|$)/iu.test(id) ? `MiMo V${match[1]} 语音` : `MiMo V${match[1]}`;
  }
  if (provider === "Qwen") {
    if ((match = id.match(/^qwen(\d+(?:\.\d+)?)-/iu))) return `Qwen ${match[1]}`;
    if (/^qwen-vl-/iu.test(id)) return "Qwen VL";
    if (/^qwen-omni-/iu.test(id)) return "Qwen Omni";
    if (/^qwen-(?:max|plus|turbo)/iu.test(id)) return "Qwen 通用";
  }
  if (provider === "DeepSeek" && (match = id.match(/^deepseek-v(\d+(?:\.\d+)?)/iu))) return `DeepSeek V${match[1]}`;
  if (provider === "Claude" && (match = id.match(/^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?$/iu))) {
    return `Claude ${match[1][0].toUpperCase()}${match[1].slice(1).toLowerCase()} ${match[3] ? `${match[2]}.${match[3]}` : match[2]}`;
  }
  if (provider === "Jimeng" && (match = id.match(/seedream-(\d+)-(\d+)/iu))) return `Seedream ${match[1]}.${match[2]}`;
  if (provider === "Seedance" && (match = id.match(/seedance-(\d+)-(\d+)/iu))) return `Seedance ${match[1]}.${match[2]}`;
  if (provider === "MiniMax" && (match = id.match(/^minimax-(h\d+)/iu))) return `MiniMax ${match[1].toUpperCase()}`;
  return MODEL_SERIES_OTHER_LABEL;
}
// 系列按目录里最靠前的成员排序，组内同理；目录外（接口列出来的）型号排在后面，「其他型号」永远垫底。
function modelSeriesGroups(provider, stageKey, models = []) {
  const catalog = modelCatalogFor(provider, stageKey);
  const ranked = uniqueModels(models)
    .map((model, index) => ({ model, rank: catalog.includes(model) ? catalog.indexOf(model) : catalog.length + index }))
    .sort((a, b) => a.rank - b.rank);
  const groups = new Map();
  for (const { model } of ranked) {
    const label = modelSeriesLabel(provider, model);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(model);
  }
  return [...groups]
    .map(([label, items]) => ({ label, models: items }))
    .sort((a, b) => Number(a.label === MODEL_SERIES_OTHER_LABEL) - Number(b.label === MODEL_SERIES_OTHER_LABEL));
}
// 只有一个系列，或每个系列都只有一个型号时，二级菜单只会多点一下，直接平铺。
function modelSeriesNeedsCascade(groups = []) {
  return groups.length > 1 && groups.some((group) => group.models.length > 1);
}
function renderModelPickerItems(models, current) {
  return models.map((model) => `<button class="model-picker-item" type="button" role="menuitemradio" aria-checked="${model === current}" data-model-value="${escape(model)}"><span class="model-picker-check" aria-hidden="true">${model === current ? "✓" : ""}</span><span>${escape(model)}</span><span></span></button>`).join("");
}
function syncModelPickerLabel(row) {
  const select = row?.querySelector("[data-model-name]");
  const label = row?.querySelector("[data-model-picker-label]");
  if (select && label) label.textContent = select.value;
}
function handleModelPickerTriggerClick(event) {
  const trigger = event.target.closest("[data-model-picker-trigger]");
  if (!trigger) return;
  if (modelPicker.trigger === trigger) {
    closeModelPicker();
    return;
  }
  // event.detail 为 0 表示由回车/空格触发：键盘打开时把焦点送进菜单。
  openModelPicker(trigger, { focus: event.detail === 0 });
}
function handleModelPickerTriggerKeydown(event) {
  const trigger = event.target.closest("[data-model-picker-trigger]");
  if (!trigger || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
  event.preventDefault();
  if (modelPicker.trigger !== trigger) openModelPicker(trigger, { focus: true });
  else focusModelPickerItem(modelPicker.root, 0);
}
function openModelPicker(trigger, { focus = false } = {}) {
  closeModelPicker();
  const row = trigger.closest("[data-model-stage]");
  const select = row?.querySelector("[data-model-name]");
  if (!row || !select) return;
  const provider = row.querySelector("[data-model-provider]")?.value || "";
  const models = [...select.options].map((option) => option.value);
  if (!models.length) return;
  const groups = modelSeriesGroups(provider, row.dataset.modelStage, models);
  const cascade = modelSeriesNeedsCascade(groups);
  const root = createModelPickerMenu();
  root.innerHTML = cascade
    ? groups.map((group, index) => `<button class="model-picker-item model-picker-series${group.models.includes(select.value) ? " current" : ""}" type="button" role="menuitem" aria-haspopup="menu" aria-expanded="false" data-model-series-index="${index}"><span class="model-picker-check" aria-hidden="true">${group.models.includes(select.value) ? "•" : ""}</span><span>${escape(group.label)}</span><span class="model-picker-chevron" aria-hidden="true">›</span></button>`).join("")
    : renderModelPickerItems(groups.flatMap((group) => group.models), select.value);
  Object.assign(modelPicker, { root, trigger, select, groups: cascade ? groups : [], activeSeries: -1 });
  trigger.setAttribute("aria-expanded", "true");
  positionModelPickerMenu(root, trigger.getBoundingClientRect());
  if (focus) {
    const items = modelPickerItems(root);
    const current = items.findIndex((item) => item.classList.contains("current") || item.getAttribute("aria-checked") === "true");
    focusModelPickerItem(root, Math.max(0, current));
  }
}
function createModelPickerMenu(extraClass = "") {
  const menu = document.createElement("div");
  menu.className = `model-picker-menu${extraClass ? ` ${extraClass}` : ""}`;
  menu.setAttribute("role", "menu");
  menu.addEventListener("click", handleModelPickerMenuClick);
  menu.addEventListener("mouseover", handleModelPickerMenuHover);
  menu.addEventListener("keydown", handleModelPickerMenuKeydown);
  document.body.append(menu);
  return menu;
}
function openModelPickerSeries(index, { focus = false } = {}) {
  clearTimeout(modelPicker.hoverTimer);
  const group = modelPicker.groups[index];
  const anchor = modelPicker.root?.querySelector(`[data-model-series-index="${index}"]`);
  if (!group || !anchor) return;
  if (modelPicker.activeSeries !== index) {
    modelPicker.submenu?.remove();
    for (const item of modelPicker.root.querySelectorAll("[data-model-series-index]")) {
      item.classList.toggle("open", item === anchor);
      item.setAttribute("aria-expanded", String(item === anchor));
    }
    const submenu = createModelPickerMenu("model-picker-submenu");
    submenu.innerHTML = renderModelPickerItems(group.models, modelPicker.select.value);
    modelPicker.submenu = submenu;
    modelPicker.activeSeries = index;
    positionModelPickerSubmenu(submenu, anchor.getBoundingClientRect(), modelPicker.root.getBoundingClientRect());
  }
  if (focus) {
    const current = group.models.indexOf(modelPicker.select.value);
    focusModelPickerItem(modelPicker.submenu, Math.max(0, current));
  }
}
function closeModelPickerSeries() {
  clearTimeout(modelPicker.hoverTimer);
  modelPicker.submenu?.remove();
  modelPicker.submenu = null;
  modelPicker.activeSeries = -1;
  for (const item of modelPicker.root?.querySelectorAll("[data-model-series-index]") || []) {
    item.classList.remove("open");
    item.setAttribute("aria-expanded", "false");
  }
}
function closeModelPicker() {
  if (!modelPicker.root) return;
  clearTimeout(modelPicker.hoverTimer);
  modelPicker.submenu?.remove();
  modelPicker.root.remove();
  modelPicker.trigger?.setAttribute("aria-expanded", "false");
  Object.assign(modelPicker, { root: null, submenu: null, trigger: null, select: null, groups: [], activeSeries: -1, hoverTimer: 0 });
}
function chooseModelPickerValue(value) {
  const { select, trigger } = modelPicker;
  if (!select) return;
  select.value = value;
  syncModelPickerLabel(select.closest("[data-model-stage]"));
  closeModelPicker();
  trigger?.focus();
}
function handleModelPickerMenuClick(event) {
  const option = event.target.closest("[data-model-value]");
  if (option) {
    chooseModelPickerValue(option.dataset.modelValue);
    return;
  }
  // 点击系列也能展开：触屏没有悬停。
  const series = event.target.closest("[data-model-series-index]");
  if (series) openModelPickerSeries(Number(series.dataset.modelSeriesIndex));
}
function handleModelPickerMenuHover(event) {
  if (event.currentTarget === modelPicker.submenu) {
    // 鼠标已经到了子菜单：取消斜穿其他系列时排下的切换。
    clearTimeout(modelPicker.hoverTimer);
    return;
  }
  const series = event.target.closest("[data-model-series-index]");
  if (!series) return;
  const index = Number(series.dataset.modelSeriesIndex);
  clearTimeout(modelPicker.hoverTimer);
  if (index === modelPicker.activeSeries) return;
  // 已有子菜单时稍等一下再切换，鼠标斜着移向子菜单途中擦过别的系列不会把它换掉。
  modelPicker.hoverTimer = setTimeout(() => openModelPickerSeries(index), modelPicker.submenu ? 140 : 0);
}
function handleModelPickerMenuKeydown(event) {
  const menu = event.currentTarget;
  const inSubmenu = menu === modelPicker.submenu;
  const items = modelPickerItems(menu);
  const index = items.indexOf(document.activeElement);
  const series = event.target.closest("[data-model-series-index]");
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const step = event.key === "ArrowDown" ? 1 : -1;
    focusModelPickerItem(menu, index < 0 ? 0 : (index + step + items.length) % items.length);
  } else if (event.key === "Home" || event.key === "End") {
    event.preventDefault();
    focusModelPickerItem(menu, event.key === "Home" ? 0 : items.length - 1);
  } else if (series && (event.key === "ArrowRight" || event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    openModelPickerSeries(Number(series.dataset.modelSeriesIndex), { focus: true });
  } else if (inSubmenu && event.key === "ArrowLeft") {
    event.preventDefault();
    const active = modelPicker.activeSeries;
    closeModelPickerSeries();
    focusModelPickerItem(modelPicker.root, active);
  } else if (event.key === "Escape") {
    // 先收菜单，不让同一次 Escape 冒泡到 window 把整个模型设置弹窗也关掉。
    event.preventDefault();
    event.stopPropagation();
    if (inSubmenu) {
      const active = modelPicker.activeSeries;
      closeModelPickerSeries();
      focusModelPickerItem(modelPicker.root, active);
    } else {
      const trigger = modelPicker.trigger;
      closeModelPicker();
      trigger?.focus();
    }
  } else if (event.key === "Tab") {
    closeModelPicker();
  }
}
function modelPickerItems(menu) {
  return menu ? [...menu.querySelectorAll(".model-picker-item")] : [];
}
function focusModelPickerItem(menu, index) {
  modelPickerItems(menu)[index]?.focus();
}
function positionModelPickerMenu(menu, anchorRect) {
  const gap = 4;
  const margin = 8;
  menu.style.minWidth = `${Math.round(anchorRect.width)}px`;
  const { width, height } = menu.getBoundingClientRect();
  const left = Math.min(anchorRect.left, window.innerWidth - width - margin);
  let top = anchorRect.bottom + gap;
  if (top + height > window.innerHeight - margin && anchorRect.top - gap - height >= margin) top = anchorRect.top - gap - height;
  menu.style.left = `${Math.max(margin, left)}px`;
  menu.style.top = `${Math.max(margin, Math.min(top, window.innerHeight - height - margin))}px`;
}
// 子菜单贴着父菜单右缘展开（与 macOS 一致，略微叠一点）；右边放不下就翻到左边，两边都放不下（窄屏）就盖在父菜单上。
function positionModelPickerSubmenu(menu, anchorRect, parentRect) {
  const margin = 8;
  const overlap = 3;
  const { width, height } = menu.getBoundingClientRect();
  let left = parentRect.right - overlap;
  if (left + width > window.innerWidth - margin) {
    left = parentRect.left - width + overlap;
    if (left < margin) left = Math.max(margin, Math.min(parentRect.left + 16, window.innerWidth - width - margin));
  }
  // 子菜单第一项与系列项对齐：减掉菜单的内边距与边框。
  const top = Math.min(anchorRect.top - 6, window.innerHeight - height - margin);
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(Math.max(margin, top))}px`;
}
async function saveModelSettings() {
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
  sessionStorage.setItem("directorModelOverrides", JSON.stringify(next));
  applyEffectiveModelState();
  renderModelSettings();
  updateModelStateLabel();
  updateModelActionLabels();
  elements.storyModelName.textContent = modelDisplayLabel(state.storyProvider, state.storyModel);
  setModelSettingsStatus("已应用。之后所有生成请求都会使用当前模型路由。", "ready");
  await refreshOpenShotVideoPromptAfterModelChange();
}
async function resetModelSettings() {
  state.modelOverrides = {};
  sessionStorage.removeItem("directorModelOverrides");
  applyEffectiveModelState();
  renderModelSettings();
  updateModelStateLabel();
  updateModelActionLabels();
  elements.storyModelName.textContent = modelDisplayLabel(state.storyProvider, state.storyModel);
  setModelSettingsStatus("已恢复后端默认模型。", "ready");
  await refreshOpenShotVideoPromptAfterModelChange();
}

// 换了镜头视频模型或写稿模型：镜头弹窗开着时，本镜提示词的缓存键已经变了，按新模型重新写。
async function refreshOpenShotVideoPromptAfterModelChange() {
  const variant = selectedVariant();
  const plan = variant ? state.animationPlans[variant.id] || null : null;
  if (!isStoryboardPlan(plan) || !state.shotVideoGeneration.open) return;
  state.shotVideoGeneration.promptKey = null;
  await updateShotVideoGeneratorPreview();
}

function setModelSettingsStatus(message, tone = "") {
  elements.modelSettingsStatus.textContent = message;
  elements.modelSettingsStatus.className = `story-status ${tone}`;
}
function readModelOverrides() {
  try {
    const value = JSON.parse(sessionStorage.getItem("directorModelOverrides") || "{}");
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
  const llmProviders = new Set(["Qwen", "MiMo", "DeepSeek", "Claude"]);
  const configured = Object.entries(state.providers || {})
    .filter(([provider, value]) => llmProviders.has(provider) && value?.configured)
    .map(([provider]) => provider);
  const fromStages = MODEL_STAGE_DEFS
    .filter((stage) => !stage.providerLocked)
    .map((stage) => state.modelStages?.[stage.key]?.provider)
    .filter((provider) => llmProviders.has(provider));
  return [...new Set([...configured, ...fromStages, "Qwen", "MiMo", "DeepSeek", "Claude"])];
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
  if (stageKey === "shotVideo") return modelCatalogFor(provider, stageKey).includes(model);
  if (provider !== "Qwen" || !MEDIA_INPUT_MODEL_STAGES.has(stageKey)) return true;
  return !isKnownQwenTextOnlyModel(model) && /(?:plus|vl|omni)/iu.test(model);
}
function providerAllowedForStage(provider, stageKey) {
  // 参考片仿写只列 Claude 与 MiMo（服务端同样只认这两家）。
  if (stageKey === REFERENCE_REWRITE_STAGE) return REFERENCE_REWRITE_PROVIDERS.includes(provider);
  return !(TEXT_ONLY_MODEL_PROVIDERS.has(provider) && MEDIA_INPUT_MODEL_STAGES.has(stageKey));
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
  return `${modelDisplayLabel(state.analysisProvider, state.analysisModel)} 解析 · 剧情 ${modelDisplayLabel(state.storyProvider, state.storyModel)} · 动画 ${modelDisplayLabel(state.animationProvider, state.animationModel)}`;
}
function updateModelActionLabels() {
  renderFullStoryControls();
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
function persistedTaskModelLabel(artifactId, stage, fallback = "") {
  const snapshot = state.productionTasks?.[artifactId]?.modelSnapshot?.[stage];
  return snapshot?.model ? modelDisplayLabel(snapshot.provider, snapshot.model) : fallback;
}
function modelName(model) { return String(model || "").split("/").pop(); }
function validateReady() {
  renderReferenceRewriteControls();
  if (sourceLoading || !browserWorkspace.workspace) { elements.run.disabled = true; return; }
  if (state.running) return;
  elements.run.disabled = !setupReadiness().ready;
}

// 「开始」按钮能不能点，以及不能点的原因。validateReady 与导演助手共用这一处判断（不碰按钮）。
function setupReadiness() {
  if (sourceLoading || !browserWorkspace.workspace) return { ready: false, reason: "页面还在恢复上一次的进度。" };
  const missingProfile = [
    elements.fixedCharacter.value.trim() ? "" : "固定角色",
    elements.vertical.value.trim() ? "" : "垂直赛道"
  ].filter(Boolean);
  const profileReason = missingProfile.length ? `先在左边填好${missingProfile.join("和")}。` : "";
  if (isStoryEntryMode()) {
    // 剧情入口不需要视频：固定角色、垂直赛道填好，故事草稿合法（只给角色设定时不要正文）即可开始。
    let storyReason = "";
    try { normalizeStorySource(currentStorySourceDraft()); } catch (error) { storyReason = error.message || "故事原文不合法。"; }
    const task = state.taskSnapshots[state.directorTaskId];
    if (isActiveTask(task)) return { ready: false, reason: `${storyPipelineLabels().noun}正在进行。` };
    if (storyReason || profileReason) return { ready: false, reason: profileReason || storyReason };
    return { ready: true, reason: "" };
  }
  const resumableWithoutMedia = Boolean(
    state.production.runId
    && state.production.artifacts?.referenceAnalysis?.status === "current"
    && state.production.artifacts?.sourceScriptReconstruction?.status === "current"
    && state.production.artifacts?.visualGuardrails?.status === "current"
    && state.production.artifacts?.themeVariants?.status !== "current"
  );
  if (!(state.frames.length >= 3 || resumableWithoutMedia)) {
    return { ready: false, reason: state.production.runId ? "要继续这个 Run，需要重新上传同一个参考视频。" : "先上传参考视频。" };
  }
  if (profileReason) return { ready: false, reason: profileReason };
  return { ready: true, reason: "" };
}
function showError(message, tone = "error") {
  elements.error.textContent = message;
  elements.error.classList.toggle("notice", Boolean(message) && tone === "notice");
}
function profile() { return { fixedCharacter: elements.fixedCharacter.value.trim(), vertical: elements.vertical.value.trim(), constraints: elements.constraints.value.trim() }; }
async function handleProfileInput() {
  const currentProfile = profile();
  // Keep the user's settings even if they close the page during server cleanup.
  saveProfile();
  if (
    state.production.runId
    && (!state.characterBoundaryProfile || JSON.stringify(currentProfile) !== JSON.stringify(state.characterBoundaryProfile))
  ) {
    await invalidateGlobalCharacterBoundary();
  }
  validateReady();
}
async function invalidateGlobalCharacterBoundary(message = "固定角色或创作设定已修改；旧的全局角色边界已失效，请重新运行工作流。") {
  const active = await activeProductionTasks();
  if (active.length) {
    const confirmed = window.confirm(
      `${message}\n\n当前仍有服务端任务在执行。是否明确放弃这些任务？\n`
      + "放弃不会取消已经提交给供应商的远端任务，仍可能产生费用。"
    );
    if (!confirmed) {
      showError("已保留当前 Run 和任务；未清除服务端状态。");
      return false;
    }
  }
  const epoch = browserWorkspace.beginChange();
  sourceLoading = true;
  validateReady();
  try {
    if (!await browserWorkspace.resetRun(epoch)) return false;
    clearVideoWorkspaceUi({ keepSource: true });
    showError(message);
    return true;
  } catch (error) {
    if (browserWorkspace.isCurrent(epoch)) showError(error.message || "旧生产结果尚未清理成功，请重试。");
    return false;
  } finally {
    if (browserWorkspace.isCurrent(epoch)) { sourceLoading = false; validateReady(); }
  }
}

function globalCharacterBoundaryContext() {
  return {
    creatorProfile: profile(),
    ...videoUpstreamCopies(),
    visualGuardrails: state.output.visualGuardrails
  };
}
function saveProfile() { localStorage.setItem("directorProfile", JSON.stringify(profile())); }
// 角色表情规则单独存。**绝不能并进 directorProfile**：那是 profile() 的存档，而
// profile() 整体进 character-boundary 的 sourceDigest，混进去会让「改一句表情」
// 作废全局角色边界并要求重跑整条工作流。表情是表演表现，不是角色身份事实。
// 角色画风（2026-10-09，接替「角色表情规则」那一栏）：生成分镜时随请求发给服务端，服务端写进
// 分镜的 productionStrategy.artStyle。它不进 creatorProfile，改它不会作废角色边界，只影响下一次
// 生成的分镜。
function characterArtStyle() { return normalizeCharacterArtStyle(elements.characterArtStyle.value); }
function saveCharacterArtStyle() {
  try { localStorage.setItem(CHARACTER_ART_STYLE_STORAGE_KEY, elements.characterArtStyle.value); } catch {}
}
function restoreCharacterArtStyle() {
  elements.characterArtStylePresets.innerHTML = CHARACTER_ART_STYLE_PRESETS.map((value) => `<option value="${escape(value)}"></option>`).join("");
  // catch 只兜 localStorage 本身不可用（隐私模式、站点数据被禁），不兜代码错误——
  // 表情规则那一版曾把整段包进 try 里，常量的 TDZ ReferenceError 被静默吞掉，刷新后文本框一直是空的。
  let saved = null;
  try { saved = localStorage.getItem(CHARACTER_ART_STYLE_STORAGE_KEY); } catch { saved = null; }
  // 第一次用、没有存档时填默认画风；用户清空后存的是空串，表示不指定，照样尊重。
  elements.characterArtStyle.value = typeof saved === "string" ? saved : DEFAULT_CHARACTER_ART_STYLE;
}
function restoreProfile() { try { const data = JSON.parse(localStorage.getItem("directorProfile")); if (data) { elements.fixedCharacter.value = data.fixedCharacter || ""; elements.vertical.value = data.vertical || ""; elements.constraints.value = data.constraints || ""; } } catch {} }

function saveCreationPreferences() {
  localStorage.setItem(CREATION_PREFERENCES_STORAGE_KEY, JSON.stringify(creationPreferences({
    variantCount: elements.variantCount.value,
    animationAspectRatioDefault: state.animationAspectRatioDefault,
    storyDurationTarget: state.storyDurationTarget
  })));
}

function restoreCreationPreferences() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(CREATION_PREFERENCES_STORAGE_KEY) || "{}"); } catch {}
  const preferences = creationPreferences(saved || {});
  elements.variantCount.value = preferences.variantCount;
  state.animationAspectRatioDefault = preferences.animationAspectRatioDefault;
  state.storyDurationTarget = preferences.storyDurationTarget;
  syncAnimationAspectRatioControls();
}

function persistActiveProductionRun() {
  browserWorkspace.rememberRun(state.production);
}

async function restoreActiveProductionRun(active, workspaceEpoch = browserWorkspace.epoch) {
  if (!active?.projectId || !active?.runId) return false;
  try {
    const taskQuery = new URLSearchParams({ projectId: active.projectId, runId: active.runId });
    const [run, taskPayload] = await Promise.all([
      api("/api/production/run/load", {
        projectId: active.projectId,
        runId: active.runId,
        includeContent: true
      }),
      fetch(`/api/tasks?${taskQuery}`).then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.ok) {
          throw createApiRequestError(payload, response.status, `任务列表读取失败（${response.status}）`);
        }
        return payload;
      })
    ]);
    assertWorkspaceCurrent(workspaceEpoch);
    state.production = productionStateFromRun(run);
    const allTasks = Array.isArray(taskPayload.tasks) ? taskPayload.tasks : [];
    state.taskSnapshots = {};
    for (const task of allTasks) rememberTaskSnapshot(state.taskSnapshots, task);
    restoreRunMetadata(run.metadata || {});
    restoreRunArtifacts(run.latestArtifacts || {});
    persistActiveProductionRun();
    renderRestoredDirectorArtifacts();
    state.productionTasks = {};
    for (const task of [...allTasks].reverse()) {
      for (const artifactId of task.targetArtifactIds || []) state.productionTasks[artifactId] = task;
    }
    const activeTasks = allTasks.filter((task) => ["queued", "running"].includes(task.status));
    const activeCharacterImages = activeTasks.find((task) => task.kind === "characterReferenceImages");
    if (!activeCharacterImages) {
      const completedCharacterImages = allTasks.find((task) => (
        task.kind === "characterReferenceImages"
        && task.status === "completed"
        && taskResultIsCurrent(state.production, task)
        && durableTaskTargetContext(task).variantId === state.selectedVariantId
      ));
      if (completedCharacterImages) {
        adoptCharacterImageTaskTarget(completedCharacterImages);
        applyCharacterImageTaskProgress(completedCharacterImages);
        state.characterImageGeneration.running = false;
        setCharacterImageStatus("已恢复上次生成的角色参考图，可继续预览或设为人物参考图。", "ready");
      }
    }
    const pipeline = activeTasks.find((task) => task.kind === "directorPipeline");
    if (pipeline) {
      state.running = true;
      setRunning(true);
      directorArtifactSynchronizer.markRendered(pipeline, renderedDirectorStageCount());
      void updateDirectorTaskProgress(pipeline);
      void attachRestoredDirectorPipeline(pipeline);
    }
    const storyPipeline = activeTasks.find((task) => task.kind === "storyPipeline");
    if (storyPipeline) {
      state.running = true;
      setRunning(true);
      renderStoryPipelineTaskStatus(storyPipeline);
      void attachRestoredStoryPipeline(storyPipeline);
    }
    for (const task of activeTasks.filter((item) => !item.parentTaskId && !["directorPipeline", "storyPipeline"].includes(item.kind))) {
      markRestoredTaskRunning(task);
      void attachRestoredStandaloneTask(task);
    }
    syncDirectorTaskStatus();
    syncStoryTaskStatus({ includeTerminal: true });
    return true;
  } catch (error) {
    if (!browserWorkspace.isCurrent(workspaceEpoch)) return false;
    // 暂时的服务不可用不能删除当前页面的 workspace 指针。
    showError(error?.message || "暂时无法恢复上次生产 Run，请稍后刷新重试。", "notice");
    return false;
  }
}

async function attachRestoredDirectorPipeline(task) {
  const workspaceEpoch = browserWorkspace.epoch;
  try {
    const completed = await waitForDurableTask(task, updateDirectorTaskProgress);
    await directorArtifactSynchronizer.sync(completed);
    assertWorkspaceCurrent(workspaceEpoch);
    renderDirectorTaskStatus(completed);
  } catch (error) {
    if (!browserWorkspace.isCurrent(workspaceEpoch)) return;
    renderDirectorTaskError(error, "AI 导演任务未能继续");
  } finally {
    if (!browserWorkspace.isCurrent(workspaceEpoch)) return;
    state.running = false;
    setRunning(false);
    validateReady();
  }
}

// 刷新后重新接管还在跑的参考片仿写任务。
async function attachRestoredReferenceRewrite(task) {
  const workspaceEpoch = browserWorkspace.epoch;
  try {
    await finishReferenceRewriteTask(task, workspaceEpoch);
  } catch (error) {
    if (!browserWorkspace.isCurrent(workspaceEpoch)) return;
    setReferenceRewriteStatus(`参考片仿写没有完成：${error.message || "未知错误"}`, "error");
  } finally {
    if (browserWorkspace.isCurrent(workspaceEpoch)) {
      state.referenceRewriteRunning = false;
      renderReferenceRewriteControls();
    }
  }
}

function markRestoredTaskRunning(task) {
  const target = durableTaskTargetContext(task);
  if (task.kind === "variants") {
    state.variantsRegenerating = true;
    if (state.output.themeVariants) renderVariants(state.output.themeVariants);
    setStage("variants", "active");
  } else if (task.kind === "fullStory") {
    state.storyRunning = true;
    syncStoryTaskStatus();
  } else if (["animationPlan", "characterReferenceRefine"].includes(task.kind)) {
    state.animationRunning = true;
    syncStoryTaskStatus();
  } else if (task.kind === "shotVideo" && target.shotId) {
    setShotVideoStateItem(target.shotId, { status: "running", message: "已重新接管服务端视频任务…" }, target.variantId);
  } else if (task.kind === REFERENCE_REWRITE_TASK_KIND) {
    state.referenceRewriteRunning = true;
    setReferenceRewriteStatus(referenceRewriteProgressText(task));
    renderReferenceRewriteControls();
  } else if (task.kind === "characterReferenceImages") {
    adoptCharacterImageTaskTarget(task);
    state.characterImageGeneration.running = true;
    applyCharacterImageTaskProgress(task);
    setCharacterImageRunning(true);
  }
}

function adoptCharacterImageTaskTarget(task) {
  const target = durableTaskTargetContext(task);
  if (!target.variantId || target.roleIndex === null) return false;
  state.characterImageGeneration.selectedIndex = target.roleIndex;
  state.characterImageGeneration.resultsTarget = `${target.variantId}:${target.roleIndex}`;
  if ([...elements.characterImageRole.options].some((option) => option.value === String(target.roleIndex))) {
    elements.characterImageRole.value = String(target.roleIndex);
  }
  return true;
}

async function attachRestoredStandaloneTask(task) {
  if (task.kind === REFERENCE_REWRITE_TASK_KIND) return attachRestoredReferenceRewrite(task);
  const workspaceEpoch = browserWorkspace.epoch;
  try {
    const completed = await waitForDurableTask(task, (current) => {
      if (current.kind === "characterReferenceImages") applyCharacterImageTaskProgress(current);
    });
    state.productionTasks ||= {};
    for (const artifactId of completed.targetArtifactIds || []) state.productionTasks[artifactId] = completed;
    await reloadActiveProductionRun(state.production, { preserveSelectedVariant: task.kind === "fullStory" });
    const artifactId = completed.targetArtifactIds?.[0] || "";
    if (completed.kind === "variants") {
      setStage("variants", "done");
    } else if (completed.kind === "fullStory") {
      const variantId = artifactId.slice("fullStory:".length);
      const story = state.fullStories[variantId];
      if (variantId === state.selectedVariantId) {
        if (story) renderFullStory(story);
        setStoryStatus(`完整剧情任务已完成${formatStageUsageSuffix(completed.usage)}`, "ready");
      }
    } else if (["animationPlan", "characterReferenceRefine"].includes(completed.kind)) {
      const variantId = artifactId.slice("animationPlan:".length);
      const plan = state.animationPlans[variantId];
      if (plan) renderAnimationPlan(plan);
      setAnimationStatus(`服务端任务已完成${formatStageUsageSuffix(completed.usage)}`, "ready");
    } else if (completed.kind === "characterReferenceImages") {
      adoptCharacterImageTaskTarget(completed);
      applyCharacterImageTaskProgress(completed);
      setCharacterImageStatus(`角色参考图任务已完成${formatStageUsageSuffix(completed.usage)}`, "ready");
    } else if (completed.kind === "shotVideo") {
      const variantId = artifactId.split(":")[1] || "";
      const plan = state.animationPlans[variantId];
      if (plan) renderAnimationPlan(plan);
      setAnimationStatus("镜头媒体任务已完成。", "ready");
    }
  } catch (error) {
    if (!browserWorkspace.isCurrent(workspaceEpoch)) return;
    const target = durableTaskTargetContext(task);
    if (task.kind === "variants") {
      setStage("variants", "error");
      showError(error.message || "主题变体任务中断");
    } else if (task.kind === "fullStory") renderFullStoryTaskError(error, "完整剧情任务中断", target.variantId);
    else if (["animationPlan", "characterReferenceRefine"].includes(task.kind)) {
      setAnimationStatus(error.message || "动画任务中断", "error");
    } else if (task.kind === "characterReferenceImages") {
      setCharacterImageStatus(error.message || "角色参考图任务中断", "error");
    } else if (task.kind === "shotVideo" && target.shotId) {
      setShotVideoStateItem(target.shotId, {
        status: "error",
        message: error.message || "镜头视频任务中断"
      }, target.variantId);
      updateShotVideoResult(target.shotId);
      renderShotVideoModalResults();
      setAnimationStatus(error.message || "镜头视频任务中断", "error");
    }
  } finally {
    if (!browserWorkspace.isCurrent(workspaceEpoch)) return;
    if (task.kind === "variants") {
      state.variantsRegenerating = false;
      if (state.output.themeVariants) renderVariants(state.output.themeVariants);
    }
    if (task.kind === "fullStory") {
      state.storyRunning = false;
      setStoryRunning(false);
      syncStoryTaskStatus({ includeTerminal: true });
    }
    if (["animationPlan", "characterReferenceRefine"].includes(task.kind)) {
      state.animationRunning = false;
      setAnimationRunning(false);
    }
    if (task.kind === "characterReferenceImages") {
      state.characterImageGeneration.running = false;
      setCharacterImageRunning(false);
      syncCharacterImageTaskStatus({ includeTerminal: true });
    }
    if (task.kind === "shotVideo") {
      renderShotVideoModalResults();
      if (state.shotVideoGeneration.open) {
        setShotVideoGeneratorRunning(false);
        await updateShotVideoGeneratorPreview({ preservePrompt: true });
      }
    }
  }
}

function restoreRunMetadata(metadata = {}) {
  // 入口以 Run 元数据为准：剧情 Run 恢复成剧情入口，其余一律是参考视频入口。
  state.entryMode = metadata.entryMode === STORY_ENTRY_MODE ? STORY_ENTRY_MODE : "video";
  if (state.entryMode === STORY_ENTRY_MODE) {
    state.storyMode = metadata.storyMode === STORY_MODE_CHARACTER_ONLY ? STORY_MODE_CHARACTER_ONLY : STORY_MODE_FULL_TEXT;
  }
  applyEntryModeUi();
  state.metadata = metadata.sourceVideo || null;
  if (metadata.creatorProfile && typeof metadata.creatorProfile === "object") {
    elements.fixedCharacter.value = metadata.creatorProfile.fixedCharacter || "";
    elements.vertical.value = metadata.creatorProfile.vertical || "";
    elements.constraints.value = metadata.creatorProfile.constraints || "";
    saveProfile();
  }
  if (typeof metadata.transcript === "string") elements.transcript.value = metadata.transcript;
}

function restoreRunArtifacts(latestArtifacts = {}, { selectedVariantId = null } = {}) {
  const currentContent = (artifactId) => {
    const entry = latestArtifacts[artifactId];
    return entry?.lineage?.status === "current" ? entry.content : null;
  };
  // storySource 只在剧情 Run 上存在；只在有的时候加这个键，参考视频 Run 的导出内容逐字不变。
  const storySource = currentContent("storySource");
  state.output = {
    referenceAnalysis: currentContent("referenceAnalysis"),
    sourceScriptReconstruction: currentContent("sourceScriptReconstruction"),
    creativeBrief: currentContent("creativeBrief"),
    visualGuardrails: currentContent("visualGuardrails"),
    themeVariants: currentContent("themeVariants"),
    ...(storySource ? { storySource } : {})
  };
  state.referenceRewrite = currentContent(REFERENCE_REWRITE_ARTIFACT_ID);
  renderReferenceRewritePanel();
  if (storySource) {
    elements.storySourceText.value = storySource.storyText || "";
    state.storyMode = storySource.storyMode === STORY_MODE_CHARACTER_ONLY ? STORY_MODE_CHARACTER_ONLY : STORY_MODE_FULL_TEXT;
    applyEntryModeUi();
  }
  state.characterBoundaryProfile = state.output.visualGuardrails ? { ...profile() } : null;
  state.fullStories = {};
  state.animationPlans = {};
  state.shotVideoPrompts = {};
  state.animationPlanMetadata = {};
  state.animationAspectRatioDrafts = {};
  state.shotVideoResults = {};
  // 旧 v2 的 shotFrame:* 产物留在磁盘上，不再读取。
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
    else if (artifactId.startsWith("shotVideoPrompt:")) state.shotVideoPrompts[artifactId] = entry.content;
    else if (artifactId.startsWith("shotVideo:")) {
      const parts = artifactId.split(":");
      const variantId = parts[1] || "";
      const shotId = parts.slice(2).join(":");
      state.shotVideoResults[shotVideoResultKey(variantId, shotId)] = entry.content;
    }
  }
  state.output.fullStories = state.fullStories;
  state.output.animationPlans = state.animationPlans;
  const selectionStillAvailable = selectedVariantId && state.output.themeVariants?.variants
    .some((variant) => String(variant.id) === String(selectedVariantId));
  // 粘贴完整故事的 Run 没有候选：选中的就是故事位，依据是服务端签发的 storySource，不靠默认值。
  state.selectedVariantId = storySource?.storyMode === STORY_MODE_FULL_TEXT
    ? STORY_ENTRY_VARIANT_ID
    : selectionStillAvailable ? selectedVariantId : resolveRestoredVariantId(latestArtifacts);
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
    // 粘贴完整故事没有候选卡：第二格是可翻拍镜头的入口卡。
    isStorySourceRun()
      ? [state.fullStories[STORY_ENTRY_VARIANT_ID], renderStorySourceShots, "variants"]
      : [state.output.themeVariants, renderVariants, "variants"]
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
  syncDirectorTaskStatus();
}
function selectedVariant() {
  // 粘贴完整故事的 Run 没有候选：选中的是故事位 V1（只在页面内部用，见 storySourceSlot）。
  if (isStorySourceRun()) return String(state.selectedVariantId) === STORY_ENTRY_VARIANT_ID ? storySourceSlot() : undefined;
  return (state.output.themeVariants?.variants || []).find((variant) => String(variant.id) === String(state.selectedVariantId));
}
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
  // 剧情 Run 签 3.1 包（2026-10-10）：原文、角色边界、候选、固定角色设定都由服务端从 Run 读出，
  // 页面不发（发了会被拒）；页面内部的「故事位」也不是候选，不发。只发导出信息和剧情、分镜两份副本，
  // 服务端用它们核对页面上看到的就是当前版本。
  if (isStoryEntryMode()) {
    return {
      exportedAt: new Date().toISOString(),
      mode: state.mode,
      modelInfo: currentModelInfo(),
      fullStory: state.fullStories[variant.id] || null,
      animationPlan: state.animationPlans[variant.id] || null
    };
  }
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
    shotVideoResults: state.shotVideoResults || {}
  };
  return pack;
}

function updateStoryExportActions() {
  const pack = selectedStoryPackage();
  const hasStory = Boolean(pack?.fullStory);
  // 参考视频的 Run 签 3.0 包，剧情 Run 签 3.1 包（2026-10-10 起两种都能导出）。
  elements.exportStoryPackage.disabled = !hasStory;
  elements.exportStoryTestPackage.disabled = !hasStory;
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
  const reportStatus = createStoryPackageStatusReporter();
  const pack = selectedStoryPackage();
  if (!pack?.fullStory) return setStoryStatus("请先生成完整剧情，再导出当前生产包。", "error");
  try {
    const sealed = await sealProductionPackage(pack);
    downloadProductionPackage(sealed, { onError: (message) => reportStatus(message, "error") });
    reportStatus(`已发起下载：${storyPackageFilename(sealed)}`, "ready");
  } catch (error) {
    reportStatus(error.message || "生产包签发失败。", "error");
  }
}

async function exportStoryTestPackage() {
  const reportStatus = createStoryPackageStatusReporter();
  const pack = selectedStoryPackage();
  if (!pack?.fullStory) return reportStatus("请先生成或导入完整剧情，再导出测试包。", "error");
  try {
    const sealed = await sealProductionPackage(pack);
    downloadProductionPackage(sealed, { testPackage: true, onError: (message) => reportStatus(message, "error") });
    reportStatus(`已发起下载：${storyPackageFilename(sealed, { testPackage: true })}`, "ready");
  } catch (error) {
    reportStatus(error.message || "测试包签发失败。", "error");
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
  let workspaceEpoch = browserWorkspace.epoch;
  let reportStatus = createStoryPackageStatusReporter();
  try {
    reportStatus("正在导入测试包…", "");
    const payload = JSON.parse(await file.text());
    assertWorkspaceCurrent(workspaceEpoch);
    const imported = await browserWorkspace.importPackage(payload, workspaceEpoch);
    if (!imported) return;
    assertWorkspaceCurrent(workspaceEpoch);
    // Only a valid import replaces the active UI lifetime. A rejected package
    // must leave the existing pipeline's progress observers attached.
    workspaceEpoch = browserWorkspace.beginChange();
    clearVideoWorkspaceUi();
    sourceLoading = false;
    let restored;
    try {
      // 按服务端返回的新 Run 元数据分支（不看包里的自述）：剧情 Run 走刷新恢复那条路。
      restored = imported.production?.metadata?.entryMode === STORY_ENTRY_MODE
        ? await restoreImportedStoryRun(imported)
        : restoreStoryPackage(imported.payload, imported.production);
    } finally {
      // This accepted import synchronously establishes a new Run and page.
      // Its feedback belongs there, including a local restore error.
      reportStatus = createStoryPackageStatusReporter();
    }
    if (restored.storyEntry) {
      reportStatus(`已校验并隔离导入剧情 Run：${restored.hasStory ? fullStoryLabel() : `未含${fullStoryLabel()}`}${restored.hasAnimation ? ` + ${planShortLabel()}` : ""}；图片和视频结果需要重新生成。`, "ready");
      return;
    }
    showError("导入包未包含原视频；已清理此前上传的视频。重新选择视频会清除当前导入结果。", "notice");
    reportStatus(`已校验并隔离导入 ${restored.id}：${restored.hasStory ? "完整剧情" : "未含完整剧情"}${restored.hasAnimation ? " + 动画生产包" : ""}；旧媒体未混入。`, "ready");
  } catch (error) {
    if (!browserWorkspace.isCurrent(workspaceEpoch)) return;
    reportStatus(error.message || "测试包导入失败", "error");
    if (elements.storyPage.classList.contains("hidden")) showError(error.message || "测试包导入失败");
  }
}

// 导入包带来的模型选择：参考视频与剧情两种包共用。
function applyImportedModelInfo(modelInfo) {
  if (!modelInfo) return;
  if (modelInfo.overrides && typeof modelInfo.overrides === "object") {
    state.modelOverrides = sanitizeStoredModelOverrides(modelInfo.overrides);
    sessionStorage.setItem("directorModelOverrides", JSON.stringify(state.modelOverrides));
  }
  applyEffectiveModelState();
  elements.storyModelName.textContent = modelDisplayLabel(state.storyProvider, state.storyModel);
  renderModelSettings();
}

// 剧情 Run 的 3.1 包（2026-10-10）：页面走「刷新恢复」那条路——从服务端读回刚导入的 Run，
// 不从包里的内容拼页面状态（两条路曾在原文、原文输入框、候选列表上不一致）。顺序照 startStoryEntryRun：
// 先建生产状态，再按 Run 元数据设入口，最后读回各份产物（会把原文填回输入框、选中故事位 V1）。
// 只渲染分场页、不自动生成：导入之后不该自己发起计费调用。
async function restoreImportedStoryRun(imported) {
  const production = imported.production;
  storyRunImporting = true;
  try {
    state.production = productionStateFromRun({
      projectId: production.projectId,
      runId: production.runId,
      lineageSchemaVersion: production.lineageSchemaVersion
    });
    persistActiveProductionRun();
    restoreRunMetadata(production.metadata || {});
    applyImportedModelInfo(imported.payload?.modelInfo);
    await reloadActiveProductionRun(state.production);
    state.selectedVariantId = STORY_ENTRY_VARIANT_ID;
    history.replaceState({ storyVariantId: STORY_ENTRY_VARIANT_ID }, "", `/story/${STORY_ENTRY_VARIANT_ID}`);
    renderStoryPage({ autoGenerate: false });
    validateReady();
    return {
      storyEntry: true,
      id: STORY_ENTRY_VARIANT_ID,
      hasStory: Boolean(state.fullStories[STORY_ENTRY_VARIANT_ID]),
      hasAnimation: Boolean(state.animationPlans[STORY_ENTRY_VARIANT_ID])
    };
  } finally {
    storyRunImporting = false;
    scheduleDirectorAgentRefresh();
  }
}

function restoreStoryPackage(payload, production) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("测试包 JSON 格式无效。");
  if (!production?.projectId || !production?.runId || !production?.artifacts) throw new Error("服务端没有返回隔离后的生产 Run。");
  // 入口以导入后新 Run 的元数据为准，与刷新恢复同一个函数。首页停在「从剧情开始」时导入参考视频的
  // 测试包，若不切回参考视频入口，故事会按剧情 Run 处理（只认故事位 V1），分场页显示不出来。
  restoreRunMetadata(production.metadata || {});
  const variant = resolveImportedVariant(payload);
  if (!variant?.id) throw new Error("测试包缺少 selectedVariant 或主题变体 id。");
  const id = String(variant.id);
  // 服务端验签之后只按包内顶层字段重建 Run（productionStateStore.importPackage），页面也只读这些字段；
  // 旧导出形状（fullStories / output / metadata 等）不会被服务端导入，这里也不回退去读。
  const fullStory = payload.fullStory || null;
  const animationPlan = payload.animationPlan || null;

  if (payload.creatorProfile && typeof payload.creatorProfile === "object") {
    elements.fixedCharacter.value = payload.creatorProfile.fixedCharacter || "";
    elements.vertical.value = payload.creatorProfile.vertical || "";
    elements.constraints.value = payload.creatorProfile.constraints || "";
    saveProfile();
    validateReady();
  }
  applyImportedModelInfo(payload.modelInfo);

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
  state.metadata = payload.sourceVideo || null;
  state.output = {
    referenceAnalysis: payload.referenceAnalysis || null,
    sourceScriptReconstruction: payload.sourceScriptReconstruction || null,
    creativeBrief: payload.creativeBrief || null,
    visualGuardrails: payload.visualGuardrails || null
  };
  state.characterBoundaryProfile = state.output.visualGuardrails ? { ...profile() } : null;
  state.output.themeVariants = mergeImportedThemeVariants(payload.themeVariants, variant);
  state.selectedVariantId = id;

  state.fullStories = {};
  state.animationPlans = {};
  state.animationPlanMetadata = {};
  state.animationAspectRatioDrafts = {};
  state.shotVideoResults = {};
  state.characterReferenceStatuses = {};
  state.characterAudioStatuses = {};
  if (fullStory) {
    state.fullStories[id] = fullStory;
    state.output.fullStory = fullStory;
  }
  if (animationPlan) {
    state.animationPlans[id] = animationPlan;
    state.animationAspectRatioDrafts[id] = normalizeAnimationPlanAspectRatio(animationPlan.productionStrategy?.targetAspectRatio);
    state.output.animationPlan = animationPlan;
  }
  state.output.fullStories = state.fullStories;
  state.output.animationPlans = state.animationPlans;
  state.output.animationPlanMetadata = state.animationPlanMetadata;
  state.characterImageGeneration.results = [];
  resetCharacterImageReference();
  state.shotVideoGeneration.referenceAssets = [];
  renderCurrentMainOutputs();
  elements.export.classList.remove("hidden");
  history.replaceState({ storyVariantId: id }, "", `/story/${encodeURIComponent(id)}`);
  renderStoryPage({ autoGenerate: false });
  return { id, hasStory: Boolean(fullStory), hasAnimation: Boolean(animationPlan) };
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

function storyPackageContext() {
  return JSON.stringify([state.production.projectId, state.production.runId, state.selectedVariantId]);
}

function resetStoryPackageStatus() {
  storyPackageFeedbackRevision += 1;
  storyPackageFeedbackContext = storyPackageContext();
  setStoryPackageStatus(STORY_PACKAGE_HELP);
}

function syncStoryPackageStatusContext() {
  if (storyPackageFeedbackContext !== storyPackageContext()) resetStoryPackageStatus();
}

function createStoryPackageStatusReporter() {
  syncStoryPackageStatusContext();
  const revision = ++storyPackageFeedbackRevision;
  const context = storyPackageFeedbackContext;
  const workspaceEpoch = browserWorkspace.epoch;
  // A download may finish after navigation. Keep the download, but do not
  // carry its transient acknowledgement or error into a different page.
  return (message, tone = "") => {
    if (!browserWorkspace.isCurrent(workspaceEpoch)
      || revision !== storyPackageFeedbackRevision
      || context !== storyPackageContext()) return;
    setStoryPackageStatus(message, tone);
  };
}

function escape(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}
// careRecipient / helper / emotionalMedium 是可选叙事构件：故事不需要就整个字段省略。
// 缺席时整行不渲染——渲染成“待确认”会让用户以为模型漏填了，实际是这个故事根本不需要它。
// 候选的叙事路径徽章。参考片基本不靠戏剧结构留人，因此候选契约允许
// slice_of_life（生活片段型）——主角可以没有目标、不作艰难抉择。
// 标出来让用户按口味挑，而不是每次都拿到四个任务型故事。
// 候选合计时长徽章。纯展示：不进 Artifact、不参与派生、不 stale 任何东西。
// 存在理由是这个数字此前完全不可见，而它实际决定成片长度——下游 Full Story 按
// 它排场次时间轴，Animation Plan 再按时间轴派生镜头。用户此前只能在生成完
// Full Story 之后才发现片子变长了。
function variantDurationBadge(storyOutline) {
  const total = storyOutlineTotalSeconds(storyOutline);
  if (total <= 0) return "";
  const window = storyDurationWindow(resolveStoryDurationTarget(state.storyDurationTarget, {
    metadata: state.metadata,
    sourceScriptReconstruction: state.output.sourceScriptReconstruction
  }));
  const offTarget = Boolean(window) && (total < window.min || total > window.max);
  const title = window
    ? `候选各拍 estimatedSeconds 合计 ${total} 秒，当前目标窗口 ${window.min}-${window.max} 秒。成片长度由这个合计决定。`
    : `候选各拍 estimatedSeconds 合计 ${total} 秒。成片长度由这个合计决定。`;
  return `<span class="duration-badge${offTarget ? " duration-off" : ""}" title="${escape(title)}">约 ${escape(total)} 秒</span>`;
}

function narrativeModeBadge(mode) {
  if (mode === "slice_of_life") return `<span class="mode-badge mode-slice">生活型</span>`;
  if (mode === "dramatic") return `<span class="mode-badge mode-dramatic">剧情型</span>`;
  return "";
}

function optionalCastSpan(label, value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  return `<span><b>${escape(label)}</b>${escape(text)}</span>`;
}
function formatDialogue(items = []) {
  if (!Array.isArray(items) || !items.length) return "无对白，以动作和声画推进";
  return items.map((item) => `${escape(item.speaker || "角色")}：${escape(item.line || "")}${item.deliveryOrSubtext ? `（${escape(item.deliveryOrSubtext)}）` : ""}`).join("<br>");
}
function formatBytes(bytes) { if (!bytes) return "0 B"; const unit = Math.min(3, Math.floor(Math.log(bytes) / Math.log(1024))); return `${(bytes / (1024 ** unit)).toFixed(unit ? 1 : 0)} ${["B", "KB", "MB", "GB"][unit]}`; }
function formatTime(seconds) { const value = Math.max(0, Math.floor(Number(seconds) || 0)); return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`; }
function skeletonFrames(count) { return Array.from({ length: count }, () => `<div class="frame"></div>`).join(""); }

// ---- 导演助手（2026-10-09）----
// 页面右侧的对话栏：按进度提议下一步，用户点卡片上的「确认执行」才执行，执行的就是页面上
// 原有按钮背后的同一段代码。「能做哪几步」只由 public/director-agent-progress.js 算；
// 模型只把用户打的字对到其中一步。设计与边界见 docs/director-agent-chat-2026-10-09.md。

// 从页面状态取出导演助手需要的事实：只有状态、计数、版本号和固定标签，
// 不读故事原文、提示词或计划里的图片数据。
function directorAgentFacts() {
  const storyEntry = isStoryEntryMode();
  const storySlot = isStorySourceRun();
  const artifacts = state.production.artifacts || {};
  const pipelineKind = storyEntry ? "storyPipeline" : "directorPipeline";
  const pipelineLabel = storyEntry ? storyPipelineLabels().noun : "AI 导演";
  const pipelineTask = taskForUi({ kinds: [pipelineKind], rootOnly: true });
  const pipelineActive = activeTaskForKinds([pipelineKind], { rootOnly: true });
  const candidatesCurrent = artifacts.themeVariants?.status === "current";
  const candidates = storySlot || !candidatesCurrent ? [] : (state.output.themeVariants?.variants || [])
    .map((variant) => ({ id: String(variant.id), title: String(variant.title || "") }));
  const base = {
    // init 全部完成（含读完模型设置）之前不算恢复完：那时的镜头视频模型等还是默认值，按它提议会提错。
    restored: directorAgentStarted && !sourceLoading && !storyRunImporting && Boolean(browserWorkspace.workspace),
    epoch: browserWorkspace.epoch,
    entryMode: storyEntry ? "story" : "video",
    storyMode: state.storyMode,
    runId: state.production.runId || "",
    route: elements.storyPage.classList.contains("hidden") ? "main" : "story",
    storySlot,
    storySlotId: STORY_ENTRY_VARIANT_ID,
    selectedVariantId: state.selectedVariantId ? String(state.selectedVariantId) : "",
    candidates,
    candidatesRevision: artifacts.themeVariants?.revision || "",
    storiesByVariant: storySlot
      ? { [STORY_ENTRY_VARIANT_ID]: Boolean(state.fullStories[STORY_ENTRY_VARIANT_ID]) }
      : Object.fromEntries(candidates.map((candidate) => [candidate.id, Boolean(state.fullStories[candidate.id])])),
    pipeline: {
      done: storyEntry
        ? artifacts[storyPipelineDoneArtifactId()]?.status === "current"
        : candidatesCurrent,
      busy: state.running || Boolean(pipelineActive),
      paused: pipelineActive?.progress?.controlState === "paused",
      failure: directorAgentFailure(pipelineTask, pipelineLabel)
    }
  };
  const variantId = directorAgentChosenVariant(base)?.id || "";
  const story = variantId ? state.fullStories[variantId] : null;
  const plan = variantId ? state.animationPlans[variantId] : null;
  const storyTask = variantId ? taskForUi({ kinds: ["fullStory"], artifactId: `fullStory:${variantId}`, rootOnly: true }) : null;
  const planTask = variantId ? taskForUi({ kinds: ["animationPlan"], artifactId: `animationPlan:${variantId}` }) : null;
  // 旧版（2.0/3.0）分镜已不再支持：不当成分镜（plan 为空），只把实际版本报给规则，由规则提议重新生成。
  const legacyPlanVersion = legacyAnimationPlanVersion(plan) || "";
  const planFacts = legacyPlanVersion ? null : directorAgentPlanFacts(variantId, plan);
  const failures = [base.pipeline.failure];
  if (!storyEntry) failures.push(directorAgentFailure(taskForUi({ kinds: ["variants"], artifactId: "themeVariants", rootOnly: true }), "换一批故事候选"));
  if (variantId) {
    failures.push(directorAgentFailure(storyTask, fullStoryLabel()), directorAgentFailure(planTask, planShortLabel()));
    for (const role of planFacts?.roles || []) {
      failures.push(directorAgentFailure(taskForUi({ kinds: ["characterReferenceImages"], artifactId: `characterImages:${variantId}:${role.index}` }),
        `「${role.name || `角色 ${role.index + 1}`}」的角色参考图`));
    }
    for (const shot of planFacts?.shots || []) {
      failures.push(
        directorAgentFailure(taskForUi({ kinds: ["shotVideoPrompt"], artifactId: storyboardPromptArtifactId(variantId, shot.shotId) }), `镜头 ${shot.shotId} 的提示词`),
        directorAgentFailure(taskForUi({ kinds: ["shotVideo"], artifactId: `shotVideo:${variantId}:${shot.shotId}` }), `镜头 ${shot.shotId} 的视频`)
      );
    }
  }
  let storyContinuing = false;
  if (storyEntry) {
    try { storyContinuing = storyEntryContinuing(normalizeStorySource(currentStorySourceDraft())); } catch { storyContinuing = false; }
  }
  const labels = storyPipelineLabels();
  const stageLabel = (stage) => {
    const setting = effectiveStageSetting(stage);
    return modelDisplayLabel(setting.provider, setting.model);
  };
  const distinctLabels = (stages) => [...new Set(stages.map(stageLabel).filter(Boolean))].join("、");
  const video = shotVideoSetting();
  const precheckFailure = fullStoryPrecheckFailure && fullStoryPrecheckFailure.variantId === variantId ? fullStoryPrecheckFailure : null;
  return {
    ...base,
    chosenVariantId: variantId,
    modalOpen: Boolean(state.characterImageGeneration.open || state.shotVideoGeneration.open)
      || !elements.modelSettingsModal.classList.contains("hidden"),
    setup: setupReadiness(),
    storyContinuing,
    labels: { pipelineStart: labels.start, pipelineContinue: labels.continue },
    candidatesBusy: state.variantsRegenerating || Boolean(activeTaskForKinds(["variants"], { rootOnly: true })),
    hasDownstream: Object.keys(state.fullStories).length > 0 || Object.keys(state.animationPlans).length > 0,
    story: story ? {
      exists: true,
      revision: artifacts[`fullStory:${variantId}`]?.revision || "",
      sceneCount: Array.isArray(story.sceneScript) ? story.sceneScript.length : 0,
      seconds: Number(story.targetDurationSeconds) || 0
    } : { exists: false },
    storyTaskId: storyTask?.status === "completed" ? storyTask.taskId : "",
    storyBusy: state.storyRunning || state.storyPrecheckRunning || Boolean(activeTaskForKinds(["fullStory"], { rootOnly: true })),
    storyFailure: directorAgentFailure(storyTask, fullStoryLabel()),
    precheck: {
      awaitingDecision: Boolean(fullStoryPrecheckState && fullStoryPrecheckState.route !== "expand"
        && fullStoryPrecheckState.variantId === variantId && !state.storyPrecheckRunning),
      passStillValid: Boolean(variantId && state.output.themeVariants && precheckPassStillValid(variantId, state.output.themeVariants)),
      failure: precheckFailure ? { id: precheckFailure.id, text: precheckFailure.message } : null
    },
    plan: planFacts,
    legacyPlanVersion,
    planTaskId: planTask?.status === "completed" ? planTask.taskId : "",
    planBusy: state.animationRunning || Boolean(activeTaskForKinds(["animationPlan"])),
    planFailure: directorAgentFailure(planTask, planShortLabel()),
    imagesBusy: state.characterImageGeneration.running || Boolean(activeTaskForKinds(["characterReferenceImages"])),
    videoBusy: state.shotVideoGeneration.running || Boolean(activeTaskForKinds(["shotVideo", "shotVideoPrompt"])),
    busyText: directorAgentBusyText(pipelineKind, pipelineLabel),
    failures: failures.filter(Boolean),
    nextPlanSettings: {
      aspectRatio: variantId ? selectedAnimationAspectRatio(variantId) : state.animationAspectRatioDefault,
      artStyle: characterArtStyle(),
      musicOn: variantId ? backgroundMusicEnabled(variantId) : false
    },
    models: {
      pipeline: storyEntry
        ? distinctLabels(["visualGuardrails", storySlot ? "fullStory" : "variants"])
        : distinctLabels(["analysis", "reconstruction", "brief", "visualGuardrails", "variants"]),
      candidates: stageLabel("variants"),
      story: storyEntry ? stageLabel("fullStory") : distinctLabels(["storyCandidateReview", "fullStory"]),
      plan: stageLabel("animationPlan"),
      image: stageLabel("imageGeneration"),
      video: modelDisplayLabel(video.provider, video.model),
      edit: stageLabel("oneSentenceEdit")
    },
    usage: {
      pipeline: directorAgentLastUsage(pipelineKind),
      variants: directorAgentLastUsage("variants"),
      fullStory: directorAgentLastUsage("fullStory"),
      plan: directorAgentLastUsage("animationPlan"),
      // 修改稿不是任务，用量只记在页面内存里（这个标签页上一次的修改稿）。
      edit: oneSentenceEditLastUsage
    },
    edit: directorAgentEditFacts(variantId, story, plan)
  };
}

// 一句话修改的事实：能不能改剧情、采纳后会作废几样东西（只数当前版本）、有没有修改稿在等决定。
// 计数口径与服务端一致：改剧情作废分镜及其下游；改分镜作废单镜提示词、镜头视频与角色候选图，
// 已设为人物参考图的图存在分镜里，改分镜时保留、改剧情时跟着分镜一起作废。
function directorAgentEditFacts(variantId, story, plan) {
  const artifacts = state.production.artifacts || {};
  const current = Object.entries(artifacts).filter(([, entry]) => entry?.status === "current").map(([artifactId]) => artifactId);
  const count = (kind) => current.filter((artifactId) => {
    const [prefix, owner] = artifactId.split(":");
    return prefix === kind && owner === variantId;
  }).length;
  const planCurrent = Boolean(variantId && artifacts[animationPlanArtifactId(variantId)]?.status === "current" && plan);
  const roleImages = planCurrent ? (plan.characterReferencePrompts || [])
    .filter((item) => typeof item?.referenceImageDataUrl === "string" && item.referenceImageDataUrl).length : 0;
  const downstream = { shotVideoPrompt: count("shotVideoPrompt"), shotVideo: count("shotVideo"), characterImages: count("characterImages") };
  const pending = oneSentenceEditPending();
  return {
    storyEditable: Boolean(story && isNarrativeFullStory(story)),
    storyInvalidation: { counts: { animationPlan: planCurrent ? 1 : 0, ...downstream }, roleImagesLost: roleImages },
    storyboardInvalidation: { counts: { ...downstream }, roleImagesKept: roleImages },
    pending: pending ? {
      target: pending.target,
      shotId: pending.shotId,
      variantId: pending.variantId,
      label: oneSentenceEditTargetLabel(pending.target, pending.shotId, { storySlot: Boolean(pending.storySlot) }),
      where: oneSentenceEditWhere(pending.target, pending.shotId, { storySlot: Boolean(pending.storySlot) })
    } : null,
    event: oneSentenceEditEvent
  };
}

function directorAgentPlanFacts(variantId, plan) {
  if (!variantId || !plan) return null;
  const artifactId = animationPlanArtifactId(variantId);
  const productionContext = planProductionContext(state.production, artifactId);
  const target = shotVideoSetting();
  const writer = effectiveStageSetting("animationPlan");
  const shots = (plan.shotPlan || []).map((shot) => {
    const shotId = String(shot.shotId || "");
    const cached = state.shotVideoPrompts?.[storyboardPromptArtifactId(variantId, shotId)];
    return {
      shotId,
      seconds: Number(shot.durationSeconds) || 0,
      hasVideo: state.production.artifacts?.[`shotVideo:${variantId}:${shotId}`]?.status === "current",
      promptRevision: state.production.artifacts?.[storyboardPromptArtifactId(variantId, shotId)]?.revision || "",
      promptCached: Boolean(productionContext && storyboardPromptMatches(cached, {
        planDigest: productionContext.planDigest, provider: target.provider, model: target.model,
        textProvider: writer.provider, textModel: writer.model
      }))
    };
  });
  return {
    revision: state.production.artifacts?.[artifactId]?.revision || "",
    hasProductionContext: Boolean(productionContext),
    shots,
    roles: (plan.characterReferencePrompts || []).map((item, index) => ({
      index,
      name: String(item.characterName || ""),
      hasImage: Boolean(item.referenceImageAdded || item.referenceImageDataUrl)
    })),
    seconds: shots.reduce((sum, shot) => sum + shot.seconds, 0),
    aspectRatio: normalizeAnimationPlanAspectRatio(plan.productionStrategy?.targetAspectRatio),
    artStyle: String(plan.productionStrategy?.artStyle || "")
  };
}

// 失败只认 taskForUi 给出的那一个：依赖已经换过的旧失败不算当前状态。供应商原文只显示在页面上，
// 不发给模型（发给模型的进度说明只写「没有成功」）。
function directorAgentFailure(task, label) {
  if (!task || !["failed", "interrupted", "conflicted"].includes(task.status)) return null;
  const error = task.error || {};
  return {
    id: task.taskId,
    label,
    text: taskErrorMessage(task, `${label}${task.status === "interrupted" ? "被中断了" : "没有完成"}`),
    contentFiltered: error.code === "MODEL_CONTENT_FILTERED" || error.category === "content-filter"
  };
}

function directorAgentBusyText(pipelineKind, pipelineLabel) {
  // 一句话修改是页面里的同步请求，写稿与签发期间不提别的动作。
  const editLabel = oneSentenceEdit
    ? oneSentenceEditTargetLabel(oneSentenceEdit.target, oneSentenceEdit.shotId, { storySlot: Boolean(oneSentenceEdit.storySlot) })
    : "";
  if (oneSentenceEdit?.status === "writing") return `正在按你的话写${editLabel}的修改稿…`;
  if (oneSentenceEdit?.adopting) return `正在签发${editLabel}的修改…`;
  for (const kind of [pipelineKind, "variants", "fullStory", "animationPlan", "characterReferenceRefine",
    "characterReferenceImages", "shotVideoPrompt", "shotVideo"]) {
    const task = activeTaskForKinds([kind], { rootOnly: true });
    if (!task) continue;
    if (task.progress?.controlState === "paused") {
      return `${kind === pipelineKind ? pipelineLabel : "任务"}已暂停：在页面上点继续按钮接着跑。`;
    }
    return taskUiView(task).message;
  }
  if (state.running) return isStoryEntryMode() ? `正在开始${storyPipelineLabels().noun}…` : "正在开始 AI 导演…";
  if (state.storyPrecheckRunning) return "正在做展开前体检…";
  if (state.storyRunning) return `正在生成${fullStoryLabel()}…`;
  if (state.variantsRegenerating) return "正在换一批故事候选…";
  if (state.animationRunning) return `正在生成${planShortLabel()}…`;
  if (state.characterImageGeneration.running) return "正在生成角色参考图…";
  if (state.shotVideoGeneration.running) return "正在生成镜头视频…";
  return "";
}

// 这个 Run 里上一次完成的同类任务的用量（只看主任务，子任务的用量已经算进主任务里）。
function directorAgentLastUsage(kind) {
  const task = Object.values(state.taskSnapshots)
    .filter((item) => item.kind === kind && !item.parentTaskId && item.status === "completed" && item.usage)
    .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")))[0];
  return task?.usage || null;
}

function directorAgentProgressNow() {
  return deriveDirectorProgress(directorAgentFacts());
}

function refreshDirectorAgentNow() {
  expireStaleOneSentenceEdit();
  const facts = directorAgentFacts();
  const progress = deriveDirectorProgress(facts);
  directorAgent.observe(facts, progress);
  renderDirectorAgent(progress);
  return progress;
}

// 页面状态变化的地方都会调它；合并成一次刷新，免得一次操作里刷十几遍。
function scheduleDirectorAgentRefresh() {
  if (directorAgentRefreshTimer) return;
  directorAgentRefreshTimer = setTimeout(() => {
    directorAgentRefreshTimer = null;
    refreshDirectorAgentNow();
  }, 0);
}

function renderDirectorAgent(progress = directorAgentProgressNow()) {
  renderDirectorAgentStatus({
    entry: elements.directorAgentEntry,
    steps: elements.directorAgentSteps,
    busy: elements.directorAgentBusy
  }, progress);
  const messages = directorAgent.messages;
  const signature = JSON.stringify([directorAgent.pendingTurn, messages.map((message) => [message.id, message.card?.state || "", message.card?.stateText || ""])]);
  if (signature !== directorAgentMessagesSignature) {
    directorAgentMessagesSignature = signature;
    const lastId = messages.at(-1)?.id || "";
    const scrollToEnd = lastId !== directorAgentLastMessageId || directorAgent.pendingTurn;
    directorAgentLastMessageId = lastId;
    renderDirectorAgentMessages({ messages: elements.directorAgentMessages, send: elements.directorAgentSend },
      { messages, pendingTurn: directorAgent.pendingTurn }, { scrollToEnd });
  }
  // 页面恢复完之前、或上一句还在等回复时不能发。
  elements.directorAgentSend.disabled = directorAgent.pendingTurn || !directorAgentStarted;
}

// 展开状态不保存：长期存储只能放创作宇宙那七项设置。
function setDirectorAgentOpen(open) {
  elements.directorAgentPanel.classList.toggle("hidden", !open);
  document.body.classList.toggle("director-agent-open", open);
  elements.directorAgentToggle.setAttribute("aria-expanded", open ? "true" : "false");
}

function bindDirectorAgentEvents() {
  // 页面恢复完之前不能发消息（startDirectorAgent 之后由 renderDirectorAgent 打开）。
  elements.directorAgentSend.disabled = true;
  elements.directorAgentToggle.addEventListener("click", () => {
    setDirectorAgentOpen(elements.directorAgentPanel.classList.contains("hidden"));
  });
  elements.closeDirectorAgent.addEventListener("click", () => setDirectorAgentOpen(false));
  elements.directorAgentPanel.addEventListener("click", (event) => {
    const target = event.target.closest?.("[data-agent-confirm], [data-agent-dismiss], [data-agent-chip], [data-agent-quick]");
    if (!target) return;
    if (target.dataset.agentConfirm) return void confirmDirectorAgentCard(target.dataset.agentConfirm);
    if (target.dataset.agentDismiss) return dismissDirectorAgentCard(target.dataset.agentDismiss);
    if (target.dataset.agentChip) return directorAgentChoose(target.dataset.agentChip);
    if (target.dataset.agentQuick) return directorAgentQuick(target.dataset.agentQuick);
  });
  elements.directorAgentComposer.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitDirectorAgentInput();
  });
  elements.directorAgentInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void submitDirectorAgentInput();
    }
  });
}

// 页面恢复完之后启动：宽屏默认展开，按当前进度打招呼；之后每 1.5 秒兜底刷新一次
// （展开前体检、按钮状态这类不经过任务轮询的变化靠它接住）。
function startDirectorAgent() {
  if (directorAgentStarted) return;
  directorAgentStarted = true;
  if ((window.innerWidth || 0) >= 1280) setDirectorAgentOpen(true);
  refreshDirectorAgentNow();
  window.setInterval(() => scheduleDirectorAgentRefresh(), 1500);
}

function directorAgentQuick(kind) {
  if (!directorAgentStarted) return;
  const progress = directorAgentProgressNow();
  if (kind === "next") directorAgent.showNext(progress);
  else directorAgent.showStatus(progress);
  renderDirectorAgent(progress);
}

function directorAgentChoose(key) {
  if (!directorAgentStarted) return;
  const progress = directorAgentProgressNow();
  directorAgent.showChoice(key, progress);
  renderDirectorAgent(progress);
}

async function submitDirectorAgentInput() {
  const text = elements.directorAgentInput.value;
  // 页面还没恢复完（模型设置还没读到）时不发：那时的进度说明是错的。
  if (!directorAgentStarted || !text.trim() || directorAgent.pendingTurn) return;
  elements.directorAgentInput.value = "";
  await sendDirectorAgentMessage(text);
}

// 用户打的字交给模型理解。只在用户发消息时调用模型；打开页面、步骤完成都不调用。
async function sendDirectorAgentMessage(text) {
  const workspaceEpoch = browserWorkspace.epoch;
  const payload = directorAgent.beginTurn(text, directorAgentProgressNow());
  if (!payload) return;
  renderDirectorAgent();
  try {
    const response = await requestDirectorAgentTurn(payload);
    if (!browserWorkspace.isCurrent(workspaceEpoch)) return;
    directorAgent.finishTurn({ turn: response.result.turn, usage: response.usage }, directorAgentProgressNow());
  } catch (error) {
    directorAgent.failTurn(error, error?.usage || null);
  }
  renderDirectorAgent();
}

// 不走 api()：api() 会把用量记进正在进行的那一步（例如一次体检或分镜），
// 一条对话的花费就混进了那一步的合计。这里单独请求，并把这条消息自己的用量带回来显示。
async function requestDirectorAgentTurn(body) {
  const workspaceEpoch = browserWorkspace.epoch;
  const response = await fetch("/api/director-agent/turn", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(withModelOverrides(body))
  });
  const data = await response.json().catch(() => ({}));
  assertWorkspaceCurrent(workspaceEpoch);
  if (!response.ok || !data.ok) {
    const error = createApiRequestError(data, response.status, `请求失败（${response.status}）`);
    error.usage = data.usage || null;
    throw error;
  }
  return { result: data.result, usage: data.usage || null };
}

function dismissDirectorAgentCard(messageId) {
  const message = directorAgent.card(messageId);
  if (message?.card.state !== "pending") return;
  directorAgent.markCard(messageId, "dismissed", "先不做。需要时点「下一步」。");
  renderDirectorAgent();
}

// 点「确认执行」：按现在的页面状态重新算一遍；动作已经不在清单里、或它依赖的东西变了，卡片作废。
async function confirmDirectorAgentCard(messageId) {
  if (!directorAgentStarted) return;
  const message = directorAgent.card(messageId);
  if (message?.card.state !== "pending") return;
  const progress = directorAgentProgressNow();
  const action = progress.actions.find((item) => item.key === message.card.key);
  if (!action || action.guard !== message.card.guard) {
    directorAgent.markCard(messageId, "void", action ? "进度或设置变了，这张卡作废了。" : "这一步现在不能做了，这张卡作废了。");
    directorAgent.showNext(progress);
    renderDirectorAgent(progress);
    return;
  }
  directorAgent.markCard(messageId, "executing", "正在执行…");
  renderDirectorAgent(progress);
  let outcome;
  try {
    outcome = executeDirectorAgentAction(action, message.card);
  } catch (error) {
    outcome = { started: false, text: `没有开始：${error?.message || "未知原因"}` };
  }
  directorAgent.markCard(messageId, outcome.started ? "done" : "failed", outcome.text);
  refreshDirectorAgentNow();
}

// 执行器：调页面上原有按钮背后的同一个函数。长任务不 await（AI 导演要跑完整条流水线才返回），
// 调用后马上看对应的「正在运行」标记：函数如果什么都没做就直接返回，如实说「没有开始」并引用页面提示。
function executeDirectorAgentAction(action, card = {}) {
  const [variantId, second] = action.params;
  const run = (promise) => {
    Promise.resolve(promise).catch(() => {});
  };
  const started = (text) => ({ started: true, text });
  const notStarted = (element) => ({
    started: false,
    text: `没有开始${element?.textContent?.trim() ? `：${element.textContent.trim()}` : "。"}`
  });
  switch (action.id) {
    case "startPipeline":
      run(runWorkflow());
      return state.running ? started("已开始，进度会同步显示在这里和页面上。") : notStarted(elements.error);
    case "regenerateCandidates":
      if (!elements.storyPage.classList.contains("hidden")) backToMainResults();
      run(regenerateThemeVariants());
      return state.variantsRegenerating ? started("已开始换一批故事候选。") : notStarted(elements.error);
    case "chooseCandidate":
      navigateToStory(variantId);
      return state.storyPrecheckRunning || state.storyRunning || state.fullStories[variantId]
        ? started("已打开分场页并开始展开。")
        : notStarted(elements.storyStatus);
    case "openStoryPage":
      showDirectorAgentStoryPage(variantId);
      return started("已打开分场页。");
    case "generateFullStory":
      showDirectorAgentStoryPage(variantId);
      run(startFullStory());
      return state.storyPrecheckRunning || state.storyRunning ? started("已开始。") : notStarted(elements.storyStatus);
    case "generateStoryboard":
      showDirectorAgentStoryPage(variantId);
      run(generateAnimationPlan({ force: false }));
      return state.animationRunning ? started("已开始生成分镜。") : notStarted(elements.animationStatus);
    case "openCharacterImages":
      showDirectorAgentStoryPage(variantId);
      state.characterImageGeneration.selectedIndex = Number(second) || 0;
      openCharacterImageGenerator();
      return state.characterImageGeneration.open
        ? started("已打开出图弹窗：选好张数后点生成；挑一张满意的点「设为人物参考图」。")
        : notStarted(elements.animationStatus);
    case "openShotVideo":
      showDirectorAgentStoryPage(variantId);
      run(openShotVideoGenerator(second));
      return state.shotVideoGeneration.open
        ? started("已打开镜头弹窗：看过提示词再点生成。")
        : notStarted(elements.animationStatus);
    case "editStory":
    case "editStoryboard":
    case "editShotPrompt":
      return startOneSentenceEdit(action, card.instruction);
    default:
      return { started: false, text: "没有开始：不认识的动作。" };
  }
}

// 只跳到分场页、不自动生成（navigateToStory 会在没有剧情时自动展开，那是「选这个故事」的行为）。
function showDirectorAgentStoryPage(variantId) {
  const path = `/story/${encodeURIComponent(variantId)}`;
  if (location.pathname === path && String(state.selectedVariantId) === String(variantId)
    && !elements.storyPage.classList.contains("hidden")) return;
  state.selectedVariantId = variantId;
  history.pushState({ storyVariantId: variantId }, "", path);
  renderStoryPage({ autoGenerate: false });
}

// ---- 一句话修改（2026-10-11，导演 Agent 第三期）----
// 只在导演助手里说：卡片带用户的原话，确认后另起一次调用按原话写修改稿，修改稿显示在被改的东西所在的位置
// （剧情与分镜在分场页上，单镜提示词在那一镜的视频弹窗里）。采纳由服务端拿当前版本重新应用同一组修改、
// 核对结果摘要后签发，页面随后从服务端读回 Run。设计见 docs/one-sentence-edit-2026-10-11.md。

function oneSentenceEditPending() {
  return oneSentenceEdit?.status === "ready" && oneSentenceEdit.result?.decision === "edit" ? oneSentenceEdit : null;
}

function oneSentenceEditArtifactIdFor(target, variantId, shotId) {
  if (target === "story") return `fullStory:${variantId}`;
  if (target === "storyboard") return animationPlanArtifactId(variantId);
  return storyboardPromptArtifactId(variantId, shotId);
}

function recordOneSentenceEditEvent(entry, type, extra = {}) {
  const storySlot = Boolean(entry.storySlot);
  oneSentenceEditEvent = {
    id: `one-sentence-edit-event-${++oneSentenceEditSequence}`,
    type,
    target: entry.target,
    shotId: entry.shotId || "",
    storySlot,
    where: oneSentenceEditWhere(entry.target, entry.shotId, { storySlot }),
    ...extra
  };
}

// 参考视频 Run 改剧情或分镜时，服务端要用固定角色设定核对角色边界的签名；剧情 Run 用开 Run 时那一份。
function oneSentenceEditProfileField(target) {
  return !isStoryEntryMode() && target !== "shotPrompt" ? { creatorProfile: profile() } : {};
}

function startOneSentenceEdit(action, instruction) {
  const target = directorAgentEditTarget(action.id);
  const [variantId, shotId = ""] = action.params;
  const text = String(instruction || "").trim();
  if (!target) return { started: false, text: "没有开始：不认识的修改。" };
  if (!text) return { started: false, text: "没有开始：卡片上没有你的原话。请在对话栏里再说一次要怎么改。" };
  if (oneSentenceEdit?.status === "writing" || oneSentenceEdit?.adopting || oneSentenceEditPending()) {
    return { started: false, text: "没有开始：上一份修改稿还没处理完。" };
  }
  const artifactId = oneSentenceEditArtifactIdFor(target, variantId, shotId);
  const current = state.production.artifacts?.[artifactId];
  if (current?.status !== "current" || !current.revision) return { started: false, text: "没有开始：要改的东西现在没有当前版本。" };
  showDirectorAgentStoryPage(variantId);
  const storySlot = isStorySourceRun();
  oneSentenceEdit = {
    id: `one-sentence-edit-${++oneSentenceEditSequence}`,
    status: "writing",
    storySlot,
    target,
    variantId: String(variantId),
    shotId: String(shotId),
    artifactId,
    runId: state.production.runId,
    baseRevision: current.revision,
    instruction: text,
    result: null,
    error: "",
    usage: null,
    adopting: false,
    adoptError: ""
  };
  if (target === "shotPrompt") void openShotVideoGenerator(shotId);
  renderOneSentenceEditHosts();
  void requestOneSentenceEditDraft(oneSentenceEdit);
  return { started: true, text: `已开始按你的话写修改稿，写好后显示在${oneSentenceEditWhere(target, shotId, { storySlot })}。` };
}

// 不走 api()：api() 会把用量记进正在进行的那一步，修改稿的花费单独显示在修改稿上。
async function requestOneSentenceEditDraft(entry) {
  const workspaceEpoch = browserWorkspace.epoch;
  const body = withModelOverrides({
    projectId: state.production.projectId,
    runId: state.production.runId,
    target: entry.target,
    variantId: entry.variantId,
    ...(entry.target === "shotPrompt" ? { shotId: entry.shotId } : {}),
    baseRevision: entry.baseRevision,
    instruction: entry.instruction,
    ...oneSentenceEditProfileField(entry.target)
  });
  try {
    const response = await fetch("/api/one-sentence-edit/draft", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await response.json().catch(() => ({}));
    if (!browserWorkspace.isCurrent(workspaceEpoch) || oneSentenceEdit !== entry) return;
    entry.usage = data.usage || null;
    if (data.usage) oneSentenceEditLastUsage = data.usage;
    if (!response.ok || !data.ok) throw createApiRequestError(data, response.status, `请求失败（${response.status}）`);
    entry.status = "ready";
    entry.result = data.result;
    if (data.result?.decision === "edit") {
      recordOneSentenceEditEvent(entry, "ready", { changes: (data.result.changes || []).length, patches: (data.result.patches || []).length });
    }
    else recordOneSentenceEditEvent(entry, "declined");
  } catch (error) {
    if (!browserWorkspace.isCurrent(workspaceEpoch) || oneSentenceEdit !== entry) return;
    entry.status = "failed";
    entry.error = error?.message || "未知原因";
    recordOneSentenceEditEvent(entry, "failed", {
      error: entry.error,
      contentFiltered: error?.code === "MODEL_CONTENT_FILTERED" || error?.category === "content-filter"
    });
  }
  renderOneSentenceEditHosts();
  scheduleDirectorAgentRefresh();
}

function oneSentenceEditBaseCurrent(entry) {
  const current = state.production.artifacts?.[entry.artifactId];
  return state.production.runId === entry.runId && current?.status === "current" && current.revision === entry.baseRevision;
}

// 修改稿是针对当时那一版写的：那一版变了（重新生成、设为人物参考图、重新拆分……）就作废，
// 绝不把基于旧内容的修改盖到新版本上。换了 Run 时悄悄丢掉（对话栏会说「已经换成新的 Run」）。
function expireStaleOneSentenceEdit() {
  const entry = oneSentenceEdit;
  if (!entry || entry.adopting) return false;
  if (state.production.runId !== entry.runId) {
    oneSentenceEdit = null;
    renderOneSentenceEditHosts();
    return true;
  }
  if (!oneSentenceEditPending() || oneSentenceEditBaseCurrent(entry)) return false;
  oneSentenceEdit = null;
  recordOneSentenceEditEvent(entry, "expired");
  renderOneSentenceEditHosts();
  return true;
}

async function adoptOneSentenceEdit() {
  const entry = oneSentenceEditPending();
  if (!entry || entry.adopting) return;
  const workspaceEpoch = browserWorkspace.epoch;
  if (!oneSentenceEditBaseCurrent(entry)) {
    expireStaleOneSentenceEdit();
    scheduleDirectorAgentRefresh();
    return;
  }
  const savedPrompt = String(state.shotVideoPrompts?.[entry.artifactId]?.videoPrompt || "");
  const manualPromptEdited = entry.target === "shotPrompt" && state.shotVideoGeneration.open
    && state.shotVideoGeneration.shotId === entry.shotId
    && elements.shotVideoPromptPreview.value.trim() !== savedPrompt.trim();
  const confirmText = oneSentenceEditConfirmText(entry.result, { manualPromptEdited, storySlot: Boolean(entry.storySlot) });
  if (confirmText && !window.confirm(confirmText)) return;
  entry.adopting = true;
  entry.adoptError = "";
  renderOneSentenceEditHosts();
  scheduleDirectorAgentRefresh();
  try {
    const response = await fetch("/api/production/one-sentence-edit/adopt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: state.production.projectId,
        runId: state.production.runId,
        target: entry.target,
        variantId: entry.variantId,
        ...(entry.target === "shotPrompt" ? { shotId: entry.shotId } : {}),
        baseRevision: entry.baseRevision,
        patches: entry.result.patches,
        resultDigest: entry.result.resultDigest,
        ...oneSentenceEditProfileField(entry.target)
      })
    });
    const data = await response.json().catch(() => ({}));
    assertWorkspaceCurrent(workspaceEpoch);
    if (!response.ok || !data.ok) throw createApiRequestError(data, response.status, `请求失败（${response.status}）`);
  } catch (error) {
    if (!browserWorkspace.isCurrent(workspaceEpoch) || oneSentenceEdit !== entry) return;
    entry.adopting = false;
    if (["ONE_SENTENCE_EDIT_BASE_CHANGED", "ONE_SENTENCE_EDIT_RESULT_MISMATCH"].includes(error?.code)) {
      oneSentenceEdit = null;
      recordOneSentenceEditEvent(entry, "expired");
    } else {
      entry.adoptError = error?.message || "未知原因";
    }
    renderOneSentenceEditHosts();
    scheduleDirectorAgentRefresh();
    return;
  }
  // 已经签发。从服务端读回 Run：新版本与被作废的下游都以服务端为准，不在页面上拼。
  oneSentenceEdit = null;
  recordOneSentenceEditEvent(entry, "adopted", { invalidation: entry.result.invalidation || null });
  try {
    await reloadActiveProductionRun(state.production, { preserveSelectedVariant: true });
    assertWorkspaceCurrent(workspaceEpoch);
    if (entry.target === "shotPrompt") {
      const adopted = state.shotVideoPrompts?.[entry.artifactId];
      if (adopted && state.shotVideoGeneration.open && state.shotVideoGeneration.shotId === entry.shotId) {
        elements.shotVideoPromptPreview.value = adopted.videoPrompt;
        setShotVideoStatus("已采纳修改，提示词换成了新版本。这一镜已有的视频不会自动重做。", "ready");
      }
    } else if (!elements.storyPage.classList.contains("hidden")) {
      renderStoryPage({ autoGenerate: false });
    }
  } catch (error) {
    if (!browserWorkspace.isCurrent(workspaceEpoch)) return;
    showError(`修改已经签发，但页面没有读回新版本：${error?.message || "未知原因"}。请刷新页面。`);
  }
  renderOneSentenceEditHosts();
  scheduleDirectorAgentRefresh();
}

// 放弃：什么都不变。没改成或失败的那一份只是收起来（结果已经报过一次）。
function discardOneSentenceEdit() {
  const entry = oneSentenceEdit;
  if (!entry || entry.status === "writing" || entry.adopting) return;
  const pending = Boolean(oneSentenceEditPending());
  oneSentenceEdit = null;
  if (pending) recordOneSentenceEditEvent(entry, "discarded");
  renderOneSentenceEditHosts();
  scheduleDirectorAgentRefresh();
}

// 这一镜的提示词正在改、或修改稿等着决定：弹窗里不能生成视频、不能重写提示词。
function oneSentenceEditBlocksShot(shotId) {
  const entry = oneSentenceEdit;
  return Boolean(entry && entry.target === "shotPrompt" && entry.shotId === String(shotId)
    && (entry.status === "writing" || entry.adopting || oneSentenceEditPending()));
}

function renderOneSentenceEditHosts() {
  const entry = oneSentenceEdit;
  const hosts = [["story", elements.storyEditPreview], ["storyboard", elements.storyboardEditPreview], ["shotPrompt", elements.shotPromptEditPreview]];
  for (const [target, host] of hosts) {
    if (!host) continue;
    const visible = Boolean(entry && entry.target === target
      && String(state.selectedVariantId || "") === entry.variantId
      && (target !== "shotPrompt" || (state.shotVideoGeneration.open && state.shotVideoGeneration.shotId === entry.shotId)));
    host.innerHTML = visible ? renderOneSentenceEditPreview(entry) : "";
    host.classList.toggle("hidden", !visible);
  }
}

function bindOneSentenceEditEvents() {
  for (const host of [elements.storyEditPreview, elements.storyboardEditPreview, elements.shotPromptEditPreview]) {
    if (!host) continue;
    host.addEventListener("click", (event) => {
      const button = event.target.closest?.("[data-one-sentence-action]");
      if (!button || button.disabled) return;
      if (button.dataset.oneSentenceAction === "adopt") void adoptOneSentenceEdit();
      else if (button.dataset.oneSentenceAction === "discard") discardOneSentenceEdit();
    });
  }
}
