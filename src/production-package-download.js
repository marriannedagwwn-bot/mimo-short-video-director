import { ProductionStateError } from "./production-lineage.js";
import { storyPackageFilename } from "../public/export-filename.js";

export function createProductionPackageDownloadHandler({ productionStore, maxPackageBytes = 70 * 1024 * 1024 }) {
  return async (request, response, url) => {
    if (request.method !== "POST" || url.pathname !== "/api/production/package/download") return false;
    if (!String(request.headers["content-type"] || "").startsWith("application/x-www-form-urlencoded")) {
      throw new ProductionStateError("生产包下载需要表单提交。", { code: "PACKAGE_DOWNLOAD_CONTENT_TYPE", httpStatus: 415 });
    }
    const chunks = [];
    let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length;
      // Percent-encoding expands a UTF-8 byte to at most three ASCII bytes.
      if (bytes > maxPackageBytes * 3 + 1024) {
        throw new ProductionStateError("生产包超过下载大小上限。", { code: "PACKAGE_DOWNLOAD_TOO_LARGE", httpStatus: 413 });
      }
      chunks.push(chunk);
    }
    const fields = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
    const source = fields.get("package") || "";
    if (Buffer.byteLength(source) > maxPackageBytes) {
      throw new ProductionStateError("生产包超过下载大小上限。", { code: "PACKAGE_DOWNLOAD_TOO_LARGE", httpStatus: 413 });
    }
    let payload;
    try {
      if (fields.getAll("package").length !== 1) throw new Error("missing or duplicate package");
      payload = JSON.parse(source);
    } catch {
      throw new ProductionStateError("生产包下载内容不是有效 JSON。", { code: "PACKAGE_DOWNLOAD_INVALID_JSON", httpStatus: 400 });
    }
    // Reuse the existing signature, digest and lineage validation unchanged.
    await productionStore.validatePackage(payload);
    const filename = storyPackageFilename(payload, { testPackage: fields.get("testPackage") === "true" });
    const body = JSON.stringify(payload, null, 2);
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="production-package.json"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "content-length": Buffer.byteLength(body),
      "cache-control": "no-store"
    });
    response.end(body);
    return true;
  };
}
