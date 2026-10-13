import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { mockVariants, mockFullStory } from "../../src/mock.js";
import { fullStoryCharacterRegistryInput, mergeFullStoryCharacterRegistry, mockFullStoryCharacterRegistry,
  storyCharacterNames } from "../../src/full-story-character-registry.js";
import { ensureStoryboardPlan } from "../../src/storyboard-contract.js";
import { STORYBOARD_PLAN_VERSION } from "../../public/storyboard-plan.js";

// 最小合法 4.0 自主分镜（2026-10-11 起只支持 4.0）：角色与场次全部取自同一份 fixture 剧情，
// 每场一个片段、每个片段一个 beat。返回前过一遍服务端的 ensureStoryboardPlan——夹具不合法就直接抛错，
// 不会让 UI 测试拿一份服务端根本签发不出来的 Plan 当输入。
export function storyboardPlanFixture(fullStory) {
  const registryInput = fullStoryCharacterRegistryInput(fullStory);
  const characterRegistry = mergeFullStoryCharacterRegistry(fullStory,
    mockFullStoryCharacterRegistry(registryInput), registryInput).characterBible;
  const characterNames = storyCharacterNames(fullStory);
  const scenes = fullStory.sceneScript;
  const runtime = fullStory.targetDurationSeconds;
  const lengths = scenes.map((_, i) => Math.floor(runtime / scenes.length) + (i < runtime % scenes.length ? 1 : 0));
  const protagonist = characterRegistry.protagonist;
  const facts = (name) => characterRegistry.supportingCharacters.find((row) => row.name === name);
  const characters = characterNames.map((name) => ({ name,
    appearance: name === protagonist.name ? protagonist.identity : facts(name).appearanceFacts.join("、"), designedDetails: [] }));
  const plan = {
    promptSchemaVersion: STORYBOARD_PLAN_VERSION, selectedVariantId: fullStory.selectedVariantId, title: fullStory.title,
    productionStrategy: { format: "storyboard_video", targetAspectRatio: "16:9", targetRuntimeSeconds: runtime,
      backgroundMusicMode: "none", visualStyle: "", characterExpressionRules: "", artStyle: "",
      sourceSceneIds: scenes.map((scene) => scene.sceneId), characterNames },
    viewingIntent: fullStory.shootingSynopsis,
    visualDesign: { characters,
      locations: scenes.map((scene) => ({ name: scene.location, sourceSceneIds: [scene.sceneId], layout: scene.location, lighting: "自然光" })),
      props: [] },
    adaptations: [], blockedIssues: [],
    shotPlan: scenes.map((scene, i) => ({ shotId: `A${String(i + 1).padStart(2, "0")}`, sourceSceneIds: [scene.sceneId],
      durationSeconds: lengths[i], storyPurpose: scene.dramaticFunction, emotionalTarget: scene.emotionNode,
      transitionIn: { type: i === 0 ? "start" : "cut", description: scene.location },
      beats: [{ startSeconds: 0, endSeconds: lengths[i], sourceSceneIds: [scene.sceneId], location: scene.location,
        characters: scene.characters, framing: "中景", camera: "固定机位", visibleAction: scene.visibleAction,
        dialogue: scene.dialogue.map((line) => ({ speaker: line.speaker, text: line.line, source: "onscreen", timing: "片段内" })),
        soundDesign: scene.shotAndSound }],
      continuityOut: scene.visibleAction, acceptanceCriteria: ["夹具内容，未经过真实模型设计"] })),
    characterReferencePrompts: characters.map(({ name, appearance }) => {
      const primary = name === protagonist.name;
      return { characterName: name, storyRole: primary ? "主角" : facts(name).storyRole, identity: primary ? protagonist.identity : facts(name).identity,
        appearancePrompt: appearance, consistencyTags: primary ? [...protagonist.traits] : [...facts(name).personalityFacts], forbiddenChanges: [] };
    }),
    characterRegistry,
    editorial: { initialReview: null, repairs: [], finalReview: null, guidance: [] }
  };
  return ensureStoryboardPlan(plan, { fullStory });
}

export function uiFixture({ story = true, plan = true } = {}) {
  const themeVariants = mockVariants({ count: 3 });
  const variant = themeVariants.variants[1];
  const fullStory = mockFullStory({ variant });
  const animationPlan = storyboardPlanFixture(fullStory);
  return { themeVariants, fullStory: story ? fullStory : null, animationPlan: plan ? animationPlan : null };
}

// The app's real render/restore functions run against a small DOM boundary.
// No production function is replaced; browser validation covers the real DOM.
class Element {
  constructor(tagName = "div") { this.tagName = tagName.toUpperCase(); }
  className = ""; textContent = ""; innerHTML = ""; value = ""; disabled = false;
  options = []; dataset = {}; children = new Map(); style = {}; attributes = new Map();
  childNodes = [];
  classList = {
    contains: (name) => this.className.split(" ").includes(name),
    add: (...names) => { this.className = [...new Set([...this.className.split(" "), ...names])].filter(Boolean).join(" "); },
    remove: (...names) => { this.className = this.className.split(" ").filter((name) => !names.includes(name)).join(" "); },
    toggle: (name, enabled = !this.classList.contains(name)) => enabled ? this.classList.add(name) : this.classList.remove(name)
  };
  querySelector(selector) {
    // 剧情体检的面板容器是 fullStory 的子节点，用属性选择器取；按问题修改的按钮、
    // 预览槽与采纳按钮同理。只放行这几个，其余未知选择器仍然返回 null——有测试依赖那个 null。
    if (!['span', 'b', '[data-story-review-body]', '[data-story-repair]', '[data-story-repair-slot]',
      '[data-story-repair-adopt]'].includes(selector)) return null;
    if (!this.children.has(selector)) this.children.set(selector, new Element());
    return this.children.get(selector);
  }
  querySelectorAll() { return []; }
  addEventListener() {}
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  get lastElementChild() { return this.querySelector("span"); }
  append(...nodes) { this.childNodes.push(...nodes); }
  submit() { this.submitted = true; }
  remove() { this.removed = true; }
  pause() {} load() {}
  focus() {} scrollIntoView() {}
}

export async function loadAppUi({ story = false, plan = false, createElement,
  fetch = async () => { throw new Error("Unexpected network request in UI regression"); },
  windowSetTimeout = setTimeout, confirm = () => false,
  storage = { getItem: () => null, setItem() {}, removeItem() {} },
  // 需要分清两种存储时分别传；不传就和以前一样共用 storage。
  sessionStorage: sessionStorageOverride, localStorage: localStorageOverride } = {}) {
  let source = await readFile(new URL("../../public/app.js", import.meta.url), "utf8");
  const bindings = {};
  for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*"([^"]+)";/g)) {
    const module = await import(new URL(`../../public/${match[2]}`, import.meta.url));
    for (const name of match[1].split(",").map((part) => part.trim()).filter(Boolean)) bindings[name] = module[name];
  }
  source = source.replace(/import\s*\{[^}]+\}\s*from\s*"[^"]+";/g, "").replace("\ninit();", "");
  const nodes = new Map();
  const document = { querySelector(selector) {
    if (!nodes.has(selector)) nodes.set(selector, new Element());
    return nodes.get(selector);
  }, querySelectorAll: () => [], addEventListener() {}, body: new Element("body"),
  createElement: createElement || ((tag) => new Element(tag)) };
  const location = { pathname: "/story/V2", origin: "http://localhost" };
  const history = { pushState(_state, _title, path) { location.pathname = path; },
    replaceState(_state, _title, path) { location.pathname = path; } };
  const context = vm.createContext({ ...bindings, document,
    window: { scrollTo() {}, setTimeout: windowSetTimeout, CSS: { escape: (s) => s }, location, confirm },
    location, history, sessionStorage: sessionStorageOverride || storage, localStorage: localStorageOverride || storage,
    navigator: {}, structuredClone, crypto, URL, URLSearchParams, Blob, File, console,
    fetch, setTimeout, clearTimeout });
  vm.runInContext(`${source}\nglobalThis.app = { state, elements, renderRoute, renderStoryPage, renderAnimationPlan,
    renderCurrentMainOutputs, restoreRunArtifacts, markRestoredTaskRunning, updateTaskSnapshot,
    syncStoryTaskStatus, syncCharacterImageTaskStatus, syncShotVideoTaskStatus,
    openCharacterImageGenerator, openShotVideoGenerator,
    updateShotVideoGeneratorPreview, applyCharacterImageTaskProgress,
    shotVideoStateItem, syncDirectorTaskStatus, loadSourceVideo, browserWorkspace,
    renderDirectorControls, renderDirectorTaskStatus, renderDirectorTaskError, controlDirectorPipeline,
    renderFullStoryControls, selectedFullStoryTask, controlFullStory, generateFullStory, renderFullStoryTaskError,
    startFullStory, adoptThemeVariantsRevision, clearFullStoryPrecheck,
    runStoryQualityReview, renderStoryQualityReview,
    requestStoryQualityRepair, renderStoryQualityRepair, adoptStoryQualityRepair,
    setStoryRunning, setStoryStatus, attachRestoredStandaloneTask, reloadActiveProductionRun,
    openModelSettings, closeModelSettings, saveModelSettings, resetModelSettings, setModelSettingsStatus,
    modelSeriesGroups, modelSeriesNeedsCascade,
    renderMainPage, navigateToStory, backToMainResults, regenerateThemeVariants, setStoryPackageStatus,
    importStoryTestPackage, exportStoryTestPackage, exportCurrentStoryPackage, restoreStoryPackage,
    setRunning, resetDirectorClientState, restoreActiveProductionRun, directorArtifactSynchronizer,
    effectiveStageSetting, withModelOverrides, refineCharacterReferenceWithImage, waitForDurableTask,
    isStoryEntryMode, applyEntryModeUi, videoUpstreamCopies, globalCharacterBoundaryContext, restoreRunMetadata,
    renderStoryDurationOptions, renderStoryPipelineTaskStatus, refreshStoryDialogueCheck, updateStoryExportActions,
    ensureSelectedVariantArtifact, storyEntryRunLabel, handleStorySourceInput, handleStoryModeChange, handleProfileInput,
    handleBackgroundMusicToggle, generateAnimationPlan, selectedVariant, isStorySourceRun, setAnimationRunning,
    renderCharacterImagePromptPreview, generateCharacterReferenceImages, resetCharacterImageReference,
    restoreCharacterArtStyle, saveCharacterArtStyle, characterArtStyle,
    directorAgent, directorAgentFacts, directorAgentProgressNow, refreshDirectorAgentNow, executeDirectorAgentAction,
    confirmDirectorAgentCard, dismissDirectorAgentCard, sendDirectorAgentMessage, submitDirectorAgentInput, directorAgentQuick, directorAgentChoose,
    setDirectorAgentOpen, showDirectorAgentStoryPage, setupReadiness, validateReady, storyEntryContinuing,
    beginStageUsage, endStageUsage, browserWorkspaceForTest: browserWorkspace, selectedStoryPackage,
    shotVideoSetting, shotVideoResolutionState, shotVideoResolutionRequestFields, renderShotVideoResolutionControl,
    handleShotVideoResolutionChange, shotVideoResolutionText,
    generateShotVideo, renderShotVideoModalResults, setShotVideoGeneratorRunning, updateShotVideoProviderUi, taskUiView,
    startOneSentenceEdit, adoptOneSentenceEdit, discardOneSentenceEdit, renderOneSentenceEditHosts, expireStaleOneSentenceEdit,
    closeShotVideoGenerator, confirmGenerateShotVideo,
    oneSentenceEditForTest: () => oneSentenceEdit, oneSentenceEditEventForTest: () => oneSentenceEditEvent,
    setOneSentenceEditForTest: (value) => { oneSentenceEdit = value; },
    setSourceLoadingForTest: (value) => { sourceLoading = value; },
    setDirectorAgentStartedForTest: (value) => { directorAgentStarted = value; } };`, context);
  const app = context.app;
  const fixture = uiFixture({ story, plan });
  Object.assign(app.state, { selectedVariantId: "V2", output: { themeVariants: fixture.themeVariants },
    fullStories: story ? { V2: fixture.fullStory } : {}, animationPlans: plan ? { V2: fixture.animationPlan } : {} });
  Object.assign(app.state.production, { projectId: "project", runId: "run" });
  return { ...app, document, fixture, location };
}

export function uiTask(kind, status = "running", overrides = {}) {
  const target = { fullStory: "fullStory:V2", animationPlan: "animationPlan:V2",
    characterReferenceRefine: "animationPlan:V2", characterReferenceImages: "characterImages:V2:0",
    shotVideo: "shotVideo:V2:A01" }[kind];
  return { taskId: `task-${kind}`, projectId: "project", runId: "run", kind, status,
    targetArtifactIds: target ? [target] : [], createdAt: "2026-09-09T01:00:00Z", updatedAt: "2026-09-09T01:01:00Z",
    modelSnapshot: { generation: { provider: "MiMo", model: "mimo-v2.5" } }, ...overrides };
}
