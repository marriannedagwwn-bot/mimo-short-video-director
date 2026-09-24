# 任务状态同步与生产包下载验收（2026-09-09）

用户报告：生成完整剧情时刷新，按钮仍显示生成中，但上方提示被覆盖成“准备生成完整剧情”；要求检查其他同类入口。检查期间另报告生产包 JSON 无法下载。

原因与修复：

- Run/Task 恢复先应用任务状态，随后路由、Artifact 或弹窗渲染又写入默认提示。现在状态提示和按钮读取同一份服务端 Task 快照，重绘后重新应用；按目标、任务时间及 current revision 区分当前状态与历史任务。
- 排队、生成、改写、人物精修、图片返回数量和终态分别显示。镜头卡片在 Run 重载后恢复任务覆盖；活跃批量任务阻止单镜重复提交；批量中断后释放弹窗控件，同时保留素材校验。
- 原导出函数本轮此前未改动。现场对照中，内置浏览器的 Blob 下载无下载事件，延后释放 Blob 也无效；HTTP GET 附件与异步签发后的表单 POST 附件均产生下载事件。生产包和测试包改为签发后通过 HTTP 附件下载，服务端复用既有签名、摘要和 lineage 校验，不缓存或落盘临时下载副本。

## 验收证据

### A 静态验证

状态：通过

执行：

- `node --check public/app.js`
- `node --check public/task-status-ui.js`
- `node --check public/production-package-download.js`
- `node --check src/production-package-download.js`
- `node --check server.js`
- `git diff --check`

实际结果：

- 全部通过。

### B 自动化行为验证

状态：通过（正式测试目录）；失败（无过滤的历史目录测试发现）

执行：

- `node --test test/task-status-ui.test.js test/production-package-download.test.js`
- `node --test test/*.test.js`
- `npm test`

实际结果：

- 28 项定向测试通过：26 项状态回归运行真实 app 的渲染、恢复与弹窗函数；2 项下载测试覆盖真实 HTTP、签名包内容不变、中文文件名、测试包后缀、篡改拒绝、无效 JSON、大小上限、Content-Type 与浏览器表单错误反馈。
- 最终正式目录：1291 tests，1285 pass，6 skipped，0 fail。
- `npm test` 在最后一次批量终态补测前运行：1478 tests，1454 pass，6 skipped，18 fail。失败均位于已有 `exports/` 测试：3 个不完整 git-sync snapshot 缺模块；15 个 story-editorial-lab 实验测试的旧提示词/锚点断言失败。未删除、跳过或改写这些断言。最终新增批量终态用例及补丁已纳入上述正式目录回归。
- 原因定位过程中确实捕获并修复了候选轮询不更新状态栏、角色图数量回到 1、旧 Plan 失败覆盖新媒体、批量结束后弹窗仍锁住的反例。

### C 真实运行

状态：通过

入口：

- 当前生产服务 `http://localhost:4173/`；实际页面 `/story/V4`，故事《晒谷场的午后》。
- 隔离 HTTP 状态夹具 `http://localhost:41875/`，直接提供当前 `public/` 代码，仅替换 Run/Task/health API 响应，不提交模型请求。

实际结果：

- 已确认接入下载路由前当前 Run 没有 queued/running 任务。Node watch 载入新服务代码，随后根页面及 health 返回 HTTP 200，mode=live。
- 当前真实页面刷新恢复后，点击“导出当前生产包 JSON”捕获到原生下载事件。
- 下载文件 `/Users/qinfen/Downloads/晒谷场的午后.json` 实际存在，118224 bytes；重新读取并通过 `ProductionStateStore.validatePackage()`，标题与当前故事一致。
- 文件 SHA-256：`c3fc3fcb55e40edf87f042f6f10e7c908c8fcd7f204a12e249bdea2aaa5d2ae9`。
- 隔离验收结束后关闭测试标签页与 41875 服务；4173 服务继续运行。

### D 用户可见结果

状态：通过（下列已检查场景）

验证内容：

| 入口 | 实际观察 |
| --- | --- |
| 完整剧情刷新 | 提示“正在生成完整剧情…已接收 137 字”，按钮“完整剧情生成中”且禁用 |
| 已有剧情再次生成 | 提示和按钮均显示排队，未被“已生成”覆盖 |
| Animation Plan | 已有 Plan 时仍正确显示正在生成与禁用按钮 |
| 视频提示词改写 | 上方与按钮均显示改写排队 |
| 人物参考精修 | 计划状态及人物上传按钮显示精修进行中 |
| 角色图弹窗 | 任务进度 1/4、数量控件 4 张、生成按钮禁用；失败后显示错误并恢复按钮 |
| 旧 v2 镜头帧 | 卡片显示排队；弹窗接管行为由真实 app 函数回归覆盖 |
| 镜头视频 | 卡片显示服务端生成进度；独立弹窗接管由真实 app 函数回归覆盖 |
| 批量视频 | 暂停提示、暂停按钮与单镜弹窗状态一致；中断后显示终态，关闭/数量控件解锁，缺素材时生成按钮仍禁用 |
| AI 导演 | Artifact 重绘后仍显示执行中 4/5 |
| 候选重生 | 轮询显示“主题变体任务正在排队” |
| 已完成剧情恢复 | 上方显示任务完成，实际 V4 页面显示保存的模型与 token usage |
| 生产包下载 | 原生下载事件和下载目录中的已验签文件均确认 |

实际结果：

- 原截图中的状态与按钮矛盾已在浏览器刷新反例中消除；任务结束时不再统一落入“准备下一镜”或持续锁住弹窗。
- 下载提示使用“已发起下载”，不再把触发前端动作等同于文件已经保存。

### 修改范围

- 修改文件：`public/app.js`、`server.js`（下载 handler 接线）。
- 新增文件：`public/task-status-ui.js`、`public/production-package-download.js`、`src/production-package-download.js`、`test/task-status-ui.test.js`、`test/production-package-download.test.js`、`test/helpers/app-ui-harness.js`、本验收记录。
- 未修改范围：本次状态/导出修复未改生成 Prompt、业务 JSON 契约、供应商路由、Artifact 签发规则。工作区此前的页面生命周期实现及其他并行改动保留，不将整个 dirty diff 归于本次修复。
- 当前分支：`codex/story-quality-phase1`。
- 当前 HEAD：`0fd4f44ff369720d0db3617435a761532b7a8542`；本次改动未提交。

### 未覆盖路径

- 未为状态验收发起付费模型生成；受控任务响应验证 UI 恢复，不证明供应商生成质量或稳定性。
- 剧情/候选/分镜评审等原有临时报告接口没有 Durable Task，仍不支持刷新恢复；本次未将它们改为持久任务。
- 工作台“导出完整 JSON”的无签名快照仍使用原路径；本次 HTTP 附件修复范围为生产包与测试包两个按钮。
- 测试包后缀通过真实 HTTP 自动化验证；真实用户页面本次只捕获生产包按钮的下载事件。

### 剩余风险

- `npm test` 的历史导出目录 18 项失败仍存在，不能报告全仓测试全绿。
- 状态夹具验证了列出的恢复、排队、生成与终态场景，不等于遍历所有跨变体并发交互。

### 完成结论

已完成本次发现的任务状态显示修复及生产包/测试包 HTTP 下载修复；正式测试目录、受控浏览器状态检查和当前真实生产包下载验签均通过。历史实验测试失败及以上未覆盖边界保留如实记录。
