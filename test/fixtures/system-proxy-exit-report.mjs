import { writeFileSync } from "node:fs";

// Deliberately does not import or initialize system-proxy. The production
// entrypoint itself must clear inherited variables and establish direct access.
if (process.env.TEST_SYSTEM_PROXY_EXIT_REPORT) {
  process.on("exit", () => writeFileSync(process.env.TEST_SYSTEM_PROXY_EXIT_REPORT,
    JSON.stringify(Object.fromEntries(Object.entries(process.env)
      .filter(([key]) => /^(?:https?|all|no)_proxy$/iu.test(key))))));
}
