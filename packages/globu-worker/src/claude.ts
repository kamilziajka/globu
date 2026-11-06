import { DENIED_TOOLS } from "./config.js";

export type RunSettings = { permissions: { allow: string[]; deny: string[] } };

export function runSettings(allowedTools: string[]): RunSettings {
  return { permissions: { allow: allowedTools, deny: DENIED_TOOLS } };
}

export type ClaudeInvocation = {
  prompt: string;
  settingsFile: string;
  runDir: string;
  turns: number;
  runUsd: number;
  model?: string;
  pluginDir?: string;
};

export function claudeArgs(invocation: ClaudeInvocation): string[] {
  return [
    "-p",
    invocation.prompt,
    "--permission-mode",
    "dontAsk",
    "--settings",
    invocation.settingsFile,
    "--add-dir",
    invocation.runDir,
    "--max-turns",
    String(invocation.turns),
    "--max-budget-usd",
    String(invocation.runUsd),
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

export type ClaudeSummary = {
  subtype: string | null;
  isError: boolean;
  costUsd: number;
  turns: number;
  result: string | null;
  blocked: string[];
  failedTools: string[];
};

type ToolResult = { type: string; content?: unknown; is_error?: boolean };
type StreamEvent = {
  type: string;
  subtype?: string;
  is_error?: boolean;
  total_cost_usd?: number;
  num_turns?: number;
  result?: string;
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
    failedTools: []
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
