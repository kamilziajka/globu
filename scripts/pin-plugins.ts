import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { packageDir, pluginDir, readJson, root, type Target, targets, writeJson } from "./targets.ts";

type PackageManifest = {
  name: string;
  version: string;
  license?: string;
  bin: Record<string, string>;
  engines: Record<string, string>;
};
type Packed = { filename: string; integrity: string; files: { path: string }[] };
type Release = {
  name: string;
  version: string;
  tarball: string;
  resolved: string;
  integrity: string;
  manifest: PackageManifest;
  target: Target;
};

const releaseDir = path.join(root, "release");
fs.rmSync(releaseDir, { recursive: true, force: true });
fs.mkdirSync(releaseDir);

function pack(target: Target): Release {
  const manifest = readJson<PackageManifest>(path.join(target.packageDir, "package.json"));
  const output = execFileSync("npm", ["pack", target.packageDir, "--json", "--pack-destination", releaseDir], {
    encoding: "utf8"
  });
  const [packed] = JSON.parse(output) as Packed[];
  if (!packed.files.some((file) => file.path === target.bundle)) {
    throw new Error(`${manifest.name}: ${target.bundle} is missing from the tarball, run npm run build first`);
  }
  const unscoped = manifest.name.split("/").at(-1);
  return {
    name: manifest.name,
    version: manifest.version,
    tarball: `./${path.relative(root, path.join(releaseDir, packed.filename))}`,
    resolved: `https://registry.npmjs.org/${manifest.name}/-/${unscoped}-${manifest.version}.tgz`,
    integrity: packed.integrity,
    manifest,
    target
  };
}

const releases = targets.map(pack);
writeJson(
  path.join(releaseDir, "packages.json"),
  releases.map(({ manifest: _manifest, target: _target, ...release }) => release)
);

const cli = releases.find((release) => release.target.packageDir === packageDir);
if (cli === undefined) throw new Error(`${packageDir} was not packed`);
const pluginName = `${path.basename(pluginDir)}-plugin`;
const dependencies = { [cli.name]: cli.version };
writeJson(path.join(pluginDir, "package.json"), { name: pluginName, private: true, dependencies });
writeJson(path.join(pluginDir, "package-lock.json"), {
  name: pluginName,
  lockfileVersion: 3,
  requires: true,
  packages: {
    "": { name: pluginName, dependencies },
    [`node_modules/${cli.name}`]: {
      version: cli.version,
      resolved: cli.resolved,
      integrity: cli.integrity,
      ...(cli.manifest.license === undefined ? {} : { license: cli.manifest.license }),
      bin: cli.manifest.bin,
      engines: cli.manifest.engines
    }
  }
});

const pluginManifestPath = path.join(pluginDir, ".claude-plugin", "plugin.json");
writeJson(pluginManifestPath, { ...readJson<object>(pluginManifestPath), version: cli.version });

console.log(`pinned ${path.relative(root, pluginDir)} to ${cli.name}@${cli.version}`);
for (const release of releases) {
  console.log(`  publish with: npm publish ${release.tarball}`);
}
