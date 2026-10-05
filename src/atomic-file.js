import fs from "node:fs/promises";

// 「写临时文件再 rename 覆盖」的最后一步。Windows 上覆盖一个正被别的句柄打开的文件
// （并发的不加锁读者、杀毒/索引扫描）会偶发 EPERM/EACCES/EBUSY；这是瞬时的，等读者关掉
// 句柄就能成功。此前直接失败、也不清理临时文件。
//
// 证据（2026-10-05）：本机 runtime/production-runs 下留着 8 个 rename 失败后的孤儿 .tmp
// （6 个 tasks/index.json、2 个 manifest.json，09-05～09-06），其中两次是「强制释放」的
// manifest 写入——释放没生效，任务照跑并照常计费。
//
// 只在 win32 上重试：POSIX 上这几个错误码是真实的权限问题，等多久都不会好。
// 最终仍失败时删掉临时文件、原样抛出原错误——仍然是 fail closed，只是不再留下孤儿文件。
const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
export const RENAME_RETRY_DELAYS_MS = Object.freeze([10, 20, 40, 80, 160, 320, 640, 1000]);

export async function replaceFile(temporary, target, {
  platform = process.platform,
  rename = (from, to) => fs.rename(from, to),
  unlink = (file) => fs.unlink(file),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  delays = RENAME_RETRY_DELAYS_MS
} = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temporary, target);
      return;
    } catch (error) {
      const retryable = platform === "win32"
        && RETRYABLE_RENAME_CODES.has(error?.code)
        && attempt < delays.length;
      if (!retryable) {
        await Promise.resolve().then(() => unlink(temporary)).catch(() => {});
        throw error;
      }
      await sleep(delays[attempt]);
    }
  }
}
