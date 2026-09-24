# 《蚂蚁搬家式运书》修复与 A/B 记录

2026-09-14。当前 V4 已通过既有 Artifact 接口签发 `variant-V4-r2` 和 `fullStory-V4-r2`；完整剧情 65 秒。原 revision 保留。结论是**当前样本已作显式候选修订、真实重新展开并校订两处表述**，不是“单改 FullStory Prompt 就自动修好”。本轮两次 Prompt 处理均未达到内容验收，已撤回；生产代码和测试文件与本轮开始时逐字一致，先前工作不受影响。

查看 [修改前后完整正文](/Users/qinfen/Downloads/fullStory-ant-books-ab-2026-09-14/蚂蚁搬家式运书-修改前后对比.md)、[当前修订后正文](/Users/qinfen/Downloads/fullStory-ant-books-ab-2026-09-14/deliverables/蚂蚁搬家式运书-修订后正文.md) 和 [已签名生产包](/Users/qinfen/Downloads/fullStory-ant-books-ab-2026-09-14/deliverables/蚂蚁搬家式运书-修订后.json)。全部原始请求、回答、失败稿和审计在 `/Users/qinfen/Downloads/fullStory-ant-books-ab-2026-09-14`。

## 用户标准与实际修复

依据最新引用对话及用户对“像不像正常人说话”的纠正，只看实际正文；ChatGPT 的主观评分不当作测量结果。尾巴质疑已被用户纠正，不作问题处理。

| 检查点 | 原候选的 A 组真实展开 | 当前修订稿 |
|---|---|---|
| 开场观看理由 | 首 12 秒是分类、进场、拍胸脯，未显出小白子与高书堆反差 | 第一场即写高书堆，小白子抬头看书山；搬运事故也在首场出现 |
| 主动帮忙的表达 | 小白子只说“帮忙！”，求助与提供帮助不清 | “我来！”；村长回应现场搬书的危险，没有背景介绍式长句 |
| 小份与往返 | 没有具体减量，手抱与头顶动作的承托不清 | 两三本一份，先顶稳再直背蹲下抱另一小叠；放下后空手返回 |
| 意外与进度 | 滑书后直接跳到“全部搬运完毕” | 后续一趟滑到颈侧，仰头抬肩夹住，到箱边先放怀里再接头顶；余量变少、箱内增多、最后一叠入箱 |
| 收尾 | 躺竹席、扇风、猫趴肚子 | 全部保留，不另加奖励、赠物或说教 |

## 实验没有隐藏失败

四次 FullStory 调用均通过真实隔离服务的 `/api/tasks/create`，`kind=fullStory`；全部 Qwen / `qwen3.7-max`、`max_tokens=16384`、`temperature=0.3`、`top_p=0.95`、thinking 开启、目标 65 秒。一次独立编辑探针通过同一 Qwen 客户端直连，仅作诊断，没有接入生产流程。

| 版本 | 唯一计划处理/目的 | 耗时 | 实际 tokens | 结果 |
|---|---|---:|---:|---|
| A | 原候选、原生产代码 | 74.2 秒 | 12,593 | 四场/62 秒，复现晚出反差、表达歧义与跳到完成 |
| B1 | 同一候选，只增加五段通用提醒 | 94.3 秒 | 14,091 | 仍进场寒暄、齐胸高、一次后全完成；失败 |
| B2 | 同一原始输入，投影去粗排标签，并先生成 sceneScript | 68.2 秒 | 11,367 | 仍“村长，帮忙！”和齐胸高；失败 |
| 编辑探针 | 对 B2 作一次字段级编辑诊断 | 34.9 秒 | 6,081 | 能识别对白/身体冲突，但改了候选顺序，仍未补分趟；不接入生产 |
| C | 显式修订 V4，再用 A 的原生产代码展开 | 74.3 秒 | 12,135 | 四场/65 秒，主要体验改善；原文另有两处小矛盾 |

共 5 次真实调用、56,267 tokens；按当前配置单价估算 ¥1.35，非供应商账单。没有重试到挑出成功稿，没有生成图片或视频。

B1 的真实请求与 A 仅差五段指令。B2 的原始候选内容不变，只有只读投影与 Prompt 组织变化。A 与 C 使用的生产源码哈希完全相同；除候选事实那一行外，全部 messages 和采样参数逐字一致。**A/C 是候选修订对比，不能冒充固定输入的 Prompt A/B 成功。** 四次 FullStory 的模型原文与隔离 Run 签发内容均一致。

## 为何转回候选修订

原候选虽然写“拆成几小叠”，并未说明每次的实际分量、从哪一侧腾手、放下、空手回去和后续搬运。把两小叠同时拿着并不必然等于原大堆，因此不能仅凭“两叠”判数学矛盾；但当前动作顺序和过渡不够明确，真实生成反复将它扩成大负担。独立编辑还通过调换“先抱再顶”的候选顺序才解决占手问题，这不能伪装成原候选事实不变的 FullStory 修复。

本次使用现有 `ensureStoryCandidateRevisionContract → mergeStoryCandidateRevision → assertOnlyCandidateRevisionFieldsChanged → deriveStoryCandidateProjections`，由 Codex 明确撰写候选修订。只变 V4 的 action 和 estimatedSeconds；第 2 拍动作未变，所有拍号、phase、dramaticFunction、角色、标题、Hook、视觉潜力和来源证明冻结，另外三个候选逐字不变。三个剧情投影按既有函数派生。动作文字 238→355 字，增加的 117 字用于分量、腾手、往返与完成，不是另开支线；这也说明它并非零代价的措辞替换。

修订后真实 C 稿随后仅作两处人工校订，明确保留模型原稿：

1. S3 “再次顶着和抱着书往回走”改为“再次顶着和抱着小份书，从原书堆走向捐赠箱”，目的地来自同场后文。
2. S4 “书堆已经消失、箱里装满”改为逐趟减少/增加、只剩最后一小叠，再承接原有入箱动作，兑现修订候选第 5 拍。

其余 C 字段逐字不变，原始输出与最终稿的差异记录于 `manual-edit-log.json`。没有把人工校订写成模型自动通过。

## 验收证据

### A 静态验证

状态：通过

执行：

- Node 24 `node --check`；候选修订范围校验、三项投影派生及严格 Story/Scene Contract；`git diff --check`。

实际结果：

- 新候选和完整剧情通过结构校验。最终时间线 12/17/19/17 秒，既有骨架派生为 7 镜、总计 65 秒。人工校订未改变时间线或其它字段。
- 所有生产代码和测试文件已恢复到本轮开始时的原样；不是 reset/stash/checkout 工作区。

### B 自动化行为验证

状态：失败

执行：

- `node --test --test-reporter=tap test/full-story*.test.js test/direct-shot-timeline.test.js test/animation-plan-v3-direct-shot.test.js test/story-duration.test.js test/story-candidates-prompt-mock.test.js test/story-candidate-revision.test.js`
- `npm test -- --test-reporter=tap --test-concurrency=1`

实际结果：

- 相关 255 项全部通过。
- 最终全量 1813 项：1789 通过、18 失败、6 跳过。18 处均与本轮前的历史 `exports/` 失败位置一致，`test/` 目录无失败。
- B2 并发全量曾另遇一例 `EADDRINUSE`，失败发生在测试服务启动前；保留原日志，该 HTTP 控制文件单独 3/3 通过，最终顺序全量不再出现。

### C 真实运行

状态：通过

入口：

- 四个隔离 Run 的真实 Durable FullStory task；一次独立编辑诊断；当前 `4173` 服务的公开 Run/Artifact/package 接口。

实际结果：

- 所有实际请求、输出、usage 与源码哈希可核对。隔离 fixture 仅用公开签名函数重签认证字段，原始视频和业务事实未据此重新分析或认证。
- 当前 Run 已签发 `themeVariants-r2`、`variant-V4-r2`、`fullStory-V4-r2`，原四项上游和旧 revision 保留。写入前复核没有 active task、其它下游或用户期间改动；写入后重新 load Run 并核对内容及签名包。
- 当前服务仍使用 Node 24 watch，生产代码恢复后已重载；无新增自动编辑调用。

### D 用户可见结果

状态：部分通过

验证内容：

- 逐场阅读全部动作和台词，核对开场反差、减量/往返/完成、口语与角色语言边界、夹书和乘凉结尾。

实际结果：

- 当前样本正文的主修问题已处理，完整稿与签名包可打开；修复来源明确为候选编辑＋真实展开＋两处人工校订。
- 浏览器工具两次无法读取 request-header policy，本轮没有观察刷新后的 DOM/截图。当前 Run 已保存新内容，刷新原标签页可按既有恢复流程读取；不宣称已验证最终页面渲染或成片吸引力。

### 修改范围

- 修改文件：本报告及 README 文档入口；本地 Run 的 themeVariants、V4 Candidate、V4 FullStory 新 revision。
- 未修改范围：最终未保留任何本轮生产 Prompt、Schema、Validation、流程或测试变更；原工作区已有修改完整保留。其它候选内容、固定角色/尾巴、模型设置、原视频和导出历史保留。
- 当前分支：`codex/story-quality-phase1`
- 当前 HEAD：`73b25096fcbc2d62b0846731918ba9d36080477b`

### 未覆盖路径

- 新 Animation Plan、图片、视频生成及播放；浏览器刷新后交互；其它候选、模型与多轮稳定性。

### 剩余风险

- 本次仍需人工候选修订与两处正文校订，不能把它推广成“全自动 FullStory 已合格”。
- 7 镜骨架可派生，不证明实际视频中的平衡动作能稳定渲染。没有假造留存率或质量分。
- 上游整批 themeVariants 更新按既有规则使旧下游 stale；已核对本次只有 V4 的旧 FullStory 受影响，且旧内容仍在历史 revision 中。

### 完成结论

当前指定剧情已完成修订、真实对比和 r2 签发。纯 Prompt 的两个实验失败并已撤回；全自动生成质量与最终视频效果仍未获证明。
