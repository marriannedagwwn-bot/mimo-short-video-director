// Claude（Anthropic）文本客户端（2026-10-19）。
//
// 走官方 SDK @anthropic-ai/sdk（package.json 锁死版本），只做纯文本阶段，与 DeepSeek 同一档：
// 要看图或视频的阶段一律拒绝（generateJsonWithMedia 直接报错，workflow 与页面各有一道关）。
// 对外接口与 DeepSeek / MiMo / 千问客户端一样，返回同样的 7 个字段，所以 coordinator、
// 截断与审核判定、记账、Durable 心跳都不用为 Claude 加分支。
//
// 与另外三家逐条对齐的约定（依据见 CLAUDE.md §2.7）：
// - 流式，只判空闲、不设总时长（src/stream-idle-timeout.js）。SDK 自带的 10 分钟超时只管等响应头，
//   这里放到 1 小时，空闲判定始终先触发。
// - SDK 自带的重试一律关掉（maxRetries: 0）：重试次数只由 coordinator 与各阶段的预算决定。
// - stop_reason 只统一两个值：max_tokens / model_context_window_exceeded → "length"（截断），
//   refusal → "content_filter"（审核拦截，不可重试）。其余照抄 Anthropic 的原值。
// - 不开 server-side fallbacks：被拒时它会自动换另一个模型继续跑，等于静默换模型。
// - 只在阶段明确给了 Claude 版 Schema（claudeResponseSchema）时才发 output_config.format（2026-10-21，
//   目前只有 4.0 分镜审阅与终审复查）。responseSchema 参数在这里仍被忽略，与千问、DeepSeek 一样：
//   那几份是给 MiMo 派生的，用了 minLength / maxItems / minimum，Claude 的结构化输出不支持，直接发会 400。
//   其余阶段的 JSON 靠提示词、本地严格解析与已有的重试预算（整段被一对代码块包着时先去掉包裹，
//   见 unwrapWholeCodeFence）。
// - 不发 temperature / top_p：这几个型号不接受或只接受默认值。不做 assistant 预填（会 400）。
// 只用官方文档写明的事；出处与核对日期写在用到的地方。

import Anthropic, { APIConnectionTimeoutError, APIError, APIUserAbortError } from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT } from "./prompts.js";
import {
  ModelResponseError,
  assertCompletionNotContentFiltered,
  assertCompletionNotTruncated,
  outputDegenerateError,
  parseModelJson,
  parseStrictModelJson,
  streamIdleTimeoutError
} from "./mimo-client.js";
import { recordModelUsage } from "./token-usage.js";
import { afterDurableProviderCall, beforeDurableProviderCall, durableTaskHeartbeat, durableProviderAbortSignal, throwIfDurableTaskAborted } from "./durable-task-context.js";
import { createDegenerationWatch } from "./output-degeneration.js";
import { SseStreamDegenerateError, degenerationError, truncateRaw } from "./sse-stream.js";
import { CLAUDE_OUTPUT_TOKEN_CEILING, growOutputTokenLimit } from "./output-token-ceilings.js";
import { createStreamIdleTimer, resolveStreamIdleTimeoutMs } from "./stream-idle-timeout.js";
import { resolveThinkingOverride } from "./thinking-override.js";

const PROVIDER = "Claude";
export const CLAUDE_DEFAULT_BASE_URL = "https://api.anthropic.com";
// 默认型号（2026-10-19，用户按《鲸鱼风筝》设计分镜对比定的）：Sonnet 5.5 两次都过判据、没有包代码块，
// 每次约 $0.24、2.5 分钟左右。对比数据见 docs/claude-provider-2026-10-19.md。
export const CLAUDE_DEFAULT_MODEL = "claude-sonnet-5-5";
// SDK 的 timeout 只覆盖「发出请求到收到响应头」，读流期间不计（client.js fetchWithTimeout）。
// 放到 1 小时，让 stream-idle-timeout 的空闲判定（上限 15 分钟）始终先触发。
const SDK_HEADER_TIMEOUT_MS = 3_600_000;
const HEALTH_TIMEOUT_MS = 5_000;

// 单次请求关闭思考时每个型号该怎么发。出处：https://platform.claude.com/docs/en/api/errors
// 「Thinking cannot be disabled」一节，2026-10-19 核对：
// - Opus 5.5、Fable 5.1 思考一直开着，发 disabled 会 400；
// - Sonnet 5.5 不能发 disabled，要发 between_tools（不在回答前思考）；
// - Haiku 5.5 接受 disabled。
// 后两种在 effort 为 xhigh / max 时都会 400。只登记这四个型号，没登记的不猜。
export const CLAUDE_THINKING_OFF = Object.freeze({
  "claude-opus-5-5": null,
  "claude-sonnet-5-5": "between_tools",
  "claude-haiku-5-5": "disabled",
  "claude-fable-5-1": null
});
export const CLAUDE_MODELS = Object.freeze(Object.keys(CLAUDE_THINKING_OFF));
// https://platform.claude.com/docs/en/build-with-claude/effort（2026-10-19 核对）
export const CLAUDE_EFFORTS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);
const EFFORTS_FORBIDDING_THINKING_OFF = new Set(["xhigh", "max"]);

/** 关不掉思考时返回说明（导演助手在调用前用它给出 400）；能关返回空串。 */
export function claudeThinkingOffProblem(model, effort = "") {
  const key = String(model || "").trim();
  if (!Object.hasOwn(CLAUDE_THINKING_OFF, key)) {
    return `${key || "未指定的 Claude 型号"} 没有登记能不能关闭思考；请换成 ${CLAUDE_MODELS.join("、")} 之一。`;
  }
  if (CLAUDE_THINKING_OFF[key] === null) return `${key} 不能关闭思考，请换一个能关闭思考的模型。`;
  if (EFFORTS_FORBIDDING_THINKING_OFF.has(effort)) {
    return `${key} 关闭思考时 effort 只能是 high 或更低，当前 CLAUDE_API_EFFORT=${effort}。`;
  }
  return "";
}

/** CLAUDE_API_EFFORT 只接受官方的五档；空串表示不发、用型号自己的默认值。写错直接报错，不回退。 */
export function normalizeClaudeEffort(value) {
  const effort = String(value ?? "").trim().toLowerCase();
  if (!effort) return "";
  if (!CLAUDE_EFFORTS.includes(effort)) {
    throw new Error(`CLAUDE_API_EFFORT 只能是 ${CLAUDE_EFFORTS.join(" / ")}，收到「${value}」。删掉这一行就用各型号自己的默认值。`);
  }
  return effort;
}

export class ClaudeClient {
  constructor(config) {
    this.config = { ...config, effort: normalizeClaudeEffort(config?.effort) };
  }

  // 每次请求新建一个 SDK 客户端：读流期间要按收到的字节刷新这一次请求自己的空闲计时，
  // 而 SDK 不把 ping 交给调用方，只能在 fetch 这一层看字节。构造只是组装对象，不发网络请求。
  sdkClient({ onBytes = null } = {}) {
    return new Anthropic({
      // 一律给字符串：给 undefined 时 SDK 会去读 ANTHROPIC_API_KEY，给 null 时会去找本机的凭据配置。
      apiKey: String(this.config.apiKey || ""),
      // 显式给出，免得 SDK 自己去读 shell 里的 ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL。
      authToken: null,
      baseURL: this.config.baseUrl || CLAUDE_DEFAULT_BASE_URL,
      maxRetries: 0,
      timeout: SDK_HEADER_TIMEOUT_MS,
      // 不跟随 ANTHROPIC_LOG：debug 级会把请求体（提示词）打进控制台。
      logLevel: "warn",
      // 调用时才取 globalThis.fetch：--use-env-proxy、src/system-proxy.js 的全局 dispatcher、
      // 测试里 mock 的 fetch 都在这一刻生效。
      fetch: tappedFetch(onBytes)
    });
  }

  // 只核对所选型号在不在，不列出 /v1/models 的全部型号：旧型号的参数规则不一样，选到会直接 400，
  // 页面只登记 CLAUDE_MODELS 这四个。
  async checkHealth(requestedModel = this.config.model) {
    const model = requestedModel || this.config.model;
    try {
      await this.sdkClient().models.retrieve(model, { timeout: HEALTH_TIMEOUT_MS, maxRetries: 0 });
      return { reachable: true, modelAvailable: true, status: 200, modelIds: [] };
    } catch (error) {
      if (error instanceof APIError && error.status) {
        return { reachable: error.status === 404, modelAvailable: false, status: error.status, modelIds: [] };
      }
      return { reachable: false, modelAvailable: false, status: 0, modelIds: [] };
    }
  }

  async generateJson({
    prompt,
    model = null,
    maxCompletionTokens = null,
    systemPrompt = null,
    requestTimeoutMs = null,
    jsonRetryAttempts = null,
    strictJson = false,
    onCompletion = null,
    claudeResponseSchema = null
  } = {}) {
    return this.requestJson({
      prompt,
      model,
      maxCompletionTokens,
      systemPrompt,
      requestTimeoutMs,
      jsonRetryAttempts,
      strictJson,
      onCompletion,
      claudeResponseSchema
    });
  }

  async generateJsonWithMedia() {
    throw new ModelResponseError(
      "Claude 在本工作流只用于纯文本阶段，不能接收图片或视频输入",
      "",
      0,
      {
        provider: PROVIDER,
        code: "MODEL_MEDIA_UNSUPPORTED"
      }
    );
  }

  async requestJson({
    prompt,
    model = null,
    maxCompletionTokens = null,
    systemPrompt = null,
    requestTimeoutMs = null,
    jsonRetryAttempts = null,
    strictJson = false,
    onCompletion = null,
    claudeResponseSchema = null
  }) {
    const retryAttempts = jsonRetryAttempts === null
      ? Number.isFinite(Number(this.config.jsonRetryAttempts)) ? Number(this.config.jsonRetryAttempts) : 2
      : Math.max(0, Number(jsonRetryAttempts) || 0);
    let activePrompt = prompt;
    let activeMaxTokens = maxCompletionTokens;
    let lastJsonError = null;

    for (let attempt = 0; attempt <= retryAttempts; attempt += 1) {
      const completion = await this.requestCompletion({
        prompt: activePrompt,
        model,
        maxCompletionTokens: activeMaxTokens,
        systemPrompt,
        requestTimeoutMs,
        claudeResponseSchema
      });
      await notifyCompletion(onCompletion, completion);
      const content = completion.content;
      assertCompletionNotContentFiltered(completion, PROVIDER);
      try {
        assertCompletionNotTruncated(completion, PROVIDER);
        return strictJson
          ? parseStrictModelJson(content, PROVIDER)
          : parseModelJson(content, PROVIDER);
      } catch (error) {
        if (!(error instanceof ModelResponseError) || attempt >= retryAttempts) throw error;
        lastJsonError = error;
        activePrompt = jsonRetryPrompt(prompt, content);
        activeMaxTokens = retryTokenLimit(activeMaxTokens ?? this.config.maxCompletionTokens);
      }
    }

    throw lastJsonError || new ModelResponseError("Claude 未返回合法 JSON");
  }

  async requestCompletion({
    prompt,
    model = null,
    maxCompletionTokens = null,
    systemPrompt = null,
    requestTimeoutMs = null,
    thinking = null,
    claudeResponseSchema = null
  } = {}) {
    // 关不掉思考等问题在这里就抛出，一次请求都不发。
    const body = buildClaudeRequestBody(
      this.config,
      { prompt },
      { model, maxCompletionTokens, systemPrompt, thinking, claudeResponseSchema }
    );
    // 流式请求不设总时长上限，只判空闲；requestTimeoutMs 只为统一签名保留。
    const idleTimeoutMs = resolveStreamIdleTimeoutMs(this.config);
    await beforeDurableProviderCall("model_provider_call", idleTimeoutMs);
    const idle = createStreamIdleTimer(idleTimeoutMs);
    try {
      return await this.streamCompletion({ body, idle });
    } finally {
      idle.clear();
    }
  }

  async streamCompletion({ body, idle }) {
    const state = {
      content: "",
      reasoning: "",
      stopReason: "",
      stopDetails: null,
      usage: null,
      id: "",
      events: 0,
      sawStop: false,
      raw: ""
    };
    // Durable 心跳按 10 秒节流；推理期间也续报。观测失败不改变传输结论。
    let lastHeartbeatAt = 0;
    const heartbeat = () => {
      const now = Date.now();
      if (now - lastHeartbeatAt < 10_000) return;
      lastHeartbeatAt = now;
      Promise.resolve(durableTaskHeartbeat({ streamedChars: state.content.length, reasoningChars: state.reasoning.length })).catch(() => {});
    };
    // 任何字节（包括 SDK 不交给调用方的 ping）都算「有数据」：刷新空闲计时。第一个事件解析出来之后，
    // 只有 ping 的时段也照样续报心跳；在那之前不报，和另外三家「读到数据块才报进度」同序。
    const onBytes = () => {
      idle.touch();
      if (state.events > 0) heartbeat();
    };

    let stream;
    let headerRequestId = "";
    try {
      const opened = await this.sdkClient({ onBytes })
        .messages.create(body, { signal: durableProviderAbortSignal(null, idle.signal), maxRetries: 0 })
        .withResponse();
      stream = opened.data;
      headerRequestId = String(opened.request_id || "");
    } catch (error) {
      throwIfDurableTaskAborted();
      if (error instanceof APIError && error.status) {
        await afterDurableProviderCall("model_provider_response");
        throw httpError(error);
      }
      // 收到响应头之前就失败：还原成与另外三家同形的错误，classifyAttemptError 不用为 Claude 加分支。
      throw preResponseError(error, idle);
    }

    const degeneration = createDegenerationWatch();
    const checkDegeneration = (streamName, text) => {
      const hit = degeneration.check(streamName, text);
      if (!hit) return;
      throw degenerationError(streamName, hit, { contentLength: state.content.length, reasoningLength: state.reasoning.length });
    };

    try {
      for await (const event of stream) {
        state.events += 1;
        state.raw += `${JSON.stringify(event)}\n`;
        if (event?.type === "message_start") {
          state.id = String(event.message?.id || "");
          state.usage = mergeUsage(state.usage, event.message?.usage);
        } else if (event?.type === "content_block_delta") {
          const delta = event.delta || {};
          if (delta.type === "text_delta" && typeof delta.text === "string") {
            state.content += delta.text;
            if (delta.text) checkDegeneration("content", state.content);
          } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
            // 推理单独收集，绝不混进正文——否则会被当成 JSON 正文送进校验器。
            state.reasoning += delta.thinking;
            if (delta.thinking) checkDegeneration("reasoning", state.reasoning);
          }
        } else if (event?.type === "message_delta") {
          if (event.delta?.stop_reason) state.stopReason = String(event.delta.stop_reason);
          if (event.delta?.stop_details) state.stopDetails = event.delta.stop_details;
          state.usage = mergeUsage(state.usage, event.usage);
        } else if (event?.type === "message_stop") {
          state.sawStop = true;
        }
        heartbeat();
      }
    } catch (error) {
      // 只记实际收到的用量；取消、断流或冻结复检失败也不能丢账。
      recordModelUsage({ provider: PROVIDER, model: body.model, usage: state.usage });
      throwIfDurableTaskAborted();
      await afterDurableProviderCall("model_provider_response");
      const partial = partialInfo(state);
      if (idle.fired) throw streamIdleTimeoutError(PROVIDER, idle, partial, headerRequestId);
      // 必须排在「中途断开」之前：主动叫停的死循环同样已经收到过数据。
      if (error instanceof SseStreamDegenerateError) {
        throw outputDegenerateError(PROVIDER, Object.assign(error, partial), headerRequestId);
      }
      // 200 之后流里来了 event: error（例如 overloaded_error）。
      if (error instanceof APIError && !error.status) throw streamErrorEvent(error, partial, headerRequestId);
      if (state.events > 0) {
        throw new ModelResponseError(
          `Claude 流式传输在收到 ${state.content.length} 字正文（${state.events} 个事件）后中断：${error?.message || "连接中断"}`,
          partial.partialRaw,
          0,
          { provider: PROVIDER, code: "MODEL_STREAM_ABORTED", requestId: headerRequestId, usage: state.usage }
        );
      }
      throw error;
    }

    if (!state.sawStop) {
      // SDK 在连接被中止时静默结束迭代（取消、空闲超时都走这里），所以完整与否只看有没有 message_stop。
      recordModelUsage({ provider: PROVIDER, model: body.model, usage: state.usage });
      throwIfDurableTaskAborted();
      await afterDurableProviderCall("model_provider_response");
      const partial = partialInfo(state);
      if (idle.fired) throw streamIdleTimeoutError(PROVIDER, idle, partial, headerRequestId);
      // 半截内容绝不当成结果返回：否则残缺 JSON 会被下游报成「JSON 格式错误」。
      throw new ModelResponseError(
        `Claude 流式响应在收到 message_stop 前中断（已接收 ${state.content.length} 字，${state.events} 个事件）`,
        partial.partialRaw,
        0,
        { provider: PROVIDER, code: "MODEL_STREAM_INCOMPLETE", requestId: headerRequestId, usage: state.usage }
      );
    }

    // 已完成响应的用量先记账；随后冻结复检失败也不能抹掉已发生的消耗。
    recordModelUsage({ provider: PROVIDER, model: body.model, usage: state.usage });
    await afterDurableProviderCall("model_provider_response");
    const finishDetail = describeStopDetails(state.stopDetails);
    const unwrapped = unwrapWholeCodeFence(state.content);
    return {
      content: unwrapped.content,
      finishReason: normalizeClaudeStopReason(state.stopReason),
      requestId: headerRequestId || state.id,
      usage: state.usage,
      providerName: PROVIDER,
      model: body.model,
      // raw 是原样的事件流，去掉包裹之前的正文在这里照样查得到。
      raw: truncateRaw(state.raw),
      ...(finishDetail ? { finishDetail } : {}),
      ...(unwrapped.unwrapped ? { contentUnwrappedFromCodeFence: true } : {})
    };
  }
}

// 整段正文恰好被一对 Markdown 代码块包着时去掉这层包裹（2026-10-19，用户确认）。
// Claude 没有 JSON 模式；《鲸鱼风筝》设计分镜对比里 Haiku 4 次把整份 JSON 包在 ```json … ``` 里，
// 里面的 JSON 完整合法（docs/claude-provider-2026-10-19.md）。包裹不是内容，去掉它是唯一、不丢信息的变换。
// 只认「开头一行是 ``` 或 ```json，结尾一行是 ```，中间再没有以 ``` 开头的行」这一种形状；
// 代码块前后多了说明文字、两个代码块、没有收尾的代码块，一律原样交回，照旧由严格解析判失败。
const WHOLE_CODE_FENCE = /^```(?:json)?[ \t]*\r?\n([\s\S]*)\r?\n```$/iu;

export function unwrapWholeCodeFence(text) {
  const value = typeof text === "string" ? text : "";
  const match = WHOLE_CODE_FENCE.exec(value.trim());
  if (!match || /^```/mu.test(match[1])) return { content: value, unwrapped: false };
  return { content: match[1], unwrapped: true };
}

export function buildClaudeRequestBody(config, { prompt }, overrides = {}) {
  const model = overrides.model || config.model || CLAUDE_DEFAULT_MODEL;
  const effort = normalizeClaudeEffort(config.effort);
  const body = {
    model,
    max_tokens: overrides.maxCompletionTokens ?? config.maxCompletionTokens ?? CLAUDE_OUTPUT_TOKEN_CEILING,
    system: typeof overrides.systemPrompt === "string" && overrides.systemPrompt.trim()
      ? overrides.systemPrompt
      : SYSTEM_PROMPT,
    messages: [{ role: "user", content: prompt }],
    stream: true,
    thinking: claudeThinkingConfig(model, resolveThinkingOverride(overrides.thinking), effort)
  };
  if (effort) body.output_config = { effort };
  if (overrides.claudeResponseSchema) {
    const schema = overrides.claudeResponseSchema.schema;
    // 与关思考那条同理，用带码的 ModelResponseError：TypeError 会被协调器当成网络故障重试。
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
      throw new ModelResponseError("claudeResponseSchema 必须是 {name, schema}", "", 0, { provider: PROVIDER, code: "MODEL_RESPONSE_SCHEMA_INVALID" });
    }
    body.output_config = { ...body.output_config, format: { type: "json_schema", schema } };
  }
  return body;
}

// 默认开着自适应思考（四个型号都是），display: summarized 让页面能显示「已推理 N 字」；
// 推理写多少由型号自己决定，深浅用 CLAUDE_API_EFFORT 调。单次请求可以要求关闭（只有导演助手会传）。
function claudeThinkingConfig(model, override, effort) {
  if (override !== "disabled") return { type: "adaptive", display: "summarized" };
  const problem = claudeThinkingOffProblem(model, effort);
  if (problem) {
    // 用带码的 ModelResponseError 而不是 TypeError：后者在协调器里会被当成网络故障重试。
    throw new ModelResponseError(problem, "", 0, { provider: PROVIDER, code: "MODEL_THINKING_UNSUPPORTED" });
  }
  return { type: CLAUDE_THINKING_OFF[model] };
}

// 只统一截断与审核两个值，让 assertCompletionNotTruncated / assertCompletionNotContentFiltered
// 与 coordinator 的既有判定生效；其余照抄 Anthropic 的原值。
// https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons（2026-10-19 核对）
export function normalizeClaudeStopReason(stopReason) {
  const value = String(stopReason || "");
  if (value === "max_tokens" || value === "model_context_window_exceeded") return "length";
  if (value === "refusal") return "content_filter";
  return value;
}

function describeStopDetails(details) {
  if (!details || typeof details !== "object") return "";
  const parts = [];
  if (details.category) parts.push(`拒绝类别 ${details.category}`);
  if (details.explanation) parts.push(`说明：${String(details.explanation).slice(0, 300)}`);
  return parts.join("，");
}

// message_start 带输入 token，message_delta 带累计的输出 token；后到的覆盖先到的同名字段。
function mergeUsage(current, next) {
  if (!next || typeof next !== "object") return current;
  const merged = { ...(current || {}) };
  for (const [key, value] of Object.entries(next)) {
    if (value !== null && value !== undefined) merged[key] = value;
  }
  return merged;
}

function partialInfo(state) {
  return {
    partialRaw: truncateRaw(state.raw),
    partialContentLength: state.content.length,
    partialChunks: state.events,
    partialUsage: state.usage
  };
}

function httpError(error) {
  return new ModelResponseError(
    `Claude 请求失败（${error.status}）`,
    error.error ? JSON.stringify(error.error) : String(error.message || ""),
    error.status,
    {
      provider: PROVIDER,
      code: "MODEL_HTTP_ERROR",
      requestId: error.requestID || ""
    }
  );
}

// 官方「HTTP errors」一节的类型与状态码对照（https://platform.claude.com/docs/en/api/errors，2026-10-19 核对）。
// 流里来的 error 事件没有 HTTP 状态，按类型还原，沿用「429 / 5xx 可重试」的既有规则。
const ERROR_TYPE_STATUS = Object.freeze({
  invalid_request_error: 400,
  authentication_error: 401,
  billing_error: 402,
  permission_error: 403,
  not_found_error: 404,
  conflict_error: 409,
  request_too_large: 413,
  rate_limit_error: 429,
  api_error: 500,
  timeout_error: 504,
  overloaded_error: 529
});

function streamErrorEvent(error, partial, requestId) {
  const type = String(error.type || error.error?.error?.type || "");
  const message = String(error.error?.error?.message || error.message || "");
  return new ModelResponseError(
    `Claude 流式响应途中返回错误（${type || "未知类型"}）：${message}`,
    error.error ? JSON.stringify(error.error) : partial.partialRaw,
    ERROR_TYPE_STATUS[type] || 0,
    {
      provider: PROVIDER,
      code: "MODEL_PROVIDER_STREAM_ERROR",
      requestId,
      usage: partial.partialUsage
    }
  );
}

function preResponseError(error, idle) {
  // 空闲计时在收到响应头之前触发：与另外三家的 fetch 被 TimeoutError 中止同形（MODEL_TIMEOUT）。
  if (idle.fired && idle.signal.reason) return idle.signal.reason;
  if (error instanceof APIConnectionTimeoutError) {
    return new DOMException("Claude 在收到响应头之前超时", "TimeoutError");
  }
  if (error instanceof APIUserAbortError) return error;
  // 网络失败：SDK 把 fetch 的 TypeError 包在 APIConnectionError 里，交回原样的 TypeError。
  if (error?.cause instanceof TypeError) return error.cause;
  return error;
}

function tappedFetch(onBytes) {
  return async (url, init) => {
    const response = await globalThis.fetch(url, init);
    if (typeof onBytes !== "function" || !response.body) return response;
    onBytes();
    const tap = new TransformStream({
      transform(chunk, controller) {
        onBytes();
        controller.enqueue(chunk);
      }
    });
    return new Response(response.body.pipeThrough(tap), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  };
}

function jsonRetryPrompt(originalPrompt, failedContent) {
  return `${originalPrompt}

上一次模型输出不是完整合法 JSON，可能被截断或包含了无法解析的内容。请重新输出一次。

纠偏要求：
- 只输出一个完整 JSON 对象，不要 Markdown，不要解释。
- 必须保留原任务要求的所有顶层字段和数组字段。
- 内容可以更精炼，但不能省略结构字段。
- 每个字符串尽量控制在 80 个汉字以内，避免长段落导致再次截断。
- 不要复述上一次错误输出；直接重新生成完整 JSON。

上一次错误输出开头仅供诊断，不要照抄：
${String(failedContent || "").slice(0, 800)}`;
}

function retryTokenLimit(value) {
  return growOutputTokenLimit(value, { factor: 1.5, ceiling: CLAUDE_OUTPUT_TOKEN_CEILING });
}

// 只观测，不参与控制流：回调抛错或 reject 一律吞掉，日志 sidecar 不得改变模型调用的成败。
async function notifyCompletion(onCompletion, completion) {
  if (typeof onCompletion !== "function") return;
  try {
    await onCompletion(completion);
  } catch {
    // 观测失败必须 fail-open。
  }
}
