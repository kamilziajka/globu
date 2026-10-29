import fs from "node:fs";
import path from "node:path";
import { commitsBehind, defaultRevision, isRepo, remoteUrl } from "./git.js";
import { sameRepo } from "./giturl.js";
import type { Root } from "./manifest.js";
import { probeDir } from "./probe.js";
import { type ResolvedShard, resolveAll } from "./registry.js";
import type { State } from "./state.js";

export type Finding = { id: string; level: "error" | "warning"; message: string };

export const CLAUDE_SETTINGS_ID = "claude-settings";

function rootsKey(roots: Root[]): string {
  return JSON.stringify(roots.map((root) => root.path).sort());
}

function rootsText(roots: Root[]): string {
  return roots.map((root) => root.path).join(", ");
}

function behindFindings(shard: ResolvedShard, dir: string): Omit<Finding, "id">[] {
  const behind = commitsBehind(dir);
  if (behind === 0) return [];
  const fix = shard.owner === "globu" ? "run `globu sync`" : "pull it";
  const count = `${behind} commit${behind === 1 ? "" : "s"}`;
  return [
    { level: "warning", message: `the clone is ${count} behind ${defaultRevision(dir)} as last fetched, ${fix}` }
  ];
}

function probeFindings(shard: ResolvedShard, dir: string): Omit<Finding, "id">[] {
  const probed = probeDir(dir);
  const preview = `preview with \`globu reprobe ${shard.id} --dry-run\``;
  if (probed.format !== shard.format) {
    const found =
      probed.format === "okf" ? `bases at ${rootsText(probed.roots)}` : "no index.md with an okf_version marker";
    return [
      {
        level: "warning",
        message: `format is now "${probed.format}" (${found}) in the working tree at ${dir}, the manifest says "${shard.format}", ${preview}`
      }
    ];
  }
  if (rootsKey(probed.roots) !== rootsKey(shard.roots)) {
    return [
      {
        level: "warning",
        message: `the roots are now ${rootsText(probed.roots)}, the manifest says ${rootsText(shard.roots)}, ${preview}`
      }
    ];
  }
  return shard.roots.flatMap((root) =>
    root.entry === undefined || fs.existsSync(path.join(dir, root.entry))
      ? []
      : [{ level: "warning" as const, message: `the entry file ${root.entry} is missing from the clone, ${preview}` }]
  );
}

function cloneFindings(shard: ResolvedShard): Omit<Finding, "id">[] {
  if (shard.path === null) return [{ level: "error", message: "not cloned on this machine, run `globu sync`" }];
  if (!shard.present) return [{ level: "error", message: `clone is missing at ${shard.path}` }];
  if (!isRepo(shard.path)) return [{ level: "error", message: `${shard.path} is not a git repository` }];

  const findings: Omit<Finding, "id">[] = [];
  if (shard.source.repo !== null && !sameRepo(remoteUrl(shard.path), shard.source.repo)) {
    findings.push({ level: "error", message: `the clone's origin does not match the manifest (${shard.source.repo})` });
  }
  return [...findings, ...behindFindings(shard, shard.path), ...probeFindings(shard, shard.path)];
}

function routingFindings(shard: ResolvedShard): Omit<Finding, "id">[] {
  const findings: Omit<Finding, "id">[] = [];
  if (shard.source.repo === null) {
    findings.push({ level: "warning", message: "no repo URL, so this shard cannot be synced to another machine" });
  }
  if (!shard.description) {
    findings.push({ level: "warning", message: "no description, Claude cannot tell what this shard holds" });
  }
  if (!shard.useWhen) {
    findings.push({ level: "warning", message: "no useWhen, Claude cannot tell when to consult this shard" });
  }
  return findings;
}

function settingsFindings(state: State, shards: ResolvedShard[]): Finding[] {
  const used = new Set(shards.map((shard) => shard.path));
  return state.claude.directories.flatMap((dir) => {
    const problem = !fs.existsSync(dir) ? "no longer exists" : used.has(dir) ? null : "belongs to no registered shard";
    return problem === null
      ? []
      : [
          { id: CLAUDE_SETTINGS_ID, level: "warning" as const, message: `${dir} ${problem}, run \`globu claude sync\`` }
        ];
  });
}

export function doctor(): Finding[] {
  const { state, shards } = resolveAll();
  const perShard = shards.flatMap((shard) =>
    [...routingFindings(shard), ...cloneFindings(shard)].map((finding) => ({ id: shard.id, ...finding }))
  );
  return [...perShard, ...settingsFindings(state, shards)];
}
