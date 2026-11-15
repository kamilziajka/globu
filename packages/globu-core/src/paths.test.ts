import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "../../testing/index.js";
import { claudeSettingsPath, clonesDir, globuHome, manifestPath, statePath } from "./paths.js";

const HOME = process.env.HOME;

afterEach(() => {
  process.env.HOME = HOME;
});

describe("paths", () => {
  it("default to the home directory", () => {
    delete process.env.GLOBU_HOME;
    delete process.env.CLAUDE_CONFIG_DIR;
    expect(globuHome()).toBe(path.join(os.homedir(), ".globu"));
    expect(claudeSettingsPath()).toBe(path.join(os.homedir(), ".claude", "settings.json"));
  });

  it("follow the environment overrides", () => {
    process.env.GLOBU_HOME = "/tmp/custom-globu";
    process.env.CLAUDE_CONFIG_DIR = "/tmp/custom-claude";
    expect(manifestPath()).toBe(path.resolve("/tmp/custom-globu/manifest.yaml"));
    expect(statePath()).toBe(path.resolve("/tmp/custom-globu/state.yaml"));
    expect(clonesDir()).toBe(path.resolve("/tmp/custom-globu/clones"));
    expect(claudeSettingsPath()).toBe(path.resolve("/tmp/custom-claude/settings.json"));
  });

  it.skipIf(process.platform === "win32")(
    "fall back to the temp directory when the home directory is not writable",
    () => {
      delete process.env.GLOBU_HOME;
      const home = tempDir();
      process.env.HOME = home;
      expect(globuHome()).toBe(path.join(home, ".globu"));

      fs.chmodSync(home, 0o500);
      try {
        expect(globuHome()).toBe(path.join(os.tmpdir(), "globu"));
        fs.chmodSync(home, 0o700);
        fs.mkdirSync(path.join(home, ".globu"));
        fs.chmodSync(home, 0o500);
        expect(globuHome()).toBe(path.join(home, ".globu"));
      } finally {
        fs.chmodSync(home, 0o700);
      }
    }
  );
});
