const state = {
  file: null,
  previewUrl: null,
  videoDataUrl: null,
  frames: [],
  metadata: null,
  output: {},
  selectedVariantId: null,
  fullStories: {},
  mode: "demo",
  mediaMode: "auto",
  storyModel: "mimo-v2.5-pro",
  nativeVideoMaxBytes: 0,
  running: false,
  storyRunning: false
};

const $ = (selector) => document.querySelector(selector);
const elements = {
  input: $("#videoInput"), dropzone: $("#dropzone"), uploadTitle: $("#uploadTitle"), uploadHint: $("#uploadHint"),
  videoInfo: $("#videoInfo"), preview: $("#videoPreview"), fileName: $("#fileName"), fileMeta: $("#fileMeta"),
  frames: $("#frames"), frameStatus: $("#frameStatus"), replace: $("#replaceVideo"), transcript: $("#transcript"),
  fixedCharacter: $("#fixedCharacter"), vertical: $("#vertical"), constraints: $("#constraints"), variantCount: $("#variantCount"),
  run: $("#runWorkflow"), error: $("#errorMessage"), modelState: $("#modelState"),
  empty: $("#emptyResults"), resultStack: $("#resultStack"), export: $("#exportButton"),
  analysis: $("#analysisResult"), script: $("#scriptResult"), brief: $("#briefResult"), variants: $("#variantsResult"),
  mainPage: $("#top"), storyPage: $("#storyPage"), storyModelName: $("#storyModelName"),
  selectedVariantSummary: $("#selectedVariantSummary"), storyStatus: $("#storyStatus"),
  storyGenerate: $("#generateFullStory"), fullStory: $("#fullStoryResult"), backToResults: $("#backToResults")
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
    state.storyModel = health.storyModel || "mimo-v2.5-pro";
    state.nativeVideoMaxBytes = health.nativeVideoMaxBytes || 0;
    elements.storyModelName.textContent = state.storyModel.split("/").pop();
    const storyReady = health.storyModelAvailable !== false;
    const connected = health.mode === "mimo" && health.providerReachable && health.modelAvailable && storyReady;
    elements.modelState.className = `model-state ${connected ? "ready" : health.mode === "mimo" ? "" : "demo"}`;
    elements.modelState.lastElementChild.textContent = connected
      ? `MiMo 已连接 · ${health.model.split("/").pop()} / 剧情 ${state.storyModel.split("/").pop()}`
      : health.mode === "mimo"
        ? health.providerReachable
          ? health.modelAvailable ? `完整剧情模型未加载：${state.storyModel.split("/").pop()}` : "MiMo 可访问，但指定模型未加载"
          : "MiMo 已配置，但服务不可达"
        : "演示模式 · 配置 MiMo 后启用真实分析";
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
  elements.variants.addEventListener("click", (event) => {
    const button = event.target.closest("[data-story-variant]");
    if (button) navigateToStory(button.dataset.storyVariant);
  });
  elements.backToResults.addEventListener("click", backToMainResults);
  elements.storyGenerate.addEventListener("click", () => generateFullStory({ force: true }));
  window.addEventListener("popstate", renderRoute);
  [elements.fixedCharacter, elements.vertical, elements.constraints].forEach((element) => element.addEventListener("input", () => { saveProfile(); validateReady(); }));
}

async function handleFile(file) {
  if (!file.type.startsWith("video/")) return showError("请选择视频文件。支持 MP4、MOV、WebM 等浏览器可播放格式。");
  if (state.mode === "mimo" && state.mediaMode === "video" && file.size > state.nativeVideoMaxBytes) {
    return showError(`当前强制使用原生视频，文件不能超过 ${formatBytes(state.nativeVideoMaxBytes)}。请压缩视频或改用 auto 模式。`);
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
    const shouldReadNativeVideo = state.mode === "mimo"
      && state.mediaMode !== "frames"
      && file.size <= state.nativeVideoMaxBytes;
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
      : state.mode === "mimo" && state.mediaMode !== "frames" && file.size > state.nativeVideoMaxBytes
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
    reader.addEventListener("error", () => reject(new Error("无法读取原始视频")), { once: true });
    reader.readAsDataURL(file);
  });
}

async function runWorkflow() {
  if (state.running) return;
  const creatorProfile = profile();
  if (state.frames.length < 3 || !creatorProfile.fixedCharacter || !creatorProfile.vertical) return showError("请先上传视频，并填写固定角色和垂直赛道。 ");
  state.running = true;
  state.output = {};
  state.fullStories = {};
  state.selectedVariantId = null;
  showError("");
  setRunning(true);
  resetPipeline();
  elements.empty.classList.add("hidden");
  elements.resultStack.classList.remove("hidden");
  [elements.analysis, elements.script, elements.brief, elements.variants].forEach((element) => { element.innerHTML = ""; element.classList.add("hidden"); });
  const shared = {
    frames: state.frames,
    ...(state.videoDataUrl ? { video: { dataUrl: state.videoDataUrl, mimeType: state.file.type, size: state.file.size } } : {}),
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

    setStage("variants", "active");
    state.output.themeVariants = await api("/api/variants", { creativeBrief: state.output.creativeBrief, creatorProfile, count: Number(elements.variantCount.value) });
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
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.detail ? `${data.error}：${data.detail.slice(0, 240)}` : data.error || `请求失败（${response.status}）`);
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
  if (existing) {
    renderFullStory(existing);
    setStoryStatus(`已生成完整剧情 · ${state.storyModel.split("/").pop()}`, "ready");
  } else {
    elements.fullStory.classList.add("hidden");
    elements.fullStory.innerHTML = "";
    if (variant) {
      setStoryStatus("准备生成完整剧情。", "");
      if (autoGenerate) generateFullStory();
    } else {
      setStoryStatus("当前页面没有可用主题变体。请先返回工作台，完成视频分析并选择一个主题变体。", "error");
    }
  }
  elements.storyGenerate.disabled = !variant || state.storyRunning;
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
  setStoryStatus(`正在调用 ${state.storyModel.split("/").pop()} 生成完整剧情…`, "active");
  try {
    const fullStory = await api("/api/full-story", {
      referenceAnalysis: state.output.referenceAnalysis,
      sourceScriptReconstruction: state.output.sourceScriptReconstruction,
      creativeBrief: state.output.creativeBrief,
      themeVariants: state.output.themeVariants,
      variant,
      creatorProfile: profile()
    });
    state.fullStories[variant.id] = fullStory;
    state.output.fullStories = state.fullStories;
    state.output.fullStory = fullStory;
    renderFullStory(fullStory);
    setStoryStatus(`完整剧情已生成 · ${state.storyModel.split("/").pop()}`, "ready");
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

function resultHeader(kicker, title, badge = "") {
  return `<div class="result-title"><div><p>${kicker}</p><h3>${title}</h3></div>${badge ? `<span class="confidence">${escape(badge)}</span>` : ""}</div>`;
}
function block(label, content) { return `<div class="result-block"><span class="block-label">${label}</span>${content}</div>`; }
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
  elements.storyGenerate.querySelector("span").textContent = running ? "完整剧情生成中…" : `用 ${state.storyModel.split("/").pop()} 生成完整剧情`;
  elements.storyGenerate.disabled = running || !selectedVariant();
}
function setStoryStatus(message, tone = "") {
  elements.storyStatus.textContent = message;
  elements.storyStatus.className = `story-status ${tone}`;
}
function validateReady() { if (!state.running) elements.run.disabled = !(state.frames.length >= 3 && elements.fixedCharacter.value.trim() && elements.vertical.value.trim()); }
function showError(message) { elements.error.textContent = message; }
function profile() { return { fixedCharacter: elements.fixedCharacter.value.trim(), vertical: elements.vertical.value.trim(), constraints: elements.constraints.value.trim() }; }
function saveProfile() { localStorage.setItem("directorProfile", JSON.stringify(profile())); }
function restoreProfile() { try { const data = JSON.parse(localStorage.getItem("directorProfile")); if (data) { elements.fixedCharacter.value = data.fixedCharacter || ""; elements.vertical.value = data.vertical || ""; elements.constraints.value = data.constraints || ""; } } catch {} }
function selectedVariant() { return (state.output.themeVariants?.variants || []).find((variant) => String(variant.id) === String(state.selectedVariantId)); }

function exportJson() {
  const payload = { exportedAt: new Date().toISOString(), mode: state.mode, sourceVideo: state.metadata, creatorProfile: profile(), ...state.output };
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `短视频创意方案-${Date.now()}.json`;
  link.click();
  URL.revokeObjectURL(url);
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
