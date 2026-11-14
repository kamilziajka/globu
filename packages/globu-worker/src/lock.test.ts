import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../../testing/index.js";
import { exclusiveHold, isStale, lockDir, lockFile, readLock, running } from "./lock.js";

const NOW = new Date("2026-11-14T10:00:00.000Z");
const now = () => NOW;

function deadPid(): number {
  return spawnSync(process.execPath, ["-e", ""]).pid as number;
}

function plant(dir: string, name: string, content: unknown): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = lockFile(dir, name);
  fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  return file;
}

describe("lockDir", () => {
  it("is ~/.globu/locks unless GLOBU_LOCK_DIR says otherwise", () => {
    expect(lockDir({})).toBe(path.join(os.homedir(), ".globu", "locks"));
    expect(lockDir({ GLOBU_LOCK_DIR: "/tmp/locks" })).toBe(path.resolve("/tmp/locks"));
    expect(lockDir()).toBe(process.env.GLOBU_LOCK_DIR);
  });
});

describe("readLock and isStale", () => {
  it("reads a valid lock and calls one stale only when its pid is gone on this host", () => {
    const dir = tempDir();
    expect(readLock(path.join(dir, "missing.lock"))).toBeNull();
    expect(readLock(plant(dir, "bad", "not json"))).toBeNull();
    expect(readLock(plant(dir, "shape", { pid: "x" }))).toBeNull();
    const lock = { pid: process.pid, host: os.hostname() };
    expect(readLock(plant(dir, "ok", { ...lock, extra: 1 }))).toEqual(lock);
    expect(running(process.pid)).toBe(true);
    expect(running(deadPid())).toBe(false);
    expect(isStale(null)).toBe(false);
    expect(isStale(lock)).toBe(false);
    expect(isStale({ pid: deadPid(), host: os.hostname() })).toBe(true);
    expect(isStale({ pid: deadPid(), host: "another-machine" })).toBe(false);
  });
});

describe("exclusiveHold", () => {
  it("takes every named lock, refuses a second holder and releases only its own", () => {
    const dir = path.join(tempDir(), "locks");
    const first = exclusiveHold(["gpu", "disk"], dir, "globu-worker", now);
    expect(first.take()).toBeNull();
    expect(first.take()).toBeNull();
    expect(JSON.parse(fs.readFileSync(lockFile(dir, "gpu"), "utf8"))).toEqual({
      pid: process.pid,
      host: os.hostname(),
      holder: "globu-worker",
      since: NOW.toISOString()
    });
    const second = exclusiveHold(["gpu"], dir, "other", now);
    const held = `gpu (held by globu-worker, pid ${process.pid} on ${os.hostname()} since ${NOW.toISOString()})`;
    expect(second.take()).toBe(held);
    expect(second.busy()).toBe(held);
    second.release();
    expect(fs.existsSync(lockFile(dir, "gpu"))).toBe(true);
    first.release();
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(second.busy()).toBeNull();
    expect(second.take()).toBe(held);
  });

  it("gives back what it took when a later lock is held", () => {
    const dir = tempDir();
    plant(dir, "disk", { pid: process.pid, host: "render-box" });
    const hold = exclusiveHold(["gpu", "disk"], dir, "globu-worker", now);
    expect(hold.take()).toBe(`disk (held by another process, pid ${process.pid} on render-box)`);
    expect(fs.existsSync(lockFile(dir, "gpu"))).toBe(false);
    expect(fs.existsSync(lockFile(dir, "disk"))).toBe(true);
  });

  it("replaces a stale lock and treats an unreadable one as held", () => {
    const dir = tempDir();
    plant(dir, "gpu", { pid: deadPid(), host: os.hostname(), holder: "klayboy render" });
    const hold = exclusiveHold(["gpu"], dir, "globu-worker", now);
    expect(hold.busy()).toBeNull();
    expect(hold.take()).toBeNull();
    expect(readLock(lockFile(dir, "gpu"))?.pid).toBe(process.pid);
    hold.release();

    const file = plant(dir, "gpu", "");
    const blocked = exclusiveHold(["gpu"], dir, "globu-worker", now);
    expect(blocked.take()).toBe(`gpu (${file} is there but holds no readable lock)`);
    expect(blocked.busy()).toBe(`gpu (${file} is there but holds no readable lock)`);
  });

  it("leaves a lock alone on release when it no longer names this process", () => {
    const dir = tempDir();
    const hold = exclusiveHold(["gpu"], dir, "globu-worker", now);
    expect(hold.take()).toBeNull();
    const file = plant(dir, "gpu", "{");
    hold.release();
    expect(fs.readFileSync(file, "utf8")).toBe("{");
  });

  it("touches nothing without names", () => {
    const dir = path.join(tempDir(), "locks");
    const hold = exclusiveHold([], dir, "globu-worker", now);
    expect(hold.take()).toBeNull();
    expect(hold.busy()).toBeNull();
    hold.release();
    expect(fs.existsSync(dir)).toBe(false);
  });
});
