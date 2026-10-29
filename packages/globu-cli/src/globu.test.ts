import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { claudeSettingsPath, clonesDir, manifestPath, statePath } from "../../globu-core/src/index.js";
import {
  addWorktree,
  baseIndex,
  captureIo,
  commitAll,
  type GitServer,
  git,
  initRepo,
  read,
  serveGit,
  tempDir,
  write
} from "../../testing/index.js";
import { globuMain } from "./globu.js";

let sandbox: string;
let server: GitServer | null = null;

function run(argv: string[], input: unknown = "", cwd = sandbox) {
  const io = captureIo(cwd, input);
  return { code: globuMain(argv, io), out: io.stdout, err: io.stderr };
}

function json(argv: string[]) {
  return JSON.parse(run([...argv, "--json"]).out);
}

function localRepo(name: string, files: Record<string, string> = { "README.md": `${name}\n` }): string {
  return initRepo(path.join(sandbox, "work", name), files);
}

function remoteRepo(name: string): string {
  return `file://${initRepo(path.join(sandbox, "remotes", name), { "README.md": `${name}\n` })}`;
}

beforeEach(() => {
  sandbox = tempDir();
});

afterEach(async () => {
  await server?.close();
  server = null;
});

describe("globu help", () => {
  it("describes the commands and where the config lives", () => {
    const help = run(["--help"]);
    expect(help.code).toBe(0);
    expect(help.out).toMatch(
      /^Usage: globu \[options\] \[command\]\n\nKnowledge bases and a knowledge registry for Claude Code\.\n/
    );
    expect(help.out).toContain("register [options] <locator>");
    expect(help.out).toContain("Config lives in ~/.globu (override with GLOBU_HOME).");
    expect(run(["--version"]).out).toMatch(/^\d+\.\d+\.\d+\n$/);
    expect(run(["help", "context"]).out).toContain("set [options] <name> <patterns...>");
  });
});

describe("globu register, show and list", () => {
  it("registers a local repo and prints what it found", () => {
    const repo = localRepo("notes", { "docs/index.md": baseIndex("notes", "Team notes") });
    const result = run(["register", "work/notes", "--use-when", "Team questions"]);
    expect(result).toEqual({
      code: 0,
      err: "",
      out: [
        "registered notes",
        "id:          notes",
        "repo:        (local only)",
        "format:      okf",
        "mode:        write",
        `path:        ${repo}`,
        "owner:       user",
        "description: Team notes",
        "use when:    Team questions",
        "roots:",
        "  docs (entry: docs/index.md)",
        "note: this repo has no origin remote, so other machines cannot sync it",
        ""
      ].join("\n")
    });
    expect(run(["list"]).out).toBe(`notes\tokf\twrite\t${repo}\n`);
    expect(json(["show", "notes"]).path).toBe(repo);
  });

  it("registers a URL and hints at missing routing text", () => {
    const url = remoteRepo("handbook");
    const result = run(["register", url, "--id", "hb"]);
    expect(result.out).toContain("registered hb\n");
    expect(result.out).toContain(`repo:        ${url}\n`);
    expect(result.out).toContain("description: -\nuse when:    -\n");
    expect(result.out).toContain("note: add routing text with `globu set hb --description ... --use-when ...`\n");
    expect(result.out).not.toContain("no origin remote");

    const editable = run(["register", url, "--path", "work/hb", "--mode", "read", "--description", "x"]).out;
    expect(editable).toContain("attached hb\n");
    expect(editable).toContain(`removed the read-only clone it replaces at ${path.join(clonesDir(), "hb")}\n`);
    expect(json(["show", "hb"])).toMatchObject({ owner: "user", mode: "read" });
  });

  it("shows shards in every local state", () => {
    const repo = localRepo("a", { "notes.txt": "no readme" });
    run(["register", repo, "--description", "d", "--use-when", "u"]);
    run(["set", "a", "--access", "read"]);
    expect(run(["show", "a"]).out).toContain("mode:        read (capped by manifest)\n");
    expect(run(["show", "a"]).out).toContain("roots:\n  .\n");

    fs.rmSync(repo, { recursive: true });
    expect(run(["list"]).out).toBe(`a\tgeneric\tread\t${repo} (missing)\n`);
    fs.rmSync(statePath());
    expect(run(["show", "a"]).out).toContain("path:        (not synced)\nowner:       -\n");
  });

  it("shows the worktree a session runs in", () => {
    const repo = localRepo("notes", { "docs/index.md": baseIndex("notes") });
    const worktree = addWorktree(repo, path.join(sandbox, "elsewhere"), "feature");
    expect(run(["register", "."], "", worktree).out).toContain(`path:        ${repo}\n`);

    expect(run(["list"], "", worktree).out).toBe(`notes\tokf\twrite\t${repo}\tthis session: ${worktree}\n`);
    expect(JSON.parse(run(["list", "--json"], "", worktree).out).shards).toMatchObject([
      { id: "notes", path: repo, workPath: worktree, here: true }
    ]);
    expect(json(["list"]).shards).toMatchObject([{ path: repo, workPath: repo, here: false }]);
    expect(run(["index"], "", worktree).out).toContain(`  - Entry: notes: ${worktree}/docs/index.md`);
    expect(run(["hook", "session-start"], { cwd: worktree }).out).toContain(`  - Location: ${worktree} (this session`);
  });

  it("rejects bad arguments", () => {
    expect(run(["register"]).err).toBe("error: missing required argument 'locator'\n");
    expect(run(["register", ".", "--mode", "admin"]).err).toBe(
      "error: option '--mode <mode>' argument 'admin' is invalid. Allowed choices are read, ask, write.\n"
    );
    expect(run(["set", "x", "--access", "ask"]).err).toBe(
      "error: option '--access <access>' argument 'ask' is invalid. Allowed choices are read, write.\n"
    );
    expect(run(["show"]).err).toBe("error: missing required argument 'id'\n");
    expect(run(["show", "nope"]).err).toBe('globu: no shard registered with id "nope"\n');
    expect(run(["list"]).out).toBe("no shards registered\n");
  });
});

describe("globu set, reprobe, unregister and sync", () => {
  it("updates, reprobes and removes a shard", () => {
    const repo = localRepo("svc");
    run(["register", repo]);
    expect(
      run(["set", "svc", "--description", "Service", "--use-when", "Service work", "--mode", "read"]).out
    ).toContain("mode:        read\n");
    expect(run(["set", "svc", "--access", "nope"]).code).toBe(1);

    expect(run(["reprobe", "svc"]).out.startsWith("unchanged\n")).toBe(true);
    write(repo, "docs/index.md", baseIndex("svc"));
    const preview = run(["reprobe", "svc", "--dry-run"]).out;
    expect(preview).toMatch(
      /^would update\nformat: generic -> okf\nroots: {2}\. \(entry: README\.md\) -> docs \(entry: docs\/index\.md\)\n/
    );
    expect(preview).toContain("format:      okf\n");
    expect(preview.endsWith("nothing written, run again without --dry-run to apply\n")).toBe(true);
    expect(run(["show", "svc"]).out).toContain("format:      generic\n");
    expect(run(["reprobe", "svc"]).out.startsWith("updated\nformat: generic -> okf\n")).toBe(true);
    const plain = localRepo("plain", { "notes.txt": "x" });
    run(["register", plain]);
    write(plain, "docs/index.md", baseIndex("plain"));
    expect(run(["reprobe", "plain", "--dry-run"]).out).toContain("roots:  . -> docs (entry: docs/index.md)\n");
    run(["unregister", "plain"]);
    expect(run(["sync"])).toMatchObject({ code: 0, out: "fetched\tsvc\n" });

    expect(run(["unregister", "svc", "--purge"]).out).toBe("unregistered svc, clone left in place\n");
    expect(run(["unregister"]).err).toBe("error: missing required argument 'id'\n");
    expect(run(["sync"]).out).toBe("no shards registered\n");
  });

  it("reports unregister outcomes and sync errors", () => {
    const url = remoteRepo("handbook");
    run(["register", url]);
    fs.rmSync(statePath());
    expect(run(["unregister", "handbook"]).out).toBe("unregistered handbook\n");

    run(["register", url]);
    fs.rmSync(url.slice("file://".length), { recursive: true });
    const failed = run(["sync"]);
    expect(failed.code).toBe(1);
    expect(failed.out).toMatch(/^error\thandbook\tgit pull --ff-only failed/);
    expect(run(["unregister", "handbook", "--purge"]).out).toBe("unregistered handbook, clone removed\n");
  });
});

describe("globu import", () => {
  it("previews, applies and refreshes a team manifest", () => {
    const url = remoteRepo("notes");
    const teamDir = path.join(sandbox, "team");
    const shard = {
      id: "notes",
      source: { type: "git", repo: url },
      format: "generic",
      roots: [{ path: ".", entry: "README.md" }],
      description: "Notes",
      useWhen: "Notes questions"
    };
    write(teamDir, ".globu/manifest.yaml", YAML.stringify({ shards: [shard], contexts: { team: ["notes"] } }));
    const plan = [teamDir, "  added:    notes", "  updated:  -", "  contexts: team", "active context: team"];
    const claudeHint =
      "next: `globu claude sync` adds the clones to the Claude settings, so Claude reads them without a prompt";
    const nextSteps = [
      "next: `globu register <path>` for each added repo that is already cloned on this machine, so that clone is attached editable instead of a second copy",
      `next: \`globu sync\` clones the rest read-only under ${clonesDir()}`,
      claudeHint
    ];

    expect(run(["import", "team", "--context", "team"])).toEqual({
      code: 0,
      err: "",
      out: [...plan, "nothing written, apply with: globu import team --context team --yes", ""].join("\n")
    });
    expect(run(["import", "team", "--file", ".globu/manifest.yaml", "--sync"])).toMatchObject({
      code: 1,
      err: "globu: --sync needs --yes, nothing is cloned for a preview\n"
    });
    expect(run(["import", "team", "--file", ".globu/manifest.yaml"]).out).toContain(
      "apply with: globu import team --file .globu/manifest.yaml --context team --yes\n"
    );
    expect(run(["list"]).out).toBe("no shards registered\n");
    expect(json(["import", "team"])).toMatchObject({
      applied: false,
      context: null,
      suggestedContext: "team",
      synced: null,
      plans: [{ file: null, ref: null, commit: null }]
    });

    expect(run(["import", "team", "--context", "team", "--yes"]).out).toBe(
      [...plan, `written to ${manifestPath()}`, ...nextSteps, ""].join("\n")
    );
    expect(run(["list"]).out).toBe("context: team\nnotes\tgeneric\tread\t(not synced)\n");
    expect(run(["sync"]).out).toBe(`cloned\tnotes\n${claudeHint}\n`);
    expect(run(["import"]).out).toContain("nothing written, apply with: globu import --yes\n");
    expect(run(["import", "--yes"]).out).toBe(
      [teamDir, "  added:    -", "  updated:  -", "  contexts: team", `written to ${manifestPath()}`, ""].join("\n")
    );
    expect(run(["import", "team", "--file", ".globu/manifest.yaml"]).out).toMatch(
      /^.*team \(\.globu\/manifest\.yaml\)\n/
    );

    write(teamDir, ".globu/manifest.yaml", YAML.stringify({ shards: [{ ...shard, description: "Team notes" }] }));
    expect(run(["import", "--yes"]).out).toBe(
      [teamDir, "  added:    -", "  updated:  notes", "  contexts: -", `written to ${manifestPath()}`, ""].join("\n")
    );
    expect(run(["show", "notes"]).out).toContain("description: Team notes\n");
  });

  it("clones right after the import with --sync and shows the commit it read", () => {
    const teamDir = initRepo(path.join(sandbox, "team"));
    const shards = [
      { id: "notes", source: { type: "git", repo: remoteRepo("notes") }, format: "generic", roots: [{ path: "." }] },
      { id: "gone", source: { type: "git", repo: "file:///nowhere/gone" }, format: "generic", roots: [{ path: "." }] }
    ];
    write(teamDir, ".globu/manifest.yaml", YAML.stringify({ shards, contexts: { team: ["notes", "gone"] } }));
    commitAll(teamDir);
    const commit = git(teamDir, "rev-parse", "HEAD").slice(0, 7);

    expect(run(["import", "team"]).out).toContain(
      `  commit:   ${commit}\nnothing written, apply with: globu import team --context team --yes\n`
    );
    const result = run(["import", "team", "--yes", "--sync"]);
    expect(result.code).toBe(1);
    expect(result.out).toContain("note: the team manifest defines the context team, `globu use team` activates it\n");
    expect(result.out).toContain("cloned\tnotes\nerror\tgone\tgit ");
    expect(result.out).toContain("next: `globu claude sync` adds the clones");
    expect(result.out).not.toContain("globu register <path>");
    expect(run(["list", "--all"]).out).toContain(`notes\tgeneric\tread\t${path.join(clonesDir(), "notes")}\n`);

    write(teamDir, ".globu/manifest.yaml", YAML.stringify({ shards: [shards[0]], contexts: { team: ["notes"] } }));
    commitAll(teamDir);
    const next = git(teamDir, "rev-parse", "HEAD").slice(0, 7);
    expect(run(["import", "--yes"]).out).toContain(`  commit:   ${next} (was ${commit})\n`);
    expect(run(["import", "team", "--yes", "--sync"])).toMatchObject({
      code: 1,
      out: expect.stringContaining("error\tgone")
    });
  });

  it("imports from a link to the manifest file inside a repo", async () => {
    const root = path.join(sandbox, "served");
    const shard = {
      id: "notes",
      source: { type: "git", repo: remoteRepo("notes") },
      format: "generic",
      roots: [{ path: "." }]
    };
    initRepo(path.join(root, "team.git"), { "manifests/team.yaml": YAML.stringify({ shards: [shard] }) });
    server = await serveGit(root, null);
    const base = server.url("team.git");

    const preview = run(["import", `${base}/-/blob/main/manifests/team.yaml`]).out;
    expect(preview.startsWith(`${base} (manifests/team.yaml) at main\n  added:    notes\n`)).toBe(true);
    expect(preview).toContain(`apply with: globu import ${base}/-/blob/main/manifests/team.yaml --yes\n`);
    expect(run(["import", `${base}/-/blob/main/manifests/team.yaml`, "--yes"]).code).toBe(0);
    expect(json(["show", "notes"])).toMatchObject({ source: { repo: shard.source.repo } });
  });

  it("rejects bad arguments", () => {
    expect(run(["import", "--file", "x.yaml"]).err).toBe("globu: --file needs a path or a repo URL to read it from\n");
    expect(run(["import"]).err).toBe("globu: nothing to import: give a path or a repo URL\n");
    expect(run(["import", "missing.yaml"])).toMatchObject({ code: 1, err: expect.stringMatching(/no manifest at/) });
  });
});

describe("globu contexts", () => {
  it("defines, selects and removes contexts", () => {
    run(["register", localRepo("team-api")]);
    run(["register", localRepo("private")]);
    expect(run(["context", "list"]).out).toBe("no contexts defined, every shard is active\n");

    expect(run(["context", "set", "work", "team-*"]).out).toBe("context work: team-*\n");
    run(["context", "set", "personal", "private"]);
    expect(run(["use", "work"]).out).toBe("active context: work\n");
    expect(run(["context", "list"]).out).toBe("* work\tteam-*\n  personal\tprivate\n");
    expect(run(["list"]).out).toMatch(/^context: work\nteam-api\t/);
    expect(json(["list", "--all"])).toMatchObject({ context: null, shards: [{ id: "team-api" }, { id: "private" }] });

    expect(run(["use", "--all"]).out).toBe("active context: all shards\n");
    expect(run(["context", "rm", "personal"]).out).toBe("removed context personal\n");
    expect(json(["context", "list"])).toEqual({ current: null, contexts: { work: ["team-*"] } });
  });

  it("rejects bad arguments", () => {
    expect(run(["use"]).err).toBe("globu: use needs a context name, or --all\n");
    expect(run(["context", "set"]).code).toBe(1);
    expect(run(["context", "set", "work"]).err).toBe("error: missing required argument 'patterns'\n");
    expect(run(["context", "nope", "x"]).err).toBe("error: unknown command 'nope'\n");
    expect(run(["context"])).toMatchObject({ code: 1, err: expect.stringMatching(/^Usage: globu context /) });
  });
});

describe("globu index, doctor and claude sync", () => {
  it("prints the index and the diagnostics", () => {
    expect(run(["index"]).out).toBe("\n");
    expect(run(["doctor"])).toEqual({ code: 0, out: "no problems found\n", err: "" });

    const repo = localRepo("notes");
    run(["register", repo, "--description", "d", "--use-when", "u"]);
    expect(run(["index"], "", repo).out).toContain("- **notes** (generic, writable, you are working inside it)");
    expect(json(["index"]).context).toBeNull();
    expect(run(["doctor"])).toMatchObject({ code: 0, out: expect.stringContaining("warning\tnotes\tno repo URL") });

    fs.rmSync(repo, { recursive: true });
    expect(run(["doctor"])).toMatchObject({ code: 1, out: expect.stringContaining("error\tnotes\tclone is missing") });
  });

  it("syncs shard paths into the Claude settings", () => {
    const repo = localRepo("notes");
    run(["register", repo]);
    expect(run(["claude", "sync"]).out).toBe(`updated ${claudeSettingsPath()}\n${repo}\n`);
    expect(run(["unregister", "notes"]).out).toBe(
      "unregistered notes, clone left in place\nnext: `globu claude sync` removes its path from the Claude settings\n"
    );
    run(["register", repo]);
    expect(run(["claude", "sync"]).out).toBe(`unchanged ${claudeSettingsPath()}\n${repo}\n`);
    expect(run(["claude", "sync", "--remove"]).out).toBe(`updated ${claudeSettingsPath()}\n`);
    expect(JSON.parse(read(claudeSettingsPath()))).toEqual({ permissions: { additionalDirectories: [] } });
    expect(run(["claude"])).toMatchObject({ code: 1, err: expect.stringMatching(/^Usage: globu claude /) });
  });
});

describe("globu resolve", () => {
  it("reports each reference and the index of the shards it touched", () => {
    const repo = localRepo("notes", { "docs/index.md": baseIndex("notes", "Team notes"), "docs/a.md": "a\n" });
    run(["register", repo]);

    const found = run(["resolve", "notes/docs/a.md"]);
    expect(found.code).toBe(0);
    expect(found.out).toMatch(
      new RegExp(`^ok\\tnotes/docs/a\\.md\\t${repo}/docs/a\\.md\\n\\n# Globu knowledge shards\\n`)
    );
    expect(found.out).toContain("## Formats\n- **okf**:");

    const missing = run(["resolve", "notes/docs/a.md", "notes/docs/b.md"]);
    expect(missing.code).toBe(1);
    expect(missing.out).toContain('\nfail\tnotes/docs/b.md\tnot on HEAD of shard "notes"\n');

    const moved = run(["resolve", "notes/a.md"]);
    expect(moved.out).toMatch(
      /^fail\tnotes\/a\.md\tnot on HEAD of shard "notes"\nsimilar\tnotes\/a\.md\tnotes\/docs\/a\.md\n\n/
    );
    expect(json(["resolve", "notes/docs/b.md"])).toMatchObject({
      ok: false,
      context: null,
      shards: ["notes"],
      refs: [{ ref: "notes/docs/b.md", ok: false, revision: "HEAD", candidates: [] }],
      index: expect.stringContaining("- **notes** (okf, writable)")
    });
  });

  it("prints no index when no shard is touched", () => {
    expect(run(["resolve", "x.md"])).toEqual({
      code: 1,
      err: "",
      out: 'fail\tx.md\tno shard is registered as "x.md" and the current directory is not in a git repo\n'
    });
    expect(run(["resolve"]).err).toBe("error: missing required argument 'refs'\n");
  });
});

describe("globu hook session-start", () => {
  it("prints nothing without shards and the index with them", () => {
    expect(run(["hook", "session-start"], { cwd: sandbox })).toEqual({ code: 0, out: "", err: "" });
    const repo = localRepo("notes");
    run(["register", repo, "--mode", "read"]);
    expect(run(["hook", "session-start"], { cwd: repo }).out).toContain(
      "- **notes** (generic, read-only, you are working inside it)"
    );
    expect(run(["hook", "session-start"], "").out).toContain("- **notes** (generic, read-only)");
  });

  it("explains a broken manifest instead of failing", () => {
    write(path.dirname(manifestPath()), "manifest.yaml", "shards: [unclosed\n");
    const result = run(["hook", "session-start"], {});
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/^Globu could not load its shard index: .*not valid YAML/);
  });
});

describe("globu hook guard", () => {
  it("blocks edits inside read-only shards only", () => {
    const repo = localRepo("notes");
    run(["register", repo, "--mode", "read"]);
    const blocked = run(["hook", "guard"], { cwd: repo, tool_input: { file_path: "docs/new.md" } });
    expect(blocked.code).toBe(2);
    expect(blocked.err).toContain(`${path.join(repo, "docs/new.md")} belongs to shard "notes", which is read-only`);
    expect(run(["hook", "guard"], { tool_input: { notebook_path: path.join(repo, "a.ipynb") } }).code).toBe(2);

    expect(run(["hook", "guard"], { tool_input: { file_path: path.join(sandbox, "elsewhere.md") } }).code).toBe(0);
    run(["set", "notes", "--mode", "write"]);
    expect(run(["hook", "guard"], { tool_input: { file_path: path.join(repo, "a.md") } }).code).toBe(0);
  });

  it("blocks edits in any worktree of a read-only shard", () => {
    const repo = localRepo("notes");
    const worktree = addWorktree(repo, path.join(sandbox, "elsewhere"), "feature");
    run(["register", repo, "--mode", "read"]);
    const blocked = run(["hook", "guard"], { cwd: worktree, tool_input: { file_path: "new/dir/a.md" } });
    expect(blocked.code).toBe(2);
    expect(blocked.err).toContain('belongs to shard "notes", which is read-only');
  });

  it("asks before edits to an ask shard from another repo", () => {
    const repo = localRepo("notes");
    const worktree = addWorktree(repo, path.join(sandbox, "elsewhere"), "feature");
    const other = localRepo("other");
    const file = path.join(repo, "docs/a.md");
    run(["register", repo, "--mode", "ask"]);

    const asked = run(["hook", "guard"], { cwd: other, tool_input: { file_path: file } });
    expect(asked).toMatchObject({ code: 0, err: "" });
    expect(JSON.parse(asked.out)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: expect.stringContaining(`${file} belongs to shard "notes", which asks before edits`)
      }
    });

    const silent = { code: 0, out: "", err: "" };
    expect(run(["hook", "guard"], { cwd: repo, tool_input: { file_path: file } })).toEqual(silent);
    expect(run(["hook", "guard"], { cwd: worktree, tool_input: { file_path: "a.md" } })).toEqual(silent);

    process.env.CLAUDE_PROJECT_DIR = worktree;
    expect(run(["hook", "guard"], { cwd: other, tool_input: { file_path: file } })).toEqual(silent);
    process.env.CLAUDE_PROJECT_DIR = other;
    expect(run(["hook", "guard"], { cwd: repo, tool_input: { file_path: file } }).out).toContain('"ask"');
  });

  it("reads shell commands for a read-only shard", () => {
    const repo = localRepo("notes");
    const other = localRepo("other");
    run(["register", repo, "--mode", "read"]);
    const bash = (command: string, cwd = other) => run(["hook", "guard"], { cwd, tool_input: { command } });

    const denied = bash(`rm ${repo}/a.md`);
    expect(denied.code).toBe(2);
    expect(denied.err).toContain(
      `this command writes to ${repo}/a.md, which belongs to shard "notes". That shard is read-only on this machine. Do not edit it.`
    );
    expect(bash(`node tool.js ${repo}/data; echo x > ${repo}/out.txt`).code).toBe(2);
    expect(bash("touch a.md", repo).code).toBe(2);

    const asked = bash(`node tool.js ${repo}/data`);
    expect(asked.code).toBe(0);
    expect(JSON.parse(asked.out).hookSpecificOutput).toMatchObject({
      permissionDecision: "ask",
      permissionDecisionReason: expect.stringContaining(
        `this command may change ${repo}/data, which belongs to shard "notes". That shard is read-only on this machine. Approve only if the command does not modify it.`
      )
    });

    const silent = { code: 0, out: "", err: "" };
    expect(bash("npm test", repo)).toEqual(silent);
    expect(bash(`cat ${repo}/README.md && git -C ${repo} log`)).toEqual(silent);
    expect(bash("rm a.md")).toEqual(silent);
  });

  it("reads shell commands for an ask shard", () => {
    const repo = localRepo("notes");
    const other = localRepo("other");
    run(["register", repo, "--mode", "ask"]);
    const bash = (command: string, cwd = other) => run(["hook", "guard"], { cwd, tool_input: { command } });

    const written = bash(`echo x > ${repo}/out.txt`);
    expect(written.code).toBe(0);
    expect(JSON.parse(written.out).hookSpecificOutput.permissionDecisionReason).toContain(
      `this command writes to ${repo}/out.txt, which belongs to shard "notes". That shard asks before edits from sessions in other repos.`
    );
    expect(bash(`cd ${repo} && npm test`).out).toContain(`this command may change ${repo}/test, which`);
    process.env.CLAUDE_PROJECT_DIR = other;
    expect(bash("npm test", repo).out).toContain('"ask"');

    const silent = { code: 0, out: "", err: "" };
    process.env.CLAUDE_PROJECT_DIR = repo;
    expect(bash("npm test && rm a.md", repo)).toEqual(silent);
    expect(bash(`rm ${repo}/a.md`)).toEqual(silent);
    delete process.env.CLAUDE_PROJECT_DIR;
    expect(bash(`ls ${repo}`)).toEqual(silent);
    expect(bash(`D=${repo}; rm $D/a.md`).out).toContain(`this command writes to ${repo}/a.md`);
  });

  it("stays out of the way when it has nothing to check", () => {
    expect(run(["hook", "guard"], { tool_input: {} }).code).toBe(0);
    expect(run(["hook", "guard"], "").code).toBe(0);
    run(["register", remoteRepo("handbook")]);
    fs.rmSync(statePath());
    expect(run(["hook", "guard"], { tool_input: { file_path: "/tmp/a.md" } }).code).toBe(0);
    write(path.dirname(manifestPath()), "manifest.yaml", "shards: [unclosed\n");
    expect(run(["hook", "guard"], { tool_input: { file_path: "/tmp/a.md" } }).code).toBe(0);
  });

  it("rejects unknown hooks", () => {
    expect(run(["hook", "other"])).toEqual({ code: 1, out: "", err: "error: unknown command 'other'\n" });
    expect(run(["hook"])).toMatchObject({ code: 1, err: expect.stringMatching(/^Usage: globu hook /) });
  });
});
