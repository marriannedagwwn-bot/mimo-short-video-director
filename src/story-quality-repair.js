// 剧情体检的「按问题修改」（story-quality-repair/1.0）。
//
// **体检本身不动，修改另起一次调用。** 编辑诊断刻意看不到候选——2026-09-18 五轮实测，
// 看得见候选时被漏判的那句话每次都被引用成「承诺已兑现」的证据。可同一个盲区让它顺手写的
// 修改会把候选承诺改坏：第六轮把体检附带的修改全部打上再复检，打上的 32 条里 4 条把承诺
// 改弱或改坏（「双手扶着」→「双手松开」、「放下竹篓」→「盖紧竹篓」……），另有 1 条把路人少女
// 删得只剩出镜角色表里一个名字。第七轮改成用户选中问题之后另起一次调用，这次给它候选与
// 「现在守住的承诺」清单：同一批问题，承诺退化 4 → 1，其余通过线全部达到。
// 数据在 ~/Downloads/fullStory-review-patch-2026-09-18/（预先登记、两份报告、原始输出）。
//
// 与命题定向修订同规格：**只出修订稿，不签发任何东西**。签发只发生在用户点「采纳」的那一刻，
// 由浏览器走既有的 fullStory 签发流程；新版本会递归 stale 这个变体的镜头计划与媒体。
//
// 模型只写 {sceneId, field, find, replace}，**原文由服务端逐字替换**：它碰不到替换点以外的
// 任何一个字。要求模型复述整段长文本，本仓库已有 0/12 的先例（§2.4 台词补写）。
import { STORY_REPAIR_MAX_PATCHES, STORY_REPAIR_PATCH_FIELDS, storyQualityRepairableItems }
  from "../public/story-review-metrics.js";
import { InputError, OutputContractError } from "./validation.js";

export { STORY_REPAIR_MAX_PATCHES, STORY_REPAIR_PATCH_FIELDS, storyQualityRepairableItems };

export const STORY_QUALITY_REPAIR_STAGE = "storyQualityRepair";
export const STORY_QUALITY_REPAIR_SCHEMA_VERSION = "story-quality-repair/1.0";

/** 单条修改执行不了的原因。它不是模型输出的结构错误，所以不触发重试，只让这一条不被采用。 */
export class StoryRepairPatchError extends Error {
  constructor(code, reason) {
    super(reason);
    this.name = "StoryRepairPatchError";
    this.code = code;
  }
}

/**
 * 按用户勾选的引用号取出要修的条目。**顺序按报告里的顺序，不按勾选顺序**：
 * 同一份选择永远生成同一段提示词，也永远以同一个顺序逐条合并。
 */
export function selectStoryQualityRepairItems(review, selectedRefs) {
  const repairable = storyQualityRepairableItems(review);
  if (!Array.isArray(selectedRefs) || !selectedRefs.length) {
    throw new InputError("至少要选中一条问题才能生成修改");
  }
  const known = new Set(repairable.map((item) => item.ref));
  const chosen = new Set();
  for (const raw of selectedRefs) {
    const ref = String(raw || "").trim();
    if (!known.has(ref)) {
      throw new InputError(`体检报告里没有可以修改的条目「${ref}」——守住的承诺不需要修`);
    }
    if (chosen.has(ref)) throw new InputError(`条目「${ref}」被选了两次`);
    chosen.add(ref);
  }
  return repairable.filter((item) => chosen.has(item.ref));
}

/**
 * 体检判为守住的承诺。它们作为「修改不得改坏」的清单交给修改调用——
 * 第六轮四次承诺退化，都是修一个物理问题时顺手改掉了候选写明的动作。
 */
export function storyQualityKeptPromises(review) {
  const checks = Array.isArray(review?.promisePreservation?.checks) ? review.promisePreservation.checks : [];
  return checks
    .filter((check) => String(check?.status || "") === "PRESERVED")
    .map((check) => ({ promise: String(check.promise || ""), evidence: String(check.evidence || "") }));
}

function occurrences(text, needle) {
  let count = 0;
  for (let from = 0; ; count += 1) {
    const at = text.indexOf(needle, from);
    if (at === -1) return count;
    from = at + needle.length;
  }
}

/**
 * 一个出镜角色在本场的「显式出现」：visibleAction 里点名的次数 + 以他为说话人的台词条数。
 * 只看这两处：characters 登记的是画面里的人，而 shotAndSound 里的名字不代表出镜。
 */
function onScreenPresence(scene, name) {
  const dialogue = Array.isArray(scene?.dialogue) ? scene.dialogue : [];
  return occurrences(String(scene?.visibleAction || ""), name)
    + dialogue.filter((line) => String(line?.speaker || "") === name).length;
}

/**
 * 把一条问题的几处修改作用到剧情上，返回新的一份。**原子执行**：任何一处执行不了，
 * 整条都不动，抛 StoryRepairPatchError。
 *
 * 判定全部是字符串比较，零语义：
 *   - find 必须在该场该字段里**逐字出现恰好一次**——出现 0 次说明模型没照抄原文，
 *     出现多次则替换哪一处无法唯一确定，两种都不猜；
 *   - dialogue 在该场全部台词正文里合起来算恰好一次；replace 为空且 find 是整句时删掉这一句，
 *     只删半句导致台词变空则拒绝（那是没写清楚要删什么）；
 *   - **修改不得让一个出镜角色从本场的动作和对白里消失**。第六轮实测：删掉路人少女的动作、
 *     脚步声和台词之后，她还登记在 characters 里，下游会把一个已经不在戏里的人渲染进画面。
 *     增删出镜角色要改 characters，那不是文字替换能做的事。
 */
export function applyStoryRepairPatches(story, patches) {
  if (!Array.isArray(patches) || !patches.length) {
    throw new StoryRepairPatchError("STORY_REPAIR_NO_PATCH", "这一条没有附修改");
  }
  if (patches.length > STORY_REPAIR_MAX_PATCHES) {
    throw new StoryRepairPatchError(
      "STORY_REPAIR_PATCH_TOO_MANY",
      `一条问题最多 ${STORY_REPAIR_MAX_PATCHES} 处修改，这一条写了 ${patches.length} 处`
    );
  }
  const draft = structuredClone(story);
  const scenes = Array.isArray(draft.sceneScript) ? draft.sceneScript : [];
  patches.forEach((patch, index) => {
    const at = `第 ${index + 1} 处修改`;
    const sceneId = String(patch?.sceneId || "").trim();
    const scene = scenes.find((entry) => String(entry?.sceneId || "") === sceneId);
    if (!scene) throw new StoryRepairPatchError("STORY_REPAIR_SCENE_NOT_FOUND", `${at}：剧情里没有场次「${sceneId}」`);
    const field = String(patch?.field || "");
    if (!STORY_REPAIR_PATCH_FIELDS.includes(field)) {
      throw new StoryRepairPatchError(
        "STORY_REPAIR_FIELD_NOT_ALLOWED",
        `${at}：只能改 ${STORY_REPAIR_PATCH_FIELDS.join("、")}，不能改「${field}」`
      );
    }
    const find = typeof patch?.find === "string" ? patch.find : "";
    if (!find) throw new StoryRepairPatchError("STORY_REPAIR_FIND_EMPTY", `${at}：没有写要替换的原文`);
    if (typeof patch.replace !== "string") {
      throw new StoryRepairPatchError("STORY_REPAIR_REPLACE_INVALID", `${at}：replace 必须是字符串`);
    }
    if (patch.replace === find) throw new StoryRepairPatchError("STORY_REPAIR_NO_CHANGE", `${at}：替换前后一字不差`);

    if (field === "dialogue") {
      const lines = Array.isArray(scene.dialogue) ? scene.dialogue : [];
      const hits = lines.flatMap((line, lineIndex) => (
        Array(occurrences(String(line?.line || ""), find)).fill(lineIndex)
      ));
      if (hits.length !== 1) throw notExactlyOnce(at, sceneId, "台词", hits.length);
      const line = lines[hits[0]];
      const original = String(line.line || "");
      if (patch.replace === "" && original === find) {
        lines.splice(hits[0], 1);
        return;
      }
      const next = original.replace(find, () => patch.replace);
      if (!next.trim()) {
        throw new StoryRepairPatchError(
          "STORY_REPAIR_DIALOGUE_LINE_EMPTY",
          `${at}：改完这句台词成了空的——要删整句，find 必须是这句台词的完整原文`
        );
      }
      line.line = next;
      return;
    }
    const text = String(scene[field] || "");
    const count = occurrences(text, find);
    if (count !== 1) throw notExactlyOnce(at, sceneId, field, count);
    scene[field] = text.replace(find, () => patch.replace);
  });

  const before = new Map((Array.isArray(story.sceneScript) ? story.sceneScript : [])
    .map((scene) => [String(scene?.sceneId || ""), scene]));
  for (const scene of scenes) {
    const original = before.get(String(scene?.sceneId || ""));
    for (const name of Array.isArray(scene?.characters) ? scene.characters : []) {
      if (onScreenPresence(original, name) > 0 && onScreenPresence(scene, name) === 0) {
        throw new StoryRepairPatchError(
          "STORY_REPAIR_REMOVES_ON_SCREEN_CHARACTER",
          `这条修改让「${name}」从 ${scene.sceneId} 的动作和对白里消失了，但出镜角色表里仍登记着这个角色——`
          + "增删出镜角色要人工调整角色表，不能用文字替换完成"
        );
      }
    }
  }
  return draft;
}

function notExactlyOnce(at, sceneId, field, count) {
  return count
    ? new StoryRepairPatchError(
      "STORY_REPAIR_FIND_NOT_UNIQUE",
      `${at}：要替换的原文在 ${sceneId} 的 ${field} 里出现了 ${count} 次，无法确定改哪一处`
    )
    : new StoryRepairPatchError(
      "STORY_REPAIR_FIND_NOT_FOUND",
      `${at}：${sceneId} 的 ${field} 里找不到这段原文——修改必须逐字照抄原文`
    );
}

/**
 * 模型输出的结构校验。**只核对形状与一一对应，不核对改得对不对**——后者要么由逐字执行
 * 与签发校验链确定性裁决（找不到原文、改完不合法），要么需要语义判断、只能由人在预览时看。
 *
 * 这里失败会带诊断重试一次（结构错了整份输出都用不上）；单条执行不了则只拒那一条，不重试。
 */
export function ensureStoryQualityRepairContract(repair, items) {
  if (!repair || typeof repair !== "object" || Array.isArray(repair)) {
    throw new OutputContractError("storyQualityRepair 必须是对象", [{
      code: "STORY_REPAIR_OUTPUT_INVALID", path: "", reason: "输出必须是一个 JSON 对象"
    }]);
  }
  const details = [];
  const push = (code, path, reason) => details.push({ code, path, reason });
  const rows = Array.isArray(repair.repairs) ? repair.repairs : null;
  if (!rows) {
    push("STORY_REPAIR_REPAIRS_INVALID", "/repairs", "repairs 必须是数组");
  } else {
    if (rows.length !== items.length) {
      push(
        "STORY_REPAIR_COUNT_MISMATCH",
        "/repairs",
        `一共选中了 ${items.length} 条问题，repairs 必须恰好 ${items.length} 条（不改的也要列出来并写 note），实际 ${rows.length} 条`
      );
    }
    rows.forEach((row, index) => {
      const path = `/repairs/${index}`;
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        push("STORY_REPAIR_ENTRY_INVALID", path, "每一条必须是对象");
        return;
      }
      const expected = items[index]?.ref;
      if (expected !== undefined && String(row.ref || "") !== expected) {
        push(
          "STORY_REPAIR_REF_MISMATCH",
          `${path}/ref`,
          `第 ${index + 1} 条必须是「${expected}」（与问题清单一一对应、顺序相同），实际写的是「${String(row.ref || "")}」`
        );
      }
      if (!String(row.note || "").trim()) {
        push("STORY_REPAIR_NOTE_MISSING", `${path}/note`, "note 必须写：改了什么；没改的说明为什么");
      }
      const patches = Array.isArray(row.patches) ? row.patches : null;
      if (!patches) {
        push("STORY_REPAIR_PATCHES_INVALID", `${path}/patches`, "patches 必须是数组（不改就写空数组）");
        return;
      }
      if (patches.length > STORY_REPAIR_MAX_PATCHES) {
        push("STORY_REPAIR_PATCH_TOO_MANY", `${path}/patches`, `一条问题最多 ${STORY_REPAIR_MAX_PATCHES} 处修改`);
      }
      patches.forEach((patch, position) => {
        const at = `${path}/patches/${position}`;
        if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
          push("STORY_REPAIR_PATCH_INVALID", at, "每一处修改必须是对象");
          return;
        }
        if (!String(patch.sceneId || "").trim()) push("STORY_REPAIR_SCENE_ID_MISSING", `${at}/sceneId`, "sceneId 必须是非空字符串");
        if (!STORY_REPAIR_PATCH_FIELDS.includes(String(patch.field || ""))) {
          push("STORY_REPAIR_FIELD_NOT_ALLOWED", `${at}/field`,
            `field 只能是 ${STORY_REPAIR_PATCH_FIELDS.join("、")}；实际写的是「${String(patch.field || "")}」`);
        }
        if (typeof patch.find !== "string" || !patch.find) push("STORY_REPAIR_FIND_EMPTY", `${at}/find`, "find 必须是从剧情里逐字复制的非空原文");
        if (typeof patch.replace !== "string") push("STORY_REPAIR_REPLACE_INVALID", `${at}/replace`, "replace 必须是字符串（删整句台词时写空字符串）");
      });
    });
  }
  if (details.length) {
    throw new OutputContractError(
      `storyQualityRepair 结构校验失败：${details.map((detail) => `${detail.path} ${detail.reason}`).join("；")}`,
      details
    );
  }
  return repair;
}

/**
 * 逐条合并。**每一条采用之前都要让整份剧情重新通过签发校验链**（`validateStory` 由调用方传入，
 * 就是 createFullStory 签发前那一条）；过不了就只拒这一条、继续下一条，最后留下的一定合法。
 *
 * 条目之间按报告顺序依次作用：后一条的原文若已被前一条改掉，会在这里被拒并如实说明是冲突，
 * 不会被悄悄改到别处去。
 */
export function mergeStoryQualityRepairs({ fullStory, items, repair, validateStory }) {
  let current = structuredClone(fullStory);
  let appliedAny = false;
  const results = items.map((item, index) => {
    const row = repair.repairs[index];
    const base = {
      ref: item.ref,
      kind: item.kind,
      patches: structuredClone(row.patches),
      note: String(row.note || "")
    };
    if (!row.patches.length) return { ...base, status: "declined" };
    let draft;
    try {
      draft = applyStoryRepairPatches(current, row.patches);
    } catch (error) {
      if (!(error instanceof StoryRepairPatchError)) throw error;
      const clashed = error.code === "STORY_REPAIR_FIND_NOT_FOUND" && appliedAny
        && appliesToOriginal(fullStory, row.patches);
      return {
        ...base,
        status: "rejected",
        code: clashed ? "STORY_REPAIR_CONFLICTS_WITH_EARLIER" : error.code,
        reason: clashed ? `与前面已采用的修改冲突：${error.message}` : error.message
      };
    }
    try {
      draft = validateStory(draft);
    } catch (error) {
      if (!(error instanceof OutputContractError)) throw error;
      return {
        ...base,
        status: "rejected",
        code: "STORY_REPAIR_RESULT_INVALID",
        reason: `改完之后剧情没有通过签发校验：${error.message}`
      };
    }
    current = draft;
    appliedAny = true;
    return { ...base, status: "applied" };
  });
  return { fullStory: current, results };
}

function appliesToOriginal(story, patches) {
  try {
    applyStoryRepairPatches(story, patches);
    return true;
  } catch {
    return false;
  }
}

/**
 * 自证：修改之外逐字节不变。它由构造保证（执行器只写这三个字段），这里再断言一次，
 * 与命题修订、分镜修订的同名断言同规格——出错就是代码缺陷，不是模型的错。
 *
 * 台词可以被删整句，所以 dialogue 只要求：留下的每一句按原顺序是原来某一句，
 * 说话人与表演说明逐字不变，只有台词正文能变。
 */
export function assertOnlyStoryRepairFieldsChanged(before, after) {
  const frame = (story) => JSON.stringify({
    ...story,
    sceneScript: (story.sceneScript || []).map((scene) => {
      const { visibleAction: _action, shotAndSound: _sound, dialogue: _dialogue, ...rest } = scene;
      return rest;
    })
  });
  const problems = [];
  if (frame(before) !== frame(after)) problems.push("可写字段之外的内容变了");
  (after.sceneScript || []).forEach((scene, index) => {
    const original = (before.sceneScript || [])[index];
    const kept = Array.isArray(scene.dialogue) ? scene.dialogue : [];
    const source = Array.isArray(original?.dialogue) ? original.dialogue : [];
    let cursor = 0;
    for (const line of kept) {
      while (cursor < source.length && !(source[cursor].speaker === line.speaker
        && source[cursor].deliveryOrSubtext === line.deliveryOrSubtext)) cursor += 1;
      if (cursor >= source.length) {
        problems.push(`${scene.sceneId} 的台词不是原来台词的子序列`);
        return;
      }
      cursor += 1;
    }
  });
  if (problems.length) {
    throw new OutputContractError(`按问题修改越界：${problems.join("；")}`, problems.map((reason) => ({
      code: "STORY_REPAIR_OUT_OF_SCOPE", path: "/sceneScript", reason
    })));
  }
}

/** 调用元数据。与命题定向修订那份同形：**拦过一次就必须说出来**，花掉的钱不能藏起来。 */
export function storyQualityRepairMetadata({ provider = "", model = "", providerCalls = 1, rejections = [] } = {}) {
  const list = Array.isArray(rejections) ? rejections : [];
  return {
    storyQualityRepair: {
      provider,
      model,
      providerCalls,
      rejections: list.map((rejection, index) => ({
        attempt: index + 1,
        message: String(rejection?.message || ""),
        details: Array.isArray(rejection?.details) ? rejection.details : []
      }))
    }
  };
}
