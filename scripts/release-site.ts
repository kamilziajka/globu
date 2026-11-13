import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { readJson, root } from "./targets.ts";

const [siteArg, dateArg] = process.argv.slice(2);
if (siteArg === undefined) {
  console.error("usage: node scripts/release-site.ts <globu-website checkout> [YYYY-MM-DD]");
  process.exit(1);
}

const site = path.resolve(siteArg);
const version = readJson<{ version: string }>(path.join(root, "package.json")).version;
const date = dateArg ?? new Date().toISOString().slice(0, 10);
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const tagged = git("rev-parse", "--short", `v${version}^{commit}`);
const released = git("log", "-1", "--format=%h", "--grep", `^Release ${version}$`, `v${version}`);

const docsDir = path.join(root, "docs");
const contentDir = path.join(site, "content");
const navFile = path.join(site, "src", "docs", "nav.ts");
for (const required of [contentDir, navFile, path.join(site, "release.json"), path.join(site, "docs", "log.md")]) {
  if (!fs.existsSync(required)) throw new Error(`${required} is missing, is ${site} a globu-website checkout?`);
}

const markdown = (dir: string) =>
  fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".md") && name !== "index.md" && name !== "log.md")
    .sort();

const before = markdown(contentDir);
const after = markdown(docsDir);
const changed = after.filter(
  (name) =>
    !before.includes(name) ||
    fs.readFileSync(path.join(contentDir, name), "utf8") !== fs.readFileSync(path.join(docsDir, name), "utf8")
);
for (const name of before) fs.rmSync(path.join(contentDir, name));
for (const name of after) fs.copyFileSync(path.join(docsDir, name), path.join(contentDir, name));

fs.writeFileSync(path.join(site, "release.json"), `${JSON.stringify({ version, releasedAt: date }, null, 2)}\n`);

const nav = fs.readFileSync(navFile, "utf8");
const slugs = after.map((name) => name.slice(0, -3));
const unlisted = slugs.filter((slug) => !nav.includes(`fromContent("${slug}")`));
const stale = [...nav.matchAll(/fromContent\("([^"]+)"\)/g)]
  .map((match) => match[1])
  .filter((slug) => !slugs.includes(slug));

const logFile = path.join(site, "docs", "log.md");
const log = fs.readFileSync(logFile, "utf8");
const changes = changed.length === 0 ? "no doc changed" : `changed: ${changed.map((name) => `\`${name}\``).join(", ")}`;
const entry = `* Globu ${version}, released on ${date}: \`release.json\` bumped and the docs snapshot in \`content\` refreshed from \`kamilziajka/globu\` at \`${tagged}\` (tag \`v${version}\`, release commit \`${released}\`), ${changes}.`;
if (log.includes(`* Globu ${version}, released on`)) {
  console.log(`docs/log.md already has the ${version} entry, left as it is`);
} else {
  const heading = `## ${date}\n`;
  const updated = log.includes(heading)
    ? log.replace(heading, `${heading}${entry}\n`)
    : log.replace(/\n## /, `\n${heading}${entry}\n\n## `);
  fs.writeFileSync(logFile, updated);
}

console.log(`release.json: ${version}, released ${date}`);
console.log(`content: ${after.length} docs, ${changes}`);
if (unlisted.length > 0 || stale.length > 0) {
  if (unlisted.length > 0) console.log(`add to src/docs/nav.ts: ${unlisted.join(", ")}`);
  if (stale.length > 0) console.log(`remove from src/docs/nav.ts: ${stale.join(", ")}`);
  process.exit(2);
}
