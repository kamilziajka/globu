import path from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir, write } from "../packages/testing/index.js";
import { behindRelease, readArtefacts } from "../scripts/artefacts.ts";

const root = path.join(import.meta.dirname, "..");

function fixture(versions: { cli: string; worker: string; plugin: string; status: string }): string {
  const dir = tempDir();
  write(dir, ".claude-plugin/marketplace.json", JSON.stringify({ name: "globu" }));
  write(dir, "packages/globu-cli/package.json", JSON.stringify({ name: "@kazet/globu", version: versions.cli }));
  write(
    dir,
    "packages/globu-worker/package.json",
    JSON.stringify({ name: "@kazet/globu-worker", version: versions.worker })
  );
  write(dir, "plugins/globu/.claude-plugin/plugin.json", JSON.stringify({ name: "globu", version: versions.plugin }));
  write(
    dir,
    "mods/globu-status/.claude-plugin/plugin.json",
    JSON.stringify({ name: "globu-status", version: versions.status })
  );
  return dir;
}

describe("release artefacts", () => {
  it("reads every artefact from its own manifest, in the order the site lists them", () => {
    const dir = fixture({ cli: "2.0.0", worker: "2.0.0", plugin: "2.0.0", status: "0.3.1" });
    expect(readArtefacts(dir)).toEqual([
      { id: "cli", name: "@kazet/globu", kind: "npm", version: "2.0.0" },
      { id: "worker", name: "@kazet/globu-worker", kind: "npm", version: "2.0.0" },
      { id: "plugin", name: "globu@globu", kind: "claude-code-plugin", version: "2.0.0" },
      { id: "status", name: "globu-status@globu", kind: "claude-code-plugin", version: "0.3.1" }
    ]);
    expect(behindRelease(readArtefacts(dir), "2.0.0")).toEqual([]);
  });

  it("names an artefact that shares the release version but lags it, and leaves the status mod alone", () => {
    const dir = fixture({ cli: "2.0.0", worker: "2.0.0", plugin: "1.9.0", status: "0.1.0" });
    expect(behindRelease(readArtefacts(dir), "2.0.0")).toEqual(["globu@globu is at 1.9.0, not 2.0.0"]);
  });

  it("finds the four artefacts in this repo", () => {
    const artefacts = readArtefacts(root);
    expect(artefacts.map(({ id, name, kind }) => ({ id, name, kind }))).toEqual([
      { id: "cli", name: "@kazet/globu", kind: "npm" },
      { id: "worker", name: "@kazet/globu-worker", kind: "npm" },
      { id: "plugin", name: "globu@globu", kind: "claude-code-plugin" },
      { id: "status", name: "globu-status@globu", kind: "claude-code-plugin" }
    ]);
    for (const artefact of artefacts) expect(artefact.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
