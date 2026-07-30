export class CastProposalValidationError extends Error {
  constructor(message, {
    code = "CAST_PROPOSAL_INVALID",
    details = []
  } = {}) {
    super(message);
    this.name = "CastProposalValidationError";
    this.code = code;
    this.details = Array.isArray(details) ? details : [];
    this.httpStatus = 502;
  }
}

export class CharacterRegistryError extends Error {
  constructor(message, {
    code = "CHARACTER_REGISTRY_INVALID",
    details = []
  } = {}) {
    super(message);
    this.name = "CharacterRegistryError";
    this.code = code;
    this.details = Array.isArray(details) ? details : [];
    this.httpStatus = 409;
  }
}

export class CastOperationError extends Error {
  constructor(message, code = "CAST_OPERATION_INVALID") {
    super(message);
    this.name = "CastOperationError";
    this.code = code;
    this.httpStatus = 409;
  }
}

export class CastPipelineDisabledError extends Error {
  constructor() {
    super("Full Story v2 Cast pipeline 尚未启用");
    this.name = "CastPipelineDisabledError";
    this.code = "FULL_STORY_V2_PIPELINE_DISABLED";
    this.httpStatus = 404;
  }
}
