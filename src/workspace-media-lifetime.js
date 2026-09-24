import fs from "node:fs/promises";
import path from "node:path";

// This is local execution control, never a provider request field. A browser
// workspace owns the manifest and deletes it before removing media directories.
export async function assertWorkspaceMediaLifetime(lifetimeFile) {
  if (!lifetimeFile) return;
  if (typeof lifetimeFile !== "string" || !path.isAbsolute(lifetimeFile)) {
    throw workspaceMediaClosedError();
  }
  let stat;
  try { stat = await fs.lstat(lifetimeFile); } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") throw workspaceMediaClosedError();
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw workspaceMediaClosedError();
}

export async function requireWorkspaceMediaDirectory(directory, lifetimeFile) {
  await assertWorkspaceMediaLifetime(lifetimeFile);
  let stat;
  try { stat = await fs.lstat(directory); } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") throw workspaceMediaClosedError();
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw workspaceMediaClosedError();
}

function workspaceMediaClosedError() {
  const error = new Error("页面工作区已关闭或媒体目录已清理，拒绝写入迟到结果");
  error.code = "BROWSER_WORKSPACE_MEDIA_CLOSED";
  return error;
}
