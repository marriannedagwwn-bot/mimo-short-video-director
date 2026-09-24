# Full Story 角色与道具边界验收

现有工作区的 46 个文件先提交为 `78f950f`，本次修复从该提交单独开始，未推送远端。

## 问题与事实来源

真实候选 V3《迷路的蒲公英》的 `characterSetup` 只有 protagonist，没有 careRecipient。初轮 Full Story 却把普通蒲公英同时放进 `characterBible.careRecipient` 与 `keyProps`，分场 characters 只列小白子、芙芙猫；原始输出分别命中 7 / 9 处 `FULL_STORY_SCENE_VISUAL_CHARACTER_MISSING`。

生产链为：已签发 Candidate → `WorkflowService.createFullStory` → `fullStoryPrompt` → 文本模型 → Full Story Schema / Scene Contract / Profile → Beat–Scene postpass → 完整复验 → Task commit。`characterBible` 的所有登记名参与出镜检查；Animation Foundation 与后续语义审计继续消费角色表、分场与道具，不能靠忽略登记名、删动作或把物件塞进出镜名单解除冲突。

权威与优先级：候选正文决定已有剧情与角色；可选功能标签不能把普通物件升级成角色。Full Story 扩写已有内容，角色表和分场名单必须一致。是否拟人属于语义判断，不以本地物种词表裁决；没有唯一签发值来源的冲突继续 fail closed，不新增自动删字段、覆盖或失败重写。

合法反例：被照料的人物、熟睡不说话的小猫、候选已经设定的蒲公英精灵仍可成为角色；被浇水的盆栽、被缝补的普通布偶、被搬到坡顶的普通蒲公英保留全部可见动作和道具用途。

## 修改假设与范围

最初只补“角色与道具”的分类说明，真实 Qwen 回放仍触发相同错误（1 次调用，24,674 token）。该样本否定了“仅补通用分类说明即可解决当前失败”的判断，不能把通过的文字断言当成修复效果。

再次检查发现，原提示词无条件展示 careRecipient 的完整五字段模板。最终按候选是否登记该可选键选择生成说明：未登记时不展示模板，开头明确本次角色表只输出 protagonist/helpers；已登记时保留可选模板，并明确普通物件仍应省略该角色登记。两阶段同时说明角色与道具的语义边界。函数只生成提示词，不修改输入候选或返回 JSON。

改动只涉及提示词、回归测试及说明文档。Schema、验证器、provider/model、任务次数、纠错协议、Artifact 内容、revision/digest 与实际浏览器 Run 均不由本次修复改写。

## 验收证据

### A 静态验证

状态：通过

执行：

- `node --check src/prompts.js`
- `git diff --check`

实际结果：

- 语法和补丁检查通过，未改输出 Schema。

### B 自动化行为验证

状态：失败

执行：

- `node --test test/full-story-character-prop-boundary.test.js test/full-story-prompt-narrative-scope.test.js test/full-story-recurring-character-registration.test.js`
- `node --test test/*.test.js`
- `npm test`

实际结果：

- 针对性测试 51 项全部通过；覆盖模板分支、输入不变、普通物件的可见事实、人物/动物/拟人角色以及漏登记仍失败。
- 正式 test 目录 1,301 项：1,295 通过、6 跳过、0 失败。
- `npm test` 最终 1,489 项：1,465 通过、6 跳过、18 失败。它额外扫描忽略的 exports 实验目录，仍有既有的 18 个失败：3 个快照缺模块，15 个实验依赖旧提示词锚点。未修改这些实验文件或跳过正确断言。
- 前两类测试只能证明提示词边界存在及既有合同未被削弱，不能证明模型必然遵守。

### C 真实运行

状态：通过

入口：

- 独立 41876 实例启动当前 `server.js`，使用临时状态根目录与原签名密钥的私有副本。
- `POST /api/tasks/create` 创建 Full Story Task，经实际路由、绑定、Qwen `qwen3.7-max`、完整校验及提交路径执行。
- 使用原候选 V3 与原已签发上游，24 秒目标。未操作用户浏览器的 current Artifact。

实际结果：

- 第一轮仅通用说明的真实回放失败，原 Run manifest 哈希保持不变。
- 移除未使用模板后的 Task `task-99f3efb4-0b30-4d31-b83b-941f214a036b` 于 08:12:37 UTC 完成，签发验收实例的 `fullStory-V3-r1`，digest 为 `4058b12c7158a1585288a97a902b1c9f32040a7487c101a9ab2a9f7ac86ceed7`。原 Run manifest 哈希仍未变。
- 实际有 3 次 provider 请求尝试：首次约 10.5 秒 transport 失败，无 completion/usage；既有 coordinator 的唯一重试返回合法 Full Story；随后 Beat–Scene postpass 六拍全部 pass、completions 为空。两份有效响应合计 30,137 token，未增加纠错次数。
- 模型观测记录的 gitCommit 为 `78f950f26084a3fc309805e3aed49e0f0006308d`；该实例在提示词修改后新启动，读取当前工作区源代码。临时实例、状态和密钥副本已清理，仅在原 Run 的私有 debug 内保留此次验收记录。
- 检查时原 4173 服务已经停止；该页面工作区已超过无连接过期时间。本轮不启动其清理流程，保留原 Run，验收使用独立实例。

### D 用户可见结果

状态：通过

验证内容：

- 新 Full Story 中普通蒲公英是否仅作为道具出现。
- 小白子、芙芙猫和原候选动作链是否保留。
- 完整 Full Story Task 是否完成并提交一个合法 Artifact。

实际结果：

- 实际生成的角色表没有 careRecipient；主角为小白子，helpers 仅含芙芙猫；所有分场 characters 都不含蒲公英，keyProps 保留蒲公英。
- 逐场读取新输出：观察蒲公英 → 原地吹气失败 → 连根捧起 → 与芙芙猫跑上坡 → 踮脚吹散种子 → 并肩坐下并放下空茎。没有用删除核心动作或新增拟人行为消除冲突。
- 本项通过仅针对角色/道具分类及 Full Story Task，不代表成片或后续 Animation Plan 已验收。

### 修改范围

- 修改文件：`src/prompts.js`、`test/full-story-character-prop-boundary.test.js`、`AGENTS.md`、本报告。
- 未修改范围：Schema、validator、workflow、已有 Artifact、provider 配置与模型路由、UI、原 Run。
- 当前分支：`codex/story-quality-phase1`。
- 当前 HEAD：`78f950f`，修复单独留在工作区。

### 未覆盖路径

- 其他文本供应商的生成效果。
- 已显式把普通物件登记为 careRecipient 的旧候选的真实模型回放。
- Animation Plan、媒体生成与最终成片。
- 原浏览器 4173 实例重新加载后的效果。

### 剩余风险

- 角色分类仍由模型理解提示词，没有可唯一推导的本地语义判据。错误输出继续明确失败，不能宣称永不复发。
- 单个真实样本通过不代表跨题材、跨模型稳定性。
- 该 24 秒候选还存在独立的既有时长问题：此次输出 S2、S3 均为 3 秒。只读调用 `deriveDirectShotSkeleton` 已确认后续会以 `DIRECT_SHOT_SCENE_DURATION_BELOW_PROVIDER_MINIMUM` 拒绝 S2。本次未改场次时长或下游 4 秒下限，不能把 Full Story 分类修复宣称为整条视频流程通过。

### 完成结论

当前失败样本已通过真实 Full Story 生成、完整校验与提交前复核，普通蒲公英保留为道具，原角色和动作链保留。修复单独留在工作区；只确认本样本与现有合同的结果，不宣称全题材、跨模型稳定性，也未处理独立的短场次时长问题。用户原 Run 未被替换，原 4173 服务未重启。
