## 项目身份

项目名称：

mimo-short-video-director

项目定位：

AI 短视频生产工作流系统。

目标：

将输入视频/创意素材转换为：

视频分析
→ 剧情理解
→ 创意重构
→ Visual Guardrails
→ Story
→ Animation Plan
→ 首尾帧
→ 视频生成
→ 导出生产数据

当前系统重点是保证：

- 剧情一致性
- 角色一致性
- 镜头连续性
- AI 输出可验证性
- 生产流程可恢复性


---

# 1. 当前架构事实（必须遵守）

## 当前主流程

当前运行流程：

Analyze
 ↓
Reconstruct
 ↓
Brief
 ↓
Visual Guardrails
 ↓
Variants
 ↓
Legacy Full Story
 ↓
Animation Plan 2.0
 ↓
Static Frame / Shot Generation
 ↓
Video Generation

---

## 当前模型 provider 边界

工作流 LLM provider 包括：

- Qwen
- MiMo
- DeepSeek

DeepSeek 当前只允许用于纯文本阶段：

- Brief
- Variants
- Legacy Full Story
- Animation Plan
- Static Frame Compiler

禁止将 DeepSeek 用于需要图片或视频输入的阶段：

- Analyze
- Reconstruct
- Visual Guardrails
- Character Reference

当前 DeepSeek 模型 ID 只登记 `deepseek-v4-flash` 和 `deepseek-v4-pro`。Flash 是页面首选项，Pro 只能显式选择；不得静默切换 provider/model。配置 `DEEPSEEK_API_KEY` 不改变现有 Qwen/MiMo 默认路由。

---

## 当前全局角色边界

`Visual Guardrails` 是固定角色语义的唯一生成阶段。它允许视觉模型结合用户设定、参考分析、脚本还原、创意简报和模型常识生成开放语义边界，不得新增本地物种关键词字典替代模型判断。

服务端签发的 `fixedCharacterBoundary` 是后续 Variants、Legacy Full Story、Animation Plan、Character Feature Compiler、人物参考精修、角色图、首尾帧和视频生成的唯一固定角色事实来源。后续阶段不得重新解析 `creatorProfile.fixedCharacter`、重新推断关键词或生成第二份角色边界。

冲突优先级：用户明确肯定/否定 > 已签发模型推断。无法消解的冲突必须阻断，不能选择任一方静默覆盖。用户或权威上游数据改变后，旧边界必须失效并重新生成。

---

# 2. Full Story 架构说明

## 当前存在

当前项目使用：

Legacy Full Story

负责：

- 生成完整剧情
- 输出 sceneScript
- 提供 Animation Plan 输入


## 当前不存在

禁止认为以下功能已经存在：

Full Story v2
Canonical Story
Canonical Pipeline
Production Package
Receipt
Canonical Provenance

当前 HEAD 不包含这些实现。


---

# 3. fullStoryV2 命名说明

代码中可能存在：

fullStoryV2
cast
registry
confirmation

这些属于：

Phase 2 Cast / Character Governance

或者未来规划。

不能解释为：

Full Story v2 已实现

修改代码时必须区分：

正确：

Character Registry
Cast Proposal

错误：

Canonical Story 已接入

---

# 4. 修改代码前必须执行

## 证据优先与实施门槛

涉及字段语义，或会改变业务行为的 Prompt、Schema、Validation、
Compiler、Retry、Recovery、Fallback、Source of Truth 修改时：

1. 先检查当前 HEAD、实际调用链、原始失败数据和现有测试。
2. 明确区分：
   - 已确认事实
   - 当前既有契约
   - 推断
   - 尚未确认的问题
   - 新提出的架构决定
3. 在修改前明确：
   - 相关字段由谁生成
   - 由谁消费
   - 哪个字段是权威事实来源
   - 字段冲突时的优先级
   - 至少一个合法反例

如果事实来源、字段语义或冲突优先级尚未明确：

- 不得修改生产代码；
- 不得新增自动覆盖、自动同步或默认值恢复；
- 不得选择冲突中的任一字段作为真相；
- 应继续只读调查，或明确请求架构决定。

两个模型输出字段发生冲突，只能证明数据不一致，
不能证明其中某一方正确。

自动修复只有在正确值能从权威上游唯一推导、
且不会删除合法信息时才允许实施。

实施过程中出现新证据推翻原假设时，立即停止叠加补丁，
返回根因调查，不得继续用第二个修复掩盖第一个修复。

任何功能修改必须：

## 第一步：确认现状

必须检查：

- 当前 git HEAD
- 当前文件是否存在
- 当前调用链
- 当前测试覆盖

禁止：

- 根据旧聊天记录判断代码状态
- 根据文件名推断功能存在
- 根据 TODO 推断已经实现


---

## 第二步：明确修改范围

修改计划必须说明：

1. 修改哪些文件
2. 为什么修改
3. 是否改变数据结构
4. 是否影响已有流程
5. 如何验证


禁止：

顺手重构
顺手优化
统一架构

除非明确授权。


---

# 5. 架构修改原则

## 小步修改

优先：

增加校验
增加隔离
增加测试
增加边界

避免：

大规模重写
替换整个流程
重新设计全部模型

---

## 保持职责隔离

必须保持：

## Full Story

负责：

叙事结构
角色
场景
对白
剧情逻辑

不负责：

镜头动画实现
动作生成
视频生成

---

## Animation Plan

涉及 startFrame、endFrame、environment、motion、
environmentChange、inherit 或 transition 的语义修改前，
必须先阅读：

`docs/animation-plan-source-of-truth.md`

如果文档没有明确当前字段的事实来源和冲突优先级，
不得自行补充解释或实施确定性修复。
负责：

镜头拆分
动作状态
首尾帧关系
动画约束

不负责：

重新创作剧情
修改角色身份
改变故事主题

---

# 6. Story Contract 原则

Full Story 输出必须满足：

## Scene Contract

每个 scene 必须：

- sceneId
- location
- characters
- visibleAction
- shotAndSound


---

## characters 是事实来源

characters 表示：

本场实际出镜角色

不是：

- 被提及的人
- 地点名称
- 道具归属
- 回忆对象


例如：

正确：

铃木奶奶站在院子里浇花

characters:

["铃木奶奶"]


错误：

铃木奶奶家的门口

不能认为：

铃木奶奶出镜


---

# 7. 角色一致性规则

禁止：

- 自动新增未登记主要角色
- 修改 variant 中已有角色身份
- 修改 careRecipient
- 修改 protagonist


任何角色变化必须：

明确登记
明确理由
明确影响范围

---

# 8. 状态隔离要求

未来所有新功能必须考虑：

variant
story revision
plan revision
request id
media namespace
digest

禁止：

只依赖：

variant.id
shotId
timestamp

作为唯一身份。


原因：

避免：

- 旧 Story 污染新 Story
- 旧视频覆盖新视频
- 异步请求回写错误版本


---

# 9. 导入导出规则

当前浏览器导出的 JSON：

属于：

测试/规划包

不是：

生产级 Production Package

除非增加：

- schema version
- digest
- signature
- provenance
- validation


禁止：

将普通 JSON 描述为：

可信生产包

---

# 10. AI 修改代码行为要求

AI 不允许：

## 1.

为了通过测试降低校验标准。


## 2.

增加关键词白名单绕过真实问题。


## 3.

改变字段含义。


## 4.

把错误隐藏。

例如：

错误：

失败时返回默认值

正确：

明确报错

---

# 11. Bug 修复流程

发现 bug：

必须：

复现
↓
确认调用链、字段职责与事实来源
↓
定位能够解释全部现象的根因
↓
检查合法反例
↓
设计最小修复
↓
增加测试
↓
回放原始失败数据
↓
验证完整流程

`npm test` 通过是必要条件，不代表新引入的业务契约正确。
涉及模型输出时，还必须回放原始失败数据，并验证至少一个合法反例。
禁止：

看到错误日志
直接修改提示词

---

# 12. 测试要求

修改后必须运行：

npm test

如果测试失败：

必须说明：

- 业务失败
- 环境失败
- 测试本身问题


不能简单忽略。


---

# 13. 文档要求

新增架构：

必须同步：

docs/
README.md
AGENTS.md

避免：

代码与文档长期偏离。


---

# 14. 当前最高优先级事项

修改优先级：

## P0

状态隔离：

variant digest
story revision
plan revision
media namespace

---

## P1

Full Story Contract：

修复：

- 角色提及误判
- 临时角色漏检
- careRecipient 漂移
- variant context 绑定


---

## P2

生产可靠性：

- 导入验证
- 签名机制
- 持久化状态
- 媒体生命周期


---

# 15. 最重要原则

修改任何代码之前：

先理解系统。

不要假设。

不要扩大范围。

不要为了让测试通过破坏业务约束。

优先保证：

正确性
一致性
可追踪性
可恢复性

而不是：

代码数量减少
实现速度
表面通过

本项目必须使用 node24 启动，禁止直接使用 25+版本直接运行，在项目运行时，如果修改了服务器相关的文件，自动重启服务器。
