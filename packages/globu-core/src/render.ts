import path from "node:path";
import { staleCount, staleSummary } from "./freshness.js";
import type { Root } from "./manifest.js";
import { conventionsFor } from "./probe.js";
import type { ResolvedShard } from "./registry.js";
import { locate, type SessionShard } from "./session.js";

const MAX_ROOTS = 6;
const ASK_FIRST = "ask first";

type PresentShard = SessionShard & { path: string; workPath: string };

function rootLine(shard: PresentShard, root: Root): string {
  const target = path.join(shard.workPath, root.entry ?? root.path);
  return root.name ? `${root.name}: ${target}` : target;
}

function accessLabel(shard: PresentShard): string {
  if (shard.mode === "read") return "read-only";
  return shard.mode === "write" || shard.here ? "writable" : ASK_FIRST;
}

function locationLine(shard: PresentShard): string {
  if (shard.workPath === shard.path) return `  - Location: ${shard.path}`;
  return `  - Location: ${shard.workPath} (this session's worktree. Read and edit it here, not in the main checkout at ${shard.path})`;
}

function shardBlock(shard: PresentShard): string {
  const here = shard.here ? ", you are working inside it" : "";
  const lines = [`- **${shard.id}** (${shard.format}, ${accessLabel(shard)}${here})`, locationLine(shard)];
  if (shard.description) lines.push(`  - What: ${shard.description}`);
  if (shard.useWhen) lines.push(`  - Use when: ${shard.useWhen}`);
  if (shard.roots.length === 1) {
    lines.push(`  - Entry: ${rootLine(shard, shard.roots[0])}`);
  } else {
    lines.push("  - Entries:");
    for (const root of shard.roots.slice(0, MAX_ROOTS)) lines.push(`    - ${rootLine(shard, root)}`);
    if (shard.roots.length > MAX_ROOTS) {
      lines.push(`    - ${shard.roots.length - MAX_ROOTS} more, run \`globu show ${shard.id}\` to list them`);
    }
  }
  const stale = staleCount(shard, shard.workPath);
  if (stale > 0) lines.push(`  - Stale: ${staleSummary(stale, shard.workPath)}`);
  return lines.join("\n");
}

export function renderIndex(shards: ResolvedShard[], context: string | null, cwd: string): string {
  if (shards.length === 0) return "";
  const present = locate(shards, cwd).filter((shard): shard is PresentShard => shard.present);
  const missing = shards.filter((shard) => !shard.present);

  const lines = [
    `# Globu knowledge shards${context === null ? "" : ` (context: ${context})`}`,
    "",
    "These knowledge sources are registered on this machine. Most live outside the current repo. When a task touches a shard's area, read its entry file first and follow links from there. Leave them alone when the task is unrelated.",
    "",
    ...present.map(shardBlock)
  ];

  const conventions = [...new Set(present.map((shard) => shard.format))].flatMap((format) => {
    const text = conventionsFor(format);
    return text === null ? [] : [`- **${format}**: ${text}`];
  });
  if (conventions.length > 0) lines.push("", "## Formats", ...conventions);

  const askFirst = present.some((shard) => accessLabel(shard) === ASK_FIRST)
    ? ` The exception is a shard marked ${ASK_FIRST}: tell the user what you want to change there and get their agreement in this session before editing it. Each edit also raises a permission prompt.`
    : "";
  lines.push(
    "",
    "## Writing",
    `Only edit shards marked writable.${askFirst} Never copy knowledge from one shard into another unless the user names the target shard. To record what a session learned, use the \`globu:update-knowledge\` skill.`
  );
  if (missing.length > 0) {
    lines.push("", `Not available locally (run \`globu sync\`): ${missing.map((shard) => shard.id).join(", ")}`);
  }
  return lines.join("\n");
}
