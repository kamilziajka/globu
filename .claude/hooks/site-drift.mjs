import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";

const ROOT = new URL("../../", import.meta.url);
const TIMEOUT_MS = 8000;

function readStdin() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return {};
  }
}

function readJson(url) {
  return JSON.parse(readFileSync(url, "utf8"));
}

function run(file, args) {
  try {
    return execFileSync(file, args, { encoding: "utf8", timeout: TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function publicPackages() {
  const dir = new URL("packages/", ROOT);
  return readdirSync(dir)
    .map((name) => new URL(`${name}/package.json`, dir))
    .filter((file) => existsSync(file))
    .map((file) => readJson(file))
    .filter((manifest) => !manifest.private)
    .sort((a, b) => (a.bin?.globu ? -1 : 0) - (b.bin?.globu ? -1 : 0));
}

async function siteVersion(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) return null;
    const body = await response.json();
    return typeof body.version === "string" ? body.version : null;
  } catch {
    return null;
  }
}

function compare(a, b) {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

async function main() {
  const input = readStdin();
  if (input.stop_hook_active) return;

  const local = readJson(new URL("package.json", ROOT)).version;
  const [cli, ...others] = publicPackages();
  if (cli === undefined) return;
  const published = run("npm", ["view", cli.name, "version"]);
  if (published === null) return;

  const findings = [];
  if (compare(local, published) > 0) {
    findings.push(`package.json is at ${local} but npm serves ${published}: the bump is not released yet. Run /release ${local}, which resumes where the release stopped.`);
  }
  for (const other of others) {
    const version = run("npm", ["view", other.name, "version"]);
    if (version !== null && version !== published) {
      findings.push(`npm serves ${cli.name}@${published} but ${other.name}@${version}: the packages release together, so one of them is missing a publish.`);
    }
  }

  if (typeof cli.homepage === "string") {
    const url = new URL("/version.json", cli.homepage);
    const site = await siteVersion(url);
    if (site !== null && compare(published, site) > 0) {
      findings.push(`${url.host} shows ${site} while npm serves ${published}: its deploy is still running or the site step of the release did not finish. Run /release ${published}, which checks and resumes where the release stopped.`);
    }
  }

  if (findings.length === 0) return;
  process.stderr.write(`Globu site drift:\n- ${findings.join("\n- ")}\nTell the user before ending.\n`);
  process.exitCode = 2;
}

main();
