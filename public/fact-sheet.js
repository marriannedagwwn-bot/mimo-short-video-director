// 「一个对象若干属性」的展示（角色、场景、道具）：左列名字，右列一行一个属性，
// 同一属性里的多条短事实用浅色圆点隔开。2026-10-14 用户看过「每条事实一个胶囊标签」的版本，
// 觉得乱（长短不一的胶囊堆成一团），同一份内容改成这种属性表。只做展示，不改任何字段。

// 多条短事实连成一行，用圆点隔开；空的不输出。接受数组或单个字符串。
export function dotList(items, escape) {
  const rows = [items].flat().map((item) => String(item ?? "").trim()).filter(Boolean);
  return rows.length ? `<span class="dot-list">${rows.map((text) => `<span>${escape(text)}</span>`).join("")}</span>` : "";
}

// rows: [{ name, note?, facts?: [{ label, html, tone? }], text? }]
// html / text 由调用方转义好；空的属性行不输出。tone：new（本片新增）、muted（占位说明）、no（禁止项）。
export function factSheet(rows, escape) {
  return `<div class="fact-sheet">${rows.map((row) => {
    const facts = (row.facts || []).filter((fact) => fact.html);
    const tone = (fact) => fact.tone ? ` class="${fact.tone}"` : "";
    return `<div class="fact-sheet-row">
      <div class="fact-sheet-name">${escape(row.name)}${row.note ? `<small>${escape(row.note)}</small>` : ""}</div>
      <div class="fact-sheet-body">${row.text ? `<p>${row.text}</p>` : ""}${facts.length ? `<dl class="kv">${facts.map((fact) => `<dt${tone(fact)}>${escape(fact.label)}</dt><dd${tone(fact)}>${fact.html}</dd>`).join("")}</dl>` : ""}</div>
    </div>`;
  }).join("")}</div>`;
}
