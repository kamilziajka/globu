import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import { packageDir, pluginDir, readJson, root, targets, writeJson } from "./targets.ts";

const { version } = readJson<{ version: string }>(path.join(root, "package.json"));

const banner = [
  "#!/usr/bin/env node",
  'import { createRequire as __createRequire } from "node:module";',
  "const require = __createRequire(import.meta.url);"
].join("\n");

for (const target of targets) {
  const outfile = path.join(target.packageDir, target.bundle);
  await build({
    entryPoints: [path.join(target.packageDir, target.entry)],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    banner: { js: banner },
    logLevel: "warning"
  });
  fs.chmodSync(outfile, 0o755);

  const manifestPath = path.join(target.packageDir, "package.json");
  const manifest = readJson<{ name: string; version: string }>(manifestPath);
  if (manifest.version !== version) writeJson(manifestPath, { ...manifest, version });
  fs.copyFileSync(path.join(root, "LICENSE"), path.join(target.packageDir, "LICENSE"));
  console.log(`built ${path.relative(root, outfile)}`);
}

const { name } = readJson<{ name: string }>(path.join(packageDir, "package.json"));
const link = path.join(pluginDir, "node_modules", name);
fs.rmSync(path.join(pluginDir, "node_modules"), { recursive: true, force: true });
fs.mkdirSync(path.dirname(link), { recursive: true });
fs.symlinkSync(path.relative(path.dirname(link), packageDir), link);
