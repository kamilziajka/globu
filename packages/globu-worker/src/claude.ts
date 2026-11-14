import { DENIED_TOOLS } from "./config.js";
import type { UsageWindow } from "./subscription.js";

export type ClaudeInvocation = {
  prompt: string;
  runDir: string;
  maxTurns: number;
  maxBudgetUsd: number;
  allowedTools: string[];
  model?: string;
  pluginDir?: string;
};

export function claudeArgs(invocation: ClaudeInvocation): string[] {
  return [
    "-p",
    invocation.prompt,
    "--permission-mode",
    "dontAsk",
    "--allowedTools",
    ...invocation.allowedTools,
    "--disallowedTools",
    ...DENIED_TOOLS,
    "--add-dir",
    invocation.runDir,
    "--max-turns",
    String(invocation.maxTurns),
    "--max-budget-usd",
    String(invocation.maxBudgetUsd),
    "--output-format",
    "stream-json",
    "--verbose",
    ...(invocation.model === undefined ? [] : ["--model", invocation.model]),
    ...(invocation.pluginDir === undefined ? [] : ["--plugin-dir", invocation.pluginDir])
  ];
}

export function implementPrompt(skill: string, briefFile: string, handbackFile: string): string {
  return `Implement the issue described in ${briefFile} with the ${skill} skill. Write the handback to ${handbackFile}.`;
}

export function repairPrompt(briefFile: string, handbackFile: string): string {
  return `Repair the pull request described in ${briefFile}: resolve what it lists, run the tests and commit. Write a short note on what you did to ${handbackFile}.`;
}

export type ClaudeSummary = {
  subtype: string | null;
  isError: boolean;
  costUsd: number;
  turns: number;
  result: string | null;
  blocked: string[];
  failedTools: string[];
  denied: string[];
  durationMs: number;
  apiMs: number;
  usage: UsageWindow[];
};

type RateWindow = { status?: string; utilization?: number; resetsAt?: number };
type RateLimitInfo = RateWindow & { rateLimitType?: string; unifiedWindows?: Record<string, RateWindow> };
type Denial = { tool_name: string; tool_input?: Record<string, unknown> };
type ToolResult = { type: string; content?: unknown; is_error?: boolean };
type StreamEvent = {
  type: string;
  subtype?: string;
  is_error?: boolean;
  total_cost_usd?: number;
  num_turns?: number;
  result?: string;
  duration_ms?: number;
  duration_api_ms?: number;
  permission_denials?: Denial[];
  rate_limit_info?: RateLimitInfo;
  message?: { content?: ToolResult[] };
};

const GUARD_MESSAGE = /shard "[^"]+"/;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part: { type?: string }) => part.type === "text")
    .map((part: { text: string }) => part.text)
    .join("\n");
}

function deniedCall(denial: Denial): string {
  const input = denial.tool_input ?? {};
  const what = typeof input.command === "string" ? input.command : JSON.stringify(input);
  return `${denial.tool_name}: ${what}`;
}

function usageOf(info: RateLimitInfo): UsageWindow[] {
  const named = info.unifiedWindows ?? (info.rateLimitType === undefined ? {} : { [info.rateLimitType]: info });
  return Object.entries(named).flatMap(([window, figure]) => {
    const rejected = (figure.status ?? info.status) === "rejected";
    if (figure.resetsAt === undefined || (figure.utilization === undefined && !rejected)) return [];
    const utilization = rejected ? 1 : (figure.utilization as number);
    return [{ window, utilization, resetsAt: new Date(figure.resetsAt * 1000).toISOString() }];
  });
}

function parseLine(line: string): StreamEvent | null {
  try {
    return JSON.parse(line) as StreamEvent;
  } catch {
    return null;
  }
}

export function summarizeStream(jsonl: string): ClaudeSummary {
  const summary: ClaudeSummary = {
    subtype: null,
    isError: false,
    costUsd: 0,
    turns: 0,
    result: null,
    blocked: [],
    failedTools: [],
    denied: [],
    durationMs: 0,
    apiMs: 0,
    usage: []
  };
  for (const line of jsonl.split("\n")) {
    const event = parseLine(line);
    if (event === null) continue;
    if (event.type === "result") {
      summary.subtype = event.subtype ?? null;
      summary.isError = event.is_error === true;
      summary.costUsd = event.total_cost_usd ?? 0;
      summary.turns = event.num_turns ?? 0;
      summary.result = event.result ?? null;
      summary.denied = (event.permission_denials ?? []).map(deniedCall);
      summary.durationMs = event.duration_ms ?? 0;
      summary.apiMs = event.duration_api_ms ?? 0;
      continue;
    }
    if (event.type === "rate_limit_event") {
      const usage = usageOf(event.rate_limit_info ?? { status: "allowed" });
      if (usage.length > 0) summary.usage = usage;
      continue;
    }
    for (const part of event.message?.content ?? []) {
      if (part.type !== "tool_result" || part.is_error !== true) continue;
      const text = textOf(part.content);
      (GUARD_MESSAGE.test(text) ? summary.blocked : summary.failedTools).push(text);
    }
  }
  return summary;
}
