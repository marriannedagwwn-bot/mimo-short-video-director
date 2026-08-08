# Animation Plan Source-of-Truth Contract

## 1. Field semantics

### startFrame.environment
待确认：
- 是稳定场景状态，还是当前首帧可见的环境层？
- 是否允许活动环境元素？
- 是否允许剧情道具？
- 是否允许角色或角色身体部分？

### endFrame.environment
待确认：
- 是对 startFrame.environment 的完整快照，还是只描述终点差异？
- 无真实变化时是否要求逐字复制？
- 逐字复制是数据契约还是 Prompt 优化策略？

### motion.environmentChange
待确认：
- 是权威变化声明？
- 是从首尾状态派生的摘要？
- 还是仅用于生视频的自然语言指令？

## 2. Source-of-truth hierarchy

必须明确：

1. Full Story 的哪些字段表示叙事事实。
2. `visibleAction`、`primaryAction`、`timingBeats` 的优先关系。
3. startFrame/endFrame 是事实源还是派生投影。
4. motion 是事实源还是连接描述。
5. 冲突时谁可以覆盖谁。
6. 哪些冲突只能 retry，不能 deterministic repair。

## 3. Environment change taxonomy

分别定义：

- 场景结构变化；
- 天气变化；
- 光线变化；
- 大气和粒子变化；
- 门窗、灯具、炊烟等环境对象变化；
- 可移动剧情道具变化；
- 角色动作；
- 镜头和构图变化；
- 仅文字改写、语义不变。

## 4. Transition strategy

明确 `inherit / transition / independent` 分别依据什么选择：

- camera；
- environment；
- lighting；
- time/weather；
- narrative action；
- manual override。

## 5. Conflict policy

为每一种冲突明确：

- reject；
- retry；
- deterministic repair；
- require explicit product decision。

## 6. Allowed repairs

逐项列出能唯一推导、无信息损失的修复。

## 7. Forbidden repairs

至少包括：

- 根据冲突字段单方面覆盖另一字段；
- 根据自由文本字符串不同直接断言真实环境变化；
- 在来源优先级未确定时静默删除尾帧状态。