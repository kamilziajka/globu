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
      apiMs: 228_000,
      segments: 1,
      usage: []
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
      apiMs: 0,
      segments: 1,
      usage: []
    });
    expect(summarizeStream("").turns).toBe(0);
  });

  it("sums the turns and durations of a run that was woken for its background tasks", () => {
    const segment = (turns: number, ms: number, apiMs: number, cost: number, denials: string[] = []) =>
      JSON.stringify({
        type: "result",
        subtype: "success",
        num_turns: turns,
        duration_ms: ms,
        duration_api_ms: apiMs,
        total_cost_usd: cost,
        result: `after ${turns}`,
        permission_denials: denials.map((command) => ({ tool_name: "Bash", tool_input: { command } }))
      });
    const woken = [
      segment(62, 357_625, 105_097, 1.41),
      segment(1, 1_267, 106_328, 1.43),
      JSON.stringify({ type: "result", subtype: "success" }),
      segment(17, 286_612, 209_648, 2.25)
    ];
    expect(summarizeStream(woken.join("\n"))).toMatchObject({
      turns: 80,
      durationMs: 645_504,
      apiMs: 209_648,
      costUsd: 2.25,
      segments: 4,
      result: "after 17"
    });

    const cumulative = [segment(1, 1, 1, 1, ["a"]), segment(1, 1, 1, 1, ["a", "b"])];
    expect(summarizeStream(cumulative.join("\n")).denied).toEqual(["Bash: a", "Bash: b"]);
    const perSegment = [segment(1, 1, 1, 1, ["a", "b"]), segment(1, 1, 1, 1, ["c"])];
    expect(summarizeStream(perSegment.join("\n")).denied).toEqual(["Bash: a", "Bash: b", "Bash: c"]);
  });

  it("keeps the subscription windows of the latest rate limit event that has any", () => {
    const event = (info?: Record<string, unknown>) =>
      JSON.stringify({ type: "rate_limit_event", rate_limit_info: info, uuid: "u", session_id: "s" });
    const recorded = {
      status: "allowed",
      resetsAt: 1794619800,
      rateLimitType: "five_hour",
      overageStatus: "rejected",
      overageDisabledReason: "org_level_disabled",
      isUsingOverage: false,
      unifiedWindows: {
        five_hour: { utilization: 0.08, resetsAt: 1794619800, status: "allowed" },
        seven_day: { utilization: 0.6, resetsAt: 1794708000, status: "allowed" },
        seven_day_opus: { resetsAt: 1794708000 },
        overage: { utilization: 0.1 }
      }
    };
    const stream = [
      event({ status: "allowed", rateLimitType: "five_hour", utilization: 0.5, resetsAt: 1 }),
      event(recorded)
    ];
    expect(summarizeStream([...stream, event(), event({ status: "allowed" })].join("\n")).usage).toEqual([
      { window: "five_hour", utilization: 0.08, resetsAt: "2026-11-14T01:30:00.000Z" },
      { window: "seven_day", utilization: 0.6, resetsAt: "2026-11-15T02:00:00.000Z" }
    ]);
    const rejected = event({ status: "rejected", rateLimitType: "five_hour", resetsAt: 1794619800 });
    expect(summarizeStream(rejected).usage).toEqual([
      { window: "five_hour", utilization: 1, resetsAt: "2026-11-14T01:30:00.000Z" }
    ]);
    const windowRejected = event({
      status: "allowed",
      unifiedWindows: { seven_day: { status: "rejected", resetsAt: 1794708000 } }
    });
    expect(summarizeStream(windowRejected).usage[0].utilization).toBe(1);
  });
});
