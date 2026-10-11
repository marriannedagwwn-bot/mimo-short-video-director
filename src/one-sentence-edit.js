// 一句话修改（one-sentence-edit/1.0，2026-10-11，导演 Agent 第三期）。
//
// 用户在导演助手里说一句话（「第 3 场改成雨停了」「A04 别让她回头」），另起一次调用按这句原话，
// 对剧情、4.0 分镜或某一镜的视频提示词写出局部修改。**只出修改稿，不签发**：用户点「采纳」时，
// 服务端拿当前版本把同一组修改重新应用一遍、重新校验，结果摘要与修改稿一致才签发。
//
// 模型只写「在某个字段里找到唯一一段原文 → 换成什么」，原文由服务端逐字替换，它碰不到替换点以外的
// 任何一个字——与「按问题修改」、分镜内部修订同一个做法，执行器也直接复用它们。
// 做不到的（加场、加人、改时长、新增台词、话没说清楚）写 decline 说明原因，不许硬改。
//
// 本模块全是确定性函数：输出校验、三类修改的应用、预览用的改动清单、采纳后会作废什么。
// 模型调用在 workflow.createOneSentenceEdit，提示词在 one-sentence-edit-prompts.js。
import { contentDigest } from "./production-lineage.js";
import {
  StoryRepairPatchError,
  applyStoryRepairPatches,
  assertOnlyStoryRepairFieldsChanged
} from "./story-quality-repair.js";
import { applyEditorial } from "./storyboard-editorial.js";
import { catalog, editable } from "./storyboard-editorial-utils.js";
import { shotVideoPromptViolations } from "./storyboard-workflow.js";
import { OutputContractError } from "./validation.js";

export const ONE_SENTENCE_EDIT_STAGE = "oneSentenceEdit";
export const ONE_SENTENCE_EDIT_SCHEMA_VERSION = "one-sentence-edit/1.0";
export const ONE_SENTENCE_EDIT_TARGETS = Object.freeze(["story", "storyboard", "shotPrompt"]);
// 一次最多几处修改。一句话改不完六处的，多半不是局部修改。
export const ONE_SENTENCE_EDIT_MAX_PATCHES = 6;
// 与导演助手一条消息的上限相同：修改稿用的就是那条消息的原话。
export const ONE_SENTENCE_EDIT_INSTRUCTION_MAX_CHARS = 500;
export const ONE_SENTENCE_EDIT_NOTE_MAX_CHARS = 300;
// 剧情能改的字段：每场看得见的动作、镜头与声音、台词，以及这一场的情绪节点与剧情功能（情节变了，
// 它们要跟着改，否则前后矛盾）；不写场次时能改全片的一句话梗概与拍摄梗概。
// 时间轴、地点、出镜角色、说话人、场次结构一律不能改——那些决定下游镜头骨架和谁在画面里。
export const ONE_SENTENCE_EDIT_SCENE_FIELDS = Object.freeze([
  "visibleAction", "shotAndSound", "dialogue", "emotionNode", "dramaticFunction"
]);
export const ONE_SENTENCE_EDIT_STORY_FIELDS = Object.freeze(["oneLinePremise", "shootingSynopsis"]);

const PATCH_KEYS = Object.freeze({
  story: ["field", "find", "replace", "sceneId"],
  storyboard: ["find", "path", "replace"],
  shotPrompt: ["find", "replace"]
});

const FIELD_LABELS = Object.freeze({
  visibleAction: "动作",
  shotAndSound: "镜头与声音",
  dialogue: "台词",
  emotionNode: "情绪节点",
  dramaticFunction: "剧情功能",
  oneLinePremise: "一句话梗概",
  shootingSynopsis: "拍摄梗概"
});

function contractError(details) {
  return new OutputContractError(
    `一句话修改结构校验失败：${details.map((detail) => `${detail.path || "/"} ${detail.reason}`).join("；")}`,
    details
  );
}

// 执行不了的修改。只有一条修改，所以和结构错误一样带诊断重试一次（不像「按问题修改」那样只拒一条）。
function applyError(code, reason, path = "/patches") {
  return new OutputContractError(reason, [{ code, path, reason }]);
}

// 改完没过签发校验：保留校验器自己的 code 与指针（重试时模型收到的位置与校验器判定的位置是同一个），
// 只在消息前面说明这是改完之后的结果。
function resultInvalid(label, error) {
  const details = Array.isArray(error.details) && error.details.length
    ? error.details
    : [{ code: "ONE_SENTENCE_EDIT_RESULT_INVALID", path: "/patches", reason: error.message }];
  return new OutputContractError(`改完之后${label}没有通过签发校验：${error.message}`, details);
}

function occurrences(text, needle) {
  let count = 0;
  for (let from = 0; ; count += 1) {
    const at = text.indexOf(needle, from);
    if (at === -1) return count;
    from = at + needle.length;
  }
}

/** 模型输出的结构校验：只核对形状，不核对改得对不对（后者由逐字执行与签发校验裁决，或要人看）。 */
export function ensureOneSentenceEditContract(value, target) {
  if (!ONE_SENTENCE_EDIT_TARGETS.includes(target)) throw new TypeError(`未知的修改对象：${target}`);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw contractError([{ code: "ONE_SENTENCE_EDIT_OUTPUT_INVALID", path: "", reason: "输出必须是一个 JSON 对象" }]);
  }
  const details = [];
  const push = (code, path, reason) => details.push({ code, path, reason });
  if (Object.keys(value).sort().join(",") !== "decision,note,patches") {
    push("ONE_SENTENCE_EDIT_OUTPUT_INVALID", "", `只允许 decision、patches、note 三个键，实际是 ${Object.keys(value).join("、") || "（空）"}`);
  }
  if (!["edit", "decline"].includes(value.decision)) {
    push("ONE_SENTENCE_EDIT_DECISION_INVALID", "/decision", "decision 只能是 edit 或 decline");
  }
  const note = typeof value.note === "string" ? value.note.trim() : "";
  if (!note) push("ONE_SENTENCE_EDIT_NOTE_MISSING", "/note", "note 必须写：改了哪几处；拒绝时说明为什么做不到");
  else if (note.length > ONE_SENTENCE_EDIT_NOTE_MAX_CHARS) {
    push("ONE_SENTENCE_EDIT_NOTE_TOO_LONG", "/note", `note 不超过 ${ONE_SENTENCE_EDIT_NOTE_MAX_CHARS} 字，实际 ${note.length} 字`);
  }
  if (!Array.isArray(value.patches)) {
    push("ONE_SENTENCE_EDIT_PATCHES_INVALID", "/patches", "patches 必须是数组（拒绝时写空数组）");
  } else {
    const patches = value.patches;
    if (value.decision === "edit" && !patches.length) push("ONE_SENTENCE_EDIT_PATCH_COUNT", "/patches", "decision 是 edit 时至少要有一处修改");
    if (value.decision === "decline" && patches.length) push("ONE_SENTENCE_EDIT_PATCH_COUNT", "/patches", "decision 是 decline 时 patches 必须是空数组");
    if (patches.length > ONE_SENTENCE_EDIT_MAX_PATCHES) {
      push("ONE_SENTENCE_EDIT_PATCH_COUNT", "/patches", `一共最多 ${ONE_SENTENCE_EDIT_MAX_PATCHES} 处修改，实际 ${patches.length} 处`);
    }
    patches.forEach((patch, index) => {
      const at = `/patches/${index}`;
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
        push("ONE_SENTENCE_EDIT_PATCH_INVALID", at, "每一处修改必须是对象");
        return;
      }
      const expected = PATCH_KEYS[target];
      if (Object.keys(patch).sort().join(",") !== expected.join(",")) {
        push("ONE_SENTENCE_EDIT_PATCH_INVALID", at, `每一处修改只能有 ${expected.join("、")} 这几个键`);
      }
      if (typeof patch.find !== "string" || !patch.find) push("ONE_SENTENCE_EDIT_FIND_EMPTY", `${at}/find`, "find 必须是逐字复制的非空原文");
      if (typeof patch.replace !== "string") push("ONE_SENTENCE_EDIT_REPLACE_INVALID", `${at}/replace`, "replace 必须是字符串（删整句台词时写空字符串）");
      if (target === "story") {
        if (typeof patch.sceneId !== "string") {
          push("ONE_SENTENCE_EDIT_SCENE_ID_INVALID", `${at}/sceneId`, "sceneId 必须是字符串（改全片梗概时写空字符串）");
        }
        const allowed = String(patch.sceneId || "").trim() ? ONE_SENTENCE_EDIT_SCENE_FIELDS : ONE_SENTENCE_EDIT_STORY_FIELDS;
        if (!allowed.includes(patch.field)) {
          push("ONE_SENTENCE_EDIT_FIELD_NOT_ALLOWED", `${at}/field`,
            `${String(patch.sceneId || "").trim() ? "写了场次时" : "sceneId 为空时"} field 只能是 ${allowed.join("、")}，实际是「${String(patch.field ?? "")}」`);
        }
      }
      if (target === "storyboard" && (!Array.isArray(patch.path) || !patch.path.length
        || patch.path.some((key) => typeof key !== "string" || !key))) {
        push("ONE_SENTENCE_EDIT_PATH_INVALID", `${at}/path`, "path 必须是非空的字符串数组（数组下标也写成字符串，例如 \"0\"）");
      }
    });
  }
  if (details.length) throw contractError(details);
  return { decision: value.decision, patches: structuredClone(value.patches), note };
}

// ---- 剧情 ----

function applyStoryEdit(base, patches, { validateStory }) {
  let draft;
  try {
    draft = applyStoryRepairPatches(base, patches, {
      maxPatches: ONE_SENTENCE_EDIT_MAX_PATCHES,
      fields: ONE_SENTENCE_EDIT_SCENE_FIELDS,
      storyFields: ONE_SENTENCE_EDIT_STORY_FIELDS
    });
  } catch (error) {
    if (error instanceof StoryRepairPatchError) throw applyError(error.code, error.message);
    throw error;
  }
  let validated;
  try {
    validated = validateStory(draft);
  } catch (error) {
    if (error instanceof OutputContractError) throw resultInvalid("剧情", error);
    throw error;
  }
  assertOnlyStoryRepairFieldsChanged(base, validated, {
    sceneFields: ONE_SENTENCE_EDIT_SCENE_FIELDS,
    storyFields: ONE_SENTENCE_EDIT_STORY_FIELDS
  });
  return { content: validated, changes: storyChanges(base, validated) };
}

const dialogueText = (scene) => (Array.isArray(scene?.dialogue) ? scene.dialogue : [])
  .map((line) => `${line?.speaker || ""}：${line?.line || ""}`).join("\n");

function storyChanges(before, after) {
  const rows = [];
  for (const field of ONE_SENTENCE_EDIT_STORY_FIELDS) {
    if (before?.[field] !== after?.[field]) {
      rows.push({ label: `全片 · ${FIELD_LABELS[field]}`, field, before: String(before?.[field] ?? ""), after: String(after?.[field] ?? "") });
    }
  }
  (Array.isArray(after?.sceneScript) ? after.sceneScript : []).forEach((scene, index) => {
    const original = before?.sceneScript?.[index];
    for (const field of ONE_SENTENCE_EDIT_SCENE_FIELDS) {
      const was = field === "dialogue" ? dialogueText(original) : String(original?.[field] ?? "");
      const now = field === "dialogue" ? dialogueText(scene) : String(scene?.[field] ?? "");
      if (was !== now) rows.push({ label: `${scene.sceneId} · ${FIELD_LABELS[field]}`, sceneId: scene.sceneId, field, before: was, after: now });
    }
  });
  return rows;
}

// ---- 分镜 ----

/**
 * 分镜能改的文字：沿用分镜内部修订的可改清单（名字、说话人、场次来源、出镜角色、数字与结构都不在里面），
 * 再去掉角色外观——外观要和已选的人物参考图对得上，只改文字会让两边打架。
 */
export function oneSentenceStoryboardEditablePaths(plan) {
  return catalog(plan, "P").filter(editable)
    .filter((entry) => !(entry.path[0] === "visualDesign" && entry.path[1] === "characters"));
}

const getAt = (value, path) => path.reduce((node, key) => node?.[key], value);
const setAt = (value, path, next) => {
  let node = value;
  for (const key of path.slice(0, -1)) node = node[key];
  node[path.at(-1)] = next;
};

function applyStoryboardEdit(base, patches, { validationInput = {}, validatePlan }) {
  // 先逐处预检，给出用户和模型都看得懂的原因；真正的应用交给 applyEditorial（原子、带「目标之外没变」的证明）。
  const allowed = new Set(oneSentenceStoryboardEditablePaths(base).map((entry) => JSON.stringify(entry.path)));
  const simulated = structuredClone(base);
  patches.forEach((patch, index) => {
    const at = `第 ${index + 1} 处修改`;
    const where = patch.path.join("/");
    if (!allowed.has(JSON.stringify(patch.path))) {
      throw applyError("ONE_SENTENCE_EDIT_PATH_NOT_ALLOWED",
        `${at}：${where} 不在可改范围内（角色外观、名字、说话人、场次来源、出镜角色、时长与结构都不能改）`, `/patches/${index}/path`);
    }
    const text = getAt(simulated, patch.path);
    const count = occurrences(String(text ?? ""), patch.find);
    if (count !== 1) {
      throw applyError(count ? "ONE_SENTENCE_EDIT_FIND_NOT_UNIQUE" : "ONE_SENTENCE_EDIT_FIND_NOT_FOUND",
        count ? `${at}：要替换的原文在 ${where} 里出现了 ${count} 次，无法确定改哪一处`
          : `${at}：${where} 里找不到这段原文——修改必须逐字照抄原文`, `/patches/${index}/find`);
    }
    if (patch.find === patch.replace) throw applyError("ONE_SENTENCE_EDIT_NO_CHANGE", `${at}：替换前后一字不差`, `/patches/${index}`);
    const next = String(text).replace(patch.find, () => patch.replace);
    if (!next.trim()) throw applyError("ONE_SENTENCE_EDIT_EMPTY_RESULT", `${at}：改完 ${where} 成了空的`, `/patches/${index}/replace`);
    setAt(simulated, patch.path, next);
  });
  const outcome = applyEditorial(
    { repairs: [{ ref: "U1", disposition: "revise", patches: structuredClone(patches), note: "一句话修改" }] },
    { input: validationInput, plan: base, items: [{ ref: "U1" }] }
  );
  if (outcome.errors.length) throw applyError("ONE_SENTENCE_EDIT_RESULT_INVALID", `修改没能应用：${outcome.errors.join("；")}`);
  const row = outcome.rows[0];
  if (row.status !== "applied") {
    throw applyError("ONE_SENTENCE_EDIT_RESULT_INVALID", `改完之后分镜没有通过校验：${row.reason || row.status}`);
  }
  let validated;
  try {
    validated = validatePlan(outcome.result);
  } catch (error) {
    if (error instanceof OutputContractError) throw resultInvalid("分镜", error);
    throw error;
  }
  return {
    content: validated,
    changes: row.changes.map((change) => ({
      label: storyboardChangeLabel(base, change.path),
      path: change.path,
      before: change.original,
      after: change.modified
    }))
  };
}

const LEAF_LABELS = Object.freeze({
  visibleAction: "动作",
  camera: "运镜",
  framing: "景别",
  soundDesign: "声音",
  location: "地点",
  text: "台词",
  timing: "台词时机",
  storyPurpose: "剧情目的",
  emotionalTarget: "情绪",
  continuityOut: "衔接",
  layout: "布局",
  lighting: "光线",
  appearanceAndSupport: "外观与支撑",
  original: "原文",
  change: "改动",
  reason: "理由"
});
const GROUP_LABELS = Object.freeze({ locations: "场景", props: "道具" });

function leafLabel(rest) {
  if (rest.includes("dialogue")) return rest.at(-1) === "timing" ? "台词时机" : "台词";
  if (rest[0] === "transitionIn") return "转场说明";
  if (rest[0] === "acceptanceCriteria") return "验收标准";
  return LEAF_LABELS[rest.at(-1)] || rest.join("/");
}

export function storyboardChangeLabel(plan, path) {
  if (path[0] === "shotPlan") {
    const shotId = plan?.shotPlan?.[Number(path[1])]?.shotId || `第 ${Number(path[1]) + 1} 段`;
    if (path[2] === "beats") return `${shotId} · 第 ${Number(path[3]) + 1} 拍 · ${leafLabel(path.slice(4))}`;
    return `${shotId} · ${leafLabel(path.slice(2))}`;
  }
  if (path[0] === "visualDesign") {
    const name = plan?.visualDesign?.[path[1]]?.[Number(path[2])]?.name;
    return `${GROUP_LABELS[path[1]] || path[1]}${name ? `「${name}」` : ""} · ${leafLabel(path.slice(3))}`;
  }
  if (path[0] === "viewingIntent") return "观看重点";
  if (path[0] === "adaptations") return `改编说明 ${Number(path[1]) + 1} · ${leafLabel(path.slice(2))}`;
  return path.join("/");
}

// ---- 单镜视频提示词 ----

function applyShotPromptEdit(base, patches, { projected, shotId }) {
  let text = String(base?.videoPrompt || "");
  const changes = [];
  patches.forEach((patch, index) => {
    const at = `第 ${index + 1} 处修改`;
    // 不许整段重写：本仓库实测过，让模型复述长文本时它会把措辞整体换掉。
    if (patch.find === text) {
      throw applyError("ONE_SENTENCE_EDIT_WHOLE_TEXT", `${at}：不能整段替换提示词，只能改其中的片段`, `/patches/${index}/find`);
    }
    const count = occurrences(text, patch.find);
    if (count !== 1) {
      throw applyError(count ? "ONE_SENTENCE_EDIT_FIND_NOT_UNIQUE" : "ONE_SENTENCE_EDIT_FIND_NOT_FOUND",
        count ? `${at}：要替换的原文在提示词里出现了 ${count} 次，无法确定改哪一处`
          : `${at}：提示词里找不到这段原文——修改必须逐字照抄原文`, `/patches/${index}/find`);
    }
    if (patch.find === patch.replace) throw applyError("ONE_SENTENCE_EDIT_NO_CHANGE", `${at}：替换前后一字不差`, `/patches/${index}`);
    text = text.replace(patch.find, () => patch.replace);
    changes.push({ label: `${shotId} · 提示词第 ${index + 1} 处`, before: patch.find, after: patch.replace });
  });
  if (!text.trim()) throw applyError("ONE_SENTENCE_EDIT_EMPTY_RESULT", "改完之后提示词成了空的");
  const violations = shotVideoPromptViolations({ videoPrompt: text }, projected);
  if (violations.length) {
    throw new OutputContractError(`改完之后提示词没有通过校验：${violations.map((issue) => issue.reason).join("；")}`, violations);
  }
  // 只换提示词正文：版本、镜头号、对应的分镜摘要、视频模型与写稿模型都保持原样，弹窗的缓存照常命中。
  return { content: { ...structuredClone(base), videoPrompt: text }, changes, afterText: text };
}

/**
 * 把一组修改应用到当前版本上，返回改好的内容、预览用的改动清单和内容摘要。
 * 修改稿（有模型）与采纳（无模型）走的是同一个函数，所以采纳时签发的就是预览里那一份。
 */
export function applyOneSentenceEdit(context, patches) {
  const applied = context.target === "story"
    ? applyStoryEdit(context.base, patches, context)
    : context.target === "storyboard"
      ? applyStoryboardEdit(context.base, patches, context)
      : applyShotPromptEdit(context.base, patches, context);
  return { ...applied, resultDigest: contentDigest(applied.content) };
}

// ---- 采纳后会作废什么 ----

/**
 * 当前版本里直接或间接依赖这一份的全部产物——采纳后状态库会把它们标成 stale（与 propagateStale 同一口径）。
 */
export function oneSentenceEditDependents(latestArtifacts, artifactId) {
  const current = Object.entries(latestArtifacts || {})
    .filter(([id, entry]) => id !== artifactId && entry?.lineage?.status === "current");
  const stale = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, entry] of current) {
      if (stale.has(id)) continue;
      const dependencies = Array.isArray(entry.lineage.dependencies) ? entry.lineage.dependencies : [];
      if (dependencies.some((ref) => ref?.artifactId === artifactId || stale.has(ref?.artifactId))) {
        stale.add(id);
        changed = true;
      }
    }
  }
  return [...stale].sort();
}

/**
 * 采纳后会作废的东西，按类别计数，给卡片与确认弹窗用。
 * roleImagesLost：改剧情时分镜跟着作废，已设为人物参考图的图存在分镜里，一起没了；
 * roleImagesKept：改分镜时新版本从当前分镜改出来，这些图原样留在新版本里。
 */
export function oneSentenceEditInvalidation(latestArtifacts, artifactId, { roleImagesLost = 0, roleImagesKept = 0 } = {}) {
  const artifactIds = oneSentenceEditDependents(latestArtifacts, artifactId);
  const counts = { animationPlan: 0, shotVideoPrompt: 0, shotVideo: 0, characterImages: 0, other: 0 };
  for (const id of artifactIds) {
    const prefix = id.split(":")[0];
    if (Object.hasOwn(counts, prefix)) counts[prefix] += 1;
    else counts.other += 1;
  }
  return { artifactIds, counts, roleImagesLost, roleImagesKept };
}

/** 分镜里已经设为人物参考图的张数（图存在分镜里，分镜作废它们就跟着没了；改分镜本身会保留）。 */
export function chosenRoleImageCount(plan) {
  return (Array.isArray(plan?.characterReferencePrompts) ? plan.characterReferencePrompts : [])
    .filter((reference) => typeof reference?.referenceImageDataUrl === "string" && reference.referenceImageDataUrl).length;
}

/** 调用元数据，与「按问题修改」同形：拦过一次就必须说出来。 */
export function oneSentenceEditMetadata({ provider = "", model = "", providerCalls = 1, rejections = [] } = {}) {
  return {
    oneSentenceEdit: {
      provider,
      model,
      providerCalls,
      rejections: (Array.isArray(rejections) ? rejections : []).map((rejection, index) => ({
        attempt: index + 1,
        message: String(rejection?.message || ""),
        details: Array.isArray(rejection?.details) ? rejection.details : []
      }))
    }
  };
}
