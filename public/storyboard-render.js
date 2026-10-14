import { factSheet } from "./fact-sheet.js";

const STAGE_LABELS = { storyboardCharacterFacts: "角色事实整理", storyboardDesign: "分镜设计", storyboardReview: "初审", storyboardRevision: "修订", storyboardReviewFinal: "终审" };

// 服务端拦过一次就必须说出来，不能让用户以为模型一次就写对了。
// 六个阶段各自允许「第一次做错」，预算封在 2 次；旧 Plan 没有 calls 这个键时整段不显示
// ——显示一个「1 次」会被读成「查过了没被拦」，而那时其实是压根没记录。
function retryNote(metadata, e) {
  const retried = (metadata?.storyboard?.calls || []).filter(row => row.providerCalls > 1);
  if (!retried.length) return "";
  return `<p class="story-review-status warn">${retried.map(row => {
    const reasons = (row.rejections || []).flatMap(rejection => rejection?.details || [])
      .map(detail => String(detail?.reason || detail?.message || "").trim()).filter(Boolean);
    return `${e(STAGE_LABELS[row.stage] || row.stage)}是第 ${e(row.providerCalls)} 次调用的结果——第一次被确定性校验拦下并按诊断重做了一次${reasons.length ? `：${e(reasons.join("；"))}` : "。"}`;
  }).join("<br>")}</p>`;
}

// 服务端改了模型输出同样必须说出来，不做静默修补。旧 Plan 没有这个键时整段不显示
// ——显示一个空的会被读成「查过了没补过」。
function boundaryRestoreNote(metadata, e) {
  const restores = metadata?.storyboard?.boundaryRestores || [];
  if (!restores.length) return "";
  return `<p class="story-review-status warn">${restores.map(row =>
    `${e(row.characterName)} 的角色参考缺了全局必需角色事实，已按签发顺序补进一致性标签：${e((row.restoredTraits || []).join("、"))}`
  ).join("<br>")}</p>`;
}

const TRANSITION_LABELS = { start: "开场", continuous: "动作连续", cut: "切换", ellipsis: "时间省略" };
const REPAIR_STATUS = { applied: ["已修订", "badge-green"], rejected: ["本条未采用", "badge-red"], not_changed: ["保留原文", ""] };

function statRow(data, e) {
  const strategy = data.productionStrategy;
  const seconds = data.shotPlan.reduce((n, s) => n + s.durationSeconds, 0);
  const stats = [
    ["画幅", strategy.targetAspectRatio], ["时长", `${seconds} 秒 · ${data.shotPlan.length} 段`],
    ["赛道", strategy.visualStyle, true], ["画风", strategy.artStyle || "未指定"],
    ["背景音乐", strategy.backgroundMusicMode === "none" ? "关闭" : "允许"]
  ];
  return `<dl class="stat-row">${stats.map(([label, value, wide]) =>
    `<div${wide ? ` class="stat-wide"` : ""}><dt>${label}</dt><dd>${e(value || "待确认")}</dd></div>`).join("")}</dl>`;
}

function scenesAndProps(data, e) {
  const locations = data.visualDesign.locations.map(row => ({ name: row.name, note: (row.sourceSceneIds || []).join("、"),
    facts: [{ label: "布局", html: e(row.layout) }, { label: "光线", html: e(row.lighting) }] }));
  const props = data.visualDesign.props.map(row => ({ name: row.name, text: e(row.appearanceAndSupport) }));
  return `${locations.length ? `<p class="sub-label">场景</p>${factSheet(locations, e)}` : ""}
    ${props.length ? `<p class="sub-label">道具</p>${factSheet(props, e)}` : ""}`;
}

// 节拍是时间轴上的一行：左列时间，右列地点与出镜人物 → 画面 → 动作 → 台词 → 声音。
function beatRow(beat, e) {
  const people = beat.characters.map(name => `<li class="chip chip-quiet">${e(name)}</li>`).join("");
  return `<li class="beat-row">
      <div class="beat-time">${beat.startSeconds}–${beat.endSeconds}<small>秒</small></div>
      <div class="beat-body">
        <div class="beat-head"><strong>${e(beat.location)}</strong>${people ? `<ul class="chips">${people}</ul>` : ""}</div>
        <dl class="kv"><dt>画面</dt><dd>${e(beat.framing)} · ${e(beat.camera)}</dd></dl>
        <p class="beat-action">${e(beat.visibleAction)}</p>
        ${beat.dialogue.length ? `<ul class="beat-dialogue">${beat.dialogue.map(line => `<li><b>${e(line.speaker)}${line.source === "offscreen" ? "（画外）" : ""}：</b>${e(line.text)}${line.timing ? `<small>${e(line.timing)}</small>` : ""}</li>`).join("")}</ul>` : ""}
        ${beat.soundDesign ? `<dl class="kv"><dt>声音</dt><dd>${e(beat.soundDesign)}</dd></dl>` : ""}
      </div>
    </li>`;
}

function shotCard(shot, { e, renderVideo, videoLabel }) {
  return `<div class="shot-card">
    <div class="shot-card-head">
      <span class="badge badge-dark">${e(shot.shotId)}</span>
      <span class="shot-card-meta">${e(shot.sourceSceneIds.join("、"))} · ${shot.durationSeconds} 秒</span>
      <span class="shot-card-mood">${e(shot.emotionalTarget)}</span>
    </div>
    <dl class="kv"><dt>剧情作用</dt><dd>${e(shot.storyPurpose)}</dd><dt>${e(TRANSITION_LABELS[shot.transitionIn.type])}</dt><dd>${e(shot.transitionIn.description)}</dd></dl>
    <ol class="beat-timeline">${shot.beats.map(beat => beatRow(beat, e)).join("")}</ol>
    <dl class="kv shot-card-outcome"><dt>结束状态</dt><dd>${e(shot.continuityOut)}</dd>
      <dt>验收标准</dt><dd><ul class="check-list">${shot.acceptanceCriteria.map(text => `<li>${e(text)}</li>`).join("")}</ul></dd></dl>
    <div class="shot-video-action">
      <div class="shot-action-row"><button class="outline-button shot-video-button" type="button" data-generate-shot-video="${e(shot.shotId)}">用 ${e(videoLabel)} 生成此镜头视频</button><span class="note">点击后单独生成本镜提示词，查看并确认后开始生成视频。</span></div>
      <div class="shot-video-result" data-shot-video-result="${e(shot.shotId)}">${renderVideo(shot.shotId)}</div>
    </div>
  </div>`;
}

function adaptations(rows, e) {
  return `<div class="adaptation-list">${rows.map(row => `<div class="adaptation">
      <div class="adaptation-head">${row.sourceSceneIds.map(id => `<span class="badge">${e(id)}</span>`).join("")}</div>
      <div class="adaptation-diff">
        <div class="adaptation-from"><span class="fact-label">原文</span><p>${e(row.original)}</p></div>
        <div class="adaptation-arrow" aria-hidden="true">→</div>
        <div class="adaptation-to"><span class="fact-label">改成</span><p>${e(row.change)}</p></div>
      </div>
      <p class="note"><b>理由</b>${e(row.reason)}</p>
    </div>`).join("")}</div>`;
}

// editorial.guidance 由服务端拼成：初审引导 + 每条修订的说明 + 终审引导 + 最后一轮审阅报出的问题
// （src/storyboard-workflow.js）。原来整串照排，修订说明在上面的修订条目里已经出现过一次，
// 又在这里重复一次；审阅仍指出的问题也和普通引导混在一起分不出来。这里按来源分开放，
// 每条原文只显示一次，判定全是逐字比较；旧 Plan 与演示 Plan 没有这些结构时退回一个列表。
function editorial(data, e) {
  const value = data.editorial || {};
  const repairs = Array.isArray(value.repairs) ? value.repairs : [];
  const guidance = [...new Set((Array.isArray(value.guidance) ? value.guidance : []).map(String))];
  const repairNotes = new Set(repairs.map(row => String(row?.note ?? "")));
  const reviewed = value.finalReview || value.initialReview || null;
  const reportedProblems = new Set((reviewed?.items || []).map(row => String(row?.reportedProblem ?? "")).filter(Boolean));
  const openProblems = guidance.filter(text => reportedProblems.has(text));
  const notes = guidance.filter(text => !repairNotes.has(text) && !reportedProblems.has(text));
  const blocked = (data.blockedIssues || []).map(String).filter(Boolean);
  const points = (items, tone = "") => `<ul class="point-list${tone ? ` ${tone}` : ""}">${items.map(text => `<li>${e(text)}</li>`).join("")}</ul>`;
  const sections = [];
  if (blocked.length) sections.push(`<p class="sub-label">无法在授权范围内解决的问题</p>${points(blocked, "warn")}`);
  if (repairs.length) sections.push(`<p class="sub-label">审阅后的修订</p><div class="editorial-list">${repairs.map(row => {
    const [label, tone] = REPAIR_STATUS[row.status] || ["说明", ""];
    const changed = row.status === "applied" && Array.isArray(row.changes) ? row.changes.length : 0;
    return `<div class="editorial-item">
        <div class="editorial-item-head"><span class="badge badge-dark">${e(row.ref)}</span><span class="badge${tone ? ` ${tone}` : ""}">${e(label)}</span>${changed ? `<span class="note">改了 ${changed} 处</span>` : ""}</div>
        <p>${e(row.note)}</p>
        ${row.status === "rejected" && row.reason ? `<p class="note"><b>未采用的原因</b>${e(row.reason)}</p>` : ""}
      </div>`;
  }).join("")}</div>`);
  if (openProblems.length) sections.push(`<p class="sub-label">${value.finalReview ? "终审复查仍指出的问题（没有再修订）" : "审阅指出、没有改正文的问题"}</p>${points(openProblems, "warn")}`);
  if (notes.length) sections.push(`<p class="sub-label">引导说明</p>${points(notes)}`);
  return sections.join("") || "<p>本轮没有额外修订说明。</p>";
}

export function renderStoryboard(data, { escape: e, block, resultHeader, renderCharacters, renderVideo, videoLabel, metadata = null }) {
  return `${resultHeader("ANIMATION PLAN", data.title, "自主分镜")}
    ${retryNote(metadata, e)}
    ${boundaryRestoreNote(metadata, e)}
    <div class="summary-strip">${e(data.viewingIntent)}</div>
    ${statRow(data, e)}
    ${block("角色设定与参考图", renderCharacters(data.characterReferencePrompts))}
    ${block("场景与道具", scenesAndProps(data, e))}
    ${block("完整分镜", `<div class="shot-list">${data.shotPlan.map(shot => shotCard(shot, { e, renderVideo, videoLabel })).join("")}</div>`)}
    ${data.adaptations.length ? block("改编说明", adaptations(data.adaptations, e)) : ""}
    ${block("修订与引导说明", editorial(data, e))}`;
}
