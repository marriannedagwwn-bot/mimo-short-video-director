// 本镜出镜角色的参考图：4.0 分镜按各 beat 的 characters 精确取，不从文字里猜。
// 2026-10-11 起只支持 4.0 分镜，镜头没有 beats 说明不是 4.0 的镜头，明确报错。
export function shotRelatedCharacterReferences(shot = {}, characterReferences = []) {
  if (!Array.isArray(shot?.beats)) throw new TypeError("只支持 4.0 分镜的镜头（缺少 beats）。");
  const references = Array.isArray(characterReferences) ? characterReferences.filter(Boolean) : [];
  if (!references.length) return [];
  const visible = new Set(shot.beats.flatMap(beat => beat.characters || []));
  return references.filter(reference => visible.has(reference.characterName));
}
