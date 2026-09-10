# 完整剧情暂停、继续与终止验收（2026-09-10）

“生成完整剧情”执行时使用与“启动 AI 导演”相同的黑色控制组：左终止，右暂停/继续，背景 32×32px、点击区域 44×44px。创建完成前控件禁用；服务端确认暂停后才显示继续，不把浏览器本地断线当作服务端暂停。

完整剧情仍是一个 `fullStory` 根任务。暂停保留创建时输入、模型、冻结依赖、目标 revision 和 claim；继续保持 taskId、换用新 requestId 重做整个 Full Story operation（初轮与 Beat–Scene postpass），跨尝试累计已知/未知用量。终止保留原已签发 Story、Plan、媒体和 Run。已提交成功的 request 不再接受暂停或终止，避免把已完成生成重跑一遍。

## A 静态验证

状态：通过。

- 10 个本次变更 JavaScript 文件通过 `node --check`，`git diff --check` 通过。
- 复用现有 control 路由、Task status、文本客户端的 AbortSignal、Artifact 提交与冻结依赖校验。未修改业务 Prompt、Full Story JSON、角色/道具边界或分场复核协议。
- 旧 attempt 的 heartbeat、usage、Stage、子任务与 commit 回调在锁内复验原 signal；不能在继续后写入新尝试。Task Store 只增加受 `safeIdentifier` 约束的 requestId 更新，不保存模型正文或请求体。

## B 自动化行为验证

状态：定向回归通过；全仓保留原有失败，无新增失败。

- UI：7 个定向文件 98/98，其中 Full Story 专属 21 项。覆盖创建等待、重复控制、暂停恢复、终止保留、未知用量、提交竞态、切换候选和迟到响应；初始 Run 的既有选中候选恢复规则不变。
- Manager 与文本取消/usage：105/105，其中 Manager 54 项，新增 Full Story 10 项。覆盖多次暂停累计、冻结输入/模型、继续前 Candidate 冲突零新调用、已提交但被上游标 stale 时控制不重跑、queued、重启 interrupted、release 和旧回调隔离。
- 真实 HTTP 回归：2/2，详见下节。
- BrowserWorkspace 清理：18/18。新增 Full Story 的 `cleanup/sweepPending × running/paused` 四项先全部复现失败，再修复仅收集导演根任务的遗漏；验证锁外中断/唤醒、清理后释放槽位、下一 Run 出队、旧 Runner 不能重建已删除 Run。
- `npm test`：1620 项，1596 通过、6 跳过、18 失败，新增 37 项全部通过。日志 `/tmp/mimo-full-story-controls-tests-20260910.log`；18 个失败名称与修改前 `/tmp/mimo-director-ui-cleanup-tests-20260910.log` 完全一致，分别为 3 项导出快照缺依赖、15 项旧实验提示词锚点不匹配。未跳过、删除或削弱这些历史断言。

## C 真实运行

状态：真实服务入口与本地供应商协议通过；未调用付费供应商。

- `test/full-story-run-control-http.test.js` 启动真实 `server.js`，使用本地 SSE 供应商与独立状态目录。上游经完整 director 流程生成；旧 Candidate/Story/Plan/media fixture 经正式 production HTTP commit 签发并绑定依赖。
- 在正文已返回、Beat–Scene postpass 流正在等待时暂停，真实 HTTP 响应关闭。Task GET/list 与相同 operation 的 create 保持同 taskId paused，零自动模型调用；继续会重做正文和复核。已知用量由 15 tokens 累计至 45 tokens，另有一次未知调用；新 Story 提交才使旧 Plan/media stale。
- 终止后让供应商尝试迟到返回，旧 Story/Plan/media 的 revision、digest、内容和 current 状态仍不变。
- 浏览器另使用独立实例、真实 45 秒 MP4，完成上传、抽帧、导演五阶段和候选选择。仅供应商替换为本地受控 SSE，没有使用生产 `.env` 或用户 Run。
- 浏览器验收目录：`/var/folders/ps/1zh3d0tx72v6m9dwhwd46ptm0000gn/T/mimo-full-story-browser-37v62igc/`。最终证据为 `final-provider-receipt.json`、`final-task-receipt.json` 和 `fixture.log`；临时标签页、provider 58238 与 server 58239 均已关闭。
- 收尾时主服务 4173 已由既有 watcher 加载修改，listener PID 68142；根页面 HTTP 200，Full Story 与导演五阶段的模型健康检查均为 HTTP 200。当前没有 queued/running Task；健康检查不等于真实付费生成验收。

## D 用户可见结果

状态：浏览器真实交互通过。

- 两个图标为独立按钮，实际坐标证实左终止、右暂停；两个点击区域均为 44×44px，伪元素背景均为 32×32px，与 AI 导演共享 CSS。
- 初轮生成暂停后刷新，页面仍显示“完整剧情已暂停”，继续按钮可用，未隐式重调模型。
- 继续成功后显示“已确认消耗 30 tokens · 1 次请求未返回用量”，同一个 taskId 完成，旧尝试未被记成零成本。
- 重新生成期间终止，页面显示“完整剧情已终止，已有结果已保留”；原剧情渲染文本逐字不变，刷新后仍保留结果，生成按钮重新可用，终止按钮隐藏。浏览器控制台无错误。
- 用户的原始 4173 标签页及其输入未被用于测试或强制刷新；刷新后加载新前端。

## 修改范围与边界

- 前端：按钮组与状态模块、创建/控制/恢复请求的候选归属隔离。
- 服务端：Full Story root 控制、尝试级 requestId/usage、迟到回调与提交竞态、BrowserWorkspace 清理唤醒。
- 测试与文档：UI、Manager、HTTP、cleanup 回归，以及 README、AGENTS 和 Production Lineage 说明。
- 当前分支 `codex/story-quality-phase1`，实现与自动化验收时的工作区基点为 `500ec4d`。用户于 2026-09-10 确认本批修改验证通过；已有代理和界面精简修改完整保留，随后按功能拆分本地提交，未推送。

未覆盖真实供应商断开 HTTP 后远端计算/计费何时停止；不能将本次验收描述为远端取消确认。继续会重新生成，可能再次计费。跨 Node 重启仍不自动恢复模型请求。
