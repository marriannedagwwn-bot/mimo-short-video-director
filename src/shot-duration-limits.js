// 单镜时长边界只有这一份：Seedance 2.0 与 MiniMax H3 的能力交集。
// 4 秒是两家的共同下限，15 秒既是共同上限，也是旧 direct_shot 长场次唯一的拆镜阈值。
//
// 它**必须待在一个零依赖的模块里**。validation.js 与 storyboard-contract.js 是一对
// 相互导入的模块（validation.js 要 ensureStoryboardPlan，contract 要 OutputContractError），
// 而自主分镜的 ajv schema 在**模块求值期**就要读这两个数——从 validation.js 取会落进
// 暂时性死区（`Cannot access 'DIRECT_SHOT_MIN_DURATION_SECONDS' before initialization`）。
// 与 public/all-reference-limits.js、public/story-duration.js 同规格：数字只有一份，
// 禁止在校验器、schema 或提示词里各自再写一遍字面量（AGENTS.md §2.14）。
//
// validation.js 原样 re-export 这两个名字，所以既有消费者一个都不用改。
export const DIRECT_SHOT_MIN_DURATION_SECONDS = 4;
export const DIRECT_SHOT_MAX_DURATION_SECONDS = 15;
