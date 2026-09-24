// 流式请求的空闲超时：从发出请求起，只要连续 N 秒没有收到任何东西（响应头、正文、
// 推理内容、SSE 心跳注释都算）就中断；只要数据还在来，就不设总时长上限。
//
// 为什么不用总时长（AbortSignal.timeout）：它从发请求起一直计到读完响应体，不管数据
// 来没来都会在时限处掐断。2026-09-22 MiMo 候选阶段实测：流一直活着、已收到 6929 个
// 推理数据块，仍在 900 秒整被切断，推理全部作废。流式传输下「服务器还在不在响应」
// 由有没有数据回答，生成总长度由 max tokens 封顶，不需要再用墙钟兜一次。
//
// 非流式客户端（DeepSeek）等待期间本来就没有数据，无法区分「在算」与「挂了」，
// 仍使用总超时，不用这个模块。

export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 120_000;

export function resolveStreamIdleTimeoutMs(config) {
  const value = Number(config?.streamIdleTimeoutMs);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_STREAM_IDLE_TIMEOUT_MS;
}

/**
 * 创建一个空闲计时器。调用 touch() 表示刚收到数据；超过 timeoutMs 没有 touch 就 abort。
 * abort 的 reason 是 name 为 TimeoutError 的 DOMException，所以在还没拿到响应头时
 * 超时，fetch 的拒绝与原先的总超时同形（classifyAttemptError 归为 MODEL_TIMEOUT）。
 * 读流阶段超时由调用方检查 fired 后改报 MODEL_STREAM_IDLE_TIMEOUT。
 */
export function createStreamIdleTimer(timeoutMs) {
  const controller = new AbortController();
  let lastActivityAt = Date.now();
  let timer = null;
  let fired = false;
  let receivedAnything = false;

  const schedule = (delay) => {
    timer = setTimeout(check, Math.max(1, delay));
    timer.unref?.();
  };
  function check() {
    timer = null;
    const idleFor = Date.now() - lastActivityAt;
    if (idleFor < timeoutMs) {
      // 期间收到过数据：按最后一次收到的时间重新排期，而不是每个数据块重建定时器。
      schedule(timeoutMs - idleFor);
      return;
    }
    fired = true;
    const seconds = Math.round(timeoutMs / 1000);
    controller.abort(new DOMException(
      receivedAnything
        ? `流式传输连续 ${seconds} 秒没有收到任何数据`
        : `发出请求后 ${seconds} 秒内没有收到服务器响应`,
      "TimeoutError"
    ));
  }
  schedule(timeoutMs);

  return {
    signal: controller.signal,
    timeoutMs,
    get fired() {
      return fired;
    },
    touch() {
      receivedAnything = true;
      lastActivityAt = Date.now();
    },
    clear() {
      if (timer) clearTimeout(timer);
      timer = null;
    }
  };
}
