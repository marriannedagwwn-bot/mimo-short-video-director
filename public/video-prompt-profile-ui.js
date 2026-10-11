/**
 * 预览框里的文本是否作为本次运行时提示词覆盖提交。
 *
 * 4.0 分镜的单镜提示词由服务端按当前模型单独编写，预览框里就是本次要发的提示词，
 * 因此只要非空就是本次运行的实际提示词。
 */
export function runtimePromptOverride(preview) {
  return String(preview ?? "").trim();
}
