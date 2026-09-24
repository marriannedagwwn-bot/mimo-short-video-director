// 离线回放「陷入逐字重复」判定：扫 debug 目录里全部落盘的 model-output，
// 用 src/output-degeneration.js 同一份规则按边收边查的步长模拟，统计命中与误报。
//
//   node scripts/output-degeneration-replay.mjs [debugRoot]
//
// 分组依据是 metadata 里供应商报告的 finish_reason：length（被截断）与 stop（正常结束）。
// 被截断的里面既有真死循环，也有推理吃光额度、正文为空的；后者正文太短，本来就不会命中。
// 正常结束的输出不应有任何一次命中——有就是误报。不花钱，不调模型。
import fs from "node:fs";
import path from "node:path";
import { createDegenerationWatch } from "../src/output-degeneration.js";

const root = path.resolve(process.argv[2] || "debug");

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name === "metadata.json") yield full;
  }
}

// 按边收边查的方式喂前缀：每次多 CHECK_EVERY 字（最后一次喂全文），与读取流程里的计数器同一个。
function firstHit(text) {
  const watch = createDegenerationWatch();
  for (let end = 1; end <= text.length; end = Math.min(text.length, end + 250)) {
    const hit = watch.check("content", text.slice(0, end));
    if (hit) return { ...hit, at: end };
    if (end === text.length) break;
  }
  return null;
}

const tally = { length: { total: 0, hit: 0, emptyContent: 0 }, stop: { total: 0, hit: 0 } };
const falsePositives = [];
const truncated = [];
for (const metadataPath of walk(root)) {
  let metadata;
  try { metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")); } catch { continue; }
  const finishReason = metadata?.provider?.finishReason;
  if (finishReason !== "length" && finishReason !== "stop") continue;
  const outputPath = path.join(path.dirname(metadataPath), "model-output.txt");
  if (!fs.existsSync(outputPath)) continue;
  const text = fs.readFileSync(outputPath, "utf8");
  const hit = firstHit(text);
  const group = tally[finishReason];
  group.total += 1;
  if (hit) group.hit += 1;
  if (finishReason === "length") {
    if (!text.length) group.emptyContent += 1;
    truncated.push({ file: path.relative(root, outputPath), length: text.length, hit });
  } else if (hit) {
    falsePositives.push({ file: path.relative(root, outputPath), ...hit });
  }
}

console.log(`被截断（finish=length）：${tally.length.total} 份，命中 ${tally.length.hit}，其中正文为空 ${tally.length.emptyContent}`);
for (const item of truncated) {
  console.log(`  ${item.hit ? "命中" : "未中"} ${item.length} 字${item.hit ? `｜周期 ${item.hit.period} × ${item.hit.repeats}｜第 ${item.hit.at} 字时｜${JSON.stringify(item.hit.unit.slice(0, 40))}` : ""}｜${item.file}`);
}
console.log(`正常结束（finish=stop）：${tally.stop.total} 份，误报 ${tally.stop.hit}`);
for (const item of falsePositives) console.log(`  误报：${item.file}｜周期 ${item.period}｜${JSON.stringify(item.unit.slice(0, 40))}`);
