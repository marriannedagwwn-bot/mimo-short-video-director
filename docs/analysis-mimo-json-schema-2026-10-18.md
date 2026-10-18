# 参考片分析接 MiMo json_schema 约束解码（2026-10-18）

## 起因

2026-10-18 同一个参考片（《她好开心_咕咕嘎嘎…可爱小企鹅》，24.06 秒，原生视频）连跑两次参考片分析，
MiMo `mimo-v2.6-pro` 开思考、`response_format: json_object`，两次都写满 16384 token 后以
`MODEL_OUTPUT_TRUNCATED` 失败（146 秒 / 188 秒，两次 `prompt_tokens` 都是 8663）。

两份原始输出前约 3.6k / 4.1k 字正常，坏在**同一个位置**：`retentionDrivers` 最后一项写完后少了 `]`：

```
…"evidence":[{"source":"video","startSecond":17,"endSecond":24}]},"whyWatchToEnd","短片以…","analysisConfidence：72,"  ,"analysisConfidence2placeholder removed"  ,"analysisConfidence72"  ,"analysisConfidence72v2"  ,…  ,"analysisConfidence72v1104"
…"evidence":[{"source":"video","startSecond":17,"endSecond":25}]},"whyWatchToEnd","全片以…","analysisConfidence:78,"  , "observedFacts"  , "2f80b6c9"  , "1c3d9e0a"  , …
```

`"whyWatchToEnd":` 被写成 `"whyWatchToEnd",`，`analysisConfidence` 的冒号被塞进字符串里。
数组里一个字符串后面语法上只能接 `,` 或 `]`——这说明 `json_object` 模式也在逐字约束输出合法 JSON：
模型想写冒号写不出来，也没有关上数组，于是一直往 `retentionDrivers` 里加字符串直到上限。
没有这层约束时这里会当场变成解析错误，几秒失败，而不是白跑满额度。

复读检测（`src/output-degeneration.js`）只认逐字重复的单元，编号递增与随机串每条都不一样，抓不到。

这与 2026-09-24 候选对照评审在 `candidateChecks` 里写出孤立字符串 `"holisticPreferenceOrder:["` 同形，
那次（以及候选、分镜设计）接 json_schema 之后结构失败归零（`docs/variants-mimo-format-2026-09-24.md`）。

`src/output-token-ceilings.js` 记着 10-05 一次 `mimo-v2.6-pro` 在 65536 上限下写了 18.3 万字、742 秒才截断，
是不是同一个原因**无法核实**：那份原始输出已经不在磁盘上。

## 做法

参考片分析**没有严格 JSON Schema 可派生**，服务端判据分在三处，模型 Schema 直接引用它们：

| 部分 | 来源 |
| --- | --- |
| 顶层 14 个键、5 个数组字段 | `src/validation.js` 的 `REFERENCE_ANALYSIS_FIELDS` / `REFERENCE_ANALYSIS_ARRAY_FIELDS` |
| `observedFacts` 的键、`factType` / `importance` 枚举、证据对象的键 | `src/reconstruction-grounding.js` 的 `OBSERVED_FACT_KEYS` 等常量 |
| 证据写法（video 秒级 / frame 帧号）与上限 | `src/prompts.js` 的 `analysisEvidenceShape(input)`，提示词与 Schema 共用 |
| 其余嵌套字段（定位、受众、人物、情绪曲线……） | 服务端不查，按 `analysisPrompt` 输出模板逐键写；测试解析模板 JSON，锁住键集合与顺序 |

- `referenceAnalysisModelSchema(input)`（`src/contracts/reference-analysis-model-schema.js`）：每个对象
  `additionalProperties:false`、模板里的键全部必填；只用在 MiMo 上实测过的关键字，出现别的直接抛错
  （未知关键字一旦被拒，视频请求会被客户端静默退回抽帧）。
- 证据：video 写法 `startSecond` 0..max−1、`endSecond` 1..max（max = 时长向上取整，与服务端「时长加 1 秒容差」
  同一界限；取不到时长时不写上限）；frame 写法 `frameNumber` 1..关键帧数。`endSecond > startSecond`、
  重复引用、全空白字符串仍由服务端判。
- `workflow.analyze` 把 Schema 与提示词用同一份 `promptInput` 构造；`VIDEO_EVIDENCE_TIME_INVALID` 后改用抽帧重取时
  跟着换成 frame 写法。只有 MiMo 客户端发 json_schema，千问忽略；`MIMO_JSON_SCHEMA=false` 全局关掉。
- 提示词逐字未变（golden 测试，四种输入的 sha256 与改动前相同）；服务端校验、签发、重试预算、16384 上限、演示模式都不变。

**模型一侧比服务端严（用户确认）**：嵌套字段服务端不查，这里按模板钉死结构。只收紧结构，不收紧内容
（除 `observation` 外不加 `minLength`）。

**五处 `evidence`（人物、主角身份、被关爱对象、情绪曲线、留存驱动）统一成与 `observedFacts` 相同的证据对象（用户确认）。**
代价：10-05 那批里《简历》这五处写的是带时间的描述字符串（如 `"00:06-00:08 特写显示文件封面「简历」"`），
`variant-source-baseline` 建原片证据目录时会把 `characters[].evidence` 里的字符串当原文收进来；
以后这种写法不会再出现，这类 Run 的目录会少这几条人物描述。另 6 份本来就是对象，目录里本来就没有。

## 回测

10-05 那批 7 份成功结果（`~/Downloads/视频及字幕/runs/*/01-referenceAnalysis.json`，全是 `mimo-v2.6-pro`、原生视频）：

- 7/7 的键集合与顺序和模板完全一致，取值类型一致。
- 用模型 Schema（按各自视频时长构造）校验：**6/7 通过**；《简历》只因上面那五处 evidence 是字符串被拒（32 处，全在这五处），其余结构全部通过。
- `reports/durable-task-baseline` 下两份是演示 `mockAnalysis` 的产物，不计。

## 真实回放

脚本 `scripts/analysis-schema-replay.mjs`：读失败那个 Run 的源视频副本（SHA-256 与 Run 记录一致）、元数据与旁白，
按页面 `sampleVideo` 的规则重算 7 个关键帧时间（0.72 … 23.33 秒），交给当前代码的 `workflow.analyze`；
与失败那两次相同的 MiMo `mimo-v2.6-pro`、开思考、上限 16384。视频方式三次的 `prompt_tokens` 都是 8663，
与失败那两次相同，输入一致。原始输出与汇总在 `reports/analysis-schema-replay-2026-10-18/`。

| 回放 | 调用 | 结果 | completion tokens（其中推理） | 耗时 |
| --- | --- | --- | --- | --- |
| video-1 | ① 视频 → 被 `VIDEO_EVIDENCE_TIME_INVALID` 拦；② 抽帧重取 | 签发（frame evidence） | 3185（683）/ 3418（399） | 68 秒 + 86 秒 |
| video-2 | ① 视频 | 签发（video evidence） | 3681（895） | 81 秒 |
| video-3 | ① 视频 | 签发（video evidence） | 4812（1976） | 114 秒 |
| frames-1 | ① 抽帧 | 签发（frame evidence） | 4047（511） | 90 秒 |

- 事先登记的线（视频方式 3 次全部签发、不截断、无结构失败）**达到**：截断 0/5、结构失败 0/5，5 次调用都发了
  json_schema、都是 `finish_reason: stop`；输出 3.2k–4.8k token，离 16384 很远（改前两次都写满 16384）。
  抽帧方式 1/1 签发，说明帧号写法的 Schema 与图片输入一起也能用。
- 「不发生静默改抽帧」：MiMo 客户端的静默改抽帧 0 次。但 video-1 走了 `workflow.analyze` 既有的再取证：
  第一份输出结构完全合法，只是有 3 处 evidence 写成 `startSecond == endSecond`（15, 15）。Schema 表达不了
  「结束秒大于开始秒」，服务端判 `VIDEO_EVIDENCE_TIME_INVALID`，按既有设计用抽帧重取一次后签发。
  **所以视频方式一次就签发的是 2/3**，video-1 多花了一次调用，签发的是 frame evidence。这一条不是本次引入的
  （提示词一直写着 start < end），本次不改。
- 内容：三份视频方式的结果都正常（企鹅装女孩、红螃蟹、投信、年长女性递草莓蛋糕、夕阳收尾），
  与失败那两次截断前写出的前半段一致。
- 样本小：只有这一个参考片、5 次调用。

## 没做的

- 不给复读检测加「递增编号的字符串数组」这类规则：那是猜形状的启发式。
- 不调 16384 上限。
- **既有毛病，未修**：MiMo 客户端在原生视频请求遇到 400 时会静默改用抽帧，而提示词仍写「用 video evidence」，签发会失败。
  新 Schema 跟随提示词，不改善也不恶化这件事。
