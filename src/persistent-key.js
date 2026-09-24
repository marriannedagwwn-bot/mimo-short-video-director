import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

/**
 * 服务端本地签名密钥的「读取或创建」。
 *
 * 三把密钥（生产包签名、grounding、全局角色边界）都必须跨进程重启保持不变：
 * 一旦重启换钥，落盘 Artifact 上的签名全部作废，用户恢复 Run 后点任何下游按钮
 * 都会撞上「签名无效」。所以这里只有两种结局——拿到与上次相同的密钥，或者
 * 明确失败。**任何情况下都不允许静默回退到随机生成**，那正是这类 bug 的成因。
 */

export class PersistentKeyError extends Error {
  constructor(message, { code = "PERSISTENT_KEY_INVALID" } = {}) {
    super(message);
    this.code = code;
  }
}

/**
 * @param {object} options
 * @param {string} options.directory  密钥文件所在目录，缺失时以 0700 创建。
 * @param {string} options.fileName   密钥文件名。
 * @param {number} options.byteLength 缺省生成的字节数，同时是最小可接受长度。
 * @param {string} options.label      错误与日志里的人类可读名称。
 * @param {string|null} options.envValue 环境变量值（hex）；非空时优先于文件。
 * @returns {Promise<{ key: Buffer, source: "环境变量" | "文件" }>}
 */
export async function loadOrCreatePersistentKey({
  directory,
  fileName,
  byteLength = 32,
  label = "签名密钥",
  envValue = null
} = {}) {
  const configured = String(envValue || "").trim();
  if (configured) {
    return { key: decodeConfiguredKey(configured, { byteLength, label }), source: "环境变量" };
  }

  const keyFile = path.join(directory, fileName);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });

  try {
    const existing = await fs.readFile(keyFile);
    if (existing.byteLength >= byteLength) return { key: existing, source: "文件" };
    // 长度不足的文件只报错，不覆盖：它可能是被截断的正确密钥，
    // 重新生成会把「签名验不过」升级成「原始密钥永久丢失」。
    throw new PersistentKeyError(
      `持久化${label}损坏（${existing.byteLength} 字节，至少需要 ${byteLength} 字节）：${keyFile}`
    );
  } catch (error) {
    if (error instanceof PersistentKeyError) throw error;
    if (error?.code !== "ENOENT") throw error;
  }

  const generated = randomBytes(byteLength);
  try {
    await fs.writeFile(keyFile, generated, { flag: "wx", mode: 0o600 });
    return { key: generated, source: "文件" };
  } catch (error) {
    // 并发首次启动：另一个进程刚写完，回读它写的那份，不能各用各的。
    if (error?.code !== "EEXIST") throw error;
    return { key: await fs.readFile(keyFile), source: "文件" };
  }
}

function decodeConfiguredKey(value, { byteLength, label }) {
  if (!/^[0-9a-f]+$/iu.test(value) || value.length % 2 !== 0) {
    throw new PersistentKeyError(`${label}环境变量必须是十六进制字符串`);
  }
  const key = Buffer.from(value, "hex");
  if (key.byteLength < byteLength) {
    throw new PersistentKeyError(
      `${label}环境变量太短（${key.byteLength} 字节，至少需要 ${byteLength} 字节）`
    );
  }
  return key;
}
