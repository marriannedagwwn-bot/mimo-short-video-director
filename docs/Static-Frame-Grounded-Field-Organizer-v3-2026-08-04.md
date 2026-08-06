# Static Frame Grounded Field Organizer v3

日期：2026-08-04

## 目标

Static Frame 的角色字段不再由服务端维护中文动作、姿势、身体、环境和道具词表。语义职责调整为：

```text
pose / handPropState
        ↓
Grounded Field Organizer（AI 整句语义判断）
        ↓
服务端证据与结构校验
        ↓
原文 span 确定性编译
```

`actionState` 继续由既有 `ACTION_STATE_SEMANTIC_AUDIT_V1` 做整句 AI 审核，避免两个模型重复裁决同一字段。

Animation Plan、Full Story、首尾帧和视频生成的公开 JSON 结构不变。

## AI 职责

Organizer 负责：

- 理解完整短语，而不是按固定关键词命中。
- 从不可变 Source Catalog 中选择原文证据。
- 将证据标为 `pose_body`、`pose_limbs`、`pose_orientation`、`pose_body_contact`、`pose_character_feature` 或 `hand_prop_state`。
- 删除叙事顺序、动态过程、认知、心理、意图或未来成分。
- 保留事实主体、客体、数量、否定和关系。

提示词中的“然后、接着、最后”“摆动、摇摆、挥动、移动”等仅用于解释类别含义，明确声明为非穷尽示例，不是服务端或模型的关键词白名单。

## 服务端职责

服务端不再判断某个中文词是不是动作、身体部位、环境支撑或道具。它只保留可确定验证的约束：

- `runId / targetId / characterId / frameKind / path` 锁定。
- `pose` 只能引用同角色同帧的 `pose / bodyOrientation / gaze`。
- `handPropState` 只能引用自身原文。
- Catalog span 必须是原文精确 UTF-16 切片。
- 禁止未知、伪造、重复、重叠、跨 target、跨角色、跨 frame 的 ID。
- AI 不能返回最终文本、path、offset 或自由 patch。
- 最终值只能由已签发 span 按原文顺序做删除式编译。
- `pose / handPropState` 最终必须非空。
- `pose_character_feature` 必须绑定冻结 Profile 中同角色的精确 `featureId`，且原文包含该 feature 的动态 matcher term。
- patch 原子应用后重新检查字段、角色和路径锁。

Catalog 的切片只使用标点边界和 `Intl.Segmenter` 的语言无关 word segmentation，不使用中文语义词表。

## 调用与恢复

- 每个包含 `pose / handPropState` 的有效 batch 都会调用 Organizer；“字段已经正确”也由 AI 返回原文证据确认。
- 若整理后值与原值相同，run 记录为 `noOp`，但仍保留协议与审核 metadata。
- 每个 run 最多两次 protocol call：首次调用后，只能二选一执行 `envelope_repair` 或 `evidence_reselection`。
- transport retry、Candidate error、Animation Batch Retry 和 AttemptStore 的既有预算不变。

## validation 边界

`validation.js` 仍负责字段存在、exact schema、字符串类型和必填非空。

以下三个角色字段不再接受本地中文关键词 lint：

- `pose`
- `handPropState`
- `actionState`

其他未接入 AI 整理器的静态字段仍沿用原有 lint。这一边界避免本次改动扩大到环境、摄影、灯光或 Full Story 架构。

## 已知风险

- 语义正确性由模型判断，服务端可以证明“没有创造原文外事实”，但不能用确定性代码证明 category 的自然语言含义一定正确。
- 删除式 span 允许 AI 删除任意语义片段；提示词禁止删除否定、主体、客体、数量和关键关系，但服务端不再用中文词表复判。
- 每个正常 batch 增加一次独立模型调用，带来延迟和成本。
- 本次不支持在 `pose` 与 `handPropState` 之间自动搬运事实；字段内整理保持现有上下游接口和职责边界。
