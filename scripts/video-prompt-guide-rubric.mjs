#!/usr/bin/env node
/**
 * docs/video-prompt-guide.md 档 2 那 7 条写法规则的合规率测量。
 *
 * 口径与 h3 那次一致：只统计 phase === "animation-shot-batch" 的首轮落盘，
 * 排除修复轮。默认按 direct_shot 3.1 的提交时间切分改动前后。
 *
 * 重要：下面每一条都是**表面代理指标**，不是语义判定。它能回答
 * 「模型有没有在用这种写法」，不能回答「写得对不对」。数字只用来决定
 * 值不值得往提示词里加规则；判断质量仍然要人读。
 *
 *   node scripts/video-prompt-guide-rubric.mjs [--since ISO] [--split ISO] [--dump]
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = "debug/animation-plan-model-outputs";
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
// direct_shot 3.1（ce1d85c）落地前后。3.0 的镜头是 4–6 秒硬上限，3.1 由 timeRange 派生。
const SPLIT = Date.parse(flag("--split", "2026-08-23T12:00:00Z"));
const SINCE = Date.parse(flag("--since", "1970-01-01T00:00:00Z"));

// 每条规则 → docs/video-prompt-guide.md 的模板号。检出即「用了这种写法」。
const NO_MUSIC_SENTENCE = "全片无背景音乐，只保留现场环境声与动作声。";

// 每条规则 → docs/video-prompt-guide.md 的模板号。检出即「用了这种写法」。
//
// 已经人读抽样校准过的坑，改动时不要退回去：
//   · 配乐类规则必须先剥掉合规的禁配乐收尾句，否则它会匹配自己；
//   · 节拍链和「每段带秒数」是两件事，3.0 已有半数写了链但几乎不带秒数，
//     合成一条会把「秒数是新出现的」这个真实信号说成「节拍是新出现的」；
//   · 模板5（多主体归属）没有可靠的表面代理——早先要求分号分隔的写法把
//     人读明明合格的镜头判成不合格（抽样 5/5 合格 vs 代理 5%）。宁可不测，
//     也不要往表里塞一个已知会误导的数字。
const RULES = [
  ["模板4 情绪已拆成身体部位", (s) => /(耳朵?|尾巴|肩膀|手指|双手|膝盖|眉|指尖)[^。；]{0,12}(竖起|下垂|耷拉|摆动|抖动|握拳|缩起|前倾|歪斜|并拢)/u.test(s.videoPrompt)],
  ["模板4 反例「X表示Y」情绪注解", (s) => /表示(惊喜|安心|思考|开心|关切|注意|认真|沮丧|不安|满足|配合|期待|疲惫|羞涩)/u.test(s.videoPrompt)],
  ["模板6 运镜写了起止构图", (s) => /(转|→|至|到)\s*(特写|中景|远景|全景|近景|中近景)/u.test(s.cameraMotion + s.videoPrompt)],
  ["模板7 焦点转移", (s) => /(焦点|对焦|从模糊|变清晰|由虚转实|先是模糊)/u.test(s.videoPrompt)],
  ["模板8 环境变化写了起点→终点", (s) => /(从|由)[^。；]{0,14}(变成|渐变为|转为|变为)/u.test(s.videoPrompt)],
  ["模板10 节拍链(→，不论秒数)", (s) => /→/u.test(s.videoPrompt + s.cameraMotion)],
  ["模板10 节拍链每段带秒数", (s) => /→/u.test(s.cameraMotion) && /\d+(\.\d+)?\s*秒/u.test(s.cameraMotion)],
  ["模板10 秒数之和 == 时长", (s) => {
    const secs = [...s.cameraMotion.matchAll(/(\d+(?:\.\d+)?)\s*秒/gu)].map((m) => Number(m[1]));
    if (!secs.length) return null; // 没用秒数写法，不计入分母
    return Math.abs(secs.reduce((a, b) => a + b, 0) - s.durationSeconds) < 0.01;
  }],
  ["模板11 声音分层标签", (s) => /(环境声[：:]|动作声[：:]|对白[：:])/u.test(s.soundDesign)],
  ["模板11 声音写了远近/衰减", (s) => /(远处|渐弱|渐强|回响|余响|由近及远|由远及近|逐渐远离|持续回荡)/u.test(s.soundDesign + s.videoPrompt)],
  ["反例 空泛节奏标签", (s) => /表演节奏[^，。]{0,8}[，。]/u.test(s.videoPrompt)],
  ["反例 hedging(似乎/略微/仿佛)", (s) => /(似乎|略微|仿佛)/u.test(s.videoPrompt)],
  ["禁配乐句逐字收尾", (s) => s.videoPrompt.trim().endsWith(NO_MUSIC_SENTENCE)],
  ["反例 禁配乐外仍描述配乐", (s) => {
    const body = s.videoPrompt.split(NO_MUSIC_SENTENCE).join("");
    return /(背景音乐|配乐|BGM|主题旋律|钢琴|吉他|口琴|木琴|弦乐|管弦)/u.test(body);
  }]
];

function collect(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { collect(p, out); continue; }
    if (e.name !== "model-output.txt") continue;
    let meta;
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, "metadata.json"), "utf8")); } catch { continue; }
    if (meta?.attempt?.phase !== "animation-shot-batch") continue;
    const at = Date.parse(meta.recordedAt);
    if (!(at >= SINCE)) continue;
    const raw = fs.readFileSync(p, "utf8");
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch {
      const m = raw.match(/\{[\s\S]*\}/u);
      if (m) { try { parsed = JSON.parse(m[0]); } catch { /* 未闭合的截断输出，跳过 */ } }
    }
    if (!Array.isArray(parsed?.shotPlan)) continue;
    for (const shot of parsed.shotPlan) {
      const videoPrompt = String(shot.videoPrompt || "");
      // 已下线的 H3 方言（英文分节，带 [Shot n] 起始标记）与 Seedance 中文方言
      // 完全不可比：下面全部规则都是中文表面代理，混进来只会把基线压低。
      if (/\[Shot\s*\d+\]/u.test(videoPrompt) || !/[\u4e00-\u9fa5]/u.test(videoPrompt)) continue;
      out.push({
        era: at < SPLIT ? "3.0" : "3.1",
        recordedAt: meta.recordedAt,
        model: `${meta.provider?.name || "?"}/${meta.provider?.model || "?"}`,
        project: meta.production?.projectId || "?",
        variant: meta.production?.variantId || "?",
        shotId: shot.shotId,
        durationSeconds: Number(shot.durationSeconds) || 0,
        videoPrompt,
        cameraMotion: String(shot.cameraMotion || ""),
        soundDesign: String(shot.soundDesign || "")
      });
    }
  }
  return out;
}

const shots = collect(ROOT, []);
if (!shots.length) {
  console.error(`${ROOT} 下没有符合条件的 animation-shot-batch 落盘。`);
  process.exit(1);
}
const eras = ["3.0", "3.1"].map((era) => ({ era, rows: shots.filter((s) => s.era === era) })).filter((g) => g.rows.length);

console.log("语料构成（同一口径下的分母，必须一起报告）");
for (const { era, rows } of eras) {
  const dur = [...new Set(rows.map((r) => r.durationSeconds))].sort((a, b) => a - b);
  const stories = new Set(rows.map((r) => `${r.project}/${r.variant}`));
  const models = new Set(rows.map((r) => r.model));
  console.log(`  ${era}: ${rows.length} 镜 · 时长 ${dur.join("/")}s · ${stories.size} 个剧情 · ${[...models].join(",")}`);
}

const pad = (s, n) => s + " ".repeat(Math.max(0, n - [...s].reduce((a, c) => a + (c.charCodeAt(0) > 255 ? 2 : 1), 0)));
console.log(`\n${pad("规则（表面代理，非语义判定）", 34)}${eras.map((g) => pad(g.era, 12)).join("")}`);
for (const [label, fn] of RULES) {
  const cells = eras.map(({ rows }) => {
    const scored = rows.map(fn).filter((v) => v !== null);
    if (!scored.length) return pad("—", 12);
    const hit = scored.filter(Boolean).length;
    return pad(`${hit}/${scored.length} ${Math.round((hit / scored.length) * 100)}%`, 12);
  });
  console.log(pad(label, 34) + cells.join(""));
}
console.log("\n注：「反例」行越低越好，其余越高越好。样本小于 ~30 镜时只看方向，不下结论。");

if (args.includes("--dump")) {
  const file = "/tmp/video-prompt-rubric-shots.json";
  fs.writeFileSync(file, JSON.stringify(shots, null, 2));
  console.log(`\n已导出 ${shots.length} 条到 ${file}`);
}
