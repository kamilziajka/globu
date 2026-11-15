import path from "node:path";
import { register, resolveAll, syncClaudeDirectories } from "../../globu-core/src/index.js";
import type { WorkerConfig } from "./config.js";
import { log } from "./logger.js";
import { deliveryShards } from "./projects.js";

export function bootstrapShards(config: WorkerConfig, home: string): string[] {
  const { shards } = resolveAll();
  const missing = deliveryShards(config, shards).flatMap((id) => {
    const shard = shards.find((candidate) => candidate.id === id);
    const repo = shard === undefined ? config.repos[id] : shard.path === null ? shard.source.repo : null;
    return repo === undefined || repo === null ? [] : [{ id, repo }];
  });
  if (missing.length === 0) return [];
  const lines = missing.map(({ id, repo }) => {
    const dest = path.join(home, "work", id);
    try {
      register({ locator: repo, cwd: home, id, dest, mode: "write" });
    } catch (err) {
      throw new Error(
        `could not clone ${repo} for shard ${id}: ${(err as Error).message}\nA private repository needs GLOBU_GIT_TOKEN, or on github.com a GH_TOKEN that can read it.`
      );
    }
    log().info("registered", { shard: id, repo, path: dest });
    return `registered ${id} from ${repo} in ${dest}`;
  });
  const { settingsPath } = syncClaudeDirectories(false);
  return [...lines, `shard directories written to ${settingsPath}`];
}
