import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { captureIo, tempDir } from "../../testing/index.js";
import { HELD_EXIT, type HoldDeps, hold, holderOf, NOT_STARTED_EXIT, parseResources } from "./hold.js";
import { LOCK_PIDS, lockDir, lockFile, withLockPid } from "./lock.js";

const CHILD = `
const fs = require("node:fs");
const [report, code] = process.argv.slice(1);
const dir = process.env.GLOBU_LOCK_DIR;
const locks = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
fs.writeFileSync(report, JSON.stringify({ locks, pids: process.env.GLOBU_LOCK_PIDS, cwd: process.cwd() }));
const go = report + ".go";
const timer = setInterval(() => {
  if (code !== "wait" || fs.existsSync(go)) {
    clearInterval(timer);
    process.exit(code === "wait" ? 0 : Number(code));
  }
}, 10);
`;

type Setup = { deps: HoldDeps; io: ReturnType<typeof captureIo>; signals: EventEmitter; dir: string; report: string };

function setup(overrides: Partial<HoldDeps> = {}): Setup {
  const cwd = tempDir();
  const io = captureIo(cwd);
  const signals = new EventEmitter();
  const deps: HoldDeps = {
    io,
    env: { ...process.env },
    signals,
    now: () => new Date("2026-11-15T10:00:00.000Z"),
    platform: "linux",
    pollMs: 10,
    ...overrides
  };
  return { deps, io, signals, dir: lockDir(deps.env), report: path.join(cwd, "report.json") };
}

function child(report: string, code: string): string[] {
  return [process.execPath, "-e", CHILD, report, code];
}

function plant(dir: string, name: string, lock: object): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = lockFile(dir, name);
  fs.writeFileSync(file, JSON.stringify(lock));
  return file;
}

async function until(check: () => boolean): Promise<void> {
  while (!check()) await new Promise((resolve) => setTimeout(resolve, 5));
}

const reportOf = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));

describe("parseResources and withLockPid", () => {
  it("splits on commas, drops repeats and refuses a name that is not a resource", () => {
    expect(parseResources("gpu")).toEqual(["gpu"]);
    expect(parseResources("gpu,disk,gpu")).toEqual(["gpu", "disk"]);
    expect(() => parseResources("../gpu")).toThrow('invalid resource "../gpu", a resource name is letters');
    expect(() => parseResources("gpu,")).toThrow('invalid resource ""');
  });

  it("names the holder by its command on one line of at most 60 characters", () => {
    expect(holderOf(["npm", "run", "render"])).toBe("globu-worker hold (npm run render)");
    expect(holderOf(["node", "-e", `\n  ${"x".repeat(70)}\n`])).toBe(
      `globu-worker hold (node -e ${"x".repeat(52)}...)`
    );
  });

  it("adds a pid to the ones already named", () => {
    expect(withLockPid({ A: "1" }, 7)).toEqual({ A: "1", [LOCK_PIDS]: "7" });
    expect(withLockPid({ [LOCK_PIDS]: "3" }, 7)).toEqual({ [LOCK_PIDS]: "3,7" });
  });
});

describe("hold", () => {
  it("runs the command with the locks taken, passes its exit code through and gives them back", async () => {
    const { deps, io, dir, report } = setup();
    expect(await hold(deps, "gpu,disk", child(report, "3"), {})).toBe(3);
    expect(reportOf(report)).toEqual({
      locks: ["disk.lock", "gpu.lock"],
      pids: String(process.pid),
      cwd: fs.realpathSync(io.cwd)
    });
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(io.stderr).toBe("");
  });

  it("fails at once and says by whom when a lock is held", async () => {
    const { deps, io, dir, report } = setup();
    const file = plant(dir, "gpu", { pid: process.pid, host: os.hostname(), holder: "klayboy render" });
    expect(await hold(deps, "disk,gpu", child(report, "0"), {})).toBe(HELD_EXIT);
    expect(io.stderr).toBe(
      `globu-worker: could not take gpu (held by klayboy render, pid ${process.pid} on ${os.hostname()})\n`
    );
    expect(fs.existsSync(report)).toBe(false);
    expect(fs.readdirSync(dir)).toEqual(["gpu.lock"]);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).holder).toBe("klayboy render");
  });

  it("refuses a duration it cannot read before touching a lock", async () => {
    const { deps, dir, report } = setup();
    await expect(hold(deps, "gpu", child(report, "0"), { wait: "soon" })).rejects.toThrow('invalid duration "soon"');
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("waits with --wait, says so once per holder and runs when the lock is free", async () => {
    const { deps, io, dir, report } = setup();
    const lock = { pid: process.pid, host: os.hostname() };
    const file = plant(dir, "gpu", { ...lock, holder: "klayboy render" });
    const done = hold(deps, "gpu", child(report, "0"), { wait: "1m" });
    await until(() => io.stderr.includes("waiting on"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    plant(dir, "gpu", { ...lock, holder: "klayboy export" });
    await until(() => io.stderr.includes("klayboy export"));
    fs.rmSync(file);
    expect(await done).toBe(0);
    const host = `pid ${process.pid} on ${os.hostname()}`;
    expect(io.stderr).toBe(
      `globu-worker: waiting on gpu (held by klayboy render, ${host})\n` +
        `globu-worker: waiting on gpu (held by klayboy export, ${host})\n`
    );
    expect(reportOf(report).locks).toEqual(["gpu.lock"]);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("gives up when --wait runs out", async () => {
    let clock = Date.parse("2026-11-15T10:00:00.000Z");
    const { deps, io, dir, report } = setup({
      now: () => {
        clock += 700;
        return new Date(clock);
      }
    });
    plant(dir, "gpu", { pid: process.pid, host: os.hostname() });
    expect(await hold(deps, "gpu", child(report, "0"), { wait: "2s" })).toBe(HELD_EXIT);
    const held = `gpu (held by another process, pid ${process.pid} on ${os.hostname()})`;
    expect(io.stderr).toBe(`globu-worker: waiting on ${held}\nglobu-worker: could not take ${held} within 2s\n`);
    expect(fs.existsSync(report)).toBe(false);
  });

  it("stops waiting on a signal without running the command", async () => {
    const { deps, io, dir, report, signals } = setup({ pollMs: 60_000 });
    plant(dir, "gpu", { pid: process.pid, host: os.hostname() });
    const done = hold(deps, "gpu", child(report, "0"), { wait: "1h" });
    await until(() => io.stderr.includes("waiting on"));
    signals.emit("SIGINT");
    expect(await done).toBe(130);
    expect(io.stderr).toContain("globu-worker: stopped by SIGINT while waiting on gpu (held by another process");
    expect(fs.existsSync(report)).toBe(false);
    expect(signals.listenerCount("SIGINT")).toBe(0);
  });

  it("leaves SIGINT to the terminal, forwards SIGTERM and exits as the command did", async () => {
    const { deps, dir, report, signals } = setup();
    const done = hold(deps, "gpu", child(report, "wait"), {});
    await until(() => fs.existsSync(report));
    signals.emit("SIGINT");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fs.existsSync(lockFile(dir, "gpu"))).toBe(true);
    signals.emit("SIGTERM");
    expect(await done).toBe(128 + os.constants.signals.SIGTERM);
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("forwards nothing on Windows, where the console signals the command itself", async () => {
    const { deps, dir, report, signals } = setup({ platform: "win32" });
    const done = hold(deps, "gpu", child(report, "wait"), {});
    await until(() => fs.existsSync(report));
    signals.emit("SIGTERM");
    signals.emit("SIGHUP");
    await new Promise((resolve) => setTimeout(resolve, 50));
    fs.writeFileSync(`${report}.go`, "");
    expect(await done).toBe(0);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("says when the command cannot start and gives the locks back", async () => {
    const { deps, io, dir } = setup();
    expect(await hold(deps, "gpu", ["globu-no-such-command"], {})).toBe(NOT_STARTED_EXIT);
    expect(io.stderr).toBe("globu-worker: could not start globu-no-such-command: not found on PATH\n");
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("counts a lock held by a process named in GLOBU_LOCK_PIDS on this machine as its own", async () => {
    const { deps, io, dir, report } = setup();
    const env = { ...deps.env, [LOCK_PIDS]: `1,${process.ppid}` };
    const gpu = plant(dir, "gpu", { pid: process.ppid, host: os.hostname(), holder: "globu-worker" });
    expect(await hold({ ...deps, env }, "gpu,disk", child(report, "0"), {})).toBe(0);
    expect(reportOf(report)).toMatchObject({
      locks: ["disk.lock", "gpu.lock"],
      pids: `1,${process.ppid},${process.pid}`
    });
    expect(fs.readdirSync(dir)).toEqual(["gpu.lock"]);
    expect(JSON.parse(fs.readFileSync(gpu, "utf8")).holder).toBe("globu-worker");

    plant(dir, "gpu", { pid: process.ppid, host: "render-box" });
    expect(await hold({ ...deps, env }, "gpu", child(report, "0"), {})).toBe(HELD_EXIT);
    expect(io.stderr).toBe(
      `globu-worker: could not take gpu (held by another process, pid ${process.ppid} on render-box)\n`
    );
  });
});
