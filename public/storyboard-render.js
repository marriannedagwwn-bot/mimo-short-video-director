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

export function renderStoryboard(data, { escape: e, block, cell, resultHeader, renderCharacters, renderVideo, videoLabel, metadata = null }) {
  const strategy = data.productionStrategy;
  const transition = { start: "开场", continuous: "动作连续", cut: "切换", ellipsis: "时间省略" };
  const repairStatus = { applied: "已修订", rejected: "本条未采用", not_changed: "保留原文" };
  const paragraphs = rows => rows.map(text => `<p>${e(text)}</p>`).join("");
  return `${resultHeader("ANIMATION PLAN", data.title, "自主分镜")}
    ${retryNote(metadata, e)}
    ${boundaryRestoreNote(metadata, e)}
    <div class="summary-strip">${e(data.viewingIntent)}</div>
    <div class="data-grid">${cell("画幅", strategy.targetAspectRatio)}${cell("时长", `${data.shotPlan.reduce((n,s) => n+s.durationSeconds,0)} 秒 · ${data.shotPlan.length} 段`)}${cell("风格", strategy.visualStyle)}${cell("背景音乐", strategy.backgroundMusicMode === "none" ? "关闭" : "允许")}</div>
    ${block("角色设定与参考图", renderCharacters(data.characterReferencePrompts))}
    ${block("角色事实与本片设计", data.visualDesign.characters.map(row => {
      const known = data.characterRegistry.supportingCharacters.find(item => item.name === row.name);
      const facts = known ? [known.identity, known.relationshipToProtagonist, known.storyRole, ...known.appearanceFacts, ...known.personalityFacts, ...known.speechRules] : [data.characterRegistry.protagonist.identity, ...(data.characterRegistry.protagonist.traits || [])];
      return `<p><b>${e(row.name)}</b><br>已有设定：${e(facts.filter(Boolean).join("；") || "仅登记出镜身份")}${row.designedDetails.length ? `<br>本片新增外观：${e(row.designedDetails.join("；"))}` : ""}</p>`;
    }).join(""))}
    ${block("场景与道具", `<div class="rule-list">${data.visualDesign.locations.map(row => `<div class="rule"><strong>${e(row.name)}</strong><p>${e(row.layout)}<br>${e(row.lighting)}</p></div>`).join("")}${data.visualDesign.props.map(row => `<div class="rule"><strong>${e(row.name)}</strong><p>${e(row.appearanceAndSupport)}</p></div>`).join("")}</div>`)}
    ${block("完整分镜", `<div class="shot-list">${data.shotPlan.map(shot => `<div class="shot-card">
      <div class="scene-head"><strong>${e(shot.shotId)} · ${e(shot.sourceSceneIds.join("、"))}</strong><span>${shot.durationSeconds} 秒 · ${e(shot.emotionalTarget)}</span></div>
      <p><b>剧情作用：</b>${e(shot.storyPurpose)}<br><b>${e(transition[shot.transitionIn.type])}：</b>${e(shot.transitionIn.description)}</p>
      <div class="timeline">${shot.beats.map(beat => `<div class="scene"><div class="scene-head"><strong>${beat.startSeconds}–${beat.endSeconds} 秒 · ${e(beat.location)}</strong><span>${e(beat.characters.join("、"))}</span></div>
        <p><b>画面：</b>${e(beat.framing)} · ${e(beat.camera)}</p><p>${e(beat.visibleAction)}</p>
        ${beat.dialogue.map(line => `<p><b>${e(line.speaker)}${line.source === "offscreen" ? "（画外）" : ""}：</b>${e(line.text)} <small>${e(line.timing)}</small></p>`).join("")}
        <p><b>声音：</b>${e(beat.soundDesign)}</p></div>`).join("")}</div>
      <p><b>结束状态：</b>${e(shot.continuityOut)}</p>
      <div class="tag-row">${shot.acceptanceCriteria.map(text => `<span class="tag">${e(text)}</span>`).join("")}</div>
      <div class="shot-video-action"><button class="outline-button shot-video-button" type="button" data-generate-shot-video="${e(shot.shotId)}">用 ${e(videoLabel)} 生成此镜头视频</button><p class="shot-video-reference-note">点击后单独生成本镜提示词，查看并确认后开始生成视频。</p><div class="shot-video-result" data-shot-video-result="${e(shot.shotId)}">${renderVideo(shot.shotId)}</div></div>
    </div>`).join("")}</div>`)}
    ${data.adaptations.length ? block("改编说明", data.adaptations.map(row => `<p><b>${e(row.sourceSceneIds.join("、"))}</b> ${e(row.original)} → ${e(row.change)}<br>${e(row.reason)}</p>`).join("")) : ""}
    ${block("修订与引导说明", data.editorial.repairs.map(row => `<p><b>${e(row.ref)} · ${e(repairStatus[row.status] || "说明")}</b> ${e(row.note)}</p>`).join("") + paragraphs([...data.editorial.guidance, ...data.blockedIssues]) || "<p>本轮没有额外修订说明。</p>")}`;
}
