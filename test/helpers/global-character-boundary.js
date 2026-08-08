import { sealGlobalCharacterBoundary } from "../../src/character-boundary.js";
import { mockVisualGuardrails } from "../../src/mock.js";
import { materializeGlobalCharacterBoundaryViews } from "../../src/validation.js";

export function withGlobalCharacterBoundary(workflow, input = {}, boundary = null) {
  const rawGuardrails = mockVisualGuardrails(input);
  if (boundary) rawGuardrails.fixedCharacterBoundary = structuredClone(boundary);
  const visualGuardrails = sealGlobalCharacterBoundary(
    materializeGlobalCharacterBoundaryViews(rawGuardrails, input.creatorProfile || {}),
    input,
    workflow.characterBoundaryKey
  );
  return { ...input, visualGuardrails };
}
