import test from "node:test";
import assert from "node:assert/strict";
import { resolveObjectURL } from "node:buffer";
import { loadAppUi } from "./helpers/app-ui-harness.js";

// Only decoding/canvas are simulated. The real app handles preview ownership,
// file identity, sampling orchestration and workspace generation guards.
class SamplingVideo extends EventTarget {
  duration = 7;
  videoWidth = 320;
  videoHeight = 180;
  set src(value) {
    this.url = value;
    queueMicrotask(() => this.dispatchEvent(new Event("loadedmetadata")));
  }
  set currentTime(value) {
    queueMicrotask(() => this.dispatchEvent(new Event("seeked")));
  }
}

async function fixture(t) {
  const sampledUrls = [];
  const app = await loadAppUi({ createElement(tag) {
    if (tag === "video") return new SamplingVideo();
    assert.equal(tag, "canvas");
    return {
      getContext: () => ({ drawImage(video) { sampledUrls.push(video.url); } }),
      toDataURL: () => "data:image/jpeg;base64,dGVzdA=="
    };
  } });
  t.after(() => { if (app.state.previewUrl) URL.revokeObjectURL(app.state.previewUrl); });
  return { ...app, sampledUrls };
}

test("replacing a source gives the player the new file bytes and releases the preceding preview", async (t) => {
  const { loadSourceVideo, browserWorkspace, elements, state, sampledUrls } = await fixture(t);
  // The persisted endpoint is identical for both uploads in a tab.
  const sourceUrl = "/api/browser-workspace/same-workspace/source";
  const first = new File(["first video bytes"], "same-name.mp4", { type: "video/mp4" });
  const second = new File(["second video bytes"], "same-name.mp4", { type: "video/mp4" });
  await loadSourceVideo(first, browserWorkspace.beginChange(), sourceUrl);
  const previousUrl = elements.preview.src;
  assert.equal(await resolveObjectURL(previousUrl)?.text(), await first.text());
  await loadSourceVideo(second, browserWorkspace.beginChange(), sourceUrl);
  assert.equal(await resolveObjectURL(elements.preview.src)?.text(), await second.text());
  assert.notEqual(elements.preview.src, previousUrl);
  assert.equal(resolveObjectURL(previousUrl), undefined);
  assert.equal(state.file, second);
  assert.equal(state.frames.length, 6);
  // Sampling releases its own URL without invalidating the visible player.
  assert.ok(sampledUrls.every((url) => resolveObjectURL(url) === undefined));
  assert.ok(resolveObjectURL(elements.preview.src));
});

test("a superseded source load cannot overwrite the current player", async (t) => {
  const { loadSourceVideo, browserWorkspace, elements } = await fixture(t);
  const staleEpoch = browserWorkspace.beginChange();
  const current = new File(["current"], "current.mp4", { type: "video/mp4" });
  await loadSourceVideo(current, browserWorkspace.beginChange());
  const previewUrl = elements.preview.src;
  await assert.rejects(loadSourceVideo(new File(["old"], "old.mp4"), staleEpoch));
  assert.equal(elements.preview.src, previewUrl);
  assert.equal(await resolveObjectURL(previewUrl)?.text(), "current");
});
