import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const PACKAGE_NAME = "@kazet/globu";
const WORKER_PACKAGE_NAME = "@kazet/globu-worker";
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

function siteMainVersion() {
  const output = run("gh", ["api", `repos/${SITE_REPO}/contents/release.json`, "--jq", ".content"]);
  if (output === null) return null;
  try {
    return JSON.parse(Buffer.from(output, "base64").toString("utf8")).version;
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
    findings.push(`package.json is at ${local} but npm serves ${published}: the bump is not released yet. Run /release ${local}, which resumes where the release stopped.`);
  }
  const worker = run("npm", ["view", WORKER_PACKAGE_NAME, "version"]);
  if (worker !== null && worker !== published) {
    findings.push(`npm serves ${PACKAGE_NAME}@${published} but ${WORKER_PACKAGE_NAME}@${worker}: the two packages release together, so one of them is missing a publish.`);
  }

  const site = await siteVersion();
  if (site !== null && compare(published, site) > 0) {
    const pushed = siteMainVersion();
    if (pushed === published) {
      findings.push(`${SITE_HOST} shows ${site}; ${published} is on the main branch of ${SITE_REPO} and should be live once its deploy finishes.`);
    } else if (pushed === null) {
      findings.push(`${SITE_HOST} shows ${site} while npm serves ${published}; could not read release.json on the main branch of ${SITE_REPO}.`);
    } else {
      findings.push(
        `${SITE_HOST} shows ${site} while npm serves ${published} and the main branch of ${SITE_REPO} is at ${pushed}: the site step of the release did not run. Run /release ${published}, which resumes where the release stopped.`
      );
    }
  }

  if (findings.length === 0) return;
  process.stderr.write(`Globu site drift:\n- ${findings.join("\n- ")}\nTell the user before ending.\n`);
  process.exitCode = 2;
}

main();
