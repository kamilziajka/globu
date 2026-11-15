import { describe, expect, it } from "vitest";
import { fieldWarnings, footnoteLabels, lifecycleOf, parseInstant } from "./fields.js";

const HINT = "an ISO 8601 datetime with an offset, such as 2026-11-05T08:00:00Z";
const ACTOR = "an actor: <producer>/<version>, human:<id> or process:<id>";

describe("parseInstant", () => {
  it("reads datetimes with an offset", () => {
    expect(parseInstant("2026-11-05T08:00:00Z")).toBe(Date.UTC(2026, 10, 5, 8));
    expect(parseInstant("2026-11-05T09:30+01:00")).toBe(Date.UTC(2026, 10, 5, 8, 30));
    expect(parseInstant("2026-11-05T03:00:00-0500")).toBe(Date.UTC(2026, 10, 5, 8));
    expect(parseInstant("2026-11-05T10:00:00.5+02")).toBe(Date.UTC(2026, 10, 5, 8, 0, 0, 500));
    expect(parseInstant("2026-11-05T08:00:00.123456Z")).toBe(Date.UTC(2026, 10, 5, 8, 0, 0, 123));
  });

  it("rejects dates, missing offsets, impossible values and non-strings", () => {
    for (const value of [
      "2026-11-05",
      "2026-11-05T08:00:00",
      "2026-02-30T08:00:00Z",
      "2026-13-01T08:00:00Z",
      "2026-11-05T24:00:00Z",
      "2026-11-05T08:60:00Z",
      "2026-11-05T08:00:60Z",
      "2026-11-05T08:00:00+24:00",
      "2026-11-05T08:00:00+01:60",
      "soon",
      20270101,
      null
    ]) {
      expect(parseInstant(value), String(value)).toBeNull();
    }
  });
});

describe("fieldWarnings", () => {
  it("says nothing about a doc without the optional families", () => {
    expect(fieldWarnings({ type: "Note", title: "x" }, "Body with a footnote.[^1]\n\n[^1]: A note.\n")).toEqual([]);
  });

  it("accepts the families in their v0.2 shape", () => {
    const data = {
      type: "Research",
      sources: [
        { id: "okf", resource: "https://example.com/spec", last_modified: "2026-05-30T00:00:00Z" },
        {
          resource: "all queries in project X",
          usage_window: { from: "2026-06-01T00:00:00Z", to: "2026-06-30T00:00:00Z" }
        }
      ],
      usage_window: { from: "2026-06-01T00:00:00Z", to: "2026-06-30T00:00:00Z" },
      generated: { by: "claude-code/claude-opus-5-5", at: "2026-11-05T08:00:00Z" },
      verified: [
        { by: "human:Kamil Ziajka", at: "2026-11-06T09:30:00+01:00" },
        { by: "process:ci", at: "2026-11-07T00:00:00Z" }
      ],
      status: "stable",
      stale_after: "2027-05-01T00:00:00Z"
    };
    const body =
      "A claim.[^okf]\n\n```md\nA sample [^sample] in a fence.\n```\n\nAnd `[^inline]` in code.\n\n[^okf]: The spec.\n";
    expect(fieldWarnings(data, body)).toEqual([]);
    expect(fieldWarnings({ type: "Note", verified: { by: "human:kazet", at: "2026-11-06T09:30:00Z" } }, "")).toEqual(
      []
    );
    expect(fieldWarnings({ type: "Note", generated: { by: "globu/1.2.0" } }, "")).toEqual([]);
  });

  it("names the field of every malformed provenance entry", () => {
    expect(fieldWarnings({ sources: "https://example.com" }, "")).toEqual([
      "`sources` should be a list of entries with a `resource`"
    ]);
    const data = {
      sources: [
        "https://example.com",
        { id: "a", title: "no resource" },
        { id: 7, resource: " ", last_modified: "2026-05-30" },
        { id: "b", resource: "x", usage_window: "June" },
        { id: "c", resource: "x", usage_window: { from: "2026-06-01T00:00:00Z" } }
      ],
      usage_window: { from: "June", to: "2026-06-30T00:00:00Z" }
    };
    expect(fieldWarnings(data, "Cited.[^a] Unknown.[^missing] Again.[^missing]\n")).toEqual([
      `\`usage_window.from\` should be ${HINT}, got "June"`,
      "`sources[0]` should be a mapping with a `resource`",
      "`sources[1]` has no `resource`",
      "`sources[2]` has no `resource`",
      "`sources[2].id` should be a string",
      `\`sources[2].last_modified\` should be ${HINT}, got "2026-05-30"`,
      "`sources[3].usage_window` should be a mapping with `from` and `to`",
      "`sources[4].usage_window.to` is missing",
      "footnote `[^missing]` matches no `sources[].id`"
    ]);
  });

  it("names the field of malformed trust values", () => {
    expect(fieldWarnings({ generated: "claude" }, "")).toEqual(["`generated` should be a mapping with `by` and `at`"]);
    expect(fieldWarnings({ generated: { at: "2026-11-05" } }, "")).toEqual([
      "`generated.by` is missing",
      `\`generated.at\` should be ${HINT}, got "2026-11-05"`
    ]);
    expect(fieldWarnings({ generated: { by: "kazet", at: "2026-11-05T08:00:00Z" } }, "")).toEqual([
      `\`generated.by\` should be ${ACTOR}, got "kazet"`
    ]);
    expect(fieldWarnings({ verified: "2026-10-09" }, "")).toEqual([
      '`verified` should be a mapping or a list of `{ by, at }`, got "2026-10-09"'
    ]);
    expect(fieldWarnings({ verified: { by: "human:kazet" } }, "")).toEqual(["`verified.at` is missing"]);
    expect(fieldWarnings({ verified: ["kazet", { by: 3, at: "2026-11-05T08:00:00Z" }] }, "")).toEqual([
      "`verified[0]` should be a mapping with `by` and `at`",
      `\`verified[1].by\` should be ${ACTOR}, got 3`
    ]);
  });

  it("names the field of malformed lifecycle values", () => {
    expect(fieldWarnings({ status: "open", stale_after: "2027-04-01" }, "")).toEqual([
      '`status` should be draft, stable or deprecated, got "open"',
      `\`stale_after\` should be ${HINT}, got "2027-04-01"`
    ]);
    expect(fieldWarnings({ status: "deprecated", stale_after: 2027 }, "")).toEqual([
      `\`stale_after\` should be ${HINT}, got 2027`
    ]);
  });
});

describe("footnoteLabels", () => {
  it("lists each label once and skips code", () => {
    expect(footnoteLabels("One[^a], two[^b], again[^a].\n\n~~~\n[^c]\n~~~\n\n``[^d]``\n\n[^a]: x\n")).toEqual([
      "a",
      "b"
    ]);
  });
});

describe("lifecycleOf", () => {
  const now = Date.UTC(2026, 10, 15);

  it("marks docs at or past stale_after and deprecated docs", () => {
    expect(lifecycleOf({ stale_after: "2026-11-15T00:00:00Z" }, now)).toEqual(["stale"]);
    expect(lifecycleOf({ stale_after: "2026-01-01T00:00:00Z", status: "deprecated" }, now)).toEqual([
      "stale",
      "deprecated"
    ]);
    expect(lifecycleOf({ status: "deprecated" }, now)).toEqual(["deprecated"]);
  });

  it("leaves fresh docs and unreadable stale_after alone", () => {
    expect(lifecycleOf({ stale_after: "2026-11-15T00:00:01Z", status: "draft" }, now)).toEqual([]);
    expect(lifecycleOf({ stale_after: "2020-01-01" }, now)).toEqual([]);
    expect(lifecycleOf({}, now)).toEqual([]);
  });
});
