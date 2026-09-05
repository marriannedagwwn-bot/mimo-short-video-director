// 构造 OpenAI 兼容的 SSE 响应，供测试 mock fetch 使用。
//
// qwen-client 自 2026-09-05 起对全部模型使用流式传输（非流式长请求会在约 306 秒
// 被上游掐断），因此 mock 必须发 SSE 而不是完整 JSON 响应体。测试意图不变，
// 变的只是传输格式。判定只有一份，禁止各测试文件自己拼 SSE 文本。

export function sseChunks({ content = "", finishReason = "stop", usage = null, id = "" } = {}) {
  const lines = [];
  if (content) {
    lines.push(`data: ${JSON.stringify({ ...(id ? { id } : {}), choices: [{ delta: { content } }] })}\n\n`);
  }
  lines.push(`data: ${JSON.stringify({
    ...(id ? { id } : {}),
    choices: [{ delta: {}, finish_reason: finishReason }],
    ...(usage ? { usage } : {})
  })}\n\n`);
  lines.push("data: [DONE]\n\n");
  return lines.join("");
}

export function sseResponse(options = {}) {
  return new Response(sseChunks(options), {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
}
