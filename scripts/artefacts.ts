import path from "node:path";
import { readJson } from "./targets.ts";

export type ArtefactKind = "npm" | "claude-code-plugin";
export type Artefact = { id: string; name: string; kind: ArtefactKind; version: string };
type Source = { id: string; kind: ArtefactKind; dir: string; ownVersion?: true };

export const sources: Source[] = [
  { id: "cli", kind: "npm", dir: "packages/globu-cli" },
  { id: "worker", kind: "npm", dir: "packages/globu-worker" },
  { id: "plugin", kind: "claude-code-plugin", dir: "plugins/globu" },
  { id: "status", kind: "claude-code-plugin", dir: "mods/globu-status", ownVersion: true }
];

type Manifest = { name: string; version: string };

export function readArtefacts(root: string): Artefact[] {
  const marketplace = readJson<{ name: string }>(path.join(root, ".claude-plugin/marketplace.json")).name;
  return sources.map(({ id, kind, dir }) => {
    if (kind === "npm") {
      const { name, version } = readJson<Manifest>(path.join(root, dir, "package.json"));
      return { id, name, kind, version };
    }
    const { name, version } = readJson<Manifest>(path.join(root, dir, ".claude-plugin/plugin.json"));
    return { id, name: `${name}@${marketplace}`, kind, version };
  });
}

export function behindRelease(artefacts: Artefact[], version: string): string[] {
  return artefacts
    .filter((artefact) => !sources.find((source) => source.id === artefact.id)?.ownVersion)
    .filter((artefact) => artefact.version !== version)
    .map((artefact) => `${artefact.name} is at ${artefact.version}, not ${version}`);
}
