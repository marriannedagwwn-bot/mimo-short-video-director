// OpenAI 兼容 Server-Sent Events 的唯一一份解析实现。
//
// 存在理由（2026-09-05 实测）：非流式长请求会在约 306 秒被上游掐断。debug 侧车里
// kimi-k3 与 qwen3.8-max-0902 各两次，耗时 306503/306696/306704/306861ms，浮动仅
// 358ms，跨两个模型——是确定性的固定超时，不是网络抖动。四次全部零字节输出。
// 而成功调用最慢 234 秒，离这条悬崖只剩 72 秒余量，所以这是传输层问题而非模型问题。
// 流式让字节持续流动，不再有长静默窗口。
//
// 本模块只做解析，不决定错误语义：流不完整时抛 SseStreamIncompleteError，
// 由调用方包装成它自己的 provider 错误。这样解析可以脱离任何 client 单测。

// raw 用于错误诊断（进 ModelResponseError 的 detail）。SSE 原文比等价的非流式响应体
// 大一个数量级（每几个字一个数据块），全留会撑爆内存与日志，因此保留头尾、掐掉中段。
const DEFAULT_MAX_RAW_CHARS = 200_000;

export class SseStreamIncompleteError extends Error {
  constructor(message, { raw = "", partialContent = "", partialLength = 0 } = {}) {
    super(message);
    this.name = "SseStreamIncompleteError";
    this.code = "MODEL_STREAM_INCOMPLETE";
    this.raw = raw;
    // 只带长度不带正文：半截内容绝不能被当成可用结果传下去，留长度是为了诊断
    // 「断在哪里」。调用方需要正文时自己从 raw 里取。
    this.partialLength = partialLength || partialContent.length;
  }
}

function truncateRaw(raw, maxChars) {
  if (raw.length <= maxChars) return raw;
  const half = Math.floor(maxChars / 2);
  return `${raw.slice(0, half)}\n…[中段 ${raw.length - maxChars} 字符已省略]…\n${raw.slice(-half)}`;
}

/**
 * 把一条 OpenAI 兼容的 SSE 流读成与非流式等价的结果。
 *
 * @param {ReadableStream|AsyncIterable} body  Response.body
 * @param {object} options
 * @param {number} options.maxRawChars  raw 的保留上限
 * @param {(progress:{contentLength:number,chunks:number})=>void} options.onProgress
 *        每收到一个数据块调用一次，用于 Durable Task 心跳。异常一律吞掉——
 *        观测不得改变传输结论。
 * @returns {Promise<{content,reasoningContent,finishReason,id,usage,raw,chunks}>}
 */
export async function readSseCompletion(body, { maxRawChars = DEFAULT_MAX_RAW_CHARS, onProgress = null } = {}) {
  if (!body) throw new TypeError("readSseCompletion 需要可读的响应体");

  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let raw = "";
  let content = "";
  let reasoningContent = "";
  let finishReason = "";
  let id = "";
  let usage = null;
  let chunks = 0;
  let sawDone = false;

  const notify = () => {
    if (typeof onProgress !== "function") return;
    try {
      onProgress({ contentLength: content.length, chunks });
    } catch {
      // 观测失败不得改变传输结论
    }
  };

  const handleLine = (line) => {
    const trimmed = line.trim();
    // SSE 注释行（心跳）与事件名行都不承载数据
    if (!trimmed || trimmed.startsWith(":") || /^(event|id|retry):/u.test(trimmed)) return;
    if (!trimmed.startsWith("data:")) return;

    const payload = trimmed.slice(5).trim();
    if (!payload) return;
    if (payload === "[DONE]") {
      sawDone = true;
      return;
    }
    // [DONE] 之后的任何内容都不再改变结果
    if (sawDone) return;

    let event;
    try {
      event = JSON.parse(payload);
    } catch {
      // 单个数据块不是 JSON 不足以判定整流失败：跳过它，让结束判定去裁决。
      return;
    }

    chunks += 1;
    if (!id && event?.id) id = String(event.id);
    if (event?.usage && typeof event.usage === "object") usage = event.usage;

    const choice = event?.choices?.[0];
    if (!choice) return;
    const delta = choice.delta || {};
    if (typeof delta.content === "string") content += delta.content;
    // 推理内容单独收集，绝不混进正文——否则会被当成 JSON 正文送进 validator
    if (typeof delta.reasoning_content === "string") reasoningContent += delta.reasoning_content;
    if (choice.finish_reason) finishReason = String(choice.finish_reason);
  };

  const consume = (text) => {
    raw += text;
    buffer += text;
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      handleLine(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
    }
    notify();
  };

  const reader = typeof body.getReader === "function" ? body.getReader() : null;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // stream: true 是必须的：一个汉字的 UTF-8 字节可能被拆到两个数据块，
      // 对每块单独 decode 会产生乱码。
      consume(decoder.decode(value, { stream: true }));
    }
  } else {
    for await (const value of body) {
      consume(decoder.decode(value, { stream: true }));
    }
  }
  consume(decoder.decode());
  // 流结束时最后一行可能没有换行符
  if (buffer) {
    handleLine(buffer);
    buffer = "";
  }

  const keptRaw = truncateRaw(raw, maxRawChars);

  // 结束判定：既没有 [DONE] 也没有任何 finish_reason，就是连接在中途断了。
  // 绝不把半截内容当成成功返回——半截 JSON 会被下游报成「JSON 格式错误」，
  // 把传输问题伪装成模型输出问题。
  if (!sawDone && !finishReason) {
    throw new SseStreamIncompleteError(
      `流式响应在收到结束标志前中断（已接收 ${content.length} 字，${chunks} 个数据块）`,
      { raw: keptRaw, partialLength: content.length }
    );
  }

  return { content, reasoningContent, finishReason, id, usage, raw: keptRaw, chunks };
}
