// 命题定向修订的契约与合并。
//
// 与分镜定向修订（`animation-plan-review-validation.js` 的 `ensureRevisionContract`）
// 逐条同规格，**刻意不建 schema 文件**：那边也是纯 JS 判定。理由是这里要区分
// 「写了一个不该写的字段」与「写了一个不认识的字段」，而 schema 的 additionalProperties
// 只会给出「附加属性」这种看不出原因的消息；两套判定并存还会互相漂移。
//
// 它只负责三件事：核对模型有没有越权、把授权的改动合并回整批、证明其余部分逐字节不变。
// **判定全是形状与字符串比较，零语义**——「这条修订改得对不对」需要语义判断，没有兜底。
import { ReviewContractError } from "./animation-plan-review-validation.js";

/**
 * 可写字段。依据是 2026-09-10 的实测：一轮评审报出的三条因果断裂里，**两条的根在任务设定**
 * （「寻找主人的目的被当场抵消」「任务目标是修好秋千而非做新秋千」），只改动作链改不掉。
 * 所以 `newTask` / `environmentPressure` 必须可写，`logline` 跟着走。
 */
export const CANDIDATE_REVISION_WRITABLE = Object.freeze([
  "newTask", "environmentPressure", "logline", "keyDialogueDirections"
]);

/** 每拍可写的三个。`beat` 只作定位用，不是可写内容。 */
export const CANDIDATE_REVISION_BEAT_WRITABLE = Object.freeze([
  "action", "emotion", "estimatedSeconds"
]);

/**
 * 服务端派生或签发，出现即拒绝。
 *
 * - `keyChoice` / `climax` / `emotionalPayoff` 由 `deriveStoryCandidateProjections`
 *   从 `storyOutline[].action` 与两个拍号确定性派生，模型回显不构成新事实。
 * - `transformationProof` 的 `source` 由候选阶段的冻结证据目录签发，模型从来只写
 *   `replacement`；修订整个字段逐字保留。
 */
const CANDIDATE_REVISION_SEALED = Object.freeze([
  "keyChoice", "climax", "emotionalPayoff", "transformationProof"
]);

/**
 * 冻结字段：不是「服务端签发」，而是「改了就不是同一个命题了」或「改了会动现有闸门」。
 *
 * `dramaticFunction` 属于后者——`storyCandidateStructureSignature` 用全部拍的它拼结构签名，
 * `validateVariantStructuralDivergence` 靠那条签名两两比对分化。让模型改它等于让它动闸门的输入。
 * `keyChoiceBeat` / `climaxBeat` 同理：拍号不可写，所以拍集合也必须保持不变。
 */
const CANDIDATE_REVISION_FROZEN = Object.freeze([
  "id", "title", "oneLineHook", "verticalFit", "narrativeMode", "characterSetup",
  "keyChoiceBeat", "climaxBeat", "storyOutline",
  "novelty", "visualPotential", "experienceFidelity", "originalityRiskCheck", "highValueBeatMapping"
]);

const BEAT_FROZEN = Object.freeze(["phase", "dramaticFunction"]);

function push(details, code, path, reason) {
  details.push({ code, path, reason });
}

/** 与 `normalizeStoryReviewEcho` 同口径的比较用归一化：只吃空白，不改内容。 */
function sameText(a, b) {
  return String(a ?? "").replace(/\s+/gu, "") === String(b ?? "").replace(/\s+/gu, "");
}

function sameList(a, b) {
  const left = Array.isArray(a) ? a : [];
  const right = Array.isArray(b) ? b : [];
  if (left.length !== right.length) return false;
  return left.every((entry, index) => sameText(entry, right[index]));
}

export function findCandidate(themeVariants, candidateId) {
  const list = Array.isArray(themeVariants?.variants) ? themeVariants.variants : [];
  return list.find((candidate) => String(candidate?.id || "") === String(candidateId || "")) || null;
}

/**
 * 核对模型返回的修订有没有越权，以及它到底改没改东西。
 *
 * @param {object} revision 模型返回的 { candidateId, revisedBeats: [...], changeSummary, ... }
 * @param {object} themeVariants 当前整批命题
 * @param {string} targetCandidateId 本次授权修订的那一个
 */
export function ensureStoryCandidateRevisionContract(revision, themeVariants, targetCandidateId) {
  if (!revision || typeof revision !== "object" || Array.isArray(revision)) {
    throw new ReviewContractError("修订结果必须是对象");
  }
  const target = String(targetCandidateId || "");
  const original = findCandidate(themeVariants, target);
  if (!original) throw new ReviewContractError(`themeVariants 里没有命题 ${target || "（空）"}`);

  const details = [];
  const outline = Array.isArray(original.storyOutline) ? original.storyOutline : [];
  const beatByNumber = new Map(outline.map((beat, index) => [Number(beat?.beat), { beat, index }]));

  // 越权写入未经授权的命题不是「顺手多改了一点」。一次只修一个，其余逐字节不变。
  if (String(revision.candidateId || "") !== target) {
    push(details, "CANDIDATE_REVISION_OUT_OF_SCOPE", "/candidateId",
      `本次只授权修订 ${target}，收到的是 ${String(revision.candidateId || "（空）")}`);
  }

  for (const field of CANDIDATE_REVISION_SEALED) {
    if (field in revision) {
      push(details, "CANDIDATE_REVISION_SEALED_FIELD_PRESENT", `/${field}`,
        `${field} 由服务端派生或签发，修订结果不得包含它`);
    }
  }
  for (const field of CANDIDATE_REVISION_FROZEN) {
    if (field in revision) {
      push(details, "CANDIDATE_REVISION_FROZEN_FIELD_PRESENT", `/${field}`,
        `${field} 在修订中冻结；要改动作链请写进 revisedBeats`);
    }
  }

  if (!String(revision.changeSummary || "").trim()) {
    push(details, "CANDIDATE_REVISION_SUMMARY_MISSING", "/changeSummary",
      "必须写明改了什么、为什么这样能解掉被点名的那条因果断裂");
  }

  const rows = Array.isArray(revision.revisedBeats) ? revision.revisedBeats : null;
  if (rows === null) {
    push(details, "CANDIDATE_REVISION_BEATS_INVALID", "/revisedBeats",
      "revisedBeats 必须是数组（一拍都不改时写空数组）");
  }

  // 只覆盖、不增删：拍集合因此由构造保持不变，`keyChoiceBeat` / `climaxBeat` 永远指得对。
  const seen = new Set();
  (rows || []).forEach((row, index) => {
    const path = `/revisedBeats/${index}`;
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      push(details, "CANDIDATE_REVISION_BEATS_INVALID", path, "每一项必须是对象");
      return;
    }
    const beatNumber = Number(row.beat);
    if (!beatByNumber.has(beatNumber)) {
      push(details, "CANDIDATE_REVISION_UNKNOWN_BEAT", `${path}/beat`,
        `命题 ${target} 没有第 ${row.beat} 拍；它只有 ${outline.length} 拍`);
      return;
    }
    if (seen.has(beatNumber)) {
      push(details, "CANDIDATE_REVISION_DUPLICATE_BEAT", `${path}/beat`, `第 ${beatNumber} 拍重复出现`);
      return;
    }
    seen.add(beatNumber);
    for (const field of BEAT_FROZEN) {
      if (field in row) {
        push(details, "CANDIDATE_REVISION_FROZEN_FIELD_PRESENT", `${path}/${field}`,
          `${field} 在修订中冻结`);
      }
    }
    const wrote = CANDIDATE_REVISION_BEAT_WRITABLE.some((field) => field in row);
    if (!wrote) {
      push(details, "CANDIDATE_REVISION_BEAT_EMPTY", path,
        `第 ${beatNumber} 拍列进来了却一个可写字段都没写；不改的拍不要列`);
    }
  });

  if (details.length) {
    throw new ReviewContractError(
      `命题定向修订校验失败：${details.map((d) => `${d.path} ${d.reason}`).join("；")}`,
      details
    );
  }

  // 「有没有实际改动」放在越权检查全部通过之后单独判：模型可以合规地交回一份
  // 与原文逐字相同的修订，那不是格式错误，是没干活。
  if (!candidateRevisionChanged(original, revision)) {
    throw new ReviewContractError(
      `命题定向修订校验失败：/ 修订结果与原命题逐字相同，等于没有改动`,
      [{
        code: "CANDIDATE_REVISION_NO_CHANGE",
        path: "/",
        reason: "修订结果与原命题逐字相同；被点名的那条因果断裂必须有对应的改动"
      }]
    );
  }
  return revision;
}

/** 至少一个可写字段的值真的变了。纯字符串比较。 */
export function candidateRevisionChanged(original, revision) {
  for (const field of CANDIDATE_REVISION_WRITABLE) {
    if (!(field in revision)) continue;
    const next = revision[field];
    if (field === "keyDialogueDirections") {
      if (!sameList(next, original[field])) return true;
      continue;
    }
    if (!String(next ?? "").trim()) continue;
    if (!sameText(next, original[field])) return true;
  }
  const outline = Array.isArray(original.storyOutline) ? original.storyOutline : [];
  const byNumber = new Map(outline.map((beat) => [Number(beat?.beat), beat]));
  for (const row of Array.isArray(revision.revisedBeats) ? revision.revisedBeats : []) {
    const before = byNumber.get(Number(row?.beat));
    if (!before) continue;
    if ("action" in row && !sameText(row.action, before.action)) return true;
    if ("emotion" in row && !sameText(row.emotion, before.emotion)) return true;
    if ("estimatedSeconds" in row && Number(row.estimatedSeconds) !== Number(before.estimatedSeconds)) return true;
  }
  return false;
}

/**
 * 服务端独占合并：在克隆上逐字段覆盖，模型碰不到任何别的东西。
 *
 * 空字符串一律当成「没写」跳过——模型习惯把不改的可选字段写成 ""，硬当成改动会把
 * 一个非空字段清空。这与 `storyEngine` 那处对空串的处理同口径。
 */
export function mergeStoryCandidateRevision(themeVariants, revision) {
  const merged = structuredClone(themeVariants);
  const list = Array.isArray(merged?.variants) ? merged.variants : [];
  const index = list.findIndex((candidate) => String(candidate?.id || "") === String(revision?.candidateId || ""));
  if (index < 0) throw new ReviewContractError(`合并失败：themeVariants 里没有命题 ${revision?.candidateId}`);
  const candidate = list[index];

  for (const field of CANDIDATE_REVISION_WRITABLE) {
    if (!(field in revision)) continue;
    if (field === "keyDialogueDirections") {
      if (!Array.isArray(revision[field])) continue;
      const cleaned = revision[field].map((entry) => String(entry ?? "")).filter((entry) => entry.trim());
      if (cleaned.length) candidate[field] = cleaned;
      continue;
    }
    const value = String(revision[field] ?? "");
    if (value.trim()) candidate[field] = value;
  }

  const outline = Array.isArray(candidate.storyOutline) ? candidate.storyOutline : [];
  const positionOf = new Map(outline.map((beat, position) => [Number(beat?.beat), position]));
  for (const row of Array.isArray(revision.revisedBeats) ? revision.revisedBeats : []) {
    const position = positionOf.get(Number(row?.beat));
    if (position === undefined) continue;
    const beat = outline[position];
    if ("action" in row && String(row.action ?? "").trim()) beat.action = String(row.action);
    if ("emotion" in row && String(row.emotion ?? "").trim()) beat.emotion = String(row.emotion);
    if ("estimatedSeconds" in row && Number.isFinite(Number(row.estimatedSeconds))) {
      beat.estimatedSeconds = Number(row.estimatedSeconds);
    }
  }
  return merged;
}

/**
 * 证明可写范围之外逐字节没有变。
 *
 * 合并是按构造做的，所以这道检查抓的不是合并本身写错，而是**将来有人扩大可写范围时
 * 没有同步更新这里**——与分镜修订的 `assertOnlyRevisionFieldsChanged` 同规格。
 * 三个投影字段在这一步**还没有重新派生**，所以此时它们也必须逐字相同。
 */
export function assertOnlyCandidateRevisionFieldsChanged(before, after, candidateId) {
  const target = String(candidateId || "");
  const left = Array.isArray(before?.variants) ? before.variants : [];
  const right = Array.isArray(after?.variants) ? after.variants : [];
  if (left.length !== right.length) {
    throw new ReviewContractError(`合并改变了命题数量：${left.length} → ${right.length}`);
  }
  left.forEach((original, index) => {
    const updated = right[index];
    if (String(original?.id || "") !== target) {
      if (JSON.stringify(original) !== JSON.stringify(updated)) {
        throw new ReviewContractError(`合并动到了未授权的命题 ${original?.id || index}`);
      }
      return;
    }
    for (const key of Object.keys(original)) {
      if (key === "storyOutline" || CANDIDATE_REVISION_WRITABLE.includes(key)) continue;
      if (JSON.stringify(original[key]) !== JSON.stringify(updated?.[key])) {
        throw new ReviewContractError(`合并动到了命题 ${target} 的冻结字段 ${key}`);
      }
    }
    const beforeBeats = Array.isArray(original.storyOutline) ? original.storyOutline : [];
    const afterBeats = Array.isArray(updated?.storyOutline) ? updated.storyOutline : [];
    if (beforeBeats.length !== afterBeats.length) {
      throw new ReviewContractError(`合并改变了命题 ${target} 的拍数`);
    }
    beforeBeats.forEach((beat, position) => {
      const next = afterBeats[position];
      if (Number(beat?.beat) !== Number(next?.beat)) {
        throw new ReviewContractError(`合并改变了命题 ${target} 第 ${position + 1} 位的拍号`);
      }
      for (const key of Object.keys(beat)) {
        if (CANDIDATE_REVISION_BEAT_WRITABLE.includes(key)) continue;
        if (JSON.stringify(beat[key]) !== JSON.stringify(next?.[key])) {
          throw new ReviewContractError(`合并动到了命题 ${target} 第 ${beat.beat} 拍的冻结字段 ${key}`);
        }
      }
    });
  });
  return after;
}

/** 该命题在评审报告里被报出的因果断裂。 */
export function candidateCoherenceBreaks(review, candidateId) {
  const checks = Array.isArray(review?.candidateChecks) ? review.candidateChecks : [];
  const entry = checks.find((check) => String(check?.candidateId || "") === String(candidateId || ""));
  return Array.isArray(entry?.coherenceChecks) ? entry.coherenceChecks : [];
}

/**
 * 该命题没有迁移过来的原片机制（`not_depicted` 与 `partially_depicted`）。
 *
 * 与因果断裂并列成为修订的第二个驱动信号，依据是 2026-09-10 的实测：V4 被判 drop 的主因是
 * 三条机制全部 `not_depicted`，评审自己的 summary 也写着「最该先改的是补充转赠长辈的动作」，
 * 而修订当时只收到那一条最轻的空间断裂，于是只把「小木箱」换成了「高脚木凳」。
 *
 * **只有逐条的 `mechanismCheck` 够格当驱动信号，整体 `verdict` 不够。** 同一份输入三次回放
 * `verdict` 三次不同，而 `mechanismCheck` 逐条锚定到清单 id 与拍号，与 `coherenceChecks` 同规格。
 *
 * 机制正文在顶层 `sourceMechanisms` 里，逐条按 id 查回来——`mechanismCheck` 自己只有一个 id，
 * 光把 id 送给修订模型它什么也做不了。查不到就整条丢弃（评审的闸门保证查得到，
 * 这里是防御性的，不编造一条机制）。
 */
export function candidateUnmigratedMechanisms(review, candidateId) {
  const checks = Array.isArray(review?.candidateChecks) ? review.candidateChecks : [];
  const entry = checks.find((check) => String(check?.candidateId || "") === String(candidateId || ""));
  const mechanisms = Array.isArray(review?.sourceMechanisms) ? review.sourceMechanisms : [];
  return (Array.isArray(entry?.mechanismChecks) ? entry.mechanismChecks : [])
    .filter((check) => check?.verdict === "not_depicted" || check?.verdict === "partially_depicted")
    .map((check) => {
      const source = mechanisms.find((item) => String(item?.id || "") === String(check?.sourceMechanismId || ""));
      if (!source) return null;
      return {
        id: String(source.id || ""),
        mechanism: String(source.mechanism || ""),
        whereInSource: String(source.whereInSource || ""),
        verdict: check.verdict,
        // 2026-09-12：证据拆成前因与动作两格之后，这里必须跟着改读——
        // 不改的话 String(undefined || "") 得到空串，修订模型收到的是
        // 「本命题现在的情况：」后面什么都没有，**是静默空白不是报错**
        // （上一次改这份契约漏掉的正是消费者面，形状一模一样）。
        //
        // 旧键留一个回退：评审报告不落盘、只活在页面上，而页面不会因为服务端
        // 重启而刷新——旧代码渲染出的报告可以原样 POST 到新服务端。
        actionEvidence: String(check?.actionEvidence || check?.whereInCandidate || ""),
        // 前因单独送。requiresCause 的机制被判 partially_depicted，十有八九
        // 就是因为前因没写——只送动作证据等于把「差在哪」这一半藏起来。
        causeEvidence: String(check?.causeEvidence || ""),
        beatIndexes: Array.isArray(check?.beatIndexes) ? check.beatIndexes : []
      };
    })
    .filter(Boolean);
}
