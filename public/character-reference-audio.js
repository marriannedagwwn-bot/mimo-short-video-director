import { shotRelatedCharacterReferences } from "./shot-reference-images.js";

export const CHARACTER_REFERENCE_AUDIO_MAX_CLIPS = 3;
export const CHARACTER_REFERENCE_AUDIO_MAX_TOTAL_SECONDS = 15.05;
export const CHARACTER_REFERENCE_AUDIO_MIN_SECONDS = 2;
export const CHARACTER_REFERENCE_AUDIO_MAX_SECONDS = 15;

export function characterReferenceAudioClips(reference = {}) {
  return (Array.isArray(reference?.referenceAudioClips) ? reference.referenceAudioClips : [])
    .filter((clip) => clip && typeof clip === "object" && !Array.isArray(clip))
    .filter((clip) => /^data:audio\/[a-z0-9.+-]+;base64,/iu.test(String(clip.dataUrl || "")))
    .map((clip) => ({
      id: String(clip.id || "").trim(),
      label: String(clip.label || clip.fileName || "参考声音").trim() || "参考声音",
      fileName: String(clip.fileName || "reference-audio").trim() || "reference-audio",
      mimeType: String(clip.mimeType || "").trim(),
      dataUrl: String(clip.dataUrl || "").trim(),
      durationSeconds: Number(clip.durationSeconds) || 0,
      sizeBytes: Math.max(0, Number(clip.sizeBytes) || 0)
    }));
}

export function shotRelatedCharacterAudioClips(shot = {}, characterReferences = []) {
  return shotRelatedCharacterReferences(shot, characterReferences).flatMap((reference) => (
    characterReferenceAudioClips(reference).map((clip) => ({
      characterName: String(reference?.characterName || "").trim(),
      clip
    }))
  ));
}

export function validateCharacterReferenceAudioClips(clips = []) {
  const items = Array.isArray(clips) ? clips : [];
  if (items.length > CHARACTER_REFERENCE_AUDIO_MAX_CLIPS) {
    return `每个角色最多上传 ${CHARACTER_REFERENCE_AUDIO_MAX_CLIPS} 段参考声音。`;
  }
  const invalidDuration = items.find((clip) => (
    Number(clip?.durationSeconds) < CHARACTER_REFERENCE_AUDIO_MIN_SECONDS
    || Number(clip?.durationSeconds) > CHARACTER_REFERENCE_AUDIO_MAX_SECONDS
  ));
  if (invalidDuration) {
    return `${String(invalidDuration.label || invalidDuration.fileName || "参考声音")} 时长必须在 ${CHARACTER_REFERENCE_AUDIO_MIN_SECONDS}-${CHARACTER_REFERENCE_AUDIO_MAX_SECONDS} 秒之间。`;
  }
  const totalDuration = items.reduce((sum, clip) => sum + (Number(clip?.durationSeconds) || 0), 0);
  if (totalDuration > CHARACTER_REFERENCE_AUDIO_MAX_TOTAL_SECONDS) {
    return `每个角色的参考声音总时长不能超过 15 秒，当前 ${totalDuration.toFixed(2)} 秒。`;
  }
  return "";
}
