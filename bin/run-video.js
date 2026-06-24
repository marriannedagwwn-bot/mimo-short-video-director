#!/usr/bin/env node
import { runVideoCommand } from "../src/run-video-command.js";

process.exitCode = await runVideoCommand(process.argv.slice(2));
