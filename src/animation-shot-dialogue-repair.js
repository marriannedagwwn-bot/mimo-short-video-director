import { contentDigest } from "./production-lineage.js";
import {
  NO_BACKGROUND_MUSIC_SENTENCE,
  OutputContractError,
  shotDialogueMissingFromVideoPrompt
} from "./validation.js";

export const ANIMATION_SHOT_DIALOGUE_REPAIR_SCHEMA_VERSION = "animation_shot_dialogue_repair/1.0";

const DIALOGUE_MISSING_CODE = "DIRECT_SHOT_DIALOGUE_MISSING_FROM_VIDEO_PROMPT";
const MAX_REPAIR_TARGETS = 6;
// 插入内容在台词本身之外还允许的字数，够写一句说话动作的框架句。
const INSERTION_LENGTH_ALLOWANCE = 120;

// 服务端私有签发身份：模型拿到的序列化计划无法伪造成可合并计划。
const issuedRepairPlans = new WeakSet();

/**
 * 规划一次有界的 videoPrompt 台词补写。
 *
 * 触发条件严格到只有一种：批次校验因 DIRECT_SHOT_DIALOGUE_MISSING_FROM_VIDEO_PROMPT
 * 失败。**目标不从错误里的 path 解析**——路径字符串是人类可读格式，解析它就是在猜；
 * 改为用与校验器**同一个函数**重新扫描候选，保证要修的和会被拒的是同一批。
 *
 * 返回 null 表示不可修复，调用方必须 fail closed。
 */
export function planAnimationShotDialogueRepair(candidate, error) {
  if (!isRecord(candidate) || !Array.isArray(candidate.shotPlan)) return null;
  if (!(error instanceof OutputContractError)) return null;
  const details = Array.isArray(error.details) ? error.details : [];
  if (!details.length) return null;
  // 只要掺进任何一个我们无权修复的诊断，就整体放弃——不缩小失败面。
  if (!details.every((detail) => isRecord(detail) && detail.code === DIALOGUE_MISSING_CODE)) return null;

  const targets = [];
  for (const [index, shot] of candidate.shotPlan.entries()) {
    if (!isRecord(shot)) return null;
    const missing = shotDialogueMissingFromVideoPrompt(shot);
    if (!missing) continue;
    if (typeof shot.videoPrompt !== "string" || !shot.videoPrompt.trim()) return null;
    if (typeof shot.dialogueOrSubtitle !== "string" || !shot.dialogueOrSubtitle.trim()) return null;
    targets.push({
      repairId: `D${targets.length + 1}`,
      pointer: `/shotPlan/${index}/videoPrompt`,
      shotId: String(shot.shotId || ""),
      currentValue: shot.videoPrompt,
      // 权威：这一镜已签发的对白，以及校验器判定仍然缺失的那几句。
      dialogueOrSubtitle: shot.dialogueOrSubtitle,
      missingLines: missing,
      trailingSentence: trailingMusicSentence(shot.videoPrompt)
    });
  }
  if (!targets.length || targets.length > MAX_REPAIR_TARGETS) return null;

  const plan = deepFreeze({
    schemaVersion: ANIMATION_SHOT_DIALOGUE_REPAIR_SCHEMA_VERSION,
    baseDigest: contentDigest(candidate),
    targets,
    authorityDigest: contentDigest(targets.map((target) => ({
      repairId: target.repairId,
      pointer: target.pointer,
      dialogueOrSubtitle: target.dialogueOrSubtitle,
      missingLines: target.missingLines
    })))
  });
  issuedRepairPlans.add(plan);
  return plan;
}

/**
 * 第二次模型请求只发送：目标当前值、缺失的台词、修复说明。
 * 不发送整份批次、不发送 Foundation、不发送上游边界。
 */
export function animationShotDialogueRepairPrompt(plan) {
  assertIssuedRepairPlan(plan);
  const targets = plan.targets.map((target) => ({
    repairId: target.repairId,
    shotId: target.shotId,
    currentVideoPrompt: target.currentValue,
    dialogueOrSubtitle: target.dialogueOrSubtitle,
    missingSpokenLines: target.missingLines,
    mustEndWith: target.trailingSentence || null
  }));
  return `你现在只执行 Animation Plan direct_shot 的 videoPrompt 台词补写。

ANIMATION_SHOT_DIALOGUE_REPAIR_V1

服务端已冻结原批次。**不要重写、不要复述、不要输出 currentVideoPrompt。** 你只需要为每个目标写出**一小段要插入的新句子**，服务端会自己把它拼进原提示词里。

待修复目标：
${JSON.stringify(targets)}

硬约束：
- insertion 只写一句到两句话，把 missingSpokenLines 里的台词**原话一字不差**地说出来。写成自然的说话动作，例如：她低头说「原话」。
- 台词原话必须逐字出现在 insertion 里，标点可以在原话之外补，但原话本身不得改写、精简或换词。
- 不得复述 currentVideoPrompt 里已有的任何内容，不得新增剧情、动作、角色、道具或镜头。除了把已有台词说出来，不要引入任何新事实。
- insertion 每条不得超过 ${INSERTION_LENGTH_ALLOWANCE} 字加上台词本身的长度。写长了会被拒绝。
- 不得输出 path、op、replacement、完整镜头对象或任何额外字段。

只输出一个 JSON 对象，不要 Markdown，不要解释。严格使用以下结构：
{"schemaVersion":"${ANIMATION_SHOT_DIALOGUE_REPAIR_SCHEMA_VERSION}","baseDigest":${JSON.stringify(plan.baseDigest)},"repairs":[{"repairId":"...","insertion":"要插入的新句子"}]}

repairs 必须与待修复目标**等量、同序**，repairId 逐一对应。`;
}

/**
 * 在克隆上原子合并，并证明两件事：目标之外一个字节都没变；目标之内原文逐字保留、
 * 只多出包含缺失台词的插入内容。合并后调用方必须从头重跑完整批次校验。
 */
export function mergeAnimationShotDialogueRepair(candidate, envelope, plan) {
  assertIssuedRepairPlan(plan);
  assertExactKeys(envelope, ["schemaVersion", "baseDigest", "repairs"], "animationShotDialogueRepair");
  if (envelope.schemaVersion !== ANIMATION_SHOT_DIALOGUE_REPAIR_SCHEMA_VERSION) {
    throw new OutputContractError("videoPrompt 台词补写 schemaVersion 无效");
  }
  if (envelope.baseDigest !== plan.baseDigest || contentDigest(candidate) !== plan.baseDigest) {
    throw new OutputContractError("videoPrompt 台词补写 baseDigest 与冻结候选不一致");
  }
  if (!Array.isArray(envelope.repairs) || envelope.repairs.length !== plan.targets.length) {
    throw new OutputContractError(`videoPrompt 台词补写必须返回 ${plan.targets.length} 个 repairs`);
  }

  const merged = structuredClone(candidate);
  envelope.repairs.forEach((repair, index) => {
    assertExactKeys(repair, ["repairId", "insertion"], `animationShotDialogueRepair.repairs[${index}]`);
    const target = plan.targets[index];
    if (repair.repairId !== target.repairId) {
      throw new OutputContractError(`videoPrompt 台词补写 repairs[${index}].repairId 必须等于 ${target.repairId}`);
    }
    const insertion = repair.insertion;
    assertInsertionAuthorized(target, insertion);
    const shotIndex = Number(target.pointer.split("/")[2]);
    // 原文由服务端**按构造**保留：模型从来没有机会碰它。
    merged.shotPlan[shotIndex].videoPrompt = spliceInsertion(target, insertion);
  });

  assertOnlyTargetsChanged(candidate, merged, plan.targets);
  return merged;
}

/**
 * 模型只提供插入内容，服务端把它拼进原文——原文**按构造**逐字保留，模型碰不到。
 *
 * 这一版刻意不再让模型返回整条改写后的 videoPrompt：实测它会把 400 多字原文
 * 整体重写（措辞全换），于是「原文必须逐字保留」把每一次补写都拦死。要求模型
 * 逐字复述长文本在本仓库已有先例证明不可靠（见 CLAUDE.md 关键拍号那节的 0/12），
 * 与 Beat–Scene postpass 只收 `addition` 的做法对齐才是正确形状。
 */
function assertInsertionAuthorized(target, insertion) {
  if (typeof insertion !== "string" || !insertion.trim()) {
    throw new OutputContractError(`videoPrompt 台词补写 ${target.repairId} 的 insertion 必须是非空字符串`);
  }
  const lines = splitMissingLines(target.missingLines);
  for (const line of lines) {
    if (!insertion.includes(line)) {
      throw new OutputContractError(
        `videoPrompt 台词补写 ${target.repairId} 的插入内容缺少台词原话：${line}`
      );
    }
  }
  // 长度上限防止模型借 insertion 夹带一整条重写：够写「她低头说「原话」，语气心疼。」
  // 这类框架句，但装不下一份提示词。
  const allowance = target.missingLines.length + INSERTION_LENGTH_ALLOWANCE;
  if (insertion.length > allowance) {
    throw new OutputContractError(
      `videoPrompt 台词补写 ${target.repairId} 的插入内容过长（${insertion.length} 字，上限 ${allowance}）：只写把台词说出来的那一两句，不要复述原提示词。`
    );
  }
  // 不得把原文的开头抄进来——那是在试图重写而不是插入。
  const originalOpening = target.currentValue.slice(0, 12);
  if (originalOpening && insertion.includes(originalOpening)) {
    throw new OutputContractError(
      `videoPrompt 台词补写 ${target.repairId} 复述了原提示词开头：只需要写新插入的那句话。`
    );
  }
}

/** 把插入内容拼在收尾句之前；没有收尾句时追加到末尾。 */
function spliceInsertion(target, insertion) {
  const original = target.currentValue;
  const tail = target.trailingSentence || "";
  const head = tail ? original.slice(0, original.length - tail.length) : original;
  return `${head}${insertion.trim()}${tail}`;
}

/** 目标之外必须逐字节不变；目标本身只允许变成 replacement。 */
function assertOnlyTargetsChanged(candidate, merged, targets) {
  const stripped = structuredClone(merged);
  const baseline = structuredClone(candidate);
  for (const target of targets) {
    const shotIndex = Number(target.pointer.split("/")[2]);
    stripped.shotPlan[shotIndex].videoPrompt = baseline.shotPlan[shotIndex].videoPrompt;
  }
  if (contentDigest(stripped) !== contentDigest(baseline)) {
    throw new OutputContractError("videoPrompt 台词补写改动了目标之外的数据");
  }
}

function splitMissingLines(value) {
  return String(value || "")
    .split("；")
    .map((line) => line.trim())
    .filter(Boolean);
}

function trailingMusicSentence(videoPrompt) {
  const text = String(videoPrompt || "");
  return text.endsWith(NO_BACKGROUND_MUSIC_SENTENCE) ? NO_BACKGROUND_MUSIC_SENTENCE : "";
}

function assertIssuedRepairPlan(plan) {
  if (!issuedRepairPlans.has(plan)) {
    throw new OutputContractError("videoPrompt 台词补写计划不是服务端签发的实例");
  }
}

function assertExactKeys(value, keys, label) {
  if (!isRecord(value)) throw new OutputContractError(`${label} 必须是对象`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new OutputContractError(`${label} 只允许字段：${keys.join("、")}`);
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}
