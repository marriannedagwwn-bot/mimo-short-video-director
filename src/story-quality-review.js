// 剧情体检（FullStory 终审编辑）的常量、只读投影与服务端派生。
//
// 这个阶段回答一件事：**选中的候选，有没有在展开成完整剧情时被写坏。**
// 它只出报告——不签发 Artifact、不进 lineage、不 stale、不阻断 Animation Plan，
// 页面刷新即失。与候选对照评审同规格。
//
// **两次顺序调用，第一次看不到候选。** 这是 2026-09-18 五轮离线 A/B 实测出来的，
// 不是设计偏好（数据在 ~/Downloads/fullStory-review-upgrade-ab-2026-09-18/）：
// 把「忠实保留候选」与「判这个动作成不成立」放进同一次调用时，被漏判的那句话
// 每次都被同一次调用引用成「承诺已兑现」的证据——风铃的手段-目的冲突 1/2、
// 阶梯餐厅的物理冲突 0/2，而两处缺陷都写在候选原文里。拆开之后手段-目的冲突升到 2/2，
// `missing_reference_state` 从 0/36 升到 2/2 且对已修好的版本 0/2。
// 与 §2.12b ⑥「共享机制清单先于候选产出」、展开前承诺核对拆两次调用是同一个招式。
import { longestCommonRun, normalizeDialogueChars } from "./validation.js";
// 枚举与标签的唯一来源在共享模块——提示词、校验器、schema 与浏览器都从那里取，
// 放在这里会变成第二份。这个方向不构成循环：validation.js 不 import 本文件。
import { PROMISE_SOURCE_FIELDS, STORY_QUALITY_ISSUE_TYPES } from "../public/story-review-metrics.js";

export { PROMISE_SOURCE_FIELDS, STORY_QUALITY_ISSUE_TYPES };

export const STORY_QUALITY_REVIEW_SCHEMA_VERSION = "story-quality-review/2.0";

/** 两次调用共用一个 stage 名：它们是同一档体检的两步，原文侧车也落在同一个 scope。 */
export const STORY_QUALITY_REVIEW_STAGE = "storyQualityReview";

/** 判成「没守住」的两档，比「被削弱」更重。派生总判定时按这两档优先。 */
const PROMISE_BROKEN = Object.freeze(["MISSING", "CONTRADICTED"]);

/**
 * 候选只读投影。**必须与 `fullStoryCandidateFacts` 分开，不要复用那一份。**
 *
 * `fullStoryCandidateFacts`（src/full-story-contract.js）刻意排除了 `keyDialogueDirections`，
 * 依据是 §2.10：台词草案不进 FullStory **生成**输入，剧情要按动作自己写对白。
 * 但**核对承诺必须看得见承诺本身**——《午后的阶梯餐厅》那条「全程无台词且不发出一丝声响」
 * 就写在这个字段里，它是五轮实测里最有价值的真阳性（2/2）。
 *
 * 所以这个不对称是有意的：生成阶段要防草案泄漏，验证阶段要看见承诺。
 */
export function buildStoryQualityCandidateProjection(candidate = {}) {
  const pick = (keys) => Object.fromEntries(
    keys.filter((key) => candidate[key] !== undefined)
      .map((key) => [key, structuredClone(candidate[key])])
  );
  return {
    ...pick([
      "id", "title", "oneLineHook", "logline", "narrativeMode", "characterSetup",
      "newTask", "environmentPressure", "keyChoiceBeat", "climaxBeat",
      "keyChoice", "climax", "emotionalPayoff", "keyDialogueDirections",
      "novelty", "visualPotential"
    ]),
    storyOutline: (Array.isArray(candidate.storyOutline) ? candidate.storyOutline : [])
      .map((beat) => ({
        beat: beat?.beat,
        action: String(beat?.action || ""),
        emotion: String(beat?.emotion || ""),
        estimatedSeconds: beat?.estimatedSeconds
      }))
  };
}

/**
 * 承诺总判定由服务端从逐条 status 派生，**不取模型给的值**。
 * 任一 MISSING/CONTRADICTED → FAIL；任一 WEAKENED → WARN；否则 PASS。
 * 纯枚举计数，零语义，与 §2.12b ⑩A「verdict 由派生、模型不写」同规格。
 */
export function deriveStoryQualityPromiseStatus(checks) {
  const statuses = (Array.isArray(checks) ? checks : []).map((check) => String(check?.status || ""));
  if (statuses.some((status) => PROMISE_BROKEN.includes(status))) return "FAIL";
  if (statuses.includes("WEAKENED")) return "WARN";
  return "PASS";
}

/**
 * 候选正文，供 `evidenceInCandidate` 比对。只取候选自己写下的剧情动作——
 * 不含标题与钩子，它们是对故事的描述而不是动作，放进来会让任何提到核心道具的证据都命中。
 */
export function storyQualityCandidateBody(candidate = {}) {
  const parts = (Array.isArray(candidate.storyOutline) ? candidate.storyOutline : [])
    .map((beat) => String(beat?.action || ""));
  for (const key of ["keyChoice", "climax", "emotionalPayoff", "newTask", "environmentPressure"]) {
    if (candidate[key]) parts.push(String(candidate[key]));
  }
  return normalizeDialogueChars(parts.join(""));
}

/**
 * 给每条 issue 附上「这段证据的文字是不是来自候选」这个事实。
 *
 * **它只用于展示，绝不参与任何判定，也不设阈值闸门。** 2026-09-18 第二轮实测已证伪
 * 阈值方案：同一个道具（竹席）在两个样本上的最长连续命中落在 7/8 与 15，只因为展开时
 * 多插了两处修饰词；更根本的是它**分不开真假阳性**——真问题（台阶，13/17）与
 * 误报（竹席，15/15）都写在候选里。所以这里只输出数字，不输出结论。
 */
export function annotateStoryQualityIssues(issues, candidateBody) {
  return (Array.isArray(issues) ? issues : []).map((issue) => ({
    ...issue,
    evidenceRun: longestCommonRun(normalizeDialogueChars(issue?.evidence), candidateBody)
  }));
}

/** 把两次调用的结果合成一份报告。承诺总判定在这里派生，不取模型的值。 */
export function assembleStoryQualityReview({ fullStory, editorial, promise, candidate } = {}) {
  const checks = (Array.isArray(promise?.checks) ? promise.checks : []).map((check) => ({
    promise: String(check?.promise || ""),
    source: (Array.isArray(check?.source) ? check.source : []).map((item) => String(item || "")),
    status: String(check?.status || ""),
    evidence: String(check?.evidence || "")
  }));
  return {
    schemaVersion: STORY_QUALITY_REVIEW_SCHEMA_VERSION,
    selectedVariantId: String(fullStory?.selectedVariantId || ""),
    summary: String(editorial?.summary || ""),
    promisePreservation: { status: deriveStoryQualityPromiseStatus(checks), checks },
    issues: annotateStoryQualityIssues(editorial?.issues, storyQualityCandidateBody(candidate))
  };
}
