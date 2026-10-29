import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import {
  baseIndex,
  commitAll,
  type GitServer,
  git,
  initRepo,
  read,
  serveGit,
  tempDir,
  write
} from "../../testing/index.js";
import { importManifests } from "./import.js";
import { loadManifest, type Manifest, saveManifest } from "./manifest.js";
import { clonesDir, manifestPath, statePath } from "./paths.js";
import { register, resolveActive, sync } from "./registry.js";
import { loadState } from "./state.js";

let sandbox: string;
let server: GitServer | null = null;

type TeamShard = { id: string; repo: string | null; access?: "read"; description?: string };

function teamManifest(shards: TeamShard[], contexts: Record<string, string[]> = {}): string {
  return YAML.stringify({
    version: 1,
    shards: shards.map((shard) => ({
      id: shard.id,
      source: { type: "git", repo: shard.repo },
      format: "okf",
      roots: [{ path: "docs", name: shard.id, entry: "docs/index.md" }],
      description: shard.description ?? `${shard.id} docs`,
      useWhen: `${shard.id} questions`,
      ...(shard.access ? { access: shard.access } : {})
    })),
    contexts
  });
}

function remoteRepo(name: string, files: Record<string, string> = { "docs/index.md": baseIndex(name) }): string {
  return `file://${initRepo(path.join(sandbox, "remotes", name), files)}`;
}

function run(locator: string | undefined, options: { file?: string; context?: string; apply?: boolean } = {}) {
  return importManifests({ locator, ...options, apply: options.apply ?? true, cwd: sandbox });
}

beforeEach(() => {
  sandbox = tempDir();
});

afterEach(async () => {
  await server?.close();
  server = null;
});

describe("import from a file", () => {
  it("previews without writing and applies with --yes", () => {
    const product = remoteRepo("product");
    const backend = remoteRepo("backend");
    const file = write(
      sandbox,
      "team.yaml",
      teamManifest(
        [
          { id: "product", repo: product },
          { id: "backend", repo: backend, access: "read" }
        ],
        {
          team: ["product", "backend"]
        }
      )
    );

    const preview = run("team.yaml", { apply: false, context: "team" });
    expect(preview).toEqual({
      applied: false,
      manifestPath: manifestPath(),
      context: "team",
      suggestedContext: null,
      plans: [
        {
          source: file,
          file: null,
          ref: null,
          commit: null,
          previousCommit: null,
          added: ["product", "backend"],
          updated: [],
          contexts: ["team"]
        }
      ]
    });
    expect(fs.existsSync(manifestPath())).toBe(false);

    const applied = run("team.yaml", { context: "team" });
    expect(applied.applied).toBe(true);
    expect(loadManifest()).toMatchObject({
      shards: [
        { id: "product", source: { repo: product }, description: "product docs" },
        { id: "backend", source: { repo: backend }, access: "read" }
      ],
      contexts: { team: ["product", "backend"] },
      imports: [{ source: file }]
    });
    expect(loadState().current).toBe("team");
    expect(resolveActive().shards.map((shard) => shard.present)).toEqual([false, false]);

    expect(sync()).toEqual([
      { id: "product", action: "cloned" },
      { id: "backend", action: "cloned" }
    ]);
    expect(read(clonesDir(), "backend", "docs/index.md")).toBe(baseIndex("backend"));
    expect(resolveActive().shards.map((shard) => shard.mode)).toEqual(["read", "read"]);
  });

  it("reads the default file inside a directory and refreshes recorded imports", () => {
    const product = remoteRepo("product");
    const dir = path.join(sandbox, "team-repo");
    write(dir, ".globu/manifest.yaml", teamManifest([{ id: "product", repo: product, access: "read" }]));

    expect(run(dir).plans[0]).toMatchObject({ source: dir, added: ["product"] });
    expect(run(dir).plans[0]).toMatchObject({ added: [], updated: [], contexts: [] });

    write(dir, ".globu/manifest.yaml", teamManifest([{ id: "product", repo: product, description: "Product truth" }]));
    const refreshed = run(undefined);
    expect(refreshed.plans).toEqual([
      {
        source: dir,
        file: null,
        ref: null,
        commit: null,
        previousCommit: null,
        added: [],
        updated: ["product"],
        contexts: []
      }
    ]);
    expect(loadManifest().shards[0]).toMatchObject({ description: "Product truth" });
    expect(loadManifest().shards[0].access).toBeUndefined();
    expect(loadManifest().imports).toEqual([{ source: dir }]);

    write(
      dir,
      ".globu/manifest.yaml",
      teamManifest([{ id: "product", repo: product, access: "read", description: "Capped" }])
    );
    expect(run(undefined).plans[0].updated).toEqual(["product"]);
    expect(loadManifest().shards[0]).toMatchObject({ description: "Capped", access: "read" });
  });

  it("takes --file for another file in the directory and keeps one record per source", () => {
    const dir = path.join(sandbox, "team-repo");
    write(dir, "manifests/work.yaml", teamManifest([{ id: "notes", repo: remoteRepo("notes") }]));
    expect(run(dir, { file: "manifests/work.yaml" }).plans[0]).toMatchObject({
      file: "manifests/work.yaml",
      added: ["notes"]
    });
    write(dir, ".globu/manifest.yaml", teamManifest([{ id: "other", repo: remoteRepo("other") }]));
    expect(run(dir).plans[0].added).toEqual(["other"]);
    expect(loadManifest().imports).toEqual([{ source: dir }]);
  });

  it("keeps local shards and leaves them where the team manifest agrees", () => {
    const notes = remoteRepo("notes");
    register({ locator: notes, cwd: sandbox, dest: "work/notes", mode: "ask" });
    register({ locator: initRepo(path.join(sandbox, "work/private")), cwd: sandbox });

    write(sandbox, "team.yaml", teamManifest([{ id: "notes", repo: notes }]));
    expect(run("team.yaml").plans[0]).toMatchObject({ added: [], updated: ["notes"] });
    expect(run("team.yaml").plans[0]).toMatchObject({ added: [], updated: [] });
    expect(resolveActive().shards.map((shard) => `${shard.id}:${shard.mode}:${shard.path}`)).toEqual([
      `notes:ask:${path.join(sandbox, "work/notes")}`,
      `private:write:${path.join(sandbox, "work/private")}`
    ]);
  });
});

describe("import conflicts", () => {
  it("refuses ids and repos that clash with local shards", () => {
    const notes = remoteRepo("notes");
    register({ locator: notes, cwd: sandbox });
    write(sandbox, "same-id.yaml", teamManifest([{ id: "notes", repo: remoteRepo("elsewhere") }]));
    expect(() => run("same-id.yaml")).toThrow(/id "notes" is taken by file:/);

    write(sandbox, "same-repo.yaml", teamManifest([{ id: "team-notes", repo: notes }]));
    expect(() => run("same-repo.yaml")).toThrow(/already registered as "notes"/);

    register({ locator: initRepo(path.join(sandbox, "work/local")), cwd: sandbox });
    write(sandbox, "local-id.yaml", teamManifest([{ id: "local", repo: remoteRepo("local") }]));
    expect(() => run("local-id.yaml")).toThrow(/id "local" is taken by a local repo/);

    write(sandbox, "no-repo.yaml", teamManifest([{ id: "x", repo: null }]));
    expect(() => run("no-repo.yaml")).toThrow(/shard "x" in .* has no repo URL/);
    expect(loadManifest().shards).toHaveLength(2);
  });

  it("explains missing files, unknown contexts and misuse", () => {
    expect(() => run("missing.yaml")).toThrow(/no manifest at .*missing\.yaml/);
    expect(() => run(sandbox)).toThrow(/no manifest at .*\.globu\/manifest\.yaml/);
    expect(() => run(undefined)).toThrow(/nothing to import/);
    expect(() => run(undefined, { file: "x" })).toThrow(/--file needs a path or a repo URL/);

    write(sandbox, "team.yaml", teamManifest([{ id: "notes", repo: remoteRepo("notes") }], { team: ["notes"] }));
    expect(() => run("team.yaml", { context: "ghost" })).toThrow(/unknown context "ghost" \(known: team\)/);
    write(sandbox, "bare.yaml", teamManifest([]));
    expect(() => run("bare.yaml", { context: "ghost" })).toThrow(/unknown context "ghost" \(known: none\)/);
    expect(fs.existsSync(manifestPath())).toBe(false);
    expect(fs.existsSync(statePath())).toBe(false);
  });

  it("ignores the imports of the team manifest itself", () => {
    const team: Manifest = {
      version: 1,
      shards: [],
      contexts: {},
      imports: [{ source: path.join(sandbox, "nested.yaml") }]
    };
    write(sandbox, "team.yaml", YAML.stringify(team));
    expect(run("team.yaml").plans[0]).toMatchObject({ added: [] });
    expect(loadManifest().imports).toEqual([{ source: path.join(sandbox, "team.yaml") }]);
  });
});

describe("import from a repo", () => {
  it("clones the repo, reads the manifest and discards the clone", () => {
    const notes = remoteRepo("notes");
    const teamDir = path.join(sandbox, "remotes/team");
    initRepo(teamDir, { ".globu/manifest.yaml": teamManifest([{ id: "notes", repo: notes }], { work: ["notes"] }) });
    const url = `file://${teamDir}`;

    const first = git(teamDir, "rev-parse", "HEAD");
    expect(run(url).plans[0]).toEqual({
      source: url,
      file: null,
      ref: null,
      commit: first,
      previousCommit: null,
      added: ["notes"],
      updated: [],
      contexts: ["work"]
    });
    expect(loadManifest().imports).toEqual([{ source: url, commit: first }]);
    expect(fs.existsSync(clonesDir())).toBe(false);

    write(teamDir, "other.yaml", teamManifest([{ id: "other", repo: remoteRepo("other") }]));
    commitAll(teamDir);
    const second = git(teamDir, "rev-parse", "HEAD");
    expect(run(url, { file: "other.yaml" }).plans[0]).toMatchObject({
      added: ["other"],
      commit: second,
      previousCommit: first
    });
    expect(loadManifest().imports).toEqual([{ source: url, file: "other.yaml", commit: second }]);
    expect(run(teamDir).plans[0]).toMatchObject({ source: teamDir, commit: second, previousCommit: null });
    expect(() => run(url, { file: "nope.yaml" })).toThrow(/no manifest at nope\.yaml in file:/);
  });

  it("splits a link to a file inside a repo into repo, ref and file", async () => {
    const root = path.join(sandbox, "served");
    const notes = remoteRepo("notes");
    const teamDir = initRepo(path.join(root, "team.git"), {
      ".globu/manifest.yaml": teamManifest([{ id: "notes", repo: notes }], { work: ["notes"] })
    });
    git(teamDir, "checkout", "-q", "-b", "draft");
    write(teamDir, "manifests/draft.yaml", teamManifest([{ id: "draft", repo: remoteRepo("draft") }]));
    commitAll(teamDir);
    git(teamDir, "checkout", "-q", "main");
    const served = await serveGit(root, null);
    server = served;
    const base = served.url("team.git");

    expect(run(`${base}/-/blob/main/.globu/manifest.yaml`).plans[0]).toMatchObject({
      source: base,
      file: ".globu/manifest.yaml",
      ref: "main",
      added: ["notes"],
      contexts: ["work"]
    });
    expect(run(`${base}/blob/draft/manifests/draft.yaml?ref_type=heads`).plans[0]).toMatchObject({
      ref: "draft",
      added: ["draft"]
    });
    expect(loadManifest().imports).toEqual([
      { source: base, file: "manifests/draft.yaml", ref: "draft", commit: git(teamDir, "rev-parse", "draft") }
    ]);
    expect(run(undefined).plans[0]).toMatchObject({ source: base, ref: "draft", added: [], updated: [] });

    expect(() => run(`${base}/-/blob/nope/x.yaml`)).toThrow(/could not clone .* at "nope"[\s\S]*--file x\.yaml/);
    expect(() => run(`${base}/blob/main/x.yaml`, { file: "y.yaml" })).toThrow(/--file cannot be combined/);
  });

  it("uses the token for http clones and pulls", async () => {
    const root = path.join(sandbox, "served");
    initRepo(path.join(root, "notes.git"), { "docs/index.md": baseIndex("notes") });
    initRepo(path.join(root, "team.git"), {
      ".globu/manifest.yaml": teamManifest([{ id: "notes", repo: "http://127.0.0.1:1/notes.git" }])
    });
    const expected = `Basic ${Buffer.from("x-access-token:secret").toString("base64")}`;
    const git = await serveGit(root, expected);
    server = git;
    const notesUrl = git.url("notes.git");

    expect(() => run(git.url("team.git"))).toThrow(/git .*clone.* failed/);
    expect(git.requests()).toEqual(["GET /team.git/info/refs?service=git-upload-pack -"]);

    process.env.GLOBU_GIT_TOKEN = "secret";
    expect(run(git.url("team.git")).plans[0].added).toEqual(["notes"]);
    const team = loadManifest();
    team.shards[0].source.repo = notesUrl;
    saveManifest(team);
    expect(sync()).toEqual([{ id: "notes", action: "cloned" }]);
    expect(sync()).toEqual([{ id: "notes", action: "pulled" }]);
    const authenticated = git.requests().slice(1);
    expect(authenticated.length).toBeGreaterThan(2);
    expect(authenticated.every((line) => line.endsWith(expected))).toBe(true);

    delete process.env.GLOBU_GIT_TOKEN;
    expect(sync()[0]).toMatchObject({ action: "error", error: expect.stringMatching(/pull --ff-only failed/) });
  });
});
