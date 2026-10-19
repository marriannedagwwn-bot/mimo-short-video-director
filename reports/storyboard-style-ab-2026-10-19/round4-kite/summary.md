# 分镜设计提示词新旧对比

- 时间：2026-10-19T04:31:38.815Z
- 冻结输入：reports/storyboard-style-ab-2026-10-19/kite-input/run-artifacts.json（时长窗口 76–104 秒，画风「日系 2.5D、千与千寻动漫风格」，背景音乐 none）
- 写稿模型：MiMo mimo-v2.6-pro（每次只调用一次，不走重试，带与生产相同的 responseSchema）；每种写法 2 次
- 旧写法：873d3eb 的 src/storyboard-prompts.js；新写法：当前工作区

| 写法 | 次 | 判据 | 片段 / beat | 总时长 | 平均每镜 | 最短 beat / 不到 1 秒 / 非整数 | 空镜 beat / 开场是空镜 | 特写 / 视角 / 特殊机位 / 带运镜（代理） | 主角出声的 beat（代理） | soundDesign 点到角色名的 beat（代理） | 对不上剧情的台词 | 含方向词的 beat（代理） | 文字量 | 耗时 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| new | 1 | 调用失败：MODEL_CONTENT_FILTERED MiMo 的内容审核拦截了这次输出（finish_reason=content_filter，本次已输出 9781 token），供应商原文：The request was rejected because it was considered high risk。审核结果不稳定，同一提示词重试常能通过；系统不会自动重试 | — / — | — 秒 | — 秒 | — / — / — | — / — | — / — / — / — | —/— | —/— | —/— | —/— | — | 193 秒 |
| new | 2 | 通过 | 11 / 34 | 94 秒 | 2.8 秒 | 2 / 0 / 0 | 3 / 是 | 10 / 0 / 6 / 0 | 10/34 | 19/34 | 0/4 | 9/34 | 3091 | 383 秒 |

逐片段原文在 calls.jsonl（design 字段）。带「代理」的列只是表面计数，写得对不对要逐份读。
