import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { register, resolveAll } from "../../globu-core/src/index.js";
import { initRepo, tempDir, write } from "../../testing/index.js";
import { bootstrapShards } from "./bootstrap.js";
import { loadWorkerConfig } from "./config.js";

function config(shards: string) {
  const text = `
jira:
  site: https://acme.atlassian.net
  jql: project = MR
  claimedStatus: Delivery
  releasedStatus: Ready for delivery
  repository:
    labelPrefix: "repo:"
shards:
${shards}`;
  return loadWorkerConfig(write(tempDir(), "worker.yaml", text));
}

describe("bootstrapShards", () => {
  it("registers missing shards that have a repository URL as editable clones in the home", () => {
    const root = tempDir();
    const home = process.env.GLOBU_HOME as string;
    const backend = initRepo(path.join(root, "remotes/backend"), { "README.md": "backend\n" });
    const product = initRepo(path.join(root, "remotes/product"), { "README.md": "product\n" });
    const shards = `  deliverable: [backend]
  companion: [product]
  repos:
    backend: file://${backend}
    product: file://${product}
`;
    const lines = bootstrapShards(config(shards), home);
    const settings = path.join(process.env.CLAUDE_CONFIG_DIR as string, "settings.json");
    expect(lines).toEqual([
      `registered backend from file://${backend} in ${path.join(home, "work/backend")}`,
      `registered product from file://${product} in ${path.join(home, "work/product")}`,
      `shard directories written to ${settings}`
    ]);
    const registered = resolveAll().shards.map((shard) => [shard.id, shard.mode, shard.present, shard.path]);
    expect(registered).toEqual([
      ["backend", "write", true, path.join(home, "work/backend")],
      ["product", "write", true, path.join(home, "work/product")]
    ]);
    expect(fs.readFileSync(path.join(home, "work/backend/README.md"), "utf8")).toBe("backend\n");
    expect(JSON.parse(fs.readFileSync(settings, "utf8")).permissions.additionalDirectories).toEqual([
      path.join(home, "work/backend"),
      path.join(home, "work/product")
    ]);
    expect(bootstrapShards(config(shards), home)).toEqual([]);
  });

  it("leaves registered shards and shards without a URL alone", () => {
    const root = tempDir();
    const home = process.env.GLOBU_HOME as string;
    const backend = initRepo(path.join(root, "remotes/backend"), { "README.md": "backend\n" });
    register({ locator: `file://${backend}`, cwd: root, dest: path.join(root, "elsewhere") });
    const shards = `  deliverable: [backend, ghost]
  repos:
    backend: file://${path.join(root, "other")}
`;
    expect(bootstrapShards(config(shards), home)).toEqual([]);
    expect(resolveAll().shards.map((shard) => shard.path)).toEqual([path.join(root, "elsewhere")]);
  });
});
