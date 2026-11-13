import { runOrThrow } from "./exec.js";
import type { WorkerDeps } from "./worker.js";

export type Checks = "passing" | "failing" | "pending" | "none";
export type PullRequest = {
  url: string;
  number: number;
  title: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  mergeable: string;
  head: string;
  base: string;
  checks: Checks;
  failing: string[];
};
export type FollowUpState = "in review" | "conflict" | "checks failing" | "needs human" | "merged" | "closed";

type RollupEntry = {
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string | null;
  state?: string;
  detailsUrl?: string;
  targetUrl?: string;
};
type RawPullRequest = {
  url: string;
  number: number;
  title: string;
  state: PullRequest["state"];
  mergeable: string;
  headRefName: string;
  baseRefName: string;
  statusCheckRollup: RollupEntry[] | null;
};

const FIELDS = "url,number,title,state,mergeable,headRefName,baseRefName,statusCheckRollup";
const FAILED = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"]);
const DONE = new Set(["COMPLETED", "SUCCESS", "FAILURE", "ERROR", "NEUTRAL", "SKIPPED"]);

function outcome(entry: RollupEntry): string {
  return entry.conclusion ?? entry.state ?? entry.status ?? "";
}

export function parsePullRequest(raw: RawPullRequest): PullRequest {
  const rollup = raw.statusCheckRollup ?? [];
  const failing = rollup
    .filter((entry) => FAILED.has(outcome(entry)))
    .map((entry) => `${entry.name ?? entry.context}: ${entry.detailsUrl ?? entry.targetUrl ?? "no link"}`);
  const pending = rollup.some((entry) => !FAILED.has(outcome(entry)) && !DONE.has(entry.status ?? outcome(entry)));
  const checks: Checks =
    rollup.length === 0 ? "none" : failing.length > 0 ? "failing" : pending ? "pending" : "passing";
  return {
    url: raw.url,
    number: raw.number,
    title: raw.title,
    state: raw.state,
    mergeable: raw.mergeable,
    head: raw.headRefName,
    base: raw.baseRefName,
    checks,
    failing
  };
}

export async function readPullRequest(deps: WorkerDeps, url: string, token: string): Promise<PullRequest> {
  const output = await runOrThrow(deps.run, "gh", ["pr", "view", url, "--json", FIELDS], {
    env: { ...deps.env, GH_TOKEN: token }
  });
  return parsePullRequest(JSON.parse(output) as RawPullRequest);
}

export function followUpState(pull: PullRequest, needsHuman: boolean): FollowUpState {
  if (pull.state === "MERGED") return "merged";
  if (pull.state === "CLOSED") return "closed";
  if (needsHuman) return "needs human";
  if (pull.mergeable === "CONFLICTING") return "conflict";
  if (pull.checks === "failing") return "checks failing";
  return "in review";
}

export function repoOf(url: string): string {
  return url.replace(/\/pull\/\d+.*$/, "");
}
