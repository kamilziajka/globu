import path from "node:path";
import { staleDocs } from "../../knowledge-base/src/index.js";
import { okfDriver } from "./drivers/okf.js";
import type { Shard } from "./manifest.js";

export function staleCount(shard: Pick<Shard, "format" | "roots">, dir: string, now: number = Date.now()): number {
  if (shard.format !== okfDriver.name) return 0;
  return shard.roots.reduce((sum, root) => sum + staleDocs(path.join(dir, root.path), now).length, 0);
}

export function staleSummary(count: number, dir: string): string {
  const docs = count === 1 ? "1 doc is" : `${count} docs are`;
  return `${docs} past stale_after or deprecated, read them with caution. \`globu base stale ${dir}\` lists them`;
}
