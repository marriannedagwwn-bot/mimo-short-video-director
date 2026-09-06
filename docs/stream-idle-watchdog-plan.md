# 流式空闲超时（idle watchdog）实施计划

**状态：待实施。** 本文件只记录方案与依据，不改变当前行为。

主线仍是剧情相关内容，本项属于传输层健壮性，等主线告一段落再做。

---

## 为什么要做

当前 `AbortSignal.timeout(effectiveTimeoutMs)` 是**总超时**：不管流是否还在出字，
到点就掐。这有两个方向的错误。

**误杀正常的长调用。** 2026-09-05 实测：一次评审调用正常出字 941 秒完成，
而 `QWEN_REQUEST_TIMEOUT_MS=900000`——它先撞我们自己的超时被掐死，放宽到 1500 秒后
同一份输入 941 秒成功。**那次失败完全是我们自己造成的**，与上游无关。

**发现真故障太慢。** 同一天的六次 `terminated` 失败，耗时 11s 到 737s 不等。
如果连接在第 30 秒就断了，总超时要等到 900 秒才可能反应——而实际上 undici 会先抛
`TypeError: terminated`，所以总超时在这类故障里根本没起作用。它唯一真正生效的场合，
恰恰是误杀那次。

流式已经提供了更准确的信号：**有数据流动就说明连接活着**。判据应该是
「多久没有收到任何数据」，而不是「总共跑了多久」。

这个思路项目里已有先例，只是在另一层：Durable Task 的本地阶段使用「300 秒无进展窗口
并随进度续期」（见 CLAUDE.md Durable Task v1 一节）。本计划是把同一思路下沉到
client 传输层。

---

## 不能完全取消总超时

有一个明确的反例。2026-09-05 的一次 kimi-k3 评审调用陷入生成退化：先编造格式定义
之外的字段（`audit_id`、`certification_body`），随后滑进英文同义词的重复循环
（`"argued": true, "quarreled": true, "bickered": true…`），正常内容只占 11.2%。

**它全程都在出字**——空闲超时永远不会触发。这次调用跑了 1700.9 秒，最终是撞
`max_tokens` 才停下，`finish_reason` 为 `length`。

所以必须保留一个宽松的总超时作为兜底。三层防线各司其职：

| 层 | 阈值 | 防的是 |
|---|---|---|
| 空闲超时（新增，主） | 无数据 120 秒 | 连接卡死、上游静默丢弃 |
| 总超时（放宽） | 30–60 分钟 | 生成退化这类「一直出字但永远不结束」 |
| `max_tokens`（已有） | 按阶段配置 | 退化的实际刹车 |

---

## 实施

### 1. `src/sse-stream.js` 增加 idle watchdog

该模块已有 `onProgress` 回调，每收到一个数据块触发一次，改动落点很小：

- 新增可选参数 `idleTimeoutMs`（默认 120000，传 0 或 null 表示关闭）
- 每次 `consume()` 收到数据时重置计时器
- 计时器到期时中止读取并抛错

**必须抛可重试的传输错误，不能抛成协议错误。** 新增 `SseStreamIdleError`，
`code` 用 `MODEL_STREAM_IDLE`，由 `qwen-client` 包装成 `ModelResponseError`。

### 2. `src/model-call-coordinator.js` 分类

`classifyAttemptError` 里给 `MODEL_STREAM_IDLE` 加分支，归入
`category: "transport"` + `retryable: true`——与既有的 `MODEL_STREAM_INCOMPLETE`
同规格。**不加这一条会落到 `ModelResponseError` 的兜底分支
（`status=0` → `protocol` 且 `retryable: false`），把可重试的网络故障变成不可重试的
协议错误**，这个坑流式改动时已经踩过一次。

### 3. `src/qwen-client.js` 传入配置

`idleTimeoutMs` 走与 `requestTimeoutMs` 相同的配置路径，允许按阶段覆盖。
`deepseek-client.js` 与 `mimo-client.js` 目前仍是非流式，不涉及。

### 4. 总超时放宽

只在**确认空闲超时可用之后**再放宽，否则会失去唯一的兜底。放宽的是默认值，
不改变按阶段覆盖的能力。

---

## 顺带解决的一件事

评审阶段（尚未进代码）实测正常成功最长 941 秒，现有 900 秒默认值不够。
空闲超时上线后，这个阶段不再需要一个精确的总超时估计——**只要它在出字就让它跑**。

在那之前，如果评审先落地，必须给它单独配置一个更长的总超时（建议 1800000），
不要动全局默认值：现有阶段实测最长 234 秒，900 秒有 3.8 倍余量，改全局是无谓的风险。

---

## 验证

1. **单元测试**（`test/sse-stream.test.js` 追加）：
   - 构造一个中途停止推送但不关闭的流，断言在 `idleTimeoutMs` 后抛 `MODEL_STREAM_IDLE`
   - 构造一个持续缓慢推送的流（间隔小于阈值、总时长超过阈值），断言**不**被中断
     ——这条是防误杀的关键
   - 断言该错误经 `classifyAttemptError` 后为 `transport` + `retryable: true`
   - `idleTimeoutMs: 0` 时行为与现在逐字一致
2. **回归**：`npm test`。已知 4 个 Windows 环境失败与本项无关
   （3 个权限位断言、1 个 `build identity` 读 HEAD）。
3. **真实验证**：用一次长评审调用确认不被误杀——那正是当初 941 秒那次的场景。

---

## 明确不做

- 不改 `deepseek-client` / `mimo-client`（仍是非流式，没有 chunk 可计）
- 不做非流式回退（违反 CLAUDE.md 第五节第 4 条）
- 不因为空闲超时就取消总超时（上面的退化案例是反例）
- 不在本计划里处理换模型兜底——那触及「不得静默切换 provider/model」，需要单独的
  架构决定
