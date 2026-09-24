#!/usr/bin/env node
import { runVideoCommand } from "../src/run-video-command.js";
import { loadEnv } from "../src/config.js";
import { initializeSystemProxy } from "../src/system-proxy.js";

loadEnv();
const systemProxy = await initializeSystemProxy();
try {
  process.exitCode = await runVideoCommand(process.argv.slice(2), { envLoaded: true });
} finally {
  await systemProxy.close();
}
