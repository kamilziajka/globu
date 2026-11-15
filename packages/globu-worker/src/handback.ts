import { type FollowUpSettings, projectOf, statusFor, type WorkerConfig } from "./config.js";
import { type FiledEntry, filedFor, saveFiled } from "./filed.js";
import type { JiraClient } from "./jira.js";
import { log } from "./logger.js";

export type FollowUpItem = { summary: string; description: string };
export type FiledFollowUp = { summary: string; key: string | null; problem: string | null };

const HEADING_RE = /^ {0,3}(#{1,6})\s+(.*?)[\s#]*$/;
const SECTION_RE = /^follow[- ]?ups$/i;
const FENCE_RE = /^\s*(```|~~~)/;
const BULLET_RE = /^ ?[-*+]\s+(.*\S)\s*$/;
const NONE_RE = /^(none|nothing|n\/a)\.?$/i;
export const SUMMARY_LIMIT = 255;

function heading(line: string): { depth: number; text: string } | null {
  const match = HEADING_RE.exec(line);
  return match === null ? null : { depth: match[1].length, text: match[2] };
}

function dedent(lines: string[]): string {
  const indents = lines.filter((line) => line.trim() !== "").map((line) => line.length - line.trimStart().length);
  const cut = Math.min(...indents);
  return lines
    .map((line) => line.slice(cut))
    .join("\n")
    .trim();
}

function bullets(lines: string[]): string[][] {
  const items: string[][] = [];
  let current: string[] | null = null;
  let fenced = false;
  let blank = false;
  for (const line of lines) {
    const fence = FENCE_RE.test(line);
    const code = fenced || fence;
    if (fence) fenced = !fenced;
    const found = code ? null : heading(line);
    if (found !== null && found.depth <= 2) break;
    const bullet = code ? null : BULLET_RE.exec(line);
    if (bullet !== null) {
      current = [bullet[1]];
      items.push(current);
    } else if (current !== null && blank && !code && /^\S/.test(line)) {
      current = null;
    } else if (current !== null) {
      current.push(line);
    }
    blank = line.trim() === "";
  }
  return items;
}

export function parseFollowUps(handback: string): FollowUpItem[] {
  const lines = handback.split(/\r?\n/);
  const start = lines.findIndex((line) => {
    const found = heading(line);
    return found !== null && found.depth === 2 && SECTION_RE.test(found.text);
  });
  if (start === -1) return [];
  return bullets(lines.slice(start + 1)).flatMap(([first, ...rest]) => {
    const line = first.replace(/\s+/g, " ");
    if (NONE_RE.test(line)) return [];
    if (line.length <= SUMMARY_LIMIT) return [{ summary: line, description: dedent(rest) }];
    return [{ summary: `${line.slice(0, SUMMARY_LIMIT - 1)}…`, description: `${line}\n\n${dedent(rest)}`.trim() }];
  });
}

function description(item: FollowUpItem, key: string, runId: string): string {
  const origin = `Follow-up of ${key}, from the handback of Globu worker run ${runId}.`;
  return item.description === "" ? origin : `${item.description}\n\n${origin}`;
}

type Ledger = { home: string; key: string; entries: FiledEntry[]; earlier: FiledEntry[] };

const EARLIER = "filed by an earlier attempt, not in this handback";

function remember(ledger: Ledger): void {
  saveFiled(ledger.home, ledger.key, ledger.entries);
}

async function link(jira: JiraClient, settings: FollowUpSettings, ledger: Ledger, entry: FiledEntry) {
  if (entry.linked) return null;
  try {
    await jira.linkIssues(settings.linkType, ledger.key, entry.key);
  } catch (err) {
    return `not linked: ${(err as Error).message}`;
  }
  entry.linked = true;
  remember(ledger);
  return null;
}

async function create(
  jira: JiraClient,
  settings: FollowUpSettings,
  ledger: Ledger,
  runId: string,
  item: FollowUpItem
): Promise<FiledEntry | string> {
  const issueType = statusFor(settings.issueType, ledger.key);
  if (issueType === undefined) return `no jira.followUps.issueType for project ${projectOf(ledger.key)}`;
  let key: string;
  try {
    key = await jira.createIssue({
      project: projectOf(ledger.key),
      issueType,
      summary: item.summary,
      description: description(item, ledger.key, runId)
    });
  } catch (err) {
    return (err as Error).message;
  }
  const entry = { summary: item.summary, key, linked: false };
  ledger.entries.push(entry);
  remember(ledger);
  return entry;
}

async function fileOne(
  jira: JiraClient,
  settings: FollowUpSettings,
  ledger: Ledger,
  runId: string,
  item: FollowUpItem,
  index: number
): Promise<FiledFollowUp & { reused: boolean }> {
  const { summary } = item;
  if (index >= settings.max) {
    return { summary, key: null, problem: `over jira.followUps.max of ${settings.max}`, reused: false };
  }
  const at = ledger.earlier.findIndex((entry) => entry.summary === summary);
  const reused = at !== -1;
  const entry = reused ? ledger.earlier.splice(at, 1)[0] : await create(jira, settings, ledger, runId, item);
  if (typeof entry === "string") return { summary, key: null, problem: entry, reused };
  const problem = await link(jira, settings, ledger, entry);
  return { summary, key: entry.key, problem, reused };
}

export async function fileFollowUps(
  jira: JiraClient,
  config: WorkerConfig,
  home: string,
  key: string,
  runId: string,
  handback: string
): Promise<FiledFollowUp[]> {
  const settings = config.jira.followUps;
  if (settings === undefined) return [];
  const entries = filedFor(home, key);
  const ledger: Ledger = { home, key, entries, earlier: [...entries] };
  const filed: FiledFollowUp[] = [];
  for (const [index, item] of parseFollowUps(handback).entries()) {
    const { reused, ...entry } = await fileOne(jira, settings, ledger, runId, item, index);
    const fields = { run: runId, key, followUp: entry.key, summary: entry.summary };
    if (entry.problem !== null) log().warn("follow-up failed", { ...fields, problem: entry.problem });
    else log().info(reused ? "follow-up reused" : "follow-up filed", fields);
    filed.push(entry);
  }
  for (const earlier of ledger.earlier) {
    const problem = await link(jira, settings, ledger, earlier);
    const fields = { run: runId, key, followUp: earlier.key, summary: earlier.summary };
    log().info("follow-up kept", problem === null ? fields : { ...fields, problem });
    const note = problem === null ? EARLIER : `${EARLIER}, ${problem}`;
    filed.push({ summary: earlier.summary, key: earlier.key, problem: note });
  }
  return filed;
}

export function followUpSection(filed: FiledFollowUp[]): string {
  if (filed.length === 0) return "";
  const lines = filed.map((entry) => {
    const problem = entry.problem === null ? "" : ` (${entry.problem})`;
    return entry.key === null
      ? `- not created: ${entry.summary}${problem}`
      : `- ${entry.key}: ${entry.summary}${problem}`;
  });
  return `Follow-up issues:\n${lines.join("\n")}\n\n`;
}
