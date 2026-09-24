/**
 * 全能参考（all_reference）素材的供应商上限。
 *
 * 这些数字此前有三份互不相干的拷贝：`validateAllReferenceArtifacts`
 * （src/shot-video-generator.js，成片前的权威闸门）、
 * `validateAllReferenceAssetDescriptors`（public/app.js，单镜路径的浏览器预检）、
 * 以及 src/shot-video-batch.js 里的一份子集。批量路径的批前预检是第四个消费者，
 * 再抄一份就等于给同一条业务约束建第四套数字——上限一变必然漏改。
 *
 * 这里**只放数字，不放校验函数**：三个调用点的数据形状本来就不同（浏览器是带
 * `referenceCount` 倍数的 descriptor、生成器是解码落盘后的 artifact、批量是尚未解码的
 * asset），强行统一形状会把改动面扩大到远超「共用同一批上限」这件事本身。
 *
 * 放在 public/ 是照搬 public/character-reference-audio.js 的既有先例：那里的常量
 * 已经同时被浏览器和 src/shot-video-batch.js 导入。
 *
 * 数值来源：Seedance 2.0 与 MiniMax H3 的全能参考接口公开限制，与本文件被提取前
 * 三处调用点里的字面量逐字一致，本次提取不改变任何一个数字。
 */

export const ALL_REFERENCE_MAX_IMAGES = 9;
export const ALL_REFERENCE_MAX_VIDEOS = 3;
export const ALL_REFERENCE_MAX_AUDIOS = 3;

// 单段参考视频/音频的时长区间。
export const ALL_REFERENCE_MEDIA_MIN_SECONDS = 2;
export const ALL_REFERENCE_MEDIA_MAX_SECONDS = 15;

// 视频、音频各自的总时长上限。0.05 的余量是留给 ffprobe 实测时长的小数尾巴，
// 不是业务上的宽容度——15.00 秒的素材不该因为解码出 15.003 被判超限。
export const ALL_REFERENCE_MEDIA_TOTAL_SECONDS = 15.05;

export const ALL_REFERENCE_MAX_VIDEO_BYTES = 50 * 1024 * 1024;

// MiniMax H3 在分项上限之外还有一个混合素材总数上限；Seedance 不施加该约束。
export const MINIMAX_H3_MAX_TOTAL_ASSETS = 12;
