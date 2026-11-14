import { describe, expect, it } from "vitest";
import { claudeArgs, implementPrompt, summarizeStream } from "./claude.js";
import { DENIED_TOOLS } from "./config.js";

describe("claudeArgs", () => {
  it("builds the headless invocation, with a model and a plugin dir only when given", () => {
    const base = { prompt: "go", runDir: "/r", maxTurns: 80, maxBudgetUsd: 5, allowedTools: ["Read", "Edit"] };
    expect(claudeArgs(base)).toEqual([
      "-p",
      "go",
      "--permission-mode",
      "dontAsk",
      "--allowedTools",
      "Read",
      "Edit",
      "--disallowedTools",
      ...DENIED_TOOLS,
      "--add-dir",
      "/r",
      "--max-turns",
      "80",
      "--max-budget-usd",
      "5",
      "--output-format",
      "stream-json",
      "--verbose"
    ]);
    expect(claudeArgs({ ...base, model: "claude-opus-5-5" }).slice(-2)).toEqual(["--model", "claude-opus-5-5"]);
    expect(claudeArgs({ ...base, pluginDir: "/src/plugins/globu" }).slice(-2)).toEqual([
      "--plugin-dir",
      "/src/plugins/globu"
    ]);
    expect(implementPrompt("issue-deliver", "/r/brief.md", "/r/handback.md")).toBe(
      "Implement the issue described in /r/brief.md with the issue-deliver skill. Write the handback to /r/handback.md."
    );
  });
});

describe("summarizeStream", () => {
  const lines = [
    "not json",
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "working" }] } }),
    JSON.stringify({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            content: 'Edit blocked: belongs to shard "product", which is read-only',
            is_error: true
          },
          {
            type: "tool_result",
            content: [{ type: "text", text: "Permission to use Bash denied" }, { type: "image" }],
            is_error: true
          },
          { type: "tool_result", content: { odd: true }, is_error: true },
          { type: "tool_result", content: "fine" },
          { type: "text", text: "ignored" }
        ]
      }
    }),
    JSON.stringify({ type: "user", message: {} }),
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      total_cost_usd: 1.25,
      num_turns: 12,
      result: "done",
      duration_ms: 798_000,
      duration_api_ms: 228_000,
      permission_denials: [
        { tool_name: "Bash", tool_input: { command: "cat a.txt | wc -l" } },
        { tool_name: "Write", tool_input: { file_path: "/etc/x" } },
        { tool_name: "Task" }
      ]
    })
  ];

  it("collects the result and sorts failed tool calls into guard blocks and other failures", () => {
    expect(summarizeStream(lines.join("\n"))).toEqual({
      subtype: "success",
      isError: false,
      costUsd: 1.25,
      turns: 12,
      result: "done",
      blocked: ['Edit blocked: belongs to shard "product", which is read-only'],
      failedTools: ["Permission to use Bash denied", ""],
      denied: ["Bash: cat a.txt | wc -l", 'Write: {"file_path":"/etc/x"}', "Task: {}"],
      durationMs: 798_000,
      apiMs: 228_000
    });
  });

  it("tolerates a result without numbers and an empty stream", () => {
    expect(summarizeStream(JSON.stringify({ type: "result", is_error: true }))).toEqual({
      subtype: null,
      isError: true,
      costUsd: 0,
      turns: 0,
      result: null,
      blocked: [],
      failedTools: [],
      denied: [],
      durationMs: 0,
      apiMs: 0
    });
    expect(summarizeStream("").turns).toBe(0);
  });
});
