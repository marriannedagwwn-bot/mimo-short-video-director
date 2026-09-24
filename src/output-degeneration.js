// 流式输出「陷入逐字重复」的确定性判定。唯一一份：SSE 读取、离线回放脚本与测试都用它。
//
// 为什么需要它（2026-09-24）：09-23 把输出上限统一成 32768，理由是「上限是模型陷入重复输出时
// 唯一的刹车」。可同一天 MiMo 开思考跑候选推理了 2.9 万 token 被截断、整次作废——那不是死循环，
// 是本来就长。有了这道检查，上限就不再是唯一的刹车，可以放到供应商自己的最大值。
//
// 判据只看形状、不看内容好坏：最近 WINDOW 字里，末尾一段不超过 MAX_PERIOD 字符的单元
// 首尾相接地重复，连续覆盖不少于 MIN_COVERAGE。离线验证（debug 全部 model-output）：
// 08-30 那 12 份真正陷入重复的完整剧情（结尾全是 11–36 字符的一小段反复出现）12/12 命中；
// 2184 份正常结束的输出按 CHECK_EVERY 步长模拟边收边查，共 8431 次检查，误报 0。
//
// 它抓不到的：不逐字重复的「越想越长」，以及换着措辞兜圈子的推理。推理流从来没有落盘，
// 手里没有推理陷入循环的样本，规则对推理流是否有效没有验证过——那一侧仍靠供应商上限兜底。

export const DEGENERATION_WINDOW_CHARS = 2000;
export const DEGENERATION_MAX_PERIOD = 80;
export const DEGENERATION_MIN_COVERAGE = 0.6;
export const DEGENERATION_CHECK_EVERY_CHARS = 1000;

/**
 * 看文本末尾是不是在原地逐字重复。
 * 取最后 DEGENERATION_WINDOW_CHARS 字；窗口不满时不判定（样本太短，短周期重复可能是合法内容）。
 * @returns {{period:number, repeats:number, unit:string}|null}
 */
export function detectRepetitionLoop(text) {
  const source = typeof text === "string" ? text : "";
  if (source.length < DEGENERATION_WINDOW_CHARS) return null;
  const window = source.slice(-DEGENERATION_WINDOW_CHARS);
  const needed = window.length * DEGENERATION_MIN_COVERAGE;
  for (let period = 1; period <= DEGENERATION_MAX_PERIOD; period += 1) {
    const unit = window.slice(-period);
    let repeats = 0;
    let end = window.length;
    while (end - period >= 0 && window.slice(end - period, end) === unit) {
      repeats += 1;
      end -= period;
    }
    if (repeats * period >= needed) return { period, repeats, unit };
  }
  return null;
}

/**
 * 边收边查的计数器：每个流各自每新增 DEGENERATION_CHECK_EVERY_CHARS 字才检查一次，
 * 不随数据块多少变化，结果可复现。
 */
export function createDegenerationWatch() {
  const nextCheckAt = new Map();
  return {
    check(streamName, text) {
      const length = typeof text === "string" ? text.length : 0;
      const threshold = nextCheckAt.get(streamName) ?? DEGENERATION_WINDOW_CHARS;
      if (length < threshold) return null;
      nextCheckAt.set(streamName, length + DEGENERATION_CHECK_EVERY_CHARS);
      return detectRepetitionLoop(text);
    }
  };
}
