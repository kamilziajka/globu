import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach } from "vitest";

for (const name of Object.keys(process.env)) {
  if (name.startsWith("GIT_")) delete process.env[name];
}
process.env.GIT_TERMINAL_PROMPT = "0";
process.env.GIT_CONFIG_NOSYSTEM = "1";

beforeEach(() => {
  const sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "globu-home-")));
  process.env.GLOBU_HOME = path.join(sandbox, "globu");
  process.env.CLAUDE_CONFIG_DIR = path.join(sandbox, "claude");
  process.env.GLOBU_LOCK_DIR = path.join(sandbox, "locks");
  delete process.env.GLOBU_CONTEXT;
  delete process.env.GLOBU_GIT_TOKEN;
  delete process.env.GLOBU_GIT_USER;
  delete process.env.CLAUDE_PROJECT_DIR;
});
