# Character Feature Compiler 与 Static Frame Compiler 改造说明

日期：2026-07-29
状态：已实施；专项测试通过，提交信息以 Git 历史为准。

## 1. 改造目标

本次改造解决旧 Static Frame Compiler 依赖固定关键词和模型自由文本修复所带来的问题：

- 狼耳、狼尾、翅膀等角色特征无法由固定 `pose` 维度规则稳定覆盖。
- 模型可能现场创造规则、状态文本或不存在于原文的事实。
- 第二次修复调用缺少明确的证据边界和错误分类。
- `handPropState` 中的手—道具关系可能被错误计为身体环境接触。
- 未选择的 Catalog 候选可能被提前当成已经验证的静态事实。
- Candidate-level 错误、协议错误和 Batch Retry 的职责边界不够清晰。

最终采用：

```text
Catalog Candidate Audit
        +
模型 Evidence Selection
        +
服务端 Grounded Patch Compilation
```

服务端不会在模型选择前宣称已经理解全部安全事实，也不会为未选择候选生成维度或 state slot。

## 2. 最终工作流

```text
Full Story 校验
├─ Animation Foundation
└─ Character Feature Compiler
      └─ 冻结 Character Feature Profile
             ↓
两项均成功
             ↓
          Shot Batch
             ↓
Static Frame Compiler
  1. Source Catalog Builder
  2. Source Catalog Candidate Audit
  3. Evidence Selection
  4. Selected Evidence 完整审核
  5. Grounded State Slot 生成
  6. 服务端组合搜索与 target-scoped validation
  7. Evidence Reselection 或 Envelope Repair
```

Animation Foundation 与 Character Feature Compiler 在 Full Story 校验后通过 `Promise.allSettled` 并行执行。

- Character Feature Compiler 不读取 Foundation 输出。
- 两者只继承 provider/model 配置。
- 任一并行阶段失败，都不会进入 Shot Batch。
- 两个阶段同时失败时，优先保留 Character Feature Compiler 的结构化错误。

## 3. Character Feature Compiler

### 3.1 权威输入

Compiler 只读取：

- `creatorProfile.fixedCharacter`
- `visualGuardrails`
- `fullStory.characterBible`
- 合法临时角色的显式上游设定
- 合法角色集合

明确排除：

- Animation Foundation
- `characterReferencePrompts`

因此 `characterReferencePrompts` 不进入 Compiler prompt，也不进入 `sourceHash`。

### 3.2 模型协议

服务端预先生成角色和证据 Catalog。模型只能返回：

- `characterTargetId`
- `suggestedFeatureKey`
- `canonicalName`
- `terms`
- `featureKind`
- `semanticSubtype`
- `evidenceLevel`
- `evidenceSpanIds`
- `inferenceSpanIds`

模型不能返回：

- 最终 `featureId`
- `sourcePath`
- 原文
- UTF-16 offset
- 当前镜头状态
- Foundation 信息

所有响应层级均使用 exact schema 语义，额外字段直接拒绝。

### 3.3 Feature 分类与 ID

固定通用 `featureKind`：

- `body_form`
- `limb_variant`
- `special_appendage`
- `face_part`
- `costume`
- `accessory`
- `other_anatomical`

`ear`、`tail`、`wing` 等只作为开放的 `semanticSubtype`，不进入不断扩大的服务端枚举。

最终 `featureId` 由服务端生成并绑定角色，例如：

```text
character-xxxx.wolf_tail
```

Static Frame 实际计数键为：

```text
characterFeature:character-xxxx.wolf_tail
```

### 3.4 Term 冲突

同一角色内：

- 完全重复的 feature 草案先确定性去重。
- `explicit` 优先于 `inferred`。
- 两个同级 feature 争用同一 term 时，该 term 对双方禁用。
- 冲突记录在 Profile metadata。

跨角色同名 term 只有在当前角色能够唯一绑定时才能参与匹配。

`inferred` feature 只代表词库授权。只有当前局部原文字面出现冻结 term 时才能识别，不会自动注入当前镜头。

### 3.5 空 Profile 与缓存

- `features: []` 是合法结果。
- 全部角色均无特殊特征时不会中断流程。
- Profile 会递归冻结。
- `sourceHash` 包含实际权威输入、角色集合、Profile 版本、维度注册表版本和 prompt/validator 版本。
- 缓存支持进程内复用和生产包 private sidecar。
- 导入的 sidecar 被视为不可信输入，复用前会重新验证 schema、digest、角色集合、证据 proof 和 matcher 冲突状态。

## 4. Static Frame Compiler

### 4.1 服务端签发 ID

每次运行创建不可变 Source Catalog，并签发运行级：

- `targetId`
- `segmentId`
- `spanId`
- `stateSlotId`

服务端内部保存：

- `sourcePath`
- UTF-16 `start/end`
- 原文切片
- `characterId`
- `frameKind`
- 字段职责
- target 授权关系

模型只看到签发 ID 及对应的只读展示文本，不返回 path、offset、角色、维度或最终状态文本。

非法、伪造、过期、跨 target、跨 segment 或跨运行 ID 均作为 protocol 错误拒绝。

### 4.2 Compile Target

只为真实违规字段签发 target，包括：

- 含心理、意图、未来、过程、对白或音效等非静态表达的字段。
- 必填但为空的 `pose`。
- 必填但为空的 `handPropState`。

空 `actionState` 仍然合法。

服务端锁定：

- path
- before
- field
- character
- frame
- `reasonCode`
- trigger
- 授权 Catalog

没有违规 target 时确定性 no-op，不调用模型。

### 4.3 Candidate Audit

Candidate Audit 只执行确定性预检查：

- ID 和层级关系
- target、角色、frame、字段授权
- 多角色结构歧义
- 明确禁止词
- 明显动态过程
- 空 span 和明显无关 span
- handProp/bodyContact 职责边界

Audit 结果只叫 `catalogCandidateEvidence`。

未选择候选：

```text
unselectedCandidateEvidence
```

它们不会被提前视为安全事实，不会提前得到 `primaryDimensionKey`，也不会生成 state slot。

### 4.4 Evidence Selection

首次模型响应只允许：

```json
{
  "targets": [{
    "targetId": "compile-target-...",
    "evidenceSelections": [{
      "segmentId": "seg-...",
      "spanIds": ["span-..."]
    }]
  }]
}
```

约束：

- 每个必需 target 恰好覆盖一次。
- 每个 target 最多 12 个 selection。
- 每个 selection 最多 4 个 span。
- 只能引用 Candidate Audit 授权的 ID。
- 不允许文本、path、offset、角色、字段、dimension、value、`visibleFacts` 或 delete。

### 4.5 删除式 Grounding

只有模型实际选择的 evidence 才进入完整审核。

服务端支持使用多个精确 span 删除中间的非静态表达，例如：

```text
原文：尾巴随后停在身体右侧
span：尾巴
span：停在身体右侧
结果：尾巴停在身体右侧
```

多 span 之间的间隔必须完全由以下内容组成：

- 已知禁止的心理、意图、未来或过程词
- 必要语法连接词
- 标点或空白

如果间隔包含其他主体、状态或事实，则拒绝该 selection，防止把不相干的原文片段重新拼成新事实。

服务端不会让模型自由改写文本。

### 4.6 Primary Dimension

固定元维度：

- `body`
- `limbs`
- `orientation`
- `bodyContact`
- `characterFeature`

`characterFeature` 本身不计数，实际使用具体 featureId。

每个 slot 只有一个 `primaryDimensionKey`，优先级为：

1. 当前角色动态 feature 精确命中
2. `orientation`
3. `bodyContact`
4. `limbs`
5. `body`

空间参照词不会重复产生次级维度。例如“尾巴停在身体右侧”只计狼尾 feature，不会因为“身体”再次计为 body。

### 4.7 bodyContact 与 handPropState

`bodyContact` 只表示身体或肢体与环境支撑面的关系，例如：

- 双手按在地面
- 背部靠在墙面
- 双膝跪在地板

以下关系不计为 `bodyContact`：

- 手—道具接触
- 握持、托举、按压道具
- 未接触、悬停或道具距离
- 无法判断接触对象类型的关系

合法手—道具静态状态仍可进入 `handPropState`，例如：

```text
双手握住盒子
```

该事实可计为 `limbs`，但绝不计为 `bodyContact`。

### 4.8 Required Dimension

`requiredDimensionCount` 只来自当前 attempt 已验证的安全 slot：

- 0 个安全维度：本次没有安全结果
- 1 个安全维度：要求 1
- 2 个及以上：要求 2

不会根据 Catalog 未选择候选推断维度，也不会因为原文可能存在其他事实而强迫模型补写第二维。

### 4.9 服务端组合搜索

模型不参与 slot 排列。

服务端按确定性顺序枚举：

1. 单 slot
2. 两个不同 primary dimension 的双 slot
3. segment 原文顺序
4. span 原文顺序
5. `stateSlotId` 字典序

过滤：

- target、角色、frame 或字段不一致
- source span 重叠
- primary dimension 重复
- 事实重复
- 明确互斥状态
- 字段职责冲突

每个组合会先写入候选副本的真实目标字段，再执行完整 target-scoped validation。

target-scoped validation 覆盖：

- path、target、角色、frame、field 锁定
- slot 与 `visibleFacts` 绑定
- required dimension
- 确定性最终文本
- 必填字段
- 非静态禁止词
- handProp/bodyContact 职责
- 互斥状态

首个通过的组合成为 canonical patch。全部 patch 原子应用后会再次复检。

整批 Animation Batch validator 仍在工作流外层执行，避免 sceneId、duration 或 motion 等无关错误被误分类成 Static candidate-level 错误。

## 5. 第二次调用语义

Static Frame 每次运行最多两次 protocol 调用：

```text
attempt 1
→ evidence_reselection 或 envelope_repair
→ 终止
```

两种模式共享预算，一次运行只能使用其中一种。

### 5.1 evidence_reselection

触发条件：

- 首次 envelope 合法。
- 当前选择没有形成通过组合。
- 仍存在未选择的授权 Catalog candidate。

attempt 2：

- 只能引用首次调用前签发的 Catalog ID。
- 只能覆盖服务端指定的失败 target。
- 完整替代 attempt 1 的 selection，不隐式合并。
- 独立生成 attempt-2 slots。
- 重新计算 attempt-2 `requiredDimensionCount`。
- 重新枚举全部合法组合。

仍无结果时返回：

```text
EVIDENCE_RESELECTION_EXHAUSTED
```

### 5.2 envelope_repair

只用于：

- JSON 无法解析
- 顶层 Schema 无效
- target 覆盖关系无法建立
- 无法形成可信 Evidence Selection envelope

修复后不得再执行 evidence reselection，也不允许第三次调用。

## 6. 错误分类与 Batch Retry

Candidate-level 错误：

| 错误码 | 含义 |
| --- | --- |
| `NO_STATIC_EVIDENCE_IN_SOURCE` | 没有授权候选，或候选全部审核后没有安全 slot |
| `NO_VALID_GROUNDED_COMBINATION` | 已有安全 slot，但全部合法组合均未通过 |
| `EVIDENCE_RESELECTION_EXHAUSTED` | 唯一一次 reselection 后仍无安全结果 |

以上三类：

- Animation Batch first-pass：触发现有唯一一次 Batch Retry。
- second-pass 或无预算：最终失败。

以下错误不触发 Batch Retry：

- `PROTOCOL_ENVELOPE_INVALID`
- 非法、伪造、过期或跨范围 ID
- JSON/Schema 错误
- 网络、provider 或 timeout
- 配置错误
- Character Feature Compiler 协议或配置错误

如果 envelope repair 成功后产生 candidate-level 错误，仍按 candidate-level 规则传播。

## 7. 多余 Patch 与模型权限

- 模型没有 delete 权限。
- 模型不能生成 canonical patch。
- 模型不能生成最终 `value` 或 `visibleFacts`。
- 未知 targetId 直接拒绝，不能通过清理掩盖协议错误。
- 服务端不会删除、清空或移除 Animation Batch 的真实字段。

## 8. Metadata、API 与页面

公开 animation plan Schema 保持不变。

metadata 增加：

- Catalog candidate 数量
- selected/unselected 数量
- attempt-1/attempt-2 slot 池
- 当前 attempt `requiredDimensionCount`
- 安全维度
- 组合搜索结果
- 中间错误码
- repairMode 和调用次数
- Candidate-level Batch Retry 传播结果
- Character Feature Compiler metadata

页面可展示：

- 五类 Static Frame 错误
- 当前安全维度和 required dimension
- selected/unselected candidate 数量
- 组合搜索结果
- repairMode
- Batch Retry 是否触发

页面和 API 的诊断投影不会展示：

- 完整 prompt
- 原始模型响应
- API Key
- `sourcePath`
- UTF-16 offset
- 无关剧情原文

## 9. Private Sidecar

生产包现在可以保存：

```text
privateSidecars.characterFeatureProfile
```

页面支持：

- 生成时回传已有 sidecar。
- 导出生产包时保留 sidecar。
- 导入生产包时恢复 sidecar。
- 服务端完整校验后复用 Profile。

## 10. 主要文件变更

### 新增

| 文件 | 作用 |
| --- | --- |
| `src/character-feature-compiler.js` | Character Feature Catalog、协议、Profile、冲突和缓存 |
| `src/static-frame-grounding.js` | Source Catalog、Candidate Audit、Evidence Review、State Slot 和组合搜索 |
| `public/compiler-observability.js` | Compiler 结构化错误的安全投影与页面渲染 |
| `test/character-feature-compiler.test.js` | Character Feature Compiler 专项测试 |
| `test/compiler-observability.test.js` | API/UI 诊断与敏感字段过滤测试 |

### 修改

| 文件 | 作用 |
| --- | --- |
| `src/static-frame-compiler.js` | 替换旧自由文本 patch 协议，接入 ID-only Evidence Selection |
| `src/workflow.js` | 并行阶段、Profile 贯穿、Batch Retry 分类和 metadata 传播 |
| `server.js` | Compiler 结构化 API 错误状态和安全 metadata |
| `public/app.js` | 成功/失败诊断展示及 sidecar 导入导出 |
| `test/static-frame-compiler.test.js` | Grounding、维度、协议和组合搜索测试 |
| `test/static-frame-compiler-workflow.test.js` | Compiler 与 Batch Retry 集成测试 |
| `test/animation-plan-batching.test.js` | 并行流程、空字段、sidecar 和重试边界测试 |
| `test/workflow.test.js` | 新 Static Frame v2 协议适配 |

## 11. 关键回归覆盖

新增或更新的测试覆盖：

- Candidate Audit 不为未选择证据生成 dimension 或 slot。
- 只有 selected evidence 能生成 slot。
- `requiredDimensionCount` 只来自当前 attempt。
- 少选真实事实不会强制补写第二维。
- 未签发或跨范围证据始终拒绝。
- 多角色事实不得绑定给错误角色。
- wing、tail 等特殊身体特征不进入固定 limbs 枚举。
- feature term 冲突和角色唯一绑定。
- inferred feature 不自动注入镜头。
- 空 Profile 合法。
- 空 pose 只能使用已签发静态证据补齐。
- 空 handPropState 无证据时触发唯一 Batch Retry。
- 句首和句中心理/过程表达的精确 span 删除式整理。
- 跨主体、跨事实多 span 拼接拒绝。
- 合法手—道具静态状态不误计为 bodyContact。
- target-scoped validator 拒绝首个互斥组合后继续搜索。
- attempt-2 独立 slots 与 required dimension。
- envelope repair 和 evidence reselection 的共享预算。
- 三类 candidate 错误的 first-pass/second-pass 行为。
- protocol、ID、Schema、网络、provider、timeout 和配置错误不触发 Batch Retry。
- Foundation 与 Character Feature 并行失败传播。
- sidecar 导入、导出、复用和篡改失效。
- 页面敏感字段过滤。

## 12. 验收结果

最终结果：

```text
npm test
tests: 316
pass: 316
fail: 0
```

专项联合回归：

```text
tests: 131
pass: 131
fail: 0
```

Static Frame 专项：

```text
tests: 26
pass: 26
fail: 0
```

其他检查：

- Node 语法检查通过。
- `git diff --check` 通过。
- 未发现旧 `STATIC_FRAME_COMPILER_V1`。
- 未发现 `targeted_replacement`。
- 未发现 `validatedCatalogEvidence` 或 source-wide validated dimension 残留。

## 13. 当前运行状态

文档生成时服务器已经重新启动：

```text
http://127.0.0.1:4173/
HTTP 200
```
