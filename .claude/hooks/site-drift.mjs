import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const PACKAGE_NAME = "@kazet/globu";
const SITE_VERSION_URL = "https://globu.kazet.blog/version.json";
const SITE_HOST = new URL(SITE_VERSION_URL).host;
const SITE_REPO = "kamilziajka/globu-website";
const TIMEOUT_MS = 8000;

function readStdin() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return {};
  }
}

function run(file, args) {
  try {
    return execFileSync(file, args, { encoding: "utf8", timeout: TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

async function siteVersion() {
  try {
    const response = await fetch(SITE_VERSION_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
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

function openSitePullRequest(version) {
  const output = run("gh", [
    "pr",
    "list",
    "--repo",
    SITE_REPO,
    "--state",
    "open",
    "--search",
    `Globu ${version} in:title`,
    "--json",
    "number,title"
  ]);
  if (output === null) return null;
  try {
    const found = JSON.parse(output).find((pr) => pr.title.includes(version));
    return found ? found.number : false;
  } catch {
    return null;
  }
}

async function main() {
  const input = readStdin();
  if (input.stop_hook_active) return;

  const local = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
  const published = run("npm", ["view", PACKAGE_NAME, "version"]);
  if (published === null) return;

  const findings = [];
  if (compare(local, published) > 0) {
    findings.push(`package.json is at ${local} but npm serves ${published}: the bump is not released yet. The release skill runs the workflow and updates the site.`);
  }

  const site = await siteVersion();
  if (site !== null && compare(published, site) > 0) {
    const pullRequest = openSitePullRequest(published);
    if (pullRequest === false) {
      findings.push(
        `${SITE_HOST} shows ${site} while npm serves ${published} and no pull request titled "Globu ${published}" is open in ${SITE_REPO}: the site update was skipped. Run the release skill's site step, or tell the user.`
      );
    } else if (typeof pullRequest === "number") {
      findings.push(`${SITE_HOST} shows ${site}; ${published} waits in ${SITE_REPO}#${pullRequest}.`);
    } else {
      findings.push(`${SITE_HOST} shows ${site} while npm serves ${published}; could not check ${SITE_REPO} for an open pull request.`);
    }
  }

  if (findings.length === 0) return;
  process.stderr.write(`Globu site drift:\n- ${findings.join("\n- ")}\nTell the user before ending.\n`);
  process.exitCode = 2;
}

main();
