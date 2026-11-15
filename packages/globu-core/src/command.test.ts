import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { commandTargets } from "./command.js";

const CWD = at("/work/home");

function at(posix: string): string {
  return path.resolve(posix);
}

function braced(name: string): string {
  return ["$", "{", name, "}"].join("");
}

function certain(source: string): string[] {
  const targets = commandTargets(source, CWD);
  expect(targets.every((target) => target.certain)).toBe(true);
  return targets.map((target) => target.path);
}

function possible(source: string): string[] {
  const targets = commandTargets(source, CWD);
  expect(targets.some((target) => target.certain)).toBe(false);
  return targets.map((target) => target.path);
}

describe("commandTargets", () => {
  it("finds nothing in commands that only read", () => {
    for (const source of [
      "ls ../other",
      "cat ../other/a.md | head -5",
      "grep -r foo ../other && wc -l ../other/a.md",
      "sed -n 1p ../other/a.md",
      "find ../other -name '*.md'",
      "sort ../other/a.txt",
      "FOO=1",
      "if test -f ../other/a; then echo yes; fi",
      "echo hi > /dev/null"
    ]) {
      expect(commandTargets(source, CWD).filter((target) => target.path.startsWith(at("/work/other")))).toEqual([]);
    }
  });

  it("treats redirects and file commands as certain writes", () => {
    expect(certain("rm -rf ../other/src a.txt")).toEqual([at("/work/other/src"), at("/work/home/a.txt")]);
    expect(certain("cp ../other/a.md ./b.md")).toEqual([at("/work/home/b.md")]);
    expect(certain("echo x > ../other/f")).toEqual([at("/work/other/f")]);
    expect(certain("if test -f x; then /bin/rm ../other/y; fi")).toEqual([at("/work/other/y")]);
    expect(certain("FOO=1 BAR=2 touch ../other/z")).toEqual([at("/work/other/z")]);
    expect(certain(`rm ~/x $HOME/y ${braced("HOME")}/z "$DIR/q" "" --target=../other/k`)).toEqual([
      path.join(os.homedir(), "x"),
      path.join(os.homedir(), "y"),
      path.join(os.homedir(), "z"),
      at("/work/other/k")
    ]);
    expect(certain('echo x > "$OUT"')).toEqual([]);
  });

  it("expands variables assigned in the same command", () => {
    expect(certain(`D=../other; rm $D/a ${braced("D")}/b`)).toEqual([at("/work/other/a"), at("/work/other/b")]);
    expect(certain("export OUT=../other/out && W=$OUT/deep; echo x > $W/f")).toEqual([at("/work/other/out/deep/f")]);
    expect(certain('D=../other bash -c "touch $D/f"')).toEqual([at("/work/other/f")]);
    expect(possible("export PATH")).toEqual([at("/work/home")]);
  });

  it("follows cd, pushd and nested shells", () => {
    expect(certain("cd ../other && touch f")).toEqual([at("/work/other/f")]);
    expect(certain("pushd ../other; mkdir -p a/b")).toEqual([at("/work/other/a/b")]);
    expect(certain('cd "$X" && rm a; cd; rm b')).toEqual([at("/work/home/a"), at("/work/home/b")]);
    expect(certain('bash -c "cd ../other && touch f"')).toEqual([at("/work/other/f")]);
    expect(certain("sh -c")).toEqual([]);
  });

  it("treats other commands as possible writes to their arguments and directory", () => {
    expect(possible("npm test")).toEqual([at("/work/home/test"), at("/work/home")]);
    expect(possible("cd ../other && npm test")).toEqual([at("/work/other/test"), at("/work/other")]);
    expect(possible("bash script.sh")).toEqual([at("/work/home/script.sh"), at("/work/home")]);
    expect(possible("sed -i s/a/b/ ../other/f")).toEqual([
      at("/work/home/s/a/b"),
      at("/work/other/f"),
      at("/work/home")
    ]);
    expect(possible("find ../other -delete")).toEqual([at("/work/other"), at("/work/home")]);
    expect(possible("sort -o out.txt in.txt")).toEqual([
      at("/work/home/out.txt"),
      at("/work/home/in.txt"),
      at("/work/home")
    ]);
    expect(possible("dd of=../other/img")).toEqual([at("/work/other/img"), at("/work/home")]);
  });

  it("separates git commands that read from those that change the repo", () => {
    for (const source of [
      "git status",
      "git -C ../other log --oneline",
      "git -c core.pager=cat --no-pager diff",
      "git branch --show-current",
      "git branch -a -vv",
      "git remote -v",
      "git remote get-url origin",
      "git stash list",
      "git tag -l 'v*'",
      "git config --get user.name",
      "git worktree list",
      "git --version",
      "git -C"
    ]) {
      expect(commandTargets(source, CWD)).toEqual([]);
    }
    expect(possible("git commit -m x")).toEqual([at("/work/home")]);
    expect(possible("git -C ../other pull")).toEqual([at("/work/other")]);
    expect(possible('git -C "$DIR" reset --hard')).toEqual([at("/work/home")]);
    expect(possible("git branch -D old")).toEqual([at("/work/home")]);
    expect(possible("git tag v1")).toEqual([at("/work/home")]);
    expect(possible("git worktree add ../x")).toEqual([at("/work/home")]);
  });
});
