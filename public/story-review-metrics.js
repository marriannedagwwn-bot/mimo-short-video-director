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

function list(value) {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === "object") : [];
}

export function storyReviewMetrics(review) {
  if (!review || typeof review !== "object") return null;

  const sceneChecks = list(review.sceneFunctionChecks);
  const retentionChecks = list(review.retentionChecks);
  const issues = list(review.issues);

  const countUnmet = (checks) => ({
    total: checks.length,
    notDepicted: checks.filter((check) => check.verdict === "not_depicted").length,
    partial: checks.filter((check) => check.verdict === "partially_depicted").length,
    unmet: checks.filter((check) => UNMET.has(check.verdict)).length
  });

  const severity = (level) => issues.filter((issue) => issue.severity === level).length;

  return {
    sceneFunctions: countUnmet(sceneChecks),
    retention: countUnmet(retentionChecks),
    // 「声明未兑现」合计：场次功能与留存设计放在一起数，这是跨故事最直接可比的一个数。
    declarationsUnmet: countUnmet(sceneChecks).unmet + countUnmet(retentionChecks).unmet,
    declarationsChecked: sceneChecks.length + retentionChecks.length,
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
  if (m.declarationsChecked) {
    parts.push(`声明未兑现 ${m.declarationsUnmet}/${m.declarationsChecked}`);
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
  const verdictCount = (value) => checks.filter((check) => check.verdict === value).length;
  return {
    candidates: checks.length,
    mechanismsChecked: mechanisms.length,
    mechanismsUnmet: mechanisms.filter((entry) => UNMET.has(entry.verdict)).length,
    notDepicted: mechanisms.filter((entry) => entry.verdict === "not_depicted").length,
    coherenceBreaks: coherence.length,
    candidatesWithCoherenceBreak: checks.filter((check) => list(check.coherenceChecks).length).length,
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
  const verdicts = [];
  if (m.pass) verdicts.push(`${m.pass} 可展开`);
  if (m.revise) verdicts.push(`${m.revise} 需修改`);
  if (m.drop) verdicts.push(`${m.drop} 建议淘汰`);
  if (verdicts.length) parts.push(verdicts.join(" · "));
  return parts.join("　|　");
}
