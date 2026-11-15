import path from "node:path";
import { Option } from "commander";
import {
  type Access,
  clonesDir,
  commandTargets,
  DEFAULT_IMPORT_FILE,
  doctor,
  guardVerdict,
  type ImportPlan,
  type ImportResult,
  importManifests,
  locate,
  type Mode,
  projectShards,
  type RefResult,
  type ReprobeResult,
  type ResolvedShard,
  register,
  removeProject,
  renderIndex,
  reprobe,
  resolveActive,
  resolveAll,
  resolveRefs,
  type SessionShard,
  type SyncEntry,
  sessionHome,
  setProject,
  sync,
  syncClaudeDirectories,
  unregister,
  updateShard,
  useProject,
  type Verdict
} from "../../globu-core/src/index.js";
import { VERSION } from "../../knowledge-base/src/index.js";
import { defineBaseCommands, validateEditHook } from "./base.js";
import { command, type Io, type JsonOption, print, readHookInput, runCli } from "./cli/index.js";

const PROGRAM = {
  name: "globu",
  description: "Knowledge bases and a knowledge registry for Claude Code.",
  version: VERSION
};

const FOOTER = `
Config lives in ~/.globu (override with GLOBU_HOME). GLOBU_CONTEXT names the project for one process, whatever repo the session starts in.
GLOBU_GIT_TOKEN makes the clones globu makes and pulls go over https with that token.`;

const MODES: Mode[] = ["read", "ask", "write"];
const ACCESS: Access[] = ["read", "write"];

function choiceOption(flags: string, description: string, choices: string[]): Option {
  return new Option(flags, description).choices(choices);
}

function location(shard: ResolvedShard): string {
  if (shard.path === null) return "(not synced)";
  return shard.present ? shard.path : `${shard.path} (missing)`;
}

function listLine(shard: SessionShard): string {
  const session = shard.workPath === shard.path ? [] : [`this session: ${shard.workPath}`];
  return [shard.id, shard.format, shard.mode, location(shard), ...session].join("\t");
}

function shardDetails(shard: ResolvedShard): string {
  return [
    `id:          ${shard.id}`,
    `repo:        ${shard.source.repo ?? "(local only)"}`,
    `format:      ${shard.format}`,
    `mode:        ${shard.mode}${shard.access === "read" ? " (capped by manifest)" : ""}`,
    `path:        ${location(shard)}`,
    `owner:       ${shard.owner ?? "-"}`,
    `description: ${shard.description || "-"}`,
    `use when:    ${shard.useWhen || "-"}`,
    "roots:",
    ...shard.roots.map((root) => `  ${root.path}${root.entry === undefined ? "" : ` (entry: ${root.entry})`}`)
  ].join("\n");
}

function guardReason({ decision, shard, target }: Verdict, viaCommand: boolean): string {
  const subject = viaCommand
    ? `this command ${target.certain ? "writes to" : "may change"} ${target.path}, which belongs to shard "${shard.id}". That shard`
    : `${target.path} belongs to shard "${shard.id}", which`;
  if (decision === "deny") {
    return `globu: ${subject} is read-only on this machine. Do not edit it. If the user wants it editable, they can run \`globu set ${shard.id} --mode write\` (user-owned clones only).`;
  }
  if (shard.mode === "read") {
    return `globu: ${subject} is read-only on this machine. Approve only if the command does not modify it.`;
  }
  return `globu: ${subject} asks before edits from sessions in other repos. Approve only if you want this session to change it.`;
}

const CLAUDE_SYNC_HINT =
  "next: `globu claude sync` adds the clones to the Claude settings, so Claude reads them without a prompt";

function shortCommit(commit: string): string {
  return commit.slice(0, 7);
}

function importPlanLines(plan: ImportPlan): string[] {
  const at = plan.ref === null ? "" : ` at ${plan.ref}`;
  const lines = [
    `${plan.source}${plan.file === null ? "" : ` (${plan.file})`}${at}`,
    `  added:    ${plan.added.join(", ") || "-"}`,
    `  updated:  ${plan.updated.join(", ") || "-"}`,
    `  projects: ${plan.projects.join(", ") || "-"}`
  ];
  if (plan.commit !== null) {
    const was =
      plan.previousCommit === null || plan.previousCommit === plan.commit
        ? ""
        : ` (was ${shortCommit(plan.previousCommit)})`;
    lines.push(`  commit:   ${shortCommit(plan.commit)}${was}`);
  }
  return lines;
}

type ImportArgs = { locator?: string; file?: string; project?: string; context?: string; sync?: boolean };

function applyCommand(args: ImportArgs, result: ImportResult): string {
  const project = result.context ?? result.suggestedContext;
  return [
    "globu import",
    ...(args.locator === undefined ? [] : [args.locator]),
    ...(args.file === undefined ? [] : [`--file ${args.file}`]),
    ...(project === null ? [] : [`--project ${project}`]),
    "--yes"
  ].join(" ");
}

function syncLines(report: SyncEntry[]): string[] {
  return report.map((entry) => [entry.action, entry.id, ...(entry.error ? [entry.error] : [])].join("\t"));
}

function importText(args: ImportArgs, result: ImportResult, synced: SyncEntry[] | null): string {
  const lines = result.plans.flatMap(importPlanLines);
  if (result.context !== null) lines.push(`active project: ${result.context}`);
  if (!result.applied) {
    lines.push(`nothing written, apply with: ${applyCommand(args, result)}`);
    return lines.join("\n");
  }
  lines.push(`written to ${result.manifestPath}`);
  if (result.suggestedContext !== null) {
    lines.push(
      `note: the team manifest defines the project ${result.suggestedContext}, \`globu use ${result.suggestedContext}\` pins it for every session`
    );
  }
  const added = result.plans.some((plan) => plan.added.length > 0);
  if (synced !== null) {
    lines.push(...syncLines(synced));
    if (synced.some((entry) => entry.action === "cloned")) lines.push(CLAUDE_SYNC_HINT);
  } else if (added) {
    lines.push(
      "next: `globu register <path>` for each added repo that is already cloned on this machine, so that clone is attached editable instead of a second copy",
      `next: \`globu sync\` clones the rest read-only under ${clonesDir()}`,
      CLAUDE_SYNC_HINT
    );
  }
  return lines.join("\n");
}

function rootsText(shard: { roots: ResolvedShard["roots"] }): string {
  return shard.roots
    .map((root) => `${root.path}${root.entry === undefined ? "" : ` (entry: ${root.entry})`}`)
    .join(", ");
}

function reprobeText(result: ReprobeResult): string {
  const verb = result.changed ? (result.applied ? "updated" : "would update") : "unchanged";
  const lines = [verb];
  const { previous, probed } = result;
  if (probed.format !== previous.format) lines.push(`format: ${previous.format} -> ${probed.format}`);
  if (JSON.stringify(probed.roots) !== JSON.stringify(previous.roots)) {
    lines.push(`roots:  ${rootsText(previous)} -> ${rootsText(probed)}`);
  }
  lines.push(shardDetails({ ...result.shard, format: result.probed.format, roots: result.probed.roots }));
  if (result.changed && !result.applied) lines.push("nothing written, run again without --dry-run to apply");
  return lines.join("\n");
}

const CANDIDATE_LABEL = { rename: "renamed", name: "similar" };

function refLines(result: RefResult): string[] {
  if (result.ok) return [`ok\t${result.ref}\t${result.location}`];
  return [
    `fail\t${result.ref}\t${result.reason}`,
    ...result.candidates.map((candidate) => `${CANDIDATE_LABEL[candidate.match]}\t${result.ref}\t${candidate.ref}`)
  ];
}

const UNREGISTER_SUFFIX = { none: "", kept: ", clone left in place", removed: ", clone removed" };

export function globuMain(argv: string[], io: Io): number {
  return runCli(
    PROGRAM,
    (program, exit) => {
      program.addHelpText("after", FOOTER);

      command(program, "register <locator>", "register a git repo as a shard, from a local path or a repo URL")
        .option("--id <id>", "shard id, defaults to the repo name")
        .addOption(choiceOption("--mode <mode>", "whether this machine may edit the shard", MODES))
        .option("--path <dir>", "where to clone a repo URL, or where its clone already is")
        .option("--description <text>", "what the shard contains")
        .option("--use-when <text>", "when Claude should consult the shard")
        .action(
          (
            locator: string,
            options: JsonOption & { id?: string; mode?: Mode; path?: string; description?: string; useWhen?: string }
          ) => {
            const result = register({
              locator,
              cwd: io.cwd,
              id: options.id,
              mode: options.mode,
              dest: options.path,
              description: options.description,
              useWhen: options.useWhen
            });
            const lines = [`${result.action} ${result.shard.id}`, shardDetails(result.shard)];
            if (result.replaced !== null) lines.push(`removed the read-only clone it replaces at ${result.replaced}`);
            if (!result.portable) {
              lines.push("note: this repo has no origin remote, so other machines cannot sync it");
            }
            if (!result.shard.description || !result.shard.useWhen) {
              lines.push(
                `note: add routing text with \`globu set ${result.shard.id} --description ... --use-when ...\``
              );
            }
            print(io, options.json, result, lines.join("\n"));
          }
        );

      command(program, "unregister <id>", "remove a shard from the manifest and the local state")
        .option("--purge", "also delete a clone that globu owns")
        .action((id: string, options: JsonOption & { purge?: boolean }) => {
          const result = unregister(id, options.purge === true);
          const lines = [`unregistered ${result.id}${UNREGISTER_SUFFIX[result.clone]}`];
          if (result.claudeListed) lines.push("next: `globu claude sync` removes its path from the Claude settings");
          print(io, options.json, result, lines.join("\n"));
        });

      command(program, "list", "list the shards of this session's project")
        .option("--all", "list every shard, whatever the project")
        .action((options: JsonOption & { all?: boolean }) => {
          const { context, shards: resolved } = options.all
            ? { ...resolveAll(), context: null }
            : resolveActive(io.cwd);
          const shards = locate(resolved, io.cwd);
          const lines = shards.map(listLine);
          if (lines.length === 0) lines.push("no shards registered");
          if (context !== null) lines.unshift(`project: ${context}`);
          print(io, options.json, { context, shards }, lines.join("\n"));
        });

      command(program, "show <id>", "show everything known about one shard").action(
        (id: string, options: JsonOption) => {
          const shard = resolveAll().shards.find((candidate) => candidate.id === id);
          if (!shard) throw new Error(`no shard registered with id "${id}"`);
          print(io, options.json, shard, shardDetails(shard));
        }
      );

      command(program, "set <id>", "edit a shard's routing text, local mode or access cap")
        .option("--description <text>", "what the shard contains")
        .option("--use-when <text>", "when Claude should consult the shard")
        .addOption(choiceOption("--mode <mode>", "whether this machine may edit the shard", MODES))
        .addOption(choiceOption("--access <access>", "the most any machine may do with the shard", ACCESS))
        .action(
          (
            id: string,
            options: JsonOption & { description?: string; useWhen?: string; mode?: Mode; access?: Access }
          ) => {
            const shard = updateShard(id, {
              description: options.description,
              useWhen: options.useWhen,
              mode: options.mode,
              access: options.access
            });
            print(io, options.json, shard, shardDetails(shard));
          }
        );

      command(program, "reprobe <id>", "detect a shard's format and roots again")
        .option("--dry-run", "show what would change without writing the manifest")
        .action((id: string, options: JsonOption & { dryRun?: boolean }) => {
          const result = reprobe(id, options.dryRun !== true);
          print(io, options.json, result, reprobeText(result));
        });

      command(program, "sync", "clone missing shards and update the existing clones").action((options: JsonOption) => {
        const report = sync();
        const lines = syncLines(report);
        if (report.some((entry) => entry.action === "cloned")) lines.push(CLAUDE_SYNC_HINT);
        print(io, options.json, report, lines.join("\n") || "no shards registered");
        if (report.some((entry) => entry.action === "error")) exit(1);
      });

      command(program, "import [locator]", "merge a team manifest into this machine's manifest")
        .option("--file <path>", `the manifest inside a repo or directory, default ${DEFAULT_IMPORT_FILE}`)
        .option("--project <name>", "pin this project for every session once the import is written")
        .addOption(new Option("--context <name>").hideHelp())
        .option("--yes", "write the merged manifest; without it the command only shows what would change")
        .option("--sync", "with --yes, run `globu sync` right after the import")
        .action((locator: string | undefined, options: JsonOption & ImportArgs & { yes?: boolean }) => {
          if (options.sync && !options.yes) throw new Error("--sync needs --yes, nothing is cloned for a preview");
          const result = importManifests({
            locator,
            file: options.file,
            context: options.project ?? options.context,
            apply: options.yes === true,
            cwd: io.cwd
          });
          const synced = options.sync ? sync() : null;
          print(io, options.json, { ...result, synced }, importText({ ...options, locator }, result, synced));
          if (synced?.some((entry) => entry.action === "error")) exit(1);
        });

      command(program, "use [project]", "pin one project for every new session, whatever repo it starts in")
        .option("--all", "clear the pin, so a session's project comes from its home repo again")
        .action((project: string | undefined, options: JsonOption & { all?: boolean }) => {
          const selected = options.all ? null : project;
          if (selected === undefined) throw new Error("use needs a project name, or --all");
          const name = useProject(selected);
          print(io, options.json, { current: name }, `active project: ${name ?? "the one of the session's home repo"}`);
        });

      const project = program.command("project").alias("context").description("define and inspect projects");

      command(project, "list", "show the projects, the pinned one and the shards every session sees").action(
        (options: JsonOption) => {
          const { manifest, state } = resolveAll();
          const projects = projectShards(manifest);
          const always = manifest.always ?? [];
          const lines = Object.entries(projects).map(
            ([name, selection]) => `${name === state.current ? "*" : " "} ${name}\t${selection.join(" ")}`
          );
          if (always.length > 0) lines.push(`always\t${always.join(" ")}`);
          const text = lines.join("\n") || "no projects defined, every session sees every shard";
          print(io, options.json, { current: state.current, projects, always }, text);
        }
      );

      command(
        project,
        "set <name> <patterns...>",
        "define a project's shards from ids or patterns, * is a wildcard"
      ).action((name: string, patterns: string[], options: JsonOption) => {
        print(io, options.json, setProject(name, patterns), `project ${name}: ${patterns.join(" ")}`);
      });

      command(project, "rm <name>", "delete a project").action((name: string, options: JsonOption) => {
        print(io, options.json, removeProject(name), `removed project ${name}`);
      });

      command(program, "index", "print the text the session hook injects").action((options: JsonOption) => {
        const { shards, context: active } = resolveActive(io.cwd);
        const index = renderIndex(shards, active, io.cwd);
        print(io, options.json, { context: active, index }, index);
      });

      command(program, "resolve <refs...>", "check that references exist on their repo's default branch").action(
        (refs: string[], options: JsonOption) => {
          const { shards: active, context: activeContext } = resolveActive(io.cwd);
          const report = resolveRefs(refs, resolveAll().shards, active, io.cwd, activeContext);
          const touched = active.filter((shard) => report.shards.includes(shard.id));
          const index = renderIndex(touched, activeContext, io.cwd);
          const lines = report.refs.flatMap(refLines);
          if (index) lines.push("", index);
          print(io, options.json, { ...report, context: activeContext, index }, lines.join("\n"));
          if (!report.ok) exit(1);
        }
      );

      command(program, "doctor", "report problems with the registered shards").action((options: JsonOption) => {
        const findings = doctor();
        const lines = findings.map((finding) => `${finding.level}\t${finding.id}\t${finding.message}`);
        print(io, options.json, findings, lines.join("\n") || "no problems found");
        if (findings.some((finding) => finding.level === "error")) exit(1);
      });

      const claude = program.command("claude").description("integrate with Claude Code settings");

      command(
        claude,
        "sync",
        "add the shards' paths to permissions.additionalDirectories, every shard unless a project is pinned"
      )
        .option("--remove", "remove the paths globu added")
        .action((options: JsonOption & { remove?: boolean }) => {
          const result = syncClaudeDirectories(options.remove === true);
          const lines = [`${result.changed ? "updated" : "unchanged"} ${result.settingsPath}`, ...result.directories];
          print(io, options.json, result, lines.join("\n"));
        });

      defineBaseCommands(program.command("base").description("OKF knowledge bases inside the current repo"), io, exit);

      const hook = program.command("hook").description("hook entry points for Claude Code");

      hook
        .command("session-start")
        .description("SessionStart entry point: print the shard index")
        .action(() => {
          const cwd = readHookInput(io)?.cwd ?? io.cwd;
          try {
            const { shards, context: active } = resolveActive(cwd);
            const index = renderIndex(shards, active, cwd);
            if (index) io.out(index);
          } catch (err) {
            io.out(`Globu could not load its shard index: ${(err as Error).message}`);
          }
        });

      hook
        .command("validate-edit")
        .description("PostToolUse entry point: validate the base that owns the edited file")
        .action(() => validateEditHook(io, exit));

      hook
        .command("guard")
        .description("PreToolUse entry point: block or ask before changes to read-only and ask shards")
        .action(() => {
          const input = readHookInput(io);
          const cwd = input?.cwd ?? io.cwd;
          const filePath = input?.tool_input.file_path ?? input?.tool_input.notebook_path;
          const command = input?.tool_input.command ?? "";
          const targets =
            filePath === undefined
              ? commandTargets(command, cwd)
              : [{ path: path.resolve(cwd, filePath), certain: true }];
          let verdict: Verdict | null;
          try {
            verdict = guardVerdict(resolveAll().shards, targets, sessionHome(cwd));
          } catch {
            return;
          }
          if (verdict === null) return;
          const reason = guardReason(verdict, filePath === undefined);
          if (verdict.decision === "deny") {
            io.err(reason);
            exit(2);
            return;
          }
          io.out(
            JSON.stringify({
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "ask",
                permissionDecisionReason: reason
              }
            })
          );
        });
    },
    argv,
    io
  );
}
