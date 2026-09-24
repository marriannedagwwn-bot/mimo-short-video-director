# 候选阶段 MiMo 格式失败与 transformationProof 提示词收紧（2026-09-24）

## 起因

2026-09-24 候选阶段第一次改用 MiMo `mimo-v2.6-pro`（开思考）。在同一个 Run（run-948397ac，参考片《奶奶的录音》）上连跑 3 次，3 次都失败了；在此之前，候选阶段留存的 57 次调用全部用的是 qwen3.7-max，09-14 以来 9/9 通过。换模型的直接原因是千问账号当天欠费（dashscope 返回 400 `Arrearage`），千问的任何请求都会失败。

| 次 | 报错（改动前的码） | 实际原因 |
|---|---|---|
| 1 | `SOURCE_BASELINE_SELECTION_INVALID`：`variants[0].transformationProof.changedCharacters 必须是对象` | 4 个候选的 20 个 changed* 全部写成字符串 |
| 2 | `SOURCE_BASELINE_SELECTION_INVALID`：`variants[1] 必须是对象` | 写完 V1 后数组里出现乱码字符串 `"id_note_check_done_V1_{"`，数组随即闭合 |
| 3 | `STORY_CANDIDATES_SCHEMA_UNKNOWN_FIELD` ×5 | 各候选随机有一拍多出空键 `emotionalNote: ""` / `emotionalX: ""` |

## 只有第 1 种和提示词有关

replacement 里「X 换成 Y」「从 A 改成 B」这类对照句的出现次数（按正则 `换成|改成|改为|从.*改` 数）：

| | replacement 数 | 对照句 | 压成字符串 |
|---|---|---|---|
| qwen3.7-max，09-14 至 09-19，9 次 | 180 | 0 | 0 |
| mimo-v2.6-pro，09-24，3 次 | 45 | 45 | 20 |

deriveSource 分支原来写的是「仍分别记录人物、任务……的**改编**。每项只输出 `{"replacement":"本片改成什么"}`」，并且原片事实参考写着「供 transformationProof.source 引用」，下面又说「不要输出 source」。MiMo 于是把「改编」读成要写出原片到本片的对照，其中一次干脆把只有一个键的对象压成了字符串。千问从未这样读。

第 2、3 种在提示词里找不到诱因（全仓库搜不到 `emotionalNote`），这次不处理。

## 改动

1. **提示词**（`src/prompts.js` `variantsPrompt` 的 deriveSource 分支）：
   - 原片事实参考只写「只供动作机制对照」，去掉「与 transformationProof.source 引用」。
   - 要求每个 changed* 必须是 `{"replacement":"…"}` 对象，不能写成字符串，只有一个键也要保留花括号。
   - replacement 只写本片这一半，不写「原片的 X 换成 Y」「从 A 改成 B」这类对照句。
   - deriveSource 由「有没有两份原片上游」决定，**与模型无关**：千问、MiMo、DeepSeek 收到逐字相同的文本。缺上游的旧调用点逐字不变。
2. **报错码**（`src/variant-source-baseline.js` 的 `apply()`）：候选形状错误不再沿用 `SOURCE_BASELINE_SELECTION_INVALID`，改报严格 Schema 在同一位置本来就会报的码（`STORY_CANDIDATES_SCHEMA_TYPE / _REQUIRED / _EMPTY_STRING / _MIN_ITEMS`），并带 JSON Pointer path。码名由 `src/contracts/contract-validator.js` 的 `schemaErrorCode` 和 `STORY_CANDIDATES_SCHEMA_CODE_PREFIX` 生成，两处共用一份。判定逻辑、报错消息、fail closed 都不变。真正的来源选取失败仍是 `SOURCE_BASELINE_SELECTION_INVALID`。

离线把前两次失败的原始输出送进新的 `apply()`：分别得到 `STORY_CANDIDATES_SCHEMA_TYPE` @ `/variants/0/transformationProof/changedCharacters` 和 `STORY_CANDIDATES_SCHEMA_TYPE` @ `/variants/1`。

## 回放（同一份上游，新提示词）

预先登记的通过线：MiMo 字符串形状 0/4，对照句 ≤25%；千问 ×1 必须通过、对照句 0（千问欠费无法执行，随后用户决定不测千问）；MiMo 整体通过率只记录，不作为通过线。

| 次 | 结果 | completion token | 形状 / 对照句 | 失败原因 |
|---|---|---|---|---|
| MiMo 1 | 失败 | 37319 | 0/20 字符串，0/20 对照句 | 两拍多出空键 `emotionalPayoffNote`（同第 3 种） |
| MiMo 2 | 失败 | 28098 | 0/25，0/25 | 4 个真候选后多出 `V0`，所有字段为空，是把提示词里的输出模板照抄了一份（09-23 的 `V5placeholder` 同型） |
| MiMo 3 | 失败 | 32425 | 0/20，0/20 | V1 与 V2 之间夹着孤立字符串 `"originalityRiskCheck"`（同第 2 种） |
| MiMo 4 | 失败 | 3564 | 输出无法解析 | MiMo 内容审核拦截（`MODEL_CONTENT_FILTERED`） |
| 千问 1 | 未能执行 | — | — | 账号欠费，400 `Arrearage`；用户决定不测千问 |

- **提示词的目标行为达标**：字符串形状 0/3（能解析的 3 次），对照句 0/65（基线 45/45）。
- **MiMo 在这一阶段仍然不可用**：包括今天的生产调用在内，7 次 0 次通过。失败集中在「多个大对象之间的衔接处」：随机多出空键、数组里混进孤立字符串、照抄空模板多写一个候选。这些在提示词里找不到对应的诱因。
- **千问侧没有做回放**：千问账号欠费，用户决定不测千问。「新提示词在千问上不回退」这一条只有单元测试兜底；改动只是把已有约束写清楚、去掉一处前后矛盾，千问原本 0/180 对照句、0 次压成字符串，本来就符合新写法。

## MiMo 的 JSON Schema 约束解码（同日实测）

目前 `.env` 的 `MIMO_JSON_MODE=true` 让所有 MiMo 阶段发送 `response_format: {type: "json_object"}`。官方文档（[Structured Output](https://mimo.mi.com/docs/en-US/quick-start/usage-guide/text-generation/structured-output)）只写了 `json_object`，并说明它只保证输出是合法 JSON，结构完全由提示词决定。上面三种结构类失败都是合法 JSON，所以 `json_object` 挡不住。

文档没写 `json_schema`，但对 `mimo-v2.6-pro` 实测是支持的，而且确实在约束解码。测法是提示词要求模型逐字返回一个故意违规的对象：

| 请求 | 结果 |
|---|---|
| `json_object` | 原样照抄：多出的键、数组里的字符串、第 3 个多余元素、空字符串、越界的 enum 与 minimum 全部保留 |
| `json_schema` + `strict: true` | 多余的键被去掉（含嵌套层）；数组里的非对象元素被去掉；`maxItems` 生效；enum、`minimum`、`$ref/$defs`、`required` 都生效。流式、开思考、不思考都一样 |
| 编造的 type、`json_schema` 缺 schema 对象 | 400，说明接口确实在解析这个参数 |
| 真实候选 Schema（6KB，43 处 `$ref`，`pattern` 改成 `minLength`） | 200，输出按 Schema 顺序开始写；这次用了 16 秒，小 Schema 是 2–6 秒 |

**`pattern` 不能用**：真实 Schema 用 `pattern: "\\S"` 表示非空字符串。MiMo 把它按全串匹配处理，`"V1"` 被截成一个字符 `"V"`；开思考时还吐出了 `"action":"""`，已经不是合法 JSON。改用 `minLength: 1` 后三次都正常。

### 接入前补测（用派生出的真实候选 Schema）

- **字段顺序会被强制**：提示词要求把 `storyOutline` 放第一个键，`json_object` 照做，`json_schema` 始终按 Schema 顺序输出。所以给模型的 Schema 按提示词输出模板的顺序排。
- **可选键可以省略**：提示词里带输出模板时（与生产一致），要求不写可选键的 4 个候选全部省略了。前一轮短提示词里没有模板，模型只能从 Schema 看结构，4 个候选全把可选键写上了；所以提示词里的模板仍然是必要的。
- 同一轮里 `json_object` 开思考又出现一次「数组里混进字符串」，`json_schema` 同样的请求没有。

### 接入方式（已实施）

- `src/contracts/story-candidates-model-schema.js` 的 `storyCandidatesModelSchema(count)` 从严格 Schema 派生出给模型用的 Schema，不另写一份。变换：去掉 `pattern`，非空字符串改用 `minLength: 1`；`transformationProof` 各项只有 `replacement`；去掉 `keyChoice/climax/emotionalPayoff`；`variants` 锁成 `minItems = maxItems = count`；字段按提示词模板排序。严格 Schema 结构变了、变换找不到目标时直接抛错。
- 只有候选调用（deriveSource 那一支）把它作为 `responseSchema` 交给客户端。选源调用、缺上游的旧调用点、其他阶段都不带。
- MiMo 客户端收到 `responseSchema` 就发 `{type: "json_schema", json_schema: {name, schema, strict: true}}`；`MIMO_JSON_SCHEMA=false` 时退回 `json_object`。接口拒绝时如实报错，不自动退回。千问与 DeepSeek 客户端忽略这个参数，照旧发 `json_object`。
- 服务端严格 Schema 与全部校验保持原样，仍是唯一的裁决方。约束解码只减少结构类失败，全空白字符串之类仍由严格 Schema 拦下。
- 这是文档外的行为，供应商可能不通知就改；内容审核拦截与语义问题它都管不了。
- 提示词文本仍然所有模型共用一份；`response_format` 属于请求参数，取决于各家接口支持什么。

### 接入后回放（同一份上游，MiMo `mimo-v2.6-pro` 开思考 ×4）

先有两轮回放因本地代理（`127.0.0.1:7892`）断连作废：一轮三个请求在同一时刻被切断，另一轮四个请求 4 秒内 `fetch failed`。这两轮与 Schema 无关，不计入。第三轮跑前连续 3 次连通性检查都通过。

| 次 | 结果 | 耗时 | completion token | 候选数 | 叙事路径 |
|---|---|---|---|---|---|
| 1 | **通过全部服务端校验** | 633 秒 | 24277 | 4 | 剧情/生活/剧情/生活 |
| 2 | **通过** | 906 秒 | 30599 | 4 | 同上 |
| 3 | **通过** | 1012 秒 | 37413 | 4 | 同上 |
| 4 | **通过** | 1080 秒 | 42266 | 4 | 同上 |

- **通过线达标**：结构类失败 0/4（基线 7 次里 5 次），整体 4/4 通过（基线 0/7）。16 个候选编号完整、标题没被截断，replacement 里对照句 0，各候选总时长 91–108 秒，全部落在 96 秒目标的 ±15% 窗口内。
- 耗时和 token 与接入前同一模型的范围相当（接入前失败的几次为 581–1138 秒、20k–37k token）。

可选键的使用情况：

| 组 | 候选数 | careRecipient | helper | emotionalMedium | endingRitual |
|---|---|---|---|---|---|
| 千问 json_object（09-14 起） | 36 | 6（17%） | 4（11%） | 3（8%） | 1（3%） |
| MiMo json_object（今天能解析的） | 22 | 7（32%） | 4（18%） | 2（9%） | 0 |
| MiMo json_schema | 16 | 9（56%） | 8（50%） | 0 | 0 |

- `emotionalMedium` / `endingRitual` 本来就很少用，16 个候选里都没出现，不能说明是约束压掉的。
- careRecipient 和 helper 变多。helper 8 个里有 7 个是固定搭档芙芙猫；每批「两个都写」的候选是 1–2 个，没有超过提示词「最多 2 个」。样本小，是不是约束造成的分不清，**需要继续观察**。
- careRecipient 9 个里有 6 个是「独居老人」。这和 09-23 看到的 MiMo 同一人物模板是同一类现象，属于内容问题而不是结构问题，这次不处理。

## 已知局限

- 对照句用正则数，只用来观察，不是闸门；「replacement 只写本片」没有确定性校验。
- 回放只用了一个参考片、一份创作设定。
- MiMo 的结构性失败（空垃圾键、孤立字符串、空模板副本）已由候选调用的 json_schema 约束解码处理，见上一节；其他 MiMo 阶段仍发 `json_object`。
- 接入后的回放只有 4 次、一个参考片，结论偏乐观；可选键使用率的变化需要更多数据判断。
- 浏览器只覆盖 provider/model，所以候选阶段改用 MiMo 时，输出上限拿的是千问那一档的 65536，而不是 MiMo 自己的 131072。今天的调用都以 `stop` 正常结束，没有撞上限。
