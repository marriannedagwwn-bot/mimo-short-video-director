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
  return `你是分镜修稿编辑。完整阅读剧情和分镜，只找明确矛盾或会影响关键动作、空间、信息理解的必要缺口。不要给质量打分；不把合理简写、安静停留、局部特写、画外台词或非核心导演改编当错误。原文已有合理解释时不要求改，写入guidance。不得自添不利条件或规定新的镜头配额。
剧情的核心因果、角色身份关系与结局受保护；模型可设计未指定外观、调整非核心表演与原场次分组。先计入前文事实，不把前文已有状态误认为刚发生的新变化。重要关系与结果要看beats实际画面，不能听验收条件自称完成。
每条问题引用带id的字符串原文，quote必须是该id.text中的逐字连续摘句。id只是定位，不是评分。不要把模型adaptations里的原文回忆当作Full Story事实。证据不足时保留为guidance，不装成确定性结论。只报必要问题，不为填表凑数量；相同根因合并成一条，最多8条。
只输出严格JSON：{"strengths":["值得保住的已有具体设计"],"guidance":["不需改正文的引导说明"],"items":[{"ref":"I1","reportedProblem":"明确问题及理由","originalEvidence":[{"id":"P001","quote":"逐字摘句"}],"guidance":"修稿关注点、需保留内容；由修稿者自行选择具体改法，不强制照办"}]}。items可以为空；ref依次I1、I2。不得输出修订正文、自评分或放行结论。
完整剧情、角色事实及制作参数：${JSON.stringify(annotate(input,"U"))}
当前完整分镜：${JSON.stringify(annotate(plan,"P"))}`;
}

export function validateStoryboardReview(value, {input, plan}) {
  // 诊断带 code + RFC 6901 指针，形状与 storyboard-contract.js 一致：没有结构化 details
  // 就等于重试时只能说「你错了」而说不出错在哪，第二次只会重复第一次。判据逐字未改。
  const fail = (code, path, text) => { throw new OutputContractError(`分镜编辑意见：${text}`, [{code, path, reason: text}]); };
  const stringArray = arr => Array.isArray(arr) && arr.every(text => typeof text === "string" && text.trim());
  if (!value || Object.keys(value).sort().join(",") !== "guidance,items,strengths" || !stringArray(value.strengths) || !stringArray(value.guidance) || !Array.isArray(value.items) || value.items.length > 8) fail("STORYBOARD_REVIEW_STRUCTURE_INVALID", "/", "结构无效：顶层只能有 strengths / guidance / items，前两者是非空字符串数组，items 最多 8 条");
  const lookup = new Map([...catalog(input,"U"), ...catalog(plan,"P")].map(row => [row.id,row]));
  value.items.forEach((item,index) => {
    if (!item || Object.keys(item).sort().join(",") !== "guidance,originalEvidence,ref,reportedProblem" || item.ref !== `I${index+1}` || ![item.guidance,item.reportedProblem].every(text => typeof text === "string" && text.trim()) || !Array.isArray(item.originalEvidence) || !item.originalEvidence.length) fail("STORYBOARD_REVIEW_ITEM_INCOMPLETE", `/items/${index}`, `问题字段或编号不完整：本条 ref 必须是 I${index+1}，且 reportedProblem / guidance 非空、originalEvidence 至少一条`);
    for (const evidence of item.originalEvidence) {
      if (!evidence || Object.keys(evidence).sort().join(",") !== "id,quote" || typeof evidence.quote !== "string" || !evidence.quote.trim() || !lookup.get(evidence.id)?.value.includes(evidence.quote)) fail("STORYBOARD_REVIEW_EVIDENCE_NOT_VERBATIM", `/items/${index}/originalEvidence`, `问题 ${item.ref} 引用不存在或不是逐字原文：quote 必须是该 id 正文里的一段连续原文，不能概括或改写`);
    }
  });
  return value;
}
