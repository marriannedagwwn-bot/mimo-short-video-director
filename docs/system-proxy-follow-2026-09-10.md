# 系统代理跟随与验收（2026-09-10）

## 修改前检查点

Run 控制相关的上一轮修改单独保存到本地提交 `500ec4d186e90b03a8b77f487367a74f2ece5fb4`，历史标签为 `checkpoint/director-controls-pending-user-20260910`。创建时用户尚未验证；2026-09-10 用户已明确确认本批修改验证通过，当前验收状态更新为已验证。原检查点保留为历史记录，未推送远端。

## 原因与行为

本机系统代理当时全部关闭，`127.0.0.1:7892` 没有监听，但自 9 月 9 日存活的项目 npm/watch 进程仍持有旧 `HTTP_PROXY`、`HTTPS_PROXY`。Node watch 重启子服务会再次继承旧值。旧环境复现为 `ECONNREFUSED 127.0.0.1:7892`；同一 Qwen `/models` 请求去掉旧代理后返回 HTTP 200，包含当前两个 Qwen 模型。确认没有 queued/running 任务后，只停止了这个项目已核对 cwd 的 watcher 进程组并清洁重启。

新的权威来源是 macOS 当前有效系统代理，服务、视频 worker 与 CLI 共用一个传输模块。每 2 秒更新配置，HTTP/HTTPS 独立开关、系统绕过规则和本机回环按同一份配置处理。代理启停和端口改变只作用于后续请求；已有请求不因配置变化被主动中断，也不会自动重试提交。

系统配置读取失败、启用项损坏和 PAC/自动发现均明确报错并阻断外部请求。需要 SOCKS 的路由也明确拒绝；已有 HTTP/HTTPS 代理覆盖的协议仍照常使用。当前 Undici SOCKS 实验实现经受控 TCP 回放发现：隧道完成后 TLS 握手卡住时，fetch 超时不能释放该连接，worker 的 close 会持续等待，所以本次不启用该路径。PAC 需要按 URL 执行脚本，当前没有实现，不把它误当 HTTP 代理。TUN/VPN 仍由操作系统路由，不需要本项目固定端口。非 macOS 使用环境代理配置。系统代理账号认证未接入钥匙串。仓库实际外连均使用 fetch；原生 http/https 只保留干净直连与同一套例外保护，若请求需要系统代理则明确拒绝，不另行实现未经业务需要的传输栈。

Node 的空 `setGlobalProxyFromEnv({})` 不能用作关闭代理；新模块建立明确的直连连接器并使用稳定 dispatcher。底层连接器退役使用 `close()` 等待在途请求结束，不用 `destroy()` 强行中断。依据：[Node 官方自定义 dispatcher](https://nodejs.org/download/release/v24.19.0/docs/api/globals.html#custom-dispatcher)、[Undici Dispatcher 生命周期](https://github.com/nodejs/undici/blob/v7.29.0/docs/docs/api/Dispatcher.md)、[Undici SOCKS5](https://github.com/nodejs/undici/blob/v7.29.0/docs/docs/api/Socks5ProxyAgent.md)。

## 验收计划

- A：修改文件 `node --check`、`git diff --check` 与完整差异审阅。
- B：真实本地代理覆盖关闭→A→B→关闭、独立协议开关、系统例外、回环、失败/PAC、在途流和取消，再跑项目测试。
- C：真实 spawn 视频 worker，检查提交→轮询→下载各请求实际路径及最终字节；运行当前 4173 服务检查 `/api/health`，不发付费生成请求。
- D：浏览器读取模型状态，确认本次代理故障造成的“部分阶段不可用”消失。系统代理切换使用隔离快照和受控代理，不改本机其他应用的网络配置。

## 验收证据

### A 静态验证

状态：通过

执行：

- 对所有修改的 JavaScript 入口、模块、测试与 fixture 执行 `node --check`。
- `git diff --check`，审阅生产差异与最终工作区状态。

实际结果：

- 全部通过。新增依赖固定为 `undici@7.29.0`，与本机 Node 24.19.0 内置版本一致；没有升级其他依赖。

### B 自动化行为验证

状态：失败（完整 `npm test` 存在历史失败）；项目测试与新增代理测试通过

执行：

- 代理核心、错误、真实入口、HTTPS 共 25 项；另与文本取消、用量、Durable Task 和错误处理联合回归。
- `node --test test/*.test.js`。
- `npm test`，逐项比较修改前后失败名称。

实际结果：

- 新增代理测试 25/25 通过；覆盖 HTTP/HTTPS 独立开关、地址/端口切换、例外/CIDR/回环、已有流继续、Abort、失败恢复、未支持模式拒绝和安全中文错误。
- 项目测试：1392 项，1386 通过、6 跳过、0 失败。日志：`/tmp/mimo-system-proxy-project-tests-isolated-20260910.log`。
- `npm test`：1583 项，1559 通过、6 跳过、18 失败。18 个失败名称与检查点前日志 `/tmp/mimo-director-control-verified-tests-20260910.log` 完全相同；3 个来自 `exports/git-sync-2026-09-09/snapshot/` 缺失源码引用，15 个来自历史 `exports/story-editorial-lab/` 的旧断言。没有修改这些导出样本或放宽断言。最终日志：`/tmp/mimo-system-proxy-official-tests-final-20260910.log`。
- 首轮完整发现把三个 `.mjs` fixture 当测试执行，因缺专属环境参数产生 3 个新失败；已增加无参数时无副作用的入口守卫，直接执行 helper 与真实子进程测试均通过，没有改变测试发现规则。
- 同时运行两套全量命令时，补充项目测试中的旧 Run 暂停用例出现一次 `waitUntil` 超时；该用例设置 50 ms 本地 watchdog、1 秒等待上限。同一轮 `npm test` 的同名用例通过。停止双套并发后，单独执行项目测试全通过；没有修改 Run 控制代码或测试断言。资源竞争是解释这一现象的推测，未据此宣称该短时限用例在高负载下稳定。

### C 真实运行

状态：通过

入口：

- 真实 spawn 的 `workers/generic-http-worker.mjs`、`bin/run-video.js --help`、`server.js`。
- 带临时 CA 的真实 TLS 服务和 HTTP CONNECT 代理；本机实际 4173 服务的 Qwen `/models` 健康检查。

实际结果：

- 一个 worker 共 4 个上游请求：直连提交 → 代理 A 轮询 → 代理 B 轮询 → 直连下载；A/B 各 1 次 CONNECT，输出字节和 receipt 正确，提交没有重复。
- macOS smoke 不预初始化代理模块，真正 worker 自行清除旧大小写代理环境变量；即使使用 `--use-env-proxy` 且旧端口不可达，本地目标仍正常执行一次。
- 同一 TLS 子进程中，HTTPS 代理开启后走 CONNECT；只关闭 HTTPS、保持 HTTP 代理时，TLS 改为直连；全部关闭后继续直连。通过上游 socket 来源确认没有复用旧代理隧道。错误主机名返回 `ERR_TLS_CERT_ALTNAME_INVALID`，证书校验没有关闭。
- 真实 server 子进程证明代理错误在导演任务失败后保持安全类型码及中文消息，Task GET 与磁盘一致；worker 通过既有 stderr/detail 显示中文原因。
- 本机 Node v24.19.0，4173 当前监听 PID `47839`，启动于 2026-09-10 14:16:25（Asia/Taipei）；watch 日志确认已加载修改。14:18 健康检查返回 `networkProxy.mode=direct`、`error=null`，Qwen 与 Analyze/Reconstruct/Brief/Visual Guardrails/Variants 五阶段均 HTTP 200。
- 当前运行文件 SHA-256：`server.js = 5f954a3b9a5f60e10f88a629ff7f838fbdebec3a57c678aa0d5d4034d89f0b05`；`src/system-proxy.js = 244f750663cfe4cb2e868317ad9d1089c7c358d674a6fbaebcf37a5afd4912eb`。

### D 用户可见结果

状态：通过（本次代理连接与提示）

验证内容：

- 实际浏览器工作台与独立 PAC 故障页面。

实际结果：

- 本机页面恢复显示 `qwen3.7-plus 解析 · 剧情 qwen3.7-max · 动画 qwen3.7-max · 静态帧 qwen3.7-max`。
- 隔离故障页直接显示“当前启用了 PAC 或自动代理发现，暂不支持此模式，已阻止外部请求。请改用系统 HTTP/HTTPS 代理。”
- 隔离页和进程已关闭；用户页面保留，未重新提交失败的付费任务。

### 修改范围

- 修改文件：`src/system-proxy.js`、三个运行入口、`src/run-video-command.js` 的已加载环境标记、`src/server-error.js`、`src/durable-task-store.js` 的错误投影、`public/app.js` 的健康状态提示、依赖锁文件及本文/README/AGENTS；新增四份代理测试与三份 fixture。
- 未修改范围：模型选择、业务 Prompt、剧情流水线、Run 控制状态机、已签发 Artifact、用户原视频、系统代理设置、其他应用环境。
- 当前分支：`codex/story-quality-phase1`。
- 实现与自动化验收时的工作区基点：`500ec4d186e90b03a8b77f487367a74f2ece5fb4`。随后按用户要求单独本地提交代理修改，未推送。

### 未覆盖路径

- 未切换真实 macOS 系统代理开关，动态切换使用隔离快照和真实受控代理；实际系统关闭状态及 Qwen 直连已验证。
- 没有通过真实外部代理发起付费文本、图片或视频生成；受控协议不代表任意外部代理可用。
- 不支持 PAC/WPAD、需要 SOCKS 的路由或钥匙串代理认证；原生 http/https 外部代理路径明确拒绝，当前业务使用 fetch。
- 用户已于 2026-09-10 确认本批修改验证通过。

### 剩余风险

- 新请求最多约 2 秒后读取到系统变化；进行中的请求仍使用原连接，原代理被用户关闭后可能自然失败。
- 历史导出样本的 18 个测试失败仍在；旧 Run 暂停测试的极短 watchdog 在双套并发时出现过一次超时，已如实记录。

### 完成结论

旧代理环境残留已清理，系统 HTTP/HTTPS 代理自动跟随已接入三个实际入口；受控 HTTP/TLS、真实 worker、实际 Qwen 健康和浏览器显示均通过验证。完整 `npm test` 仍有与修改前一致的 18 个历史失败，不能宣称全量命令全绿。
