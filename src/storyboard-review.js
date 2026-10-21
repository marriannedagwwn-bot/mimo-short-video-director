import { catalog } from "./storyboard-editorial-utils.js";
import { OutputContractError } from "./validation.js";

export function storyboardReviewPrompt({input, plan}) {
  const annotate = (value, prefix) => {
    const entries = new Map(catalog(value, prefix).map(row => [JSON.stringify(row.path), row]));
    const visit = (v, path) => {
      const row = entries.get(JSON.stringify(path));
      if (row) return {id: row.id, text: v};
      if (Array.isArray(v)) return v.map((child, i) => visit(child, [...path, String(i)]));
      if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([key, child]) => [key, visit(child, [...path, key])]));
      return v;
    };
    return visit(value, []);
  };
  return `你是分镜修稿编辑。完整阅读剧情和分镜，只找明确矛盾或会影响关键动作、空间、信息理解的必要缺口。不要给质量打分；不把合理简写、安静停留、局部特写、画外台词、非核心导演改编、空镜头、人物出画后的留空、先给局部再给脸的镜头、soundDesign 里的角色人声、写明「无人声」的揭底镜头或空镜、冷场里的静默、与前面同一构图的重复镜头、跳过时间的物件空镜或背景换成角色图案的镜头当错误。原文已有合理解释时不要求改，写入guidance。不得自添不利条件或规定新的镜头配额。
剧情的核心因果、角色身份关系与结局受保护；模型可设计未指定外观、调整非核心表演与原场次分组。先计入前文事实，不把前文已有状态误认为刚发生的新变化。重要关系与结果要看beats实际画面，不能听验收条件自称完成。
每条问题引用带id的字符串原文，quote必须是该id.text中的逐字连续摘句。id只是定位，不是评分。不要把模型adaptations里的原文回忆当作Full Story事实。证据不足时保留为guidance，不装成确定性结论。只报必要问题，不为填表凑数量；相同根因合并成一条，最多8条。
只输出严格JSON：{"strengths":["值得保住的已有具体设计"],"guidance":["不需改正文的引导说明"],"items":[{"ref":"I1","reportedProblem":"明确问题及理由","originalEvidence":[{"id":"P001","quote":"逐字摘句"}],"guidance":"修稿关注点、需保留内容；由修稿者自行选择具体改法，不强制照办"}]}。items可以为空；ref依次I1、I2。不得输出修订正文、自评分或放行结论。所有文字用中文写，quote 照原文逐字复制。
完整剧情、角色事实及制作参数：${JSON.stringify(annotate(input,"U"))}
当前完整分镜：${JSON.stringify(annotate(plan,"P"))}`;
}

// 审阅输出的键名只有这一份：校验器与 Claude 的结构化输出 Schema（contracts/storyboard-review-claude-schema.js）共用，
// 顺序与上面提示词里的输出模板一致。
export const STORYBOARD_REVIEW_KEYS = Object.freeze(["strengths", "guidance", "items"]);
export const STORYBOARD_REVIEW_ITEM_KEYS = Object.freeze(["ref", "reportedProblem", "originalEvidence", "guidance"]);
export const STORYBOARD_REVIEW_EVIDENCE_KEYS = Object.freeze(["id", "quote"]);
export const STORYBOARD_REVIEW_MAX_ITEMS = 8;

const nonEmptyString = text => typeof text === "string" && Boolean(text.trim());
const isRecord = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const describe = value => value === undefined ? "缺失" : value === null ? "null" : Array.isArray(value) ? `数组（${value.length} 项）`
  : typeof value === "string" ? (value.trim() ? "字符串" : "空字符串") : typeof value === "object" ? "对象" : typeof value === "number" ? "数字" : typeof value;
const clip = text => [...text].length > 60 ? `${[...text].slice(0, 60).join("")}…` : text;
// 只比较键的集合，与原来「排序后拼成字符串再比」等价；多出与缺少分开写，重试时才知道改哪一个。
function keyProblems(value, expected, scope) {
  const keys = Object.keys(value);
  const missing = expected.filter(key => !keys.includes(key));
  const extra = keys.filter(key => !expected.includes(key));
  return [
    ...(missing.length ? [`缺少字段 ${missing.join("、")}`] : []),
    ...(extra.length ? [`多了字段 ${extra.join("、")}，${scope}只能有 ${expected.join(" / ")}`] : [])
  ];
}

export function validateStoryboardReview(value, {input, plan}) {
  // 诊断带 code + RFC 6901 指针，形状与 storyboard-contract.js 一致：没有结构化 details
  // 就等于重试时只能说「你错了」而说不出错在哪，第二次只会重复第一次。
  // 2026-10-21：一次报出全部问题，reason 写明哪个字段错成了什么样，指针精确到出错的字段。
  // 起因是 Opus 把意见里的 guidance 写成数组，旧诊断只说「guidance 非空」，重试照样写成数组。
  // 三个 code 与「什么算错」逐字不变：原来通过的照样通过，原来拦下的照样拦下。
  const details = [];
  const add = (code, path, reason) => details.push({code, path, reason});
  const structure = (path, reason) => add("STORYBOARD_REVIEW_STRUCTURE_INVALID", path, reason);
  if (!isRecord(value)) structure("/", `审阅结果必须是 JSON 对象，顶层只能有 ${STORYBOARD_REVIEW_KEYS.join(" / ")}，写成了${describe(value)}`);
  else {
    const missingTop = keyProblems(value, STORYBOARD_REVIEW_KEYS, "顶层");
    if (missingTop.length) structure("/", missingTop.join("；"));
    for (const key of ["strengths", "guidance"]) {
      if (!Object.hasOwn(value, key)) continue;
      if (!Array.isArray(value[key])) structure(`/${key}`, `必须是字符串数组，写成了${describe(value[key])}`);
      else value[key].forEach((text, i) => { if (!nonEmptyString(text)) structure(`/${key}/${i}`, `必须是一段非空字符串，写成了${describe(text)}`); });
    }
    if (Object.hasOwn(value, "items") && !Array.isArray(value.items)) structure("/items", `必须是数组，写成了${describe(value.items)}`);
    if (Array.isArray(value.items) && value.items.length > STORYBOARD_REVIEW_MAX_ITEMS) structure("/items", `最多 ${STORYBOARD_REVIEW_MAX_ITEMS} 条，现在 ${value.items.length} 条；相同根因合并成一条`);
  }
  const items = isRecord(value) && Array.isArray(value.items) ? value.items : [];
  const lookup = new Map([...catalog(input,"U"), ...catalog(plan,"P")].map(row => [row.id,row]));
  items.forEach((item,index) => {
    const at = `/items/${index}`;
    const incomplete = (path, reason) => add("STORYBOARD_REVIEW_ITEM_INCOMPLETE", path, reason);
    if (!isRecord(item)) { incomplete(at, `第 ${index+1} 条意见必须是对象，写成了${describe(item)}`); return; }
    const itemKeys = keyProblems(item, STORYBOARD_REVIEW_ITEM_KEYS, "每条意见");
    if (itemKeys.length) incomplete(at, itemKeys.join("；"));
    if (item.ref !== `I${index+1}`) incomplete(`${at}/ref`, `ref 应为 I${index+1}，写的是 ${JSON.stringify(item.ref) ?? "undefined"}`);
    for (const key of ["reportedProblem", "guidance"]) {
      if (Object.hasOwn(item, key) && !nonEmptyString(item[key])) incomplete(`${at}/${key}`, `必须是一段非空字符串，写成了${describe(item[key])}`);
    }
    if (!Object.hasOwn(item, "originalEvidence")) return;
    if (!Array.isArray(item.originalEvidence)) { incomplete(`${at}/originalEvidence`, `必须是数组，写成了${describe(item.originalEvidence)}`); return; }
    if (!item.originalEvidence.length) { incomplete(`${at}/originalEvidence`, "至少要有一条引用"); return; }
    item.originalEvidence.forEach((evidence, k) => {
      const problems = [];
      if (!isRecord(evidence)) problems.push(`必须是 {id, quote} 对象，写成了${describe(evidence)}`);
      else {
        const evidenceKeys = Object.keys(evidence);
        const sameKeys = evidenceKeys.length === STORYBOARD_REVIEW_EVIDENCE_KEYS.length && STORYBOARD_REVIEW_EVIDENCE_KEYS.every(key => evidenceKeys.includes(key));
        if (!sameKeys) problems.push(`引用只能有 ${STORYBOARD_REVIEW_EVIDENCE_KEYS.join(" 与 ")} 两个字段，写的是 ${evidenceKeys.join("、") || "空对象"}`);
        if (!nonEmptyString(evidence.quote)) problems.push(`quote 必须是一段非空字符串，写成了${describe(evidence.quote)}`);
        else if (!lookup.has(evidence.id)) problems.push(`id ${JSON.stringify(evidence.id) ?? "undefined"} 不存在，只能引用剧情与分镜里带 id 的原文`);
        else if (!lookup.get(evidence.id).value.includes(evidence.quote)) problems.push(`quote「${clip(evidence.quote)}」不是 ${evidence.id} 正文里的逐字原文：必须从该 id 的 text 原样复制一段连续文字，不缩写、不换写法`);
      }
      if (problems.length) add("STORYBOARD_REVIEW_EVIDENCE_NOT_VERBATIM", `${at}/originalEvidence/${k}`, `问题 ${item.ref} 第 ${k+1} 条引用：${problems.join("；")}`);
    });
  });
  if (details.length) throw new OutputContractError(`分镜编辑意见：${details.map(row => `${row.path} ${row.reason}`).join("；")}`, details);
  return value;
}
