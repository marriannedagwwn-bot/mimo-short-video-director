# 参考视频换片预览修复（2026-09-09）

用户报告：更换参考视频后文件名与采样帧更新，播放器仍显示上一段视频，刷新后才正确。

确认的调用链：`handleFile → replaceSource → loadSourceVideo`；刷新恢复同样进入 `loadSourceVideo`。文件名和抽帧消费当前 File，但播放器此前消费工作区固定的 `/api/browser-workspace/<id>/source` 地址。换片前已有 pause、移除 src 和 load，HTTP 也已有 no-store。固定媒体地址可能被播放器复用，不能把问题归结为漏调 load。

本次让播放器与抽帧使用同一份当前 File，各自持有独立 Blob URL；已有清理负责释放旧预览，抽帧结束只释放自己的 URL。刷新仍先读取服务端原片、校验 SHA-256，然后创建预览。服务端存储、Run metadata、任务和业务 Artifact 契约不变。

复现边界：改前红色 4 秒与蓝色 7 秒小样本未复现偶发旧画面；检查用户当前页时播放器时长已与新片一致。没有把用户的原始故障现场重新复现，固定地址缓存是与现象相符的解释，尚无故障发生时的网络证据。本次修复直接消除预览复用可变固定地址的路径。

## 验收证据

### A 静态验证

状态：通过

执行：

- `node --check public/app.js`
- `git diff --check`

实际结果：

- 语法和补丁空白检查通过。

### B 自动化行为验证

状态：相关测试和正式测试目录通过；全目录扫描失败。

执行：

- `node --test test/source-video-preview.test.js test/browser-workspace-client.test.js test/browser-workspace-http.test.js test/director-pipeline-ui.test.js test/task-status-ui.test.js`
- `node --test test/*.test.js`
- `npm test`

实际结果：

- 相关 66 项通过。新增 2 项检查预览实际绑定的文件字节、同名文件连续替换、旧 URL 释放、抽帧 URL 与播放器隔离，以及过期 epoch 不得覆盖当前预览；使用真实 app 函数与 Node Blob，仅模拟浏览器解码和 canvas。
- 新测试在改前失败，改后通过；这证明新文件绑定与资源生命周期，不等于复现真实浏览器缓存时序。
- 正式目录共 1303 项：1297 通过，6 跳过，0 失败。
- `npm test` 共 1491 项：1467 通过，6 跳过，18 失败。3 项来自 `exports/git-sync-2026-09-09/snapshot/test` 缺失依赖模块；15 项来自 `exports/story-editorial-lab-2026-09-08` 旧提示词锚点已不匹配。这些目录及断言未修改，未将全量结果描述为通过。

### C 真实运行

状态：通过

入口：

- Node 24.19.0 启动同一工作树的独立 41875 实例，使用临时 ProductionStateStore。
- Codex 内置浏览器通过真实上传控件选择测试 MP4，无模型生成请求。
- 主实例 `http://localhost:4173/app.js` HTTP 200，响应与修改后的工作树逐字节相同。

实际结果：

- 独立实例真实完成文件上传、服务端保存、抽帧、预览与刷新恢复。
- 修改后每次加载的播放器 currentSrc 均为不同 Blob URL。
- 4173 仍由原 PID 81352 提供服务；前端静态文件更新无需重启 Node，用户现有页面需要刷新一次加载新 JS。

### D 用户可见结果

状态：测试样本通过；用户原始偶发故障未重新复现。

验证内容：

- 在同一标签页连续从蓝色 7 秒切到红色 4 秒，再切回蓝色 7 秒。
- 播放测试片，并检查下一次换片后的暂停状态与播放位置。
- 刷新恢复最后一段视频。

实际结果：

- 逐次截图检查预览颜色、文件名、播放器时长和采样帧一致；切换之间无需刷新。
- 最后一次切换后为蓝色画面、7 秒、currentTime=0、paused=true。
- 刷新后仍为蓝色 7 秒，采样帧一致，readyState=4，使用新 Blob URL。

### 修改范围

- 修改文件：`public/app.js`、`test/helpers/app-ui-harness.js`；新增 `test/source-video-preview.test.js` 与本记录。
- 未修改范围：服务端、剧情生成、数据结构、任务生命周期；保留原有 `AGENTS.md`、`src/prompts.js` 和上轮 Full Story 文档/测试改动。
- 当前分支：`codex/story-quality-phase1`
- 当前 HEAD：`78f950f26084a3fc309805e3aed49e0f0006308d`；本次未提交或推送。

### 未覆盖路径

- 用户最初发生故障时的完整换片时序、其他浏览器、全部视频编码格式。
- 本次没有调用 AI 导演或视频供应商；不涉及这些链路的改动。

### 剩余风险

- 初始故障未稳定复现，不能据此声称所有浏览器与编码组合均已排除问题。
- 全目录测试扫描仍有上述 18 项旧实验/快照失败。

### 完成结论

预览已直接绑定当前文件，独立浏览器换片与刷新恢复检查通过。用户刷新一次加载修复后即可继续验证原视频组合；服务端原视频恢复与既有创作数据契约保持不变。
