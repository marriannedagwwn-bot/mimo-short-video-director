import { contentDigest } from "./production-lineage.js";
import {
  NO_BACKGROUND_MUSIC_SENTENCE,
  OutputContractError,
  shotDialogueMissingFromVideoPrompt
} from "./validation.js";

export const ANIMATION_SHOT_DIALOGUE_REPAIR_SCHEMA_VERSION = "animation_shot_dialogue_repair/1.0";

const DIALOGUE_MISSING_CODE = "DIRECT_SHOT_DIALOGUE_MISSING_FROM_VIDEO_PROMPT";
const MAX_REPAIR_TARGETS = 6;

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

服务端已冻结原批次；你看不到也不得重写整份 Plan。只处理下面列出的镜头，且**只能往 videoPrompt 里插入台词原话**。

待修复目标：
${JSON.stringify(targets)}

硬约束：
- 原 currentVideoPrompt 的每一个字都必须逐字保留、顺序不变。你只能**插入**新内容，不得删除、改写、调换或精简任何既有文字。
- 插入的内容必须包含 missingSpokenLines 里的台词**原话**，一字不差。写成自然的说话动作，例如：她抬头说「原话」。
- mustEndWith 非 null 时，那句话必须仍然是整条 videoPrompt 的最后一句，新内容插在它**之前**。
- 不得新增剧情、动作、角色、道具或镜头；除了把已有的台词说出来，不要引入任何新事实。
- 不得输出 path、op、完整镜头对象或任何额外字段。

只输出一个 JSON 对象，不要 Markdown，不要解释。严格使用以下结构：
{"schemaVersion":"${ANIMATION_SHOT_DIALOGUE_REPAIR_SCHEMA_VERSION}","baseDigest":${JSON.stringify(plan.baseDigest)},"repairs":[{"repairId":"...","replacement":"补写后的完整 videoPrompt"}]}

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
    assertExactKeys(repair, ["repairId", "replacement"], `animationShotDialogueRepair.repairs[${index}]`);
    const target = plan.targets[index];
    if (repair.repairId !== target.repairId) {
      throw new OutputContractError(`videoPrompt 台词补写 repairs[${index}].repairId 必须等于 ${target.repairId}`);
    }
    const replacement = repair.replacement;
    if (typeof replacement !== "string" || !replacement.trim()) {
      throw new OutputContractError(`videoPrompt 台词补写 ${target.repairId} 的 replacement 必须是非空字符串`);
    }
    assertOriginalPreservedWithInsertion(target, replacement);
    const shotIndex = Number(target.pointer.split("/")[2]);
    merged.shotPlan[shotIndex].videoPrompt = replacement;
  });

  assertOnlyTargetsChanged(candidate, merged, plan.targets);
  return merged;
}

/**
 * 原文必须逐字保留，只允许插入。
 *
 * 判定方式是确定性的：把原文按「收尾句之前 / 收尾句」切成头尾两段，替换值必须以
 * 头段为前缀、以尾段为后缀，中间多出来的就是插入内容——它必须含缺失台词原话。
 * 没有收尾句时退化为「必须以原文为前缀」，与 Beat–Scene postpass 的追加式同规格。
 */
function assertOriginalPreservedWithInsertion(target, replacement) {
  const original = target.currentValue;
  const tail = target.trailingSentence || "";
  const head = tail ? original.slice(0, original.length - tail.length) : original;
  if (!replacement.startsWith(head)) {
    throw new OutputContractError(
      `videoPrompt 台词补写 ${target.repairId} 改动了原文：只能插入，不能删除或改写既有文字。`
    );
  }
  if (tail && !replacement.endsWith(tail)) {
    throw new OutputContractError(
      `videoPrompt 台词补写 ${target.repairId} 必须让「${tail}」仍然是整条提示词的最后一句。`
    );
  }
  const insertion = tail
    ? replacement.slice(head.length, replacement.length - tail.length)
    : replacement.slice(head.length);
  if (!insertion.trim()) {
    throw new OutputContractError(`videoPrompt 台词补写 ${target.repairId} 没有插入任何内容。`);
  }
  for (const line of splitMissingLines(target.missingLines)) {
    if (!insertion.includes(line)) {
      throw new OutputContractError(
        `videoPrompt 台词补写 ${target.repairId} 的插入内容缺少台词原话：${line}`
      );
    }
  }
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
