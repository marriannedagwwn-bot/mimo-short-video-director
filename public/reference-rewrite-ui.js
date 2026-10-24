// 参考片仿写接进 AI 导演（2026-10-24）的页面渲染：只拼 HTML 字符串，不碰状态、不发请求；接线在 app.js。
// 设计见 docs/reference-rewrite-2026-10-24.md。

/** AI 导演第一步「去配乐与转写」的结果卡：处理参数一行，转写稿默认折起来。 */
export function sourceTranscriptCardHtml(transcript, { escape, header }) {
  if (!transcript) return "";
  const meta = transcript.demo
    ? "演示模式：没有做去配乐和转写"
    : transcript.hasAudio === false
      ? "这支参考视频没有音轨"
      : [
        transcript.separator === "bandit-v2-multi" ? "Bandit v2 Multi 去配乐" : "",
        transcript.voiceRecovery === "mel-roformer-kim-vocal-2" ? "Mel-RoFormer 捞回叫声" : "",
        transcript.whisperModel ? `whisper ${transcript.whisperModel} 转写` : ""
      ].filter(Boolean).join(" · ");
  return `${header}
    <p class="source-transcript-meta">${escape(meta)}。转写不标说话人，有同音错字和编出来的句子；分析、还原和主题变体都把它当台词稿参考，以画面为准。</p>
    <details class="source-transcript-text"><summary>看转写稿</summary><pre>${escape(transcript.text || "")}</pre></details>`;
}

/** 剧本格式的主题变体上方：原片拆解（概要、台词表、好看在哪）。 */
export function scriptVariantOriginalHtml(themeVariants, { escape }) {
  const original = themeVariants?.original || {};
  const dialogue = Array.isArray(original.dialogue) ? original.dialogue : [];
  const strengths = Array.isArray(original.strengths) ? original.strengths : [];
  const model = themeVariants?.model || {};
  const meta = [model.provider, model.model, model.effort ? `effort ${model.effort}` : "", model.providerCalls > 1 ? `第 ${model.providerCalls} 次调用的结果` : ""]
    .filter(Boolean).map(escape).join(" · ");
  return `<div class="script-variant-original">
    <h4>原片拆解</h4>
    <p class="script-variant-summary">${escape(original.summary)}</p>
    <details class="script-variant-dialogue">
      <summary>台词（${dialogue.length} 句）</summary>
      <table>
        <thead><tr><th>时间</th><th>谁</th><th>台词</th><th>画面</th></tr></thead>
        <tbody>${dialogue.map((row) => `<tr><td>${escape(row.time)}</td><td>${escape(row.speaker)}</td><td>${escape(row.line)}</td><td>${escape(row.picture)}</td></tr>`).join("")}</tbody>
      </table>
    </details>
    <h4>原片好看在哪</h4>
    <ul>${strengths.map((item) => `<li>${escape(item)}</li>`).join("")}</ul>
    ${meta ? `<small class="script-variant-model">${meta}</small>` : ""}
  </div>`;
}

/** 剧本格式的变体卡：标题、方向、概要，「看剧本」展开，按钮进分场页。topMeta 是 app.js 拼好的配乐开关。 */
export function scriptVariantCardsHtml(themeVariants, { escape, regenerating = false, topMeta = () => "" }) {
  const variants = Array.isArray(themeVariants?.variants) ? themeVariants.variants : [];
  return `<div class="variant-grid">${variants.map((variant) => `<div class="variant script-variant">
      <div class="variant-top">
        <div><span class="variant-number">${escape(variant.id)} · SCRIPT</span><h4>${escape(variant.title)}</h4></div>
        <div class="variant-top-meta">${topMeta(variant)}</div>
      </div>
      <p class="variant-hook">${escape(variant.direction)}</p>
      <p class="variant-logline">${escape(variant.summary)}</p>
      <details class="script-variant-script"><summary>看剧本</summary><pre>${escape(variant.script)}</pre></details>
      <button class="outline-button variant-story-button" type="button" data-story-variant="${escape(variant.id)}"${regenerating ? " disabled" : ""}>拆成完整剧情 →</button>
    </div>`).join("")}</div>
    <div class="script-variant-footer">
      <button class="outline-button" type="button" data-script-variants-download>下载剧本（Markdown）</button>
    </div>`;
}

/** 分场页左侧：选中的那篇剧本。 */
export function scriptVariantSummaryHtml(variant, { escape }) {
  return `
    <span class="variant-number">${escape(variant.id)} · SCRIPT</span>
    <h3>${escape(variant.title)}</h3>
    <p>${escape(variant.direction)}</p>
    <p>${escape(variant.summary)}</p>
    <details class="script-variant-script"><summary>看剧本</summary><pre>${escape(variant.script)}</pre></details>
    <small class="story-source-note">完整剧情按这篇剧本拆场：情节、人物、结局和台词都按剧本。</small>`;
}

/**
 * 时间轴采样最后一张缩略图上的「+N」：主题变体那一步给模型看的帧比页面显示的多 N 张。
 * total 是模型看的总帧数，shown 是页面显示的张数。不多就不显示。
 */
export function frameStripMoreHtml({ total, shown, fps, escape }) {
  const extra = Math.max(0, Math.round(Number(total) || 0) - Math.round(Number(shown) || 0));
  if (!extra) return "";
  return `<span class="frame-more" title="${escape(`主题变体这一步会看 ${total} 帧（每秒 ${fps} 帧）`)}">+${escape(extra)}</span>`;
}
