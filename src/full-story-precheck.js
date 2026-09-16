// 完整剧情的「展开前体检」。
//
// 点「生成完整剧情」时先跑这一步：原样调用现有的候选对照评审（只送这一个候选），
// 再加一次专门的承诺核对，两份结果**确定性**合成一个路由——有根问题就先修订候选，
// 没有就直接展开。它只出报告：不签发 Artifact、不进 lineage、不 stale 任何东西，
// 与候选对照评审同规格，刷新页面即失。FullStory 任务本身的冻结语义不变——
// 修订候选只能在展开**之前**由用户采纳并签发新版本，不能在已冻结的展开任务里偷换。
//
// 为什么需要它（2026-09-16）：《蚂蚁搬家式运书》从 7.9 到 8.5，起作用的是展开前
// 手工修订候选，同一版 FullStory 提示词两边都没变；而事后往提示词里加规则 5 次、
// 新写一个校订器 8 次真实调用，都没能自动做到。归档数据显示现有评审只送一个候选时，
// 能抓到《追风的小猫娘》的因果断裂、对合格的 r2 运书零误报；
// 唯一漏掉的旧版运书，缺的正是「标题/钩子许诺的东西有没有被演出来」这一类判断。
//
// **承诺核对必须分两次调用，这是实测出来的，不是设计偏好**（2026-09-16 第一版 A/B）：
// 单次调用里动作链一直在上下文中，模型会照着动作链倒推期待。同一个标题
// 「蚂蚁搬家式运书」，在已经写了往返的 r2 上写出「多次往返搬运」，在只搬了一趟的
// 旧版上写成「用身体多个部位同时携带」——两者正好相反，于是两个候选都判「已兑现」。
// 所以第一次调用**看不到动作链**，只凭标题与钩子写出观众必须看到什么；
// 第二次调用才拿这份冻结的清单去动作链里逐条找。判定由服务端从逐条结果派生，
// 模型不写 verdict。与 §2.12b ⑥「共享机制清单先于候选产出」是同一个招式。
import { FULL_STORY_PROMISE_UNREALIZED_VERDICTS, InputError, derivePromiseVerdict } from "./validation.js";
import { PROMISE_UNREALIZED_REASON } from "../public/story-review-metrics.js";

export const FULL_STORY_PRECHECK_SCHEMA_VERSION = "full-story-precheck/1.0";
export const FULL_STORY_PROMISE_CHECK_SCHEMA_VERSION = "full-story-promise-check/2.0";
export const FULL_STORY_PROMISE_LIST_SCHEMA_VERSION = "full-story-promise-list/1.0";
export const FULL_STORY_PROMISE_FINDINGS_SCHEMA_VERSION = "full-story-promise-findings/1.0";
/** 两次调用共用一个 stage 名：它们是同一档核对的两步，原文侧车也落在同一个 scope。 */
export const FULL_STORY_PROMISE_CHECK_STAGE = "fullStoryPromiseCheck";

/** 承诺核对新增的路由理由；其余三个（coherence_break / scaffold_copy / blocker_defect）来自评审。 */
// 判定字符串与浏览器共用同一份（`public/story-review-metrics.js`），这里只做转出，
// 让服务端的既有引用方式不变。两边各写一遍必然漂移。
export { PROMISE_UNREALIZED_REASON };

export const FULL_STORY_PRECHECK_ROUTES = Object.freeze({
  REVISE: "revise",
  EXPAND: "expand"
});

/**
 * 第一次调用（盲写承诺清单）的输入投影。**故意不含 storyOutline。**
 *
 * 只给标题、钩子、叙事模式与主角名：主角名是为了读懂钩子里的人称，叙事模式是为了
 * 知道这是生活片段还是剧情型。其余一律不给——logline、newTask 是作者对结果的自述，
 * 动作链更是这一步要防的东西。
 */
export function buildFullStoryPromiseListProjection(candidate) {
  return {
    id: String(candidate?.id || ""),
    title: String(candidate?.title || ""),
    oneLineHook: String(candidate?.oneLineHook || ""),
    narrativeMode: String(candidate?.narrativeMode || ""),
    protagonist: String(candidate?.characterSetup?.protagonist || "")
  };
}

/** 第二次调用（逐条定位）的输入投影：冻结的承诺清单 + 动作链。 */
export function buildFullStoryPromiseFindingsProjection(candidate, promiseList) {
  const promises = Array.isArray(promiseList?.promises) ? promiseList.promises : [];
  return {
    id: String(candidate?.id || ""),
    promises: promises.map((entry, index) => ({
      promiseIndex: index,
      source: String(entry?.source || ""),
      quote: String(entry?.quote || ""),
      promise: String(entry?.promise || ""),
      mustSee: (Array.isArray(entry?.mustSee) ? entry.mustSee : []).map((item) => String(item || ""))
    })),
    storyOutline: (Array.isArray(candidate?.storyOutline) ? candidate.storyOutline : []).map((beat) => ({
      beat: beat?.beat,
      action: String(beat?.action || "")
    }))
  };
}

/** 把盲写的清单与逐条定位结果合成一份报告；verdict 在这里派生，不取模型的值。 */
export function assembleFullStoryPromiseCheck(promiseList, promiseFindings) {
  const promises = Array.isArray(promiseList?.promises) ? promiseList.promises : [];
  const findings = Array.isArray(promiseFindings?.findings) ? promiseFindings.findings : [];
  return {
    schemaVersion: FULL_STORY_PROMISE_CHECK_SCHEMA_VERSION,
    candidateId: String(promiseList?.candidateId || ""),
    promises: promises.map((entry, index) => {
      const own = findings
        .filter((finding) => Number(finding?.promiseIndex) === index)
        .map((finding) => ({
          mustSeeIndex: Number(finding.mustSeeIndex),
          found: finding.found === true,
          beat: Number(finding.beat) || 0,
          evidence: String(finding.evidence || ""),
          why: String(finding.why || "")
        }))
        .sort((left, right) => left.mustSeeIndex - right.mustSeeIndex);
      const kind = String(entry?.kind || "promise");
      const mustSee = (Array.isArray(entry?.mustSee) ? entry.mustSee : []).map((item) => String(item || ""));
      return {
        source: String(entry?.source || ""),
        quote: String(entry?.quote || ""),
        kind,
        promise: String(entry?.promise || ""),
        mustSee,
        findings: own,
        verdict: derivePromiseVerdict(kind, mustSee, own)
      };
    })
  };
}

/** 判为没兑现的承诺，原样取出供路由与修订使用。 */
export function promiseCheckGaps(promiseCheck) {
  const promises = Array.isArray(promiseCheck?.promises) ? promiseCheck.promises : [];
  return promises.filter((entry) => FULL_STORY_PROMISE_UNREALIZED_VERDICTS.includes(String(entry?.verdict || "")));
}

/**
 * 路由完全确定性：评审派生出的降级理由，并上「有没有没兑现的承诺」。
 *
 * **不看分数、不看 tier、不看模型整体偏好。** 分数能可靠分出最好与最差，
 * 分不出中段（§2.12b ⑩K），拿它决定要不要改一个用户已经选中的候选没有依据；
 * 降级理由则每一条都锚到具体拍号或具体环节，修订拿得到可执行的信号。
 */
export function deriveFullStoryPrecheckRoute({ reviewCheck = null, promiseCheck = null } = {}) {
  const reasons = [];
  for (const reason of Array.isArray(reviewCheck?.verdictOverrideReasons) ? reviewCheck.verdictOverrideReasons : []) {
    const value = String(reason || "");
    if (value && !reasons.includes(value)) reasons.push(value);
  }
  if (promiseCheckGaps(promiseCheck).length) reasons.push(PROMISE_UNREALIZED_REASON);
  return {
    route: reasons.length ? FULL_STORY_PRECHECK_ROUTES.REVISE : FULL_STORY_PRECHECK_ROUTES.EXPAND,
    reasons
  };
}

/**
 * 只含目标候选的一批命题，交给现有评审原样使用。
 * 评审的覆盖率核验按这份单候选批次逐位核对，报告也就只有这一条。
 */
export function singleCandidateThemeVariants(themeVariants, candidateId) {
  const variants = Array.isArray(themeVariants?.variants) ? themeVariants.variants : [];
  const candidate = variants.find((entry) => String(entry?.id || "") === String(candidateId || ""));
  if (!candidate) throw new InputError(`themeVariants 里没有命题 ${String(candidateId || "（空）")}`);
  return { ...themeVariants, variants: [candidate] };
}
