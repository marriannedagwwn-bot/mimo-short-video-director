#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";

const port = positiveInteger(process.env.ACCEPTANCE_STUB_PORT, 4399);
const defaultDelayMs = clampInteger(process.env.ACCEPTANCE_STUB_DELAY_MS, 0, 0, 3_600_000);
const defaultReadyCount = String(process.env.ACCEPTANCE_STUB_READY_COUNT || "").trim();
const videoFile = path.resolve(process.env.ACCEPTANCE_STUB_VIDEO_FILE || "runtime-captures/acceptance/stub.mp4");
const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const counters = {
  total: 0,
  models: 0,
  images: 0,
  videoCreate: 0,
  videoPoll: 0,
  videoDownload: 0,
  chat: 0,
  failures: 0,
  lastImagePrompt: ""
};

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || `127.0.0.1:${port}`}`);
  if (request.method === "GET" && url.pathname === "/__acceptance/counters") {
    return json(response, 200, counters);
  }
  if (request.method === "POST" && url.pathname === "/__acceptance/reset") {
    for (const key of Object.keys(counters)) counters[key] = typeof counters[key] === "number" ? 0 : "";
    return json(response, 200, counters);
  }

  counters.total += 1;
  const controls = requestControls(url, request.headers);
  if (controls.hang) return;
  if (controls.delayMs) await delay(controls.delayMs);
  if (controls.failAt > 0 && counters.total === controls.failAt) {
    counters.failures += 1;
    return json(response, 503, {
      error: {
        code: "ACCEPTANCE_STUB_FAILURE",
        message: "acceptance stub requested failure"
      }
    });
  }

  if (request.method === "GET" && /\/models$/u.test(url.pathname)) {
    counters.models += 1;
    return json(response, 200, {
      object: "list",
      data: [
        { id: "doubao-seedream-5-0-260128" },
        { id: "doubao-seedance-2-0-260128" },
        { id: "qwen3.7-plus" },
        { id: "qwen3.7-max" }
      ]
    });
  }

  if (request.method === "POST" && /\/images\/generations$/u.test(url.pathname)) {
    counters.images += 1;
    const body = await readJson(request);
    counters.lastImagePrompt = String(body?.prompt || "");
    const requestedCount = positiveInteger(
      body?.sequential_image_generation_options?.max_images,
      1
    );
    const partialCount = clampInteger(
      url.searchParams.get("readyCount") || defaultReadyCount,
      requestedCount,
      0,
      requestedCount
    );
    const data = Array.from({ length: requestedCount }, (_, imageIndex) => imageIndex < partialCount
      ? {
          b64_json: pngBase64,
          size: body?.size || "1728x2304"
        }
      : {
          error: {
            code: "ACCEPTANCE_PARTIAL_FAILURE",
            message: `stub image ${imageIndex + 1} requested failure`
          }
        });
    return json(response, 200, {
      model: body?.model || "doubao-seedream-5-0-260128",
      created: 1_788_195_600,
      data,
      usage: { generated_images: partialCount }
    });
  }

  if (request.method === "POST" && /\/contents\/generations\/tasks$/u.test(url.pathname)) {
    counters.videoCreate += 1;
    await drain(request);
    return json(response, 200, { id: `acceptance-video-${counters.videoCreate}` });
  }

  if (request.method === "GET" && /\/contents\/generations\/tasks\/[^/]+$/u.test(url.pathname)) {
    counters.videoPoll += 1;
    const taskId = decodeURIComponent(url.pathname.split("/").at(-1));
    return json(response, 200, {
      id: taskId,
      status: "succeeded",
      video_url: `http://127.0.0.1:${port}/media/stub.mp4`
    });
  }

  if (request.method === "GET" && url.pathname === "/media/stub.mp4") {
    counters.videoDownload += 1;
    try {
      const data = await fs.readFile(videoFile);
      response.writeHead(200, {
        "content-type": "video/mp4",
        "content-length": data.length,
        "cache-control": "no-store"
      });
      return response.end(data);
    } catch (error) {
      counters.failures += 1;
      return json(response, 500, { error: { code: "STUB_VIDEO_MISSING", message: error.message } });
    }
  }

  if (request.method === "POST" && /\/chat\/completions$/u.test(url.pathname)) {
    counters.chat += 1;
    await drain(request);
    return json(response, 501, {
      error: {
        code: "ACCEPTANCE_CHAT_FIXTURE_REQUIRED",
        message: "This acceptance stub intentionally has no implicit chat fallback."
      }
    });
  }

  return json(response, 404, { error: { code: "ACCEPTANCE_ROUTE_NOT_FOUND", path: url.pathname } });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Durable Task acceptance stub: http://127.0.0.1:${port}`);
  console.log(`Stub video: ${videoFile}`);
});

function requestControls(url, headers) {
  return {
    delayMs: clampInteger(
      url.searchParams.get("delayMs") || headers["x-acceptance-delay-ms"] || defaultDelayMs,
      defaultDelayMs,
      0,
      3_600_000
    ),
    failAt: clampInteger(
      url.searchParams.get("failAt") || headers["x-acceptance-fail-at"],
      0,
      0,
      1_000_000
    ),
    hang: ["1", "true"].includes(String(url.searchParams.get("hang") || headers["x-acceptance-hang"] || "").toLowerCase())
  };
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function drain(request) {
  for await (const _chunk of request) void _chunk;
}

function json(response, status, value) {
  const body = Buffer.from(`${JSON.stringify(value)}\n`);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store"
  });
  response.end(body);
}

function positiveInteger(value, fallback) {
  const numeric = Math.round(Number(value));
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function clampInteger(value, fallback, minimum, maximum) {
  if (value === null || value === undefined || value === "") return fallback;
  const numeric = Math.round(Number(value));
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(minimum, Math.min(maximum, numeric));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
