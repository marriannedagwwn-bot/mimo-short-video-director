// Native HTTP attachments work in embedded browsers that do not handle Blob
// downloads. The signed package goes straight into the response, with no cache
// or temporary download file on the server.
export function downloadProductionPackage(payload, {
  testPackage = false, onError = () => {}, document = globalThis.document,
  schedule = globalThis.setTimeout
} = {}) {
  const frame = document.createElement("iframe");
  frame.hidden = true;
  frame.name = `production-download-${crypto.randomUUID()}`;
  frame.title = "生产包下载";
  frame.onload = () => {
    try {
      const body = frame.contentDocument?.body?.textContent?.trim();
      if (!body) return;
      const result = JSON.parse(body);
      if (result.ok === false) onError(result.error?.message || result.error || "生产包下载失败，请重试。");
    } catch {
      onError("生产包下载失败，请重试。");
    }
  };
  const form = document.createElement("form");
  form.hidden = true;
  form.method = "POST";
  form.action = "/api/production/package/download";
  form.target = frame.name;
  form.acceptCharset = "UTF-8";
  for (const [name, value] of Object.entries({ package: JSON.stringify(payload), testPackage: String(testPackage) })) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.append(input);
  }
  document.body.append(frame, form);
  form.submit();
  // Keep the frame alive while the browser accepts the attachment response.
  schedule(() => { frame.remove(); form.remove(); }, 60_000);
}
