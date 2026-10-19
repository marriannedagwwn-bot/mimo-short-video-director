// 构造 Anthropic Messages API 的流式响应（SSE），供 Claude 客户端的测试 mock fetch 使用。
//
// 事件顺序按官方文档：message_start → content_block_start / delta / stop … → message_delta → message_stop，
// 中间可以夹 ping。https://platform.claude.com/docs/en/build-with-claude/streaming（2026-10-19 核对）
// 判定只有一份，禁止各测试文件自己拼 Anthropic SSE 文本。

function sseEvent(type, data) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

export function anthropicSseEvents({
  content = "",
  thinking = "",
  stopReason = "end_turn",
  stopDetails = null,
  inputTokens = 101,
  outputTokens = 37,
  id = "msg_fixture",
  model = "claude-opus-5-5",
  ping = true,
  stop = true,
  // 带 message_delta（含用量）但不带 message_stop：模拟「用量收到了、结束标志没到」的断流。
  omitStop = false,
  errorEvent = null
} = {}) {
  const events = [
    sseEvent("message_start", {
      message: {
        id, type: "message", role: "assistant", content: [], model,
        stop_reason: null, stop_sequence: null,
        usage: { input_tokens: inputTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 }
      }
    })
  ];
  let index = 0;
  if (thinking) {
    events.push(sseEvent("content_block_start", { index, content_block: { type: "thinking", thinking: "", signature: "" } }));
    events.push(sseEvent("content_block_delta", { index, delta: { type: "thinking_delta", thinking } }));
    events.push(sseEvent("content_block_delta", { index, delta: { type: "signature_delta", signature: "sig-fixture" } }));
    events.push(sseEvent("content_block_stop", { index }));
    index += 1;
  }
  if (ping) events.push(sseEvent("ping", {}));
  if (content) {
    events.push(sseEvent("content_block_start", { index, content_block: { type: "text", text: "" } }));
    events.push(sseEvent("content_block_delta", { index, delta: { type: "text_delta", text: content } }));
    events.push(sseEvent("content_block_stop", { index }));
  }
  if (errorEvent) {
    events.push(`event: error\ndata: ${JSON.stringify({ type: "error", error: errorEvent })}\n\n`);
    return events.join("");
  }
  if (stop) {
    events.push(sseEvent("message_delta", {
      delta: { stop_reason: stopReason, stop_sequence: null, stop_details: stopDetails },
      usage: { output_tokens: outputTokens }
    }));
    if (!omitStop) events.push(sseEvent("message_stop", {}));
  }
  return events.join("");
}

export function anthropicSseResponse(options = {}) {
  return new Response(anthropicSseEvents(options), {
    status: 200,
    headers: { "content-type": "text/event-stream", "request-id": options.requestId || "req_fixture" }
  });
}

export function anthropicErrorResponse(status, type, message = "fixture error") {
  return new Response(JSON.stringify({ type: "error", error: { type, message }, request_id: "req_error_fixture" }), {
    status,
    headers: { "content-type": "application/json", "request-id": "req_error_fixture" }
  });
}
