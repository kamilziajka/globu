import path from "node:path";
import { register, resolveAll, syncClaudeDirectories } from "../../globu-core/src/index.js";
import type { WorkerConfig } from "./config.js";
import { log } from "./logger.js";

export function bootstrapShards(config: WorkerConfig, home: string): string[] {
  const known = new Set(resolveAll().shards.map((shard) => shard.id));
  const wanted = [...config.shards.deliverable, ...config.shards.companion];
  const missing = wanted.filter((id) => !known.has(id) && Object.hasOwn(config.shards.repos, id));
  if (missing.length === 0) return [];
  const lines = missing.map((id) => {
    const repo = config.shards.repos[id];
    const dest = path.join(home, "work", id);
    register({ locator: repo, cwd: home, id, dest, mode: "write" });
    log().info("registered", { shard: id, repo, path: dest });
    return `registered ${id} from ${repo} in ${dest}`;
  });
  const { settingsPath } = syncClaudeDirectories(false);
  return [...lines, `shard directories written to ${settingsPath}`];
}
