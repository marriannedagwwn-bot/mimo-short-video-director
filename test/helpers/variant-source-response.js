// Deterministic protocol fixture. This is not a semantic source reviewer.
export function variantSourceResponse(prompt = "") {
  const marker = "原片证据目录：";
  if (!String(prompt).includes(marker)) return null;
  const catalog = JSON.parse(String(prompt).split(marker).at(-1));
  const selectors = {
    changedCharacters: (entry) => /\/nameOrLabel$/u.test(entry.jsonPointer),
    changedTask: (entry) => /\/coreEventSequence\/\d+\/event$/u.test(entry.jsonPointer),
    changedDialogue: (entry) => /\/dialogueGist$/u.test(entry.jsonPointer),
    changedVisualExpression: (entry) => /\/visibleActions\/\d+$/u.test(entry.jsonPointer)
  };
  return {
    selections: Object.entries(selectors).map(([field, select]) => ({
      field,
      evidenceIds: (catalog.filter(select).length ? catalog.filter(select) : catalog.slice(0, 1))
        .map((entry) => entry.evidenceId)
    }))
  };
}
