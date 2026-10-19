# 分镜设计提示词新旧对比

- 时间：2026-10-19T04:09:22.788Z
- 冻结输入：reports/storyboard-style-ab-2026-10-19/kite-input/run-artifacts.json（时长窗口 76–104 秒，画风「日系 2.5D、千与千寻动漫风格」，背景音乐 none）
- 写稿模型：MiMo mimo-v2.6-pro（每次只调用一次，不走重试，带与生产相同的 responseSchema）；每种写法 2 次
- 旧写法：873d3eb 的 src/storyboard-prompts.js；新写法：当前工作区

| 写法 | 次 | 判据 | 片段 / beat | 总时长 | 平均每镜 | 最短 beat / 不到 1 秒 / 非整数 | 空镜 beat / 开场是空镜 | 特写 / 视角 / 特殊机位 / 带运镜（代理） | 主角出声的 beat（代理） | soundDesign 点到角色名的 beat（代理） | 对不上剧情的台词 | 含方向词的 beat（代理） | 文字量 | 耗时 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| old | 1 | 通过 | 10 / 26 | 90 秒 | 3.5 秒 | 2 / 0 / 0 | 4 / 是 | 1 / 0 / 0 / 1 | 3/26 | 10/26 | 0/4 | 22/26 | 3636 | 474 秒 |
| old | 2 | STORYBOARD_BEAT_TIME_DISCONTINUOUS、STORYBOARD_BEATS_NOT_COVERING_SHOT、STORYBOARD_BEAT_TIME_DISCONTINUOUS、STORYBOARD_BEATS_NOT_COVERING_SHOT、STORYBOARD_BEAT_TIME_DISCONTINUOUS、STORYBOARD_BEATS_NOT_COVERING_SHOT、STORYBOARD_BEAT_TIME_DISCONTINUOUS、STORYBOARD_BEATS_NOT_COVERING_SHOT、STORYBOARD_BEAT_TIME_DISCONTINUOUS、STORYBOARD_BEATS_NOT_COVERING_SHOT、STORYBOARD_BEAT_TIME_DISCONTINUOUS、STORYBOARD_BEATS_NOT_COVERING_SHOT、STORYBOARD_BEAT_TIME_DISCONTINUOUS、STORYBOARD_BEATS_NOT_COVERING_SHOT、STORYBOARD_BEAT_TIME_DISCONTINUOUS、STORYBOARD_BEATS_NOT_COVERING_SHOT、STORYBOARD_BEAT_TIME_DISCONTINUOUS、STORYBOARD_BEATS_NOT_COVERING_SHOT | 10 / 23 | 90 秒 | 3.9 秒 | 2 / 0 / 0 | 2 / 是 | 4 / 0 / 1 / 7 | 4/23 | 13/23 | 0/4 | 16/23 | 3081 | 387 秒 |
| new | 1 | 通过 | 12 / 37 | 90 秒 | 2.4 秒 | 2 / 0 / 0 | 4 / 是 | 12 / 2 / 8 / 0 | 11/37 | 11/37 | 0/4 | 9/37 | 2889 | 448 秒 |
| new | 2 | 通过 | 11 / 32 | 94 秒 | 2.9 秒 | 2 / 0 / 0 | 3 / 是 | 9 / 0 / 5 / 0 | 5/32 | 16/32 | 0/4 | 10/32 | 3026 | 365 秒 |

逐片段原文在 calls.jsonl（design 字段）。带「代理」的列只是表面计数，写得对不对要逐份读。
