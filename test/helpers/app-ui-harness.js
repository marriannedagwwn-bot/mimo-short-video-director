import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { mockVariants, mockFullStory, mockAnimationPlan } from "../../src/mock.js";

export function uiFixture({ story = true, plan = true } = {}) {
  const themeVariants = mockVariants({ count: 3 });
  const variant = themeVariants.variants[1];
  const fullStory = mockFullStory({ variant });
  const animationPlan = mockAnimationPlan({ variant, fullStory });
  return { themeVariants, fullStory: story ? fullStory : null, animationPlan: plan ? animationPlan : null };
}

// The app's real render/restore functions run against a small DOM boundary.
// No production function is replaced; browser validation covers the real DOM.
class Element {
  className = ""; textContent = ""; innerHTML = ""; value = ""; disabled = false;
  options = []; dataset = {}; children = new Map(); style = {}; attributes = new Map();
  classList = {
    contains: (name) => this.className.split(" ").includes(name),
    add: (...names) => { this.className = [...new Set([...this.className.split(" "), ...names])].filter(Boolean).join(" "); },
    remove: (...names) => { this.className = this.className.split(" ").filter((name) => !names.includes(name)).join(" "); },
    toggle: (name, enabled = !this.classList.contains(name)) => enabled ? this.classList.add(name) : this.classList.remove(name)
  };
  querySelector(selector) {
    if (!['span', 'b'].includes(selector)) return null;
    if (!this.children.has(selector)) this.children.set(selector, new Element());
    return this.children.get(selector);
  }
  querySelectorAll() { return []; }
  addEventListener() {}
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  focus() {} scrollIntoView() {}
}

export async function loadAppUi({ story = false, plan = false, createElement,
  fetch = async () => { throw new Error("Unexpected network request in UI regression"); },
  windowSetTimeout = setTimeout } = {}) {
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
  }, querySelectorAll: () => [], addEventListener() {}, createElement };
  const storage = { getItem: () => null, setItem() {}, removeItem() {} };
  const context = vm.createContext({ ...bindings, document, window: { scrollTo() {}, setTimeout: windowSetTimeout, CSS: { escape: (s) => s } },
    location: { pathname: "/story/V2", origin: "http://localhost" }, sessionStorage: storage, localStorage: storage,
    navigator: {}, structuredClone, crypto, URL, URLSearchParams, Blob, File, console,
    fetch, setTimeout, clearTimeout });
  vm.runInContext(`${source}\nglobalThis.app = { state, elements, renderRoute, renderStoryPage, renderAnimationPlan,
    renderCurrentMainOutputs, restoreRunArtifacts, markRestoredTaskRunning, updateTaskSnapshot,
    syncStoryTaskStatus, syncCharacterImageTaskStatus, syncShotVideoTaskStatus, syncShotFrameTaskStatus,
    openCharacterImageGenerator, openShotVideoGenerator, openShotFrameImageGenerator,
    updateShotVideoGeneratorPreview, applyCharacterImageTaskProgress, renderShotVideoBatchProgress,
    shotVideoStateItem, shotFrameKey, syncDirectorTaskStatus, loadSourceVideo, browserWorkspace,
    renderDirectorControls, renderDirectorTaskStatus, renderDirectorTaskError, controlDirectorPipeline,
    setRunning, resetDirectorClientState, restoreActiveProductionRun, directorArtifactSynchronizer };`, context);
  const app = context.app;
  const fixture = uiFixture({ story, plan });
  Object.assign(app.state, { selectedVariantId: "V2", output: { themeVariants: fixture.themeVariants },
    fullStories: story ? { V2: fixture.fullStory } : {}, animationPlans: plan ? { V2: fixture.animationPlan } : {} });
  Object.assign(app.state.production, { projectId: "project", runId: "run" });
  return { ...app, document, fixture };
}

export function uiTask(kind, status = "running", overrides = {}) {
  const target = { fullStory: "fullStory:V2", animationPlan: "animationPlan:V2", animationPromptRewrite: "animationPlan:V2",
    characterReferenceRefine: "animationPlan:V2", characterReferenceImages: "characterImages:V2:0",
    shotFrameImage: "shotFrame:V2:A01:start", shotVideo: "shotVideo:V2:A01", shotVideoBatch: "shotVideo:V2:A01" }[kind];
  return { taskId: `task-${kind}`, projectId: "project", runId: "run", kind, status,
    targetArtifactIds: target ? [target] : [], createdAt: "2026-09-09T01:00:00Z", updatedAt: "2026-09-09T01:01:00Z",
    modelSnapshot: { generation: { provider: "MiMo", model: "mimo-v2.5" } }, ...overrides };
}
