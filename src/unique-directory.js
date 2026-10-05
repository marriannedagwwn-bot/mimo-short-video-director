import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

// `fs.mkdtemp` 的替代，语义相同：在已存在的 parent 下独占创建 `<prefix><6 位随机>` 目录并返回其路径。
//
// 为什么不直接用 mkdtemp（2026-10-05 实测，Windows 10、Node 24、LongPathsEnabled=0）：
// 同一台机器上 fs.mkdir / writeFile / rename / chmod / realpath / rmdir 在 300+ 字符的路径上
// 全部正常（Node 会自动加 `\\?\` 前缀），**只有 fs.mkdtemp** 在结果路径到 ~248 字符时报
// ENAMETOOLONG、再长报 ENOENT。浏览器 Run 内的全量模型输出日志目录本身就有 252 字符，
// 于是每次都是「上层目录全建好了，attempt 目录建不出来」，写入按 fail-open 静默放弃，
// 一次 742 秒的参考片分析失败后原文一个字都没留下。
//
// 两条与 mkdtemp 一致、调用方依赖的语义必须保持：
// - 不递归：parent 不存在时报 ENOENT，绝不顺手重建已被清理的 Run 祖先目录；
// - 独占：目标已存在（EEXIST）就换一个后缀重试，不复用别人的目录。
const SUFFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const SUFFIX_LENGTH = 6;
const MAX_ATTEMPTS = 16;

export async function createUniqueDirectory(prefixPath, { mode = 0o700, randomSuffix = defaultRandomSuffix } = {}) {
  const prefix = String(prefixPath || "");
  if (!prefix || !path.basename(prefix)) throw new TypeError("createUniqueDirectory 需要非空目录名前缀");
  let lastError = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const candidate = `${prefix}${randomSuffix()}`;
    try {
      await fs.mkdir(candidate, { mode });
      return candidate;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      lastError = error;
    }
  }
  throw lastError;
}

function defaultRandomSuffix() {
  const bytes = randomBytes(SUFFIX_LENGTH);
  let suffix = "";
  for (const byte of bytes) suffix += SUFFIX_ALPHABET[byte % SUFFIX_ALPHABET.length];
  return suffix;
}
