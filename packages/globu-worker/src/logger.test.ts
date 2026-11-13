import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "../../testing/index.js";
import type { Runner } from "./exec.js";
import type { Fetch } from "./jira.js";
import {
  fileLogger,
  type Logger,
  log,
  logFile,
  loggedFetch,
  loggedRunner,
  parseLevel,
  redact,
  setLogger,
  silentLogger,
  tail
} from "./logger.js";

const DAY = new Date("2026-11-13T09:30:00.000Z");

function lines(dir: string): Record<string, unknown>[] {
  const file = logFile(dir, DAY);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

function memory(): { logger: Logger; entries: { level: string; msg: string; fields?: Record<string, unknown> }[] } {
  const entries: { level: string; msg: string; fields?: Record<string, unknown> }[] = [];
  const at = (level: string) => (msg: string, fields?: Record<string, unknown>) => entries.push({ level, msg, fields });
  return { logger: { error: at("error"), warn: at("warn"), info: at("info"), debug: at("debug") }, entries };
}

afterEach(() => setLogger(silentLogger));

describe("logger", () => {
  it("parses the four levels and refuses anything else", () => {
    expect(parseLevel("debug")).toBe("debug");
    expect(parseLevel("error")).toBe("error");
    expect(() => parseLevel("verbose")).toThrow('invalid log level "verbose", use error, warn, info, debug');
  });

  it("redacts secrets, their JSON-escaped form and git auth headers, but not short values", () => {
    const line = JSON.stringify({
      args: ["-c", "http.https://github.com/.extraheader=Authorization: Basic eC1hY2Nlc3M=", "fetch"],
      token: "ghp_abc123",
      quoted: 'pa"ss1',
      short: "abc"
    });
    const result = redact(line, ["ghp_abc123", 'pa"ss1', "abc"]);
    expect(result).not.toContain("ghp_abc123");
    expect(result).not.toContain("eC1hY2Nlc3M=");
    expect(result).not.toContain('pa\\"ss1');
    expect(result).toContain('"short":"abc"');
    expect(JSON.parse(result).args[1]).toBe("http.https://github.com/.extraheader=[redacted]");
  });

  it("keeps the last lines of a text", () => {
    expect(tail("a\nb\nc\nd\ne\nf\ng\n")).toBe("c\nd\ne\nf\ng");
    expect(tail("")).toBe("");
  });

  it("writes JSON lines to a file per day at and above its level, redacted", () => {
    const dir = path.join(tempDir(), "logs");
    const logger = fileLogger({ dir, level: "info", secrets: ["s3cret-token"], now: () => DAY });
    logger.debug("hidden");
    logger.info("cycle", { run: "MR-1-x", note: "uses s3cret-token" });
    logger.warn("cap");
    logger.error("failed");
    expect(logFile(dir, DAY)).toBe(path.join(dir, "worker-2026-11-13.log"));
    expect(lines(dir)).toEqual([
      { time: DAY.toISOString(), level: "info", msg: "cycle", run: "MR-1-x", note: "uses [redacted]" },
      { time: DAY.toISOString(), level: "warn", msg: "cap" },
      { time: DAY.toISOString(), level: "error", msg: "failed" }
    ]);
    const quiet = path.join(tempDir(), "logs");
    fileLogger({ dir: quiet, level: "error", secrets: [], now: () => DAY }).warn("dropped");
    expect(lines(quiet)).toEqual([]);
  });

  it("has a silent default that can be replaced", () => {
    expect(log()).toBe(silentLogger);
    silentLogger.error("x");
    silentLogger.warn("x");
    silentLogger.info("x");
    silentLogger.debug("x");
    const { logger, entries } = memory();
    setLogger(logger);
    log().info("hello");
    expect(entries).toEqual([{ level: "info", msg: "hello", fields: undefined }]);
  });

  it("logs every command a runner runs", async () => {
    const { logger, entries } = memory();
    const run: Runner = async () => ({ code: 1, stdout: "out", stderr: "one\ntwo\n", timedOut: false });
    const result = await loggedRunner(run, logger)("gh", ["api", "user"], { cwd: "/w" });
    expect(result.stdout).toBe("out");
    expect(entries[0].msg).toBe("command");
    expect(entries[0].fields).toMatchObject({
      command: "gh",
      args: ["api", "user"],
      cwd: "/w",
      code: 1,
      timedOut: false,
      stderr: "one\ntwo"
    });
    expect(typeof entries[0].fields?.ms).toBe("number");
    await loggedRunner(run, logger)("git", ["status"]);
    expect(entries[1].fields?.cwd).toBeUndefined();
  });

  it("logs every Jira call with its path and status or its error", async () => {
    const { logger, entries } = memory();
    const ok: Fetch = async () => new Response("{}", { status: 201 });
    const response = await loggedFetch(ok, logger)("https://acme.atlassian.net/rest/api/2/myself?x=1", {
      method: "GET"
    });
    expect(response.status).toBe(201);
    expect(entries[0]).toMatchObject({
      level: "debug",
      msg: "jira",
      fields: { method: "GET", path: "/rest/api/2/myself?x=1", status: 201 }
    });
    const broken: Fetch = async () => {
      throw new Error("offline");
    };
    await expect(
      loggedFetch(broken, logger)("https://acme.atlassian.net/rest/api/2/myself", { method: "GET" })
    ).rejects.toThrow("offline");
    expect(entries[1].fields).toMatchObject({ method: "GET", path: "/rest/api/2/myself", error: "offline" });
  });
});
