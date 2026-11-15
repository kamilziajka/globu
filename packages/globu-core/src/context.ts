import type { Manifest } from "./manifest.js";
import type { State } from "./state.js";

export type Selection = { context: string | null; ids: string[] | null };

function matches(pattern: string, id: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`).test(id);
}

export function matchesAny(patterns: string[], id: string): boolean {
  return patterns.some((pattern) => matches(pattern, id));
}

export function projectShards(manifest: Manifest): Record<string, string[]> {
  const projects = Object.entries(manifest.projects ?? {}).map(([name, project]) => [name, project.shards]);
  return { ...Object.fromEntries(projects), ...manifest.contexts, ...Object.fromEntries(projects) };
}

export function assertProject(manifest: Manifest, name: string): void {
  const known = Object.keys(projectShards(manifest));
  if (!known.includes(name)) throw new Error(`unknown project "${name}" (known: ${known.join(", ") || "none"})`);
}

export function activeContextName(state: State): string | null {
  return process.env.GLOBU_CONTEXT || state.current;
}

export function selectShards<T extends { id: string }>(
  shards: T[],
  manifest: Manifest,
  contextName: string | null
): T[] {
  if (contextName === null) return shards;
  const projects = projectShards(manifest);
  if (!Object.hasOwn(projects, contextName)) throw new Error(`unknown project: ${contextName}`);
  const patterns = [...projects[contextName], ...(manifest.always ?? [])];
  return shards.filter((shard) => matchesAny(patterns, shard.id));
}

export function selectForHome<T extends { id: string }>(
  shards: T[],
  manifest: Manifest,
  homeId: string | null
): { context: string | null; shards: T[] } {
  const projects = Object.entries(projectShards(manifest));
  if (homeId === null || projects.length === 0) return { context: null, shards };
  const project = projects.find(([, patterns]) => matchesAny(patterns, homeId));
  if (project !== undefined) return { context: project[0], shards: selectShards(shards, manifest, project[0]) };
  const always = manifest.always ?? [];
  return { context: null, shards: shards.filter((shard) => shard.id === homeId || matchesAny(always, shard.id)) };
}
