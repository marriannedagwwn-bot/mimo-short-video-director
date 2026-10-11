// 评审 / 修订类结果的确定性校验错误。
//
// 原先定义在 animation-plan-review-validation.js（分镜终审与定向修订，2026-10-11 随旧 3.0
// 分镜一起删除）；命题定向修订（story-candidate-revision.js）与 workflow.js 的
// reviewContractAsOutputContract 仍在用它，所以单独保留在这里，形状与语义逐字不变。
export class ReviewContractError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = "ReviewContractError";
    this.code = "REVIEW_CONTRACT_INVALID";
    this.details = details;
  }
}
