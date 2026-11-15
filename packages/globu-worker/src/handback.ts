import { projectOf, statusFor, type WorkerConfig } from "./config.js";
import type { JiraClient } from "./jira.js";
import { log } from "./logger.js";

export type FollowUpItem = { summary: string; description: string };
export type FiledFollowUp = { summary: string; key: string | null; problem: string | null };
type FollowUpSettings = NonNullable<WorkerConfig["jira"]["followUps"]>;

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

async function fileOne(
  jira: JiraClient,
  settings: FollowUpSettings,
  key: string,
  runId: string,
  item: FollowUpItem,
  index: number
): Promise<FiledFollowUp> {
  const { summary } = item;
  if (index >= settings.max) return { summary, key: null, problem: `over jira.followUps.max of ${settings.max}` };
  const issueType = statusFor(settings.issueType, key);
  if (issueType === undefined) {
    return { summary, key: null, problem: `no jira.followUps.issueType for project ${projectOf(key)}` };
  }
  let created: string;
  try {
    created = await jira.createIssue({
      project: projectOf(key),
      issueType,
      summary,
      description: description(item, key, runId)
    });
  } catch (err) {
    return { summary, key: null, problem: (err as Error).message };
  }
  try {
    await jira.linkIssues(settings.linkType, key, created);
  } catch (err) {
    return { summary, key: created, problem: `not linked: ${(err as Error).message}` };
  }
  return { summary, key: created, problem: null };
}

export async function fileFollowUps(
  jira: JiraClient,
  config: WorkerConfig,
  key: string,
  runId: string,
  handback: string
): Promise<FiledFollowUp[]> {
  const settings = config.jira.followUps;
  if (settings === undefined) return [];
  const filed: FiledFollowUp[] = [];
  for (const [index, item] of parseFollowUps(handback).entries()) {
    const entry = await fileOne(jira, settings, key, runId, item, index);
    const fields = { run: runId, key, followUp: entry.key, summary: entry.summary };
    if (entry.problem === null) log().info("follow-up filed", fields);
    else log().warn("follow-up failed", { ...fields, problem: entry.problem });
    filed.push(entry);
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
