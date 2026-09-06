// Animation Plan 终审报告与定向修订的确定性校验。
//
// 这里只裁决**可唯一推导**的事：数量对不对、镜头号存不存在、顺序有没有乱、
// 显式声明的删除数是否覆盖新增数。**不做任何语义判断**——「这条问题报得对不对」
// 「这个改法好不好」都不在这里裁决，那需要人或模型评估。
//
// 存在理由（2026-09-06 实测）：
//   - 评审：模型会漏报。三张强制覆盖表把覆盖率下界提上去了，但「有没有真的逐条填」
//     必须由服务端数，不能靠模型自述。实测出现过报告里引用不存在镜头号的情况。
//   - 修订：模型会用措辞为净增开脱。实测两次——一次自称「只替换不净增」而净增 1 个
//     动作段，一次自称「均并入原有动作链，不增加独立动作段」而实际净增 2 个。
//     根因是「动作段」没有客观定义，只要判定权在模型手里，它就有解释空间。
//     因此改为要求模型显式列出 removedActions[] 与 addedActions[]，服务端只数长度。

export class ReviewContractError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = "ReviewContractError";
    this.code = "REVIEW_CONTRACT_INVALID";
    this.details = details;
  }
}

const DIMENSION_WEIGHTS = Object.freeze({
  realizedOpeningHook: 0.10,
  memorableMoment: 0.10,
  causalClarity: 0.10,
  protagonistAgency: 0.07,
  supportingAgency: 0.05,
  objectArc: 0.06,
  pacingAndDuration: 0.10,
  emotionalPayoff: 0.10,
  visualReadability: 0.09,
  continuity: 0.09,
  physicalFeasibility: 0.07,
  aiStability: 0.07
});

// 路径里的镜头号：既接受 shotPlan[A03] 也接受 0 基下标 shotPlan[2]，
// 因为已签发的旧报告用的是下标。新报告应当只用 shotId（见提示词约束）。
function shotIdsInPath(path, shotIds) {
  const out = [];
  const byId = /shotPlan\[(A\d+)\]/gu;
  for (const m of String(path).matchAll(byId)) out.push(m[1]);
  if (out.length) return out;
  const byIndex = /shotPlan\[(\d+)\]/gu;
  for (const m of String(path).matchAll(byIndex)) {
    const shotId = shotIds[Number(m[1])];
    if (shotId) out.push(shotId);
  }
  return out;
}

function push(details, code, path, reason) {
  details.push({ code, path, reason });
}

// dominantDefect 的允许类型。与提示词第零块的清单逐字一致——
// 两边不同步会让合格报告被误拒，所以清单只有这一份，改动时必须同时改提示词。
const DOMINANT_DEFECT_TYPES = new Set([
  "identity_logic", "causal_logic", "opening_hook", "motivation",
  "emotional_payoff", "continuity", "prop_state", "physical_logic",
  "pacing", "escalation", "character_agency", "visual_readability",
  "ai_execution_risk"
]);

/**
 * 校验终审报告。只裁决可唯一推导的部分。
 *
 * @param {object} report 模型返回的报告
 * @param {object} animationPlan 被评审的 Plan（提供 shotPlan 作为事实基准）
 * @returns {object} 原样返回 report，供链式调用
 */
export function ensureReviewReportContract(report, animationPlan) {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    throw new ReviewContractError("终审报告必须是对象");
  }
  const shotPlan = Array.isArray(animationPlan?.shotPlan) ? animationPlan.shotPlan : [];
  if (!shotPlan.length) throw new ReviewContractError("animationPlan.shotPlan 为空，无法校验报告");
  const shotIds = shotPlan.map((shot) => String(shot?.shotId || ""));
  const known = new Set(shotIds);
  const order = new Map(shotIds.map((id, index) => [id, index]));
  const details = [];

  // 0) dominantDefect 决定修订的优先级，选错类型会导致修错东西。
  //    这里只裁决「类型是不是清单里的一个」——纯字符串匹配。
  //    「选得对不对」是语义判断，不在这里裁决。
  if (report.dominantDefect !== undefined) {
    const defect = report.dominantDefect;
    if (!defect || typeof defect !== "object" || Array.isArray(defect)) {
      push(details, "REVIEW_DOMINANT_DEFECT_INVALID", "/dominantDefect", "dominantDefect 必须是对象");
    } else if (!DOMINANT_DEFECT_TYPES.has(String(defect.type || ""))) {
      push(details, "REVIEW_DOMINANT_DEFECT_TYPE_UNKNOWN", "/dominantDefect/type",
        `「${defect.type}」不在允许的缺陷类型内；允许值：${[...DOMINANT_DEFECT_TYPES].join("、")}`);
    }
  }

  // 1) 逐镜与逐场景必须穷举且同序
  for (const [field, code] of [
    ["shotEvaluations", "REVIEW_SHOT_COVERAGE_MISMATCH"],
    ["sceneCheck", "REVIEW_SCENE_COVERAGE_MISMATCH"]
  ]) {
    const rows = Array.isArray(report[field]) ? report[field] : [];
    if (rows.length !== shotIds.length) {
      push(details, code, `/${field}`, `条数 ${rows.length} 与 shotPlan 的 ${shotIds.length} 不一致`);
      continue;
    }
    rows.forEach((row, index) => {
      const got = String(row?.shotId || "");
      if (got !== shotIds[index]) {
        push(details, code, `/${field}/${index}/shotId`, `应为 ${shotIds[index]}，实际 ${got || "缺失"}`);
      }
    });
  }

  // 2) 所有镜头号引用必须真实存在——防止模型编造镜头
  const collectRefs = [];
  for (const section of ["issues", "upgradePath", "strengths", "dimensions", "otherFindings"]) {
    const rows = Array.isArray(report[section]) ? report[section] : [];
    rows.forEach((row, index) => {
      for (const key of ["evidencePaths", "affectedPaths"]) {
        const paths = Array.isArray(row?.[key]) ? row[key] : [];
        paths.forEach((path, pathIndex) => {
          collectRefs.push({ path: `/${section}/${index}/${key}/${pathIndex}`, value: path });
        });
      }
    });
  }
  for (const ref of collectRefs) {
    const ids = shotIdsInPath(ref.value, shotIds);
    for (const id of ids) {
      if (!known.has(id)) {
        push(details, "REVIEW_UNKNOWN_SHOT_REFERENCE", ref.path, `引用了不存在的镜头 ${id}`);
      }
    }
  }

  // 3) propTracking：两个标志互斥，trace 必须真实且有序
  const props = Array.isArray(report.propTracking) ? report.propTracking : [];
  props.forEach((prop, index) => {
    if (prop?.disappeared === true && prop?.positionUnclear === true) {
      push(details, "REVIEW_PROP_FLAG_CONFLICT", `/propTracking/${index}`,
        "disappeared 与 positionUnclear 不得同时为 true；彻底消失就只标 disappeared");
    }
    const trace = Array.isArray(prop?.trace) ? prop.trace : [];
    let previous = -1;
    trace.forEach((step, stepIndex) => {
      const id = String(step?.shotId || "");
      if (!known.has(id)) {
        push(details, "REVIEW_UNKNOWN_SHOT_REFERENCE", `/propTracking/${index}/trace/${stepIndex}/shotId`,
          `引用了不存在的镜头 ${id || "（空）"}`);
        return;
      }
      const position = order.get(id);
      if (position <= previous) {
        push(details, "REVIEW_PROP_TRACE_OUT_OF_ORDER", `/propTracking/${index}/trace/${stepIndex}`,
          `${id} 未按 shotPlan 顺序排列或重复出现`);
      }
      previous = position;
    });
  });

  // 4) 12 个维度必须齐全、权重正确
  const dims = Array.isArray(report.dimensions) ? report.dimensions : [];
  const expected = Object.keys(DIMENSION_WEIGHTS);
  const seen = new Set();
  dims.forEach((dim, index) => {
    const id = String(dim?.id || "");
    if (!(id in DIMENSION_WEIGHTS)) {
      push(details, "REVIEW_DIMENSION_UNKNOWN", `/dimensions/${index}/id`, `未知维度 ${id || "（空）"}`);
      return;
    }
    if (seen.has(id)) {
      push(details, "REVIEW_DIMENSION_DUPLICATE", `/dimensions/${index}/id`, `维度 ${id} 重复`);
      return;
    }
    seen.add(id);
    const score = Number(dim?.score);
    if (!Number.isFinite(score) || score < 0 || score > 10) {
      push(details, "REVIEW_DIMENSION_SCORE_INVALID", `/dimensions/${index}/score`, `score 必须是 0-10，实际 ${dim?.score}`);
    }
  });
  const missing = expected.filter((id) => !seen.has(id));
  if (missing.length) {
    push(details, "REVIEW_DIMENSION_MISSING", "/dimensions", `缺少维度：${missing.join("、")}`);
  }

  // 5) otherFindings 必须存在（可以为空数组）——它是结构化输出的逃生出口
  if (!Array.isArray(report.otherFindings)) {
    push(details, "REVIEW_OTHER_FINDINGS_MISSING", "/otherFindings",
      "必须是数组（可为空）；它是不属于任何已知类别的问题的唯一出口");
  }

  if (details.length) {
    throw new ReviewContractError(
      `终审报告结构校验失败：${details.map((d) => `${d.path} ${d.reason}`).join("；")}`,
      details
    );
  }
  return report;
}

/**
 * 校验定向修订结果。
 *
 * 核心是净预算：被终审判过 pacing / ai_risk 的镜头，删除的动作数必须不少于新增的。
 * 判定只数模型自己列出的两个数组的长度——「什么算一个动作」由模型声明，
 * 但声明之后就不能再改口。实测模型会在自由文本里辩称新增动作「并入了现有动作链」，
 * 显式数组消除了这个解释空间。
 *
 * @param {object} revision 模型返回的 { revisedShots: [...] }
 * @param {object} animationPlan 被修订的 Plan
 * @param {object} report 上一轮终审报告，用于判定哪些镜头受约束
 */
export function ensureRevisionContract(revision, animationPlan, report) {
  if (!revision || typeof revision !== "object") {
    throw new ReviewContractError("修订结果必须是对象");
  }
  const shotPlan = Array.isArray(animationPlan?.shotPlan) ? animationPlan.shotPlan : [];
  const shotIds = shotPlan.map((shot) => String(shot?.shotId || ""));
  const known = new Set(shotIds);
  const details = [];

  // 受约束镜头：被判过 pacing 或 ai_risk 的
  const constrained = new Set();
  for (const issue of Array.isArray(report?.issues) ? report.issues : []) {
    if (!/pacing|ai_risk/u.test(String(issue?.category || ""))) continue;
    for (const key of ["affectedPaths", "evidencePaths"]) {
      for (const path of Array.isArray(issue?.[key]) ? issue[key] : []) {
        for (const id of shotIdsInPath(path, shotIds)) constrained.add(id);
      }
    }
  }

  // 服务端签发字段：修订结果里出现即拒绝，防止模型改时长或场次归属
  const SEALED = ["shotId", "sourceSceneId", "sceneId", "durationSeconds", "storyPurpose", "emotionalTarget"];
  const WRITABLE = ["videoPrompt", "cameraMotion", "characterAction", "dialogueOrSubtitle",
    "soundDesign", "continuityNotes", "acceptanceCriteria"];

  const rows = Array.isArray(revision.revisedShots) ? revision.revisedShots : [];
  if (!rows.length) throw new ReviewContractError("修订结果 revisedShots 为空");

  const seen = new Set();
  rows.forEach((row, index) => {
    const id = String(row?.shotId || "");
    if (!known.has(id)) {
      push(details, "REVISION_UNKNOWN_SHOT", `/revisedShots/${index}/shotId`, `不存在的镜头 ${id || "（空）"}`);
      return;
    }
    if (seen.has(id)) {
      push(details, "REVISION_DUPLICATE_SHOT", `/revisedShots/${index}/shotId`, `镜头 ${id} 重复出现`);
      return;
    }
    seen.add(id);

    for (const field of SEALED) {
      if (field === "shotId") continue;
      if (field in row) {
        push(details, "REVISION_SEALED_FIELD_PRESENT", `/revisedShots/${index}/${field}`,
          `${field} 由服务端签发，修订结果不得包含它`);
      }
    }
    const original = shotPlan.find((shot) => String(shot?.shotId || "") === id);
    for (const field of WRITABLE) {
      // 原镜头就没有台词时，修订结果不写 dialogueOrSubtitle 是合理的——
      // 要求它反而会逼模型给无声镜头编一句台词出来。
      if (field === "dialogueOrSubtitle") {
        const had = String(original?.dialogueOrSubtitle || "").trim();
        if (!had || had === "无") continue;
      }
      const value = row?.[field];
      const empty = value === undefined || value === null || value === ""
        || (Array.isArray(value) && !value.length);
      if (empty) {
        push(details, "REVISION_FIELD_MISSING", `/revisedShots/${index}/${field}`,
          `${field} 缺失；改 videoPrompt 就必须同步改其余字段，否则方案内部会自相矛盾`);
      }
    }

    // 净预算：只数长度，不解释「什么算一个动作」
    const removed = Array.isArray(row?.removedActions) ? row.removedActions.filter((x) => String(x || "").trim()) : null;
    const added = Array.isArray(row?.addedActions) ? row.addedActions.filter((x) => String(x || "").trim()) : null;
    if (removed === null || added === null) {
      push(details, "REVISION_ACTION_LEDGER_MISSING", `/revisedShots/${index}`,
        "必须显式列出 removedActions[] 与 addedActions[]（没有改动时写空数组）");
      return;
    }
    if (constrained.has(id) && added.length > removed.length) {
      push(details, "REVISION_NET_ACTION_BUDGET_EXCEEDED", `/revisedShots/${index}`,
        `${id} 被终审判为节奏或稳定性有风险，新增 ${added.length} 个动作但只删除 ${removed.length} 个；`
        + "受约束镜头必须删除数不少于新增数");
    }
  });

  if (details.length) {
    throw new ReviewContractError(
      `定向修订校验失败：${details.map((d) => `${d.path} ${d.reason}`).join("；")}`,
      details
    );
  }
  return revision;
}

export const REVIEW_DIMENSION_WEIGHTS = DIMENSION_WEIGHTS;
