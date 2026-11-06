import fs from "node:fs";
import path from "node:path";

export type Target = { packageDir: string; entry: string; bundle: string };

export const root = path.join(import.meta.dirname, "..");
export const packageDir = path.join(root, "packages/globu-cli");
export const pluginDir = path.join(root, "plugins/globu");
export const entry = "src/bin/globu.ts";
export const bundle = "dist/globu.mjs";
export const targets: Target[] = [
  { packageDir, entry, bundle },
  {
    packageDir: path.join(root, "packages/globu-worker"),
    entry: "src/bin/globu-worker.ts",
    bundle: "dist/globu-worker.mjs"
  }
];

export function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

export function writeJson(file: string, value: unknown): void {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
