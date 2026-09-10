# AI 导演暂停、继续与终止验收（2026-09-10）

运行后的“启动 AI 导演”右端显示两个独立图标按钮：左侧终止，右侧暂停/继续。用户已明确接受“中断当前请求；继续时重做当前阶段”的方式，以及当前阶段可能再次计费。

实现沿用现有父子任务、Artifact 与 lineage 契约。暂停保留五个 claims 和已完成阶段，终止保留 Run 与已完成 Artifact；两者均阻止旧请求迟到提交。暂停状态不新增 Task status。用量展示已确认 token，并明确标记没有收到 usage 的请求。

## 验收证据

### A 静态验证

状态：通过。

执行：

- 对 22 个变更的 JavaScript 文件执行 `node --check`。
- `git diff --check`，审阅完整生产代码与测试 diff。

实际结果：

- 无语法和空白错误。Task Store 无新增业务内容、Prompt 或媒体字段；现有八个 status 不变。
- 请求计数在 fetch signal 构造时同步记录，guard 完成后、实际 fetch 前取消不会虚构请求。
- 所有控制转移先在 Run 锁内设置门禁，再在锁外中断连接/唤醒等待；页面清理遵守 scheduler → Run 锁顺序。

### B 自动化行为验证

状态：正式测试目录通过；全仓命令存在修改前已有的失败。

执行：

- `node --test test/*.test.js`：1367 项，1361 通过、6 跳过、0 失败。
- `npm test`：1555 项，1531 通过、6 跳过、18 失败。
- 完整日志：`/tmp/mimo-director-control-verified-official-tests-20260910.log`、`/tmp/mimo-director-control-verified-tests-20260910.log`。

实际结果：

- 18 项失败与修改前 `/tmp/mimo-layout-validation-final-20260910-01a085c9.log` 逐项名称一致，无新增失败：3 项来自 `exports/git-sync-2026-09-09/snapshot/test/` 缺失依赖，15 项来自 `exports/story-editorial-lab-2026-09-08/` 旧提示词锚点。没有删除、跳过或削弱这些断言。
- 三家文本客户端覆盖等待 headers、读取 JSON/SSE 时取消、并发任务隔离、普通 timeout、预取消零调用、已收到 usage 的保留和不重复入账。取消测试 timeout 为 60 秒，测试期限为 5 秒，不能靠等待原 timeout 通过。
- Manager 覆盖两次暂停后仅重做当前阶段、所有尝试的累计用量、已签发 revision/digest 保持、claims 保留/释放、响应返回后取消阻止 commit、queued 控制、快速 resume→pause→terminate、旧 watchdog 不提前解除 waiter、Node 重启、强制释放与页面清理回收槽位。
- 页面清理新增 running/paused × cleanup/sweepPending 四个真实 Manager/文件系统用例；暂停泄漏先复现失败再修复。断开和唤醒在锁外执行，下一 Run 能出队，迟到结果不能重建旧 Run。

### C 真实运行

状态：受控供应商协议与真实服务入口通过；付费供应商生成未作为验收调用。

入口：

- `test/director-run-control-http.test.js` 启动真实 `server.js` 子进程，经 `/api/tasks/create`、`/api/tasks/:id/control`、Task GET、Run load、校验、签发和落盘。
- 原生 HTTP/SSE 本地供应商 fixture，真实可观测 TCP 响应关闭；fixture 外的服务、调度、校验和存储均为本项目代码。
- 浏览器隔离实例使用真实 45 秒 MP4、上传、抽帧与完整页面；固定角色“小白子”、赛道“日常”、3 个候选。实例 cwd 为临时目录，最小环境变量只指向本地供应商，没有使用用户 `.env`。
- 用户实例 `http://localhost:4173/` 已由现有 `npm run dev` watcher 加载当前服务端文件；验收末尾 listener PID 36639，父 watcher 81351，根页面 HTTP 200。原页面已刷新加载新前端。

实际结果：

- Brief 首次请求在流中挂起；pause/terminate 后本地供应商确认该响应已关闭，后续阶段不被提交。
- resume 保持父 taskId，以新的子请求重做 Brief；之前 Analyze/Reconstruct 的 revision/digest 不变。最终五阶段完成，3 张候选卡生成。
- 最新服务代码还验证了暂停后更换视频：旧 Run 清理、新 Run 可执行，遗留清理记录消失。隔离测试页已关闭，两个临时监听端口已停止。
- 浏览器 fixture 日志与临时状态保留在 `/tmp/mimo-director-browser-Vlnelf/`，不属于生产数据。

### D 用户可见结果

状态：通过（正常桌面视口、真实页面与受控供应商）。

验证内容：

- 运行态右侧图标顺序、暂停/继续切换、键盘操作、刷新恢复、终止保留阶段、用量文案、暂停任务清理。

实际结果：

- 图标位于同一深色控制条右端，左终止、右暂停；44px 点击区域，独立按钮和可访问名称，没有嵌套 button。暂停后右侧为继续图标，Enter 能继续。
- 暂停文案说明当前请求会断开，继续会重做并可能再次计费；刷新保持暂停，未自动提交新请求。
- 暂停→刷新→继续完成时，页面显示“复用 2 个已有阶段”“本次实际调用 7 次模型”“已确认消耗 90 tokens”“1 次请求未返回用量”。其中正常五阶段含候选的两次调用，另有一次被暂停的 Brief 请求。
- 终止→刷新后显示“AI 导演已终止，已完成阶段已保留”“已确认消耗 30 tokens”“1 次请求未返回用量”；前两个阶段完成，Brief 已停止，后续阶段等待。无错误弹窗，启动按钮重新可用。
- 用户的 4173 页面在最终刷新时已有另一条 `fetch failed` 任务；新 UI 正确恢复其失败状态并显示“1 次请求未返回用量”。该供应商连接失败没有自动重试，也没有被本次受控验收算作真实生成成功。

### 修改范围

- 前端：`public/app.js`、`public/index.html`、`public/styles.css`、`public/director-pipeline-ui.js`、`public/token-usage-format.js`。
- 服务端：`server.js`、`src/durable-task-manager.js`、`src/durable-task-context.js`、`src/browser-workspace-cleanup.js`、`src/model-call-coordinator.js`、三家文本客户端、`src/sse-stream.js`、`src/token-usage.js`。
- 回归：新增 director control UI、真实 HTTP control、text cancellation 三份测试，扩展 Manager、cleanup、usage、SSE、director UI 与 app harness。
- 文档：本记录、`AGENTS.md`、`docs/production-lineage-state.md`。
- 未修改范围：业务 Prompt/Schema、角色与道具语义、Story/Animation Plan 契约、视频供应商的镜头边界暂停、用户模型配置、已有业务 Artifact。
- 当前分支：`codex/story-quality-phase1`；当前 HEAD：`4970eba93cf5630dade45dcd14e1c92a484330bc`。
- 修改前已按用户要求提交此前的面板/按钮对齐改动为 `4970eba`。本次控制功能改动保留在工作区，尚未提交或推送。

### 未覆盖路径

- 供应商真实远端计算/计费在断开 HTTP 后何时停止；没有调用付费模型验证这一点。
- 移动端视口和真实供应商跨地区网络差异。

### 剩余风险

- 暂停不是供应商原请求续传，重做当前阶段可能重复计费；未收到的 usage 必须保持未知。
- 已运行的父任务暂停时保留一个 workflow 槽位与内存输入，Node 重启仍会 interrupted，不能跨进程原地继续。
- `npm test` 的 18 个既有导出目录失败仍存在；4173 当前页面的 `fetch failed` 也未被本功能改动修复。

### 完成结论

运行按钮控制、服务端 HTTP/SSE 中断、当前阶段重做、已知/未知用量、刷新恢复与清理收尾已实现，并通过正式测试目录和真实浏览器/受控协议验收。不能据此宣称供应商远端计算与计费已确认停止。
