// 剧情体检的可比对数字：**全部从评审逐条判定里数出来**，不问模型要总分。
//
// 为什么不要总分：实测 13 份的模型综合分挤在 7.8–8.3、中位 8.2，ChatGPT 给参考片
// 《帮奶奶捐旧衣服》也才 8.4。那是模型对整份剧情的一次主观压缩，分辨率低、会随
// 措辞和心情漂，此刻在上面画任何一条线都是拍脑袋。
//
// 而下面这几个数是纯计数：同一份评审重算多少次都一样，跨故事直接可比，
// 也不需要任何评分刻度。它们才是能积累成基线的东西——攒够样本之后，
// 「典型几处未兑现」由真实分布回答，不由谁拍板。
//
// 与 full-story-shape-metrics.js 同规格：只统计、不裁决、不阻断、不改任何 Artifact。

const UNMET = new Set(["not_depicted", "partially_depicted"]);

/**
 * 换皮线：`sourceScaffoldOverlap.score` 到这个数就不许再判 pass。
 *
 * **判定只有一份**——`src/validation.js` 的确定性闸门与下面数出来的
 * `scaffoldCopies` 都从这里取值。两边各写一个 70，迟早会漂成
 * 「页面说没越线、服务端说越线了」。同规格的先例是 public/all-reference-limits.js
 * 与 public/story-duration.js（窗口比例只有一份，两处提示词共用）。
 *
 * 数字本身来自 2026-09-11 单次盲测的分布：已知换皮的四个候选全部 95，
 * 正常的四个落在 10–50。**不是实证过的最优值**，真实回放攒够了再调，
 * 且不得为了让某个候选通过而下调。
 */
export const SOURCE_SCAFFOLD_COPY_SCORE = 70;

/**
 * 选题终审的十一个维度与权重（2026-09-12）。**合计恰好 1.00。**
 *
 * 这张表是提示词、校验器与浏览器三方的唯一来源：提示词照它告诉模型每维占多少，
 * 校验器照它算 overallScore，浏览器照它排列展示。任何一处再写一份数字，
 * 就会出现「页面显示的权重与实际算分不一样」。
 *
 * **它没有被实证过。** 仓库在另外两个阶段测过同型的加权总分：剧情体检 13 份的
 * 综合分全部挤在 7.8–8.3（中位 8.2，参考片本身 8.4），分镜终审两个模型评同一份
 * Plan 总分只差 0.06 而单维能差 ±1.0——**那两处因此写死了「不打总分、不设门槛」**。
 * 本阶段是明确决定要试这条路，所以先按写定的权重落地、再用候选阶段自己的数据判断；
 * 在拿到 10–20 个批次的真实分布之前，**不要凭感觉调这些数字**。
 */
export const CANDIDATE_REVIEW_DIMENSION_WEIGHTS = Object.freeze({
  openingHook: 0.10,
  causalLogic: 0.10,
  protagonistAgency: 0.08,
  characterSpecificity: 0.12,
  storySpecificity: 0.10,
  originality: 0.10,
  progression: 0.10,
  emotionalPayoff: 0.10,
  visualMemorability: 0.10,
  productionFeasibility: 0.05,
  dialogueAndNaturalness: 0.05
});

/** 维度的中文名，浏览器展示用。键必须与权重表逐字一致（有测试锁住）。 */
export const CANDIDATE_REVIEW_DIMENSION_LABELS = Object.freeze({
  openingHook: "开场钩子",
  causalLogic: "因果逻辑",
  protagonistAgency: "主角施动性",
  characterSpecificity: "角色专属性",
  storySpecificity: "故事专属性",
  originality: "原创性",
  progression: "推进与节奏",
  emotionalPayoff: "情绪兑现",
  visualMemorability: "视觉记忆点",
  productionFeasibility: "制作可行性",
  dialogueAndNaturalness: "对白与自然度"
});

/**
 * 五档选题等级。`min` 是该档的下界（含），按 overallScore 从高到低匹配第一条。
 *
 * **tier 只回答「它本身有多好」，不回答「放不放行」**——后者是 effectiveVerdict，
 * 由 tier 与硬闸门取最严得出。两件事挤进一个字段会自相矛盾：一个 9.2 分但
 * 因果链断裂的候选，按分数属最高档、按闸门不许晋级，这两件事同时成立。
 */
export const CANDIDATE_REVIEW_TIERS = Object.freeze([
  { id: "ready", min: 9.0, label: "可直接展开", verdict: "pass" },
  { id: "minor_fix", min: 8.5, label: "小修后展开", verdict: "pass" },
  { id: "needs_revision", min: 8.0, label: "需定向修订", verdict: "revise" },
  { id: "major_rework", min: 7.0, label: "需较大修正", verdict: "revise" },
  { id: "reject_or_regenerate", min: 0, label: "建议淘汰或重做", verdict: "drop" }
]);

/**
 * 十一个维度之外的缺陷类型（2026-09-12 首次真实回放后补的两类）。
 *
 * `ownership_or_authority` 与 `setting_assumption` **不是新的评分维度**，
 * 只是缺陷分类：它们描述的问题各自归到 causalLogic 与 characterSpecificity 的分数里，
 * 但值得单独有个名字，否则以后没法跨批次统计「这类问题出现过几次」。
 *
 * 起因是首次真实回放漏掉的两条（详见 docs/实验数据-2026-09-12/选题终审-首次真实回放-报告.md）：
 * 图书馆的旧绘本被主角送给奶奶——那不是物理错误，是**没有人问过她有没有这本书的处置权**；
 * 以及固定搭档的猫为什么住在院子的纸箱里——上游从没建立过这条设定。
 *
 * schema 的 defectType 枚举必须等于「十一个维度 id + 这四个」，由测试锁住
 * （JSON Schema 没法 import，两边只能靠测试对齐）。
 */
export const CANDIDATE_REVIEW_SPECIAL_DEFECT_TYPES = Object.freeze([
  "ownership_or_authority",
  "setting_assumption",
  "brief_overconstraint",
  "template_convergence",
  "none"
]);

/** 特殊缺陷类型的中文标签。十一个维度的标签复用 DIMENSION_LABELS，不另写一份。 */
export const CANDIDATE_REVIEW_SPECIAL_DEFECT_LABELS = Object.freeze({
  ownership_or_authority: "所有权或处置权",
  setting_assumption: "偷偷引入的背景设定",
  brief_overconstraint: "简报约束过死",
  template_convergence: "与同批其它候选同一套机制",
  none: "无"
});

/**
 * 物理机制的可信度三档。
 *
 * **刻意不是「可行 / 不可行」二选一。** 首次真实回放里，模型把「下雨天用胶带把落叶
 * 贴在纸箱上做防水」直接判成「物理上可行，因果逻辑成立」并给了 8 分——
 * 而正在下雨时落叶与纸箱都是湿的、普通胶带未必粘得牢。
 *
 * 逼它改判「不可行」是另一种过度自信。真正缺的那一档是
 * **「在某些条件下成立，而候选没有交代那些条件」**——
 * 于是它必须把依赖的条件写出来，人一眼就能看出这条链是不是建立在空气上。
 */
export const CANDIDATE_REVIEW_CONFIDENCE_LABELS = Object.freeze({
  established: "明确成立",
  conditional: "依赖未说明的条件",
  unlikely: "多半不成立"
});

/**
 * 剧情**依不依赖**这个机制真的成立（2026-09-12 第三轮回放后补）。
 *
 * 它与 `confidence` 是**两个正交的轴**，分开之后才不会把童真想象误杀：
 * `confidence` 回答「现实里这事成不成立」，这一项回答「故事需不需要它真的成立」。
 *
 * 起因是《罐装阳光》：把阳光装进玻璃罐在物理上当然是 `unlikely`，
 * 但剧情从没要求阳光真被封住——那是角色自己的想象。第二次回放里它的
 * `productionFeasibility` 9→7、`causalLogic` 9→8，说明模型很可能把
 * 「不是现实物理」本身当成了质量问题，而这不合理。
 *
 * - `required` —— 剧情结果必须依赖它真的工作（湿胶带必须真的粘住树叶才挡得住雨）。
 *   物理不成立就该扣分。
 * - `optional` —— 成立更好，不成立剧情也走得通。
 * - `make_believe` —— 角色自己相信或假装它成立，**真实剧情并不依赖它**。
 *   **不得因为现实里做不到就扣制作可行性或因果逻辑**，只需要提醒镜头别把它拍成实的
 *   （例如玻璃罐内部真的凭空发光）。
 */
export const CANDIDATE_REVIEW_LITERAL_DEPENDENCY_LABELS = Object.freeze({
  required: "剧情必须依赖它成立",
  optional: "成立更好，不成立也走得通",
  make_believe: "角色的想象，剧情不依赖它成真"
});

/** 降级理由的中文标签。取值由校验器派生，不是模型自报。 */
export const CANDIDATE_REVIEW_OVERRIDE_LABELS = Object.freeze({
  coherence_break: "动作链存在因果断裂",
  scaffold_copy: "与原片事件链高度重合，疑似换皮",
  blocker_defect: "终审判定存在 BLOCKER 级硬伤"
});

/**
 * 展开前体检多出来的那一条路由理由：标题或钩子许诺的东西，动作链没演出来。
 * 它与上面三条并列进入路由，**判定字符串只有这一份**——服务端
 * `src/full-story-precheck.js` 直接引用它，浏览器按同一份表出中文，
 * 两边各写一遍必然漂移（§2.14 `revisionShotLoad` 记过同一个教训）。
 */
export const PROMISE_UNREALIZED_REASON = "promise_unrealized";

/** 体检路由理由的中文标签 = 评审那三条 ∪ 承诺那一条。 */
export const FULL_STORY_PRECHECK_REASON_LABELS = Object.freeze({
  ...CANDIDATE_REVIEW_OVERRIDE_LABELS,
  [PROMISE_UNREALIZED_REASON]: "标题或钩子许诺的东西，动作链没演出来"
});

/**
 * 剧情体检 2.0：承诺来源只能是候选字段或用户的固定角色设定，**不能是剧情自己**。
 *
 * 实测依据（2026-09-18 第三轮）：模型写出过 `source: "characterSetup / 完整剧情 characterBible"`
 * ——拿剧情自己当承诺来源，就成了自己声明、自己证明。第四轮靠提示词把它压到 0/48，
 * 但**结构上消除比靠措辞可靠**，所以这里限成枚举。
 *
 * 这份常量是唯一来源：提示词、`src/validation.js` 的校验器、schema 的 enum 与浏览器共用它。
 * `test/story-quality-review.test.js` 断言 schema 的 enum 与它逐项相等。
 */
export const PROMISE_SOURCE_FIELDS = Object.freeze([
  "title", "oneLineHook", "logline", "newTask", "environmentPressure",
  "keyChoice", "climax", "emotionalPayoff", "keyDialogueDirections",
  "characterSetup", "novelty", "visualPotential", "storyOutline", "fixedCharacter"
]);

/** 承诺逐条判定的四档。判成「没守住」的是 MISSING/CONTRADICTED，比 WEAKENED 重。 */
export const PROMISE_CHECK_STATUSES = Object.freeze([
  "PRESERVED", "WEAKENED", "MISSING", "CONTRADICTED"
]);

export const PROMISE_CHECK_STATUS_LABELS = Object.freeze({
  PRESERVED: "守住了",
  WEAKENED: "被削弱",
  MISSING: "没有出现",
  CONTRADICTED: "做了相反的事"
});

/**
 * 编辑诊断的九类问题。九个都来自实际观察到的失败形状，不是凭空分类。
 *
 * **不得按 type 做统计或做闸门**：实测同一个缺陷一次被归 `setup_or_provenance`、
 * 一次被归 `physical_or_world_logic`（2026-09-18 第三轮 vs 第四轮，提示词逐字未变）。
 * 它只用于分组展示。
 */
export const STORY_QUALITY_ISSUE_TYPES = Object.freeze([
  "causal_logic", "goal_method_conflict", "setup_or_provenance",
  "missing_reference_state", "progression_or_state_delta", "physical_or_world_logic",
  "character_contract", "pacing_and_action_density", "ending_naturalness"
]);

export const STORY_QUALITY_ISSUE_TYPE_LABELS = Object.freeze({
  causal_logic: "因果不成立",
  goal_method_conflict: "手段与目的打架",
  setup_or_provenance: "来由没交代",
  missing_reference_state: "缺前置参照",
  progression_or_state_delta: "没有推进",
  physical_or_world_logic: "物理或世界逻辑",
  character_contract: "违反角色设定",
  pacing_and_action_density: "动作密度过载",
  ending_naturalness: "结尾不自然"
});

/** 三个决定的严格程度，取最严时用。数字只用于比较，不对外展示。 */
const VERDICT_SEVERITY = Object.freeze({ pass: 0, revise: 1, drop: 2 });

/**
 * 从 11 维分数算加权总分。**纯算术**：缺维度、分数非法都由校验器先拦，
 * 这里只负责算，不做任何裁决。返回保留两位小数。
 */
export function candidateOverallScore(dimensions) {
  const byId = new Map(list(dimensions).map((entry) => [String(entry.id || ""), Number(entry.score)]));
  let total = 0;
  for (const [id, weight] of Object.entries(CANDIDATE_REVIEW_DIMENSION_WEIGHTS)) {
    const score = byId.get(id);
    if (!Number.isFinite(score)) return null;
    total += score * weight;
  }
  return Math.round(total * 100) / 100;
}

/** overallScore → 五档之一。分数非法时返回最低档，不猜。 */
export function candidateTier(overallScore) {
  const score = Number(overallScore);
  if (!Number.isFinite(score)) return CANDIDATE_REVIEW_TIERS[CANDIDATE_REVIEW_TIERS.length - 1];
  return CANDIDATE_REVIEW_TIERS.find((tier) => score >= tier.min)
    || CANDIDATE_REVIEW_TIERS[CANDIDATE_REVIEW_TIERS.length - 1];
}

/**
 * 最终放行决定：在「按分数该给的」与「硬闸门要求的」之间取更严的那个。
 *
 * **禁止反过来用降低分数或降低 tier 来实现降级**——那会把「这个故事其实很好，
 * 但现在有一处不能带进 FullStory 的问题」压成「这个故事不好」，两件事从此分不开。
 */
export function candidateEffectiveVerdict(scoreBasedVerdict, overrideReasons = []) {
  const base = VERDICT_SEVERITY[scoreBasedVerdict] === undefined ? "drop" : scoreBasedVerdict;
  if (!Array.isArray(overrideReasons) || !overrideReasons.length) return base;
  // 任何一条硬闸门命中，至少降到 revise；已经是 drop 的保持 drop。
  return VERDICT_SEVERITY[base] >= VERDICT_SEVERITY.revise ? base : "revise";
}

function list(value) {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === "object") : [];
}

/**
 * 剧情体检 2.0 的可比对数字。分母从「声明条数」换成「候选承诺条数」——
 * 1.0 数的是场次自报的 dramaticFunction，而那被实测为重言式；
 * 2.0 数的是候选这个**外部参照**有几条没守住。
 */
export function storyReviewMetrics(review) {
  if (!review || typeof review !== "object") return null;

  const checks = list(review.promisePreservation?.checks);
  const issues = list(review.issues);
  const countStatus = (status) => checks.filter((check) => check.status === status).length;
  const severity = (level) => issues.filter((issue) => issue.severity === level).length;
  const broken = countStatus("MISSING") + countStatus("CONTRADICTED");

  return {
    promiseStatus: String(review.promisePreservation?.status || ""),
    promisesChecked: checks.length,
    preserved: countStatus("PRESERVED"),
    weakened: countStatus("WEAKENED"),
    missing: countStatus("MISSING"),
    contradicted: countStatus("CONTRADICTED"),
    // 「承诺没守住」合计：MISSING 与 CONTRADICTED 一起数，WEAKENED 单列——
    // 前者是丢了，后者是还在但变弱，两件事不该混进同一个分子。
    promisesBroken: broken,
    blocker: severity("BLOCKER"),
    major: severity("MAJOR"),
    minor: severity("MINOR"),
    issueCount: issues.length
  };
}

/** 一行可比对摘要，给面板顶部用。不含任何评分刻度。 */
export function storyReviewHeadline(review) {
  const m = storyReviewMetrics(review);
  if (!m) return "";
  const parts = [];
  if (m.promisesChecked) {
    const lost = [];
    if (m.promisesBroken) lost.push(`${m.promisesBroken} 条没守住`);
    if (m.weakened) lost.push(`${m.weakened} 条被削弱`);
    parts.push(lost.length
      ? `候选承诺 ${m.promisesChecked} 条：${lost.join(" · ")}`
      : `候选承诺 ${m.promisesChecked} 条全部守住`);
  }
  const issues = [];
  if (m.blocker) issues.push(`${m.blocker} 严重`);
  if (m.major) issues.push(`${m.major} 建议`);
  if (m.minor) issues.push(`${m.minor} 小问题`);
  parts.push(issues.length ? `硬伤 ${issues.join(" · ")}` : "未发现硬伤");
  return parts.join("　|　");
}

/**
 * 候选对照评审的可比对数字，与上面同规格：**全部从逐条判定里数出来，不问模型要总分。**
 *
 * 理由与剧情体检完全一样，不再重复论证：总分是模型对整批候选的一次主观压缩，
 * 分辨率低、随措辞漂；而「几条机制没迁移过来」「几个候选建议淘汰」是纯计数，
 * 同一份报告重算多少次都一样，跨批次直接可比。
 *
 * 只统计、不裁决、不阻断、不改任何 Artifact。
 */
export function candidateReviewMetrics(review) {
  if (!review || typeof review !== "object") return null;
  const checks = list(review.candidateChecks);
  const mechanisms = checks.flatMap((check) => list(check.mechanismChecks));
  // 因果自洽问题的条数与上面同规格，也是纯计数。旧报告没有这个键，
  // list() 给空数组，于是旧报告数出来恒为 0——不是「没查出问题」，是那一档还不存在。
  const coherence = checks.flatMap((check) => list(check.coherenceChecks));
  // 2026-09-12 起候选级 verdict 是**派生**的 effectiveVerdict：模型不再自报。
  // 旧报告只有 verdict，回退读它——数出来的仍是「这一批有几个可展开」。
  const verdictCount = (value) => checks
    .filter((check) => (check.effectiveVerdict || check.verdict) === value).length;
  // 因硬闸门被降级的候选数：它与「分数低」是两件事——一个 9.2 分但因果链
  // 断裂的候选会出现在这里，而它的 tier 仍然是最高档。
  const overridden = checks.filter((check) => (
    Array.isArray(check.verdictOverrideReasons) && check.verdictOverrideReasons.length
  )).length;
  const scored = checks.filter((check) => Number.isFinite(Number(check.overallScore)));
  // 骨架重合分是模型给的一个整数，这里只**数有几个越线**，不搬用它的绝对值排序：
  // 盲测只验证过它能把差距极大的两组分开（8/8），没验证过它能比较两个都不换皮的候选。
  // scored 是有这一档的候选数；旧报告一个都没有，所以摘要里整段不显示。
  const scaffold = checks
    .map((check) => check.sourceScaffoldOverlap?.score)
    .filter((score) => Number.isInteger(score));
  return {
    candidates: checks.length,
    mechanismsChecked: mechanisms.length,
    mechanismsUnmet: mechanisms.filter((entry) => UNMET.has(entry.verdict)).length,
    notDepicted: mechanisms.filter((entry) => entry.verdict === "not_depicted").length,
    coherenceBreaks: coherence.length,
    candidatesWithCoherenceBreak: checks.filter((check) => list(check.coherenceChecks).length).length,
    scaffoldScored: scaffold.length,
    scaffoldCopies: scaffold.filter((score) => score >= SOURCE_SCAFFOLD_COPY_SCORE).length,
    // 评分这一档同样是「有就数、没有就整段不显示」：旧报告没有 overallScore，
    // scoredCandidates 为 0，摘要里不出现分数段——显示一个 0 分会被读成体检结论。
    scoredCandidates: scored.length,
    topScore: scored.length
      ? Math.max(...scored.map((check) => Number(check.overallScore)))
      : null,
    verdictOverridden: overridden,
    pass: verdictCount("pass"),
    revise: verdictCount("revise"),
    drop: verdictCount("drop")
  };
}

/** 一行可比对摘要，给候选评审面板顶部用。不含任何评分刻度。 */
export function candidateReviewHeadline(review) {
  const m = candidateReviewMetrics(review);
  if (!m) return "";
  const parts = [];
  if (m.mechanismsChecked) parts.push(`机制未迁移 ${m.mechanismsUnmet}/${m.mechanismsChecked}`);
  if (m.coherenceBreaks) parts.push(`因果断裂 ${m.coherenceBreaks} 处（${m.candidatesWithCoherenceBreak} 个候选）`);
  // 旧报告没有这一档，scaffoldScored 是 0，整段不显示——显示一个 0 会被读成
  // 「查过了，没有换皮」，而实际是「这一档还不存在」。与 coherenceBreaks 同规格。
  if (m.scaffoldScored) parts.push(`疑似换皮 ${m.scaffoldCopies}/${m.scaffoldScored}`);
  if (m.scoredCandidates) parts.push(`最高分 ${m.topScore.toFixed(2)}`);
  // 「被降级」单独显示：它说的不是分数低，而是有一处不能带进 Full Story 的问题。
  if (m.verdictOverridden) parts.push(`因硬性问题被降级 ${m.verdictOverridden}`);
  const verdicts = [];
  if (m.pass) verdicts.push(`${m.pass} 可展开`);
  if (m.revise) verdicts.push(`${m.revise} 需修改`);
  if (m.drop) verdicts.push(`${m.drop} 建议淘汰`);
  if (verdicts.length) parts.push(verdicts.join(" · "));
  return parts.join("　|　");
}
