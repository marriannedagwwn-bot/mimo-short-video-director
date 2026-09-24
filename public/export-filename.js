const DEFAULT_STORY_NAME = "未命名故事";
const MAX_FILENAME_STEM_LENGTH = 80;
const WINDOWS_RESERVED_STEM = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

export function sanitizeStoryFilenameStem(value, fallback = DEFAULT_STORY_NAME) {
  const clean = (candidate) => String(candidate ?? "")
    .normalize("NFC")
    .trim()
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/gu, "-")
    .replace(/\s*-\s*/gu, "-")
    .replace(/\s+/gu, " ")
    .replace(/-{2,}/gu, "-")
    .replace(/^[ .-]+|[ .-]+$/gu, "")
    .slice(0, MAX_FILENAME_STEM_LENGTH)
    .replace(/[ .-]+$/gu, "");

  let stem = clean(value) || clean(fallback) || DEFAULT_STORY_NAME;
  if (WINDOWS_RESERVED_STEM.test(stem)) stem = `${stem}-故事`;
  return stem;
}

export function storyPackageFilename(payload = {}, { testPackage = false } = {}) {
  const title = payload.fullStory?.title
    || payload.selectedVariant?.title
    || payload.animationPlan?.title
    || DEFAULT_STORY_NAME;
  const stem = sanitizeStoryFilenameStem(title);
  return `${stem}${testPackage ? "-测试包" : ""}.json`;
}
