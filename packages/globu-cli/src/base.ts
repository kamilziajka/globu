import path from "node:path";
import type { Command } from "commander";
import {
  appendLog,
  checkFile,
  findBases,
  generatedActor,
  humanId,
  isInside,
  ownerBase,
  type StaleDoc,
  type StampField,
  setupBase,
  staleRepo,
  stampDocs,
  stampTime,
  type ValidationError,
  validateBase,
  validateRepo
} from "../../knowledge-base/src/index.js";
import { command, type Exit, type Io, type JsonOption, print, readHookInput } from "./cli/index.js";

function rel(io: Io, target: string): string {
  return path.relative(io.cwd, target) || ".";
}

function target(io: Io, positional: string | undefined): string {
  return path.resolve(io.cwd, positional ?? ".");
}

function baseStatus(result: { errors: ValidationError[]; warnings: ValidationError[] }): string {
  if (result.errors.length > 0) return "FAIL";
  return result.warnings.length > 0 ? "WARN" : "OK  ";
}

function staleLine(io: Io, doc: StaleDoc): string {
  const reasons = doc.reasons.map((reason) => (reason === "stale" ? `stale since ${doc.staleAfter}` : reason));
  return `${rel(io, doc.file)}\t${reasons.join(", ")}`;
}

export function defineBaseCommands(base: Command, io: Io, exit: Exit): void {
  command(base, "setup [path]", "bootstrap a base or upgrade one in place")
    .option("--name <name>", "name of the base")
    .option("--description <text>", "one sentence describing the base")
    .option("--dir <name>", "name of the base directory, wiki by default")
    .action((dir: string | undefined, options: JsonOption & { name?: string; description?: string; dir?: string }) => {
      const summary = setupBase(target(io, dir), {
        name: options.name,
        description: options.description,
        dir: options.dir
      });
      const lines = [
        `base: ${rel(io, summary.docsDir)}`,
        ...summary.created.map((file) => `  created   ${rel(io, file)}`),
        ...summary.updated.map((file) => `  updated   ${rel(io, file)}`),
        ...summary.unchanged.map((file) => `  unchanged ${rel(io, file)}`),
        ...summary.validation.errors.map((err) => `  invalid   ${rel(io, err.file)}: ${err.message}`),
        ...summary.validation.warnings.map((warning) => `  warning   ${rel(io, warning.file)}: ${warning.message}`)
      ];
      print(io, options.json, summary, lines.join("\n"));
      if (summary.validation.errors.length > 0) exit(1);
    });

  command(base, "validate [path]", "check the OKF structure of every base under a directory").action(
    (dir: string | undefined, options: JsonOption) => {
      const validation = validateRepo(target(io, dir));
      const lines =
        validation.results.length === 0
          ? validation.errors.map((err) => `${rel(io, err.file)}: ${err.message}`)
          : validation.results.flatMap((result) => [
              `${baseStatus(result)}  ${rel(io, result.docsDir)}`,
              ...result.errors.map((err) => `      ${rel(io, err.file)}: ${err.message}`),
              ...result.warnings.map((warning) => `      ${rel(io, warning.file)}: warning: ${warning.message}`)
            ]);
      print(io, options.json, validation, lines.join("\n"));
      if (validation.errors.length > 0) exit(1);
    }
  );

  command(base, "stale [path]", "list the docs past stale_after or deprecated in every base under a directory").action(
    (dir: string | undefined, options: JsonOption) => {
      const report = staleRepo(target(io, dir));
      const docs = report.results.flatMap((result) => result.docs);
      const lines =
        report.results.length === 0
          ? report.errors.map((err) => `${rel(io, err.file)}: ${err.message}`)
          : docs.map((doc) => staleLine(io, doc));
      print(io, options.json, report, lines.join("\n") || "no stale or deprecated docs");
      if (report.errors.length > 0) exit(1);
    }
  );

  command(base, "stamp <files...>", "stamp generated on concept docs, or append a human verification")
    .option("--verified", "append { by: human:<git user.name>, at: now } to verified instead")
    .action((files: string[], options: JsonOption & { verified?: boolean }) => {
      const field: StampField = options.verified ? "verified" : "generated";
      const at = stampTime();
      const stamped = stampDocs(
        files.map((file) => path.resolve(io.cwd, file)),
        field,
        (file) => ({ by: field === "verified" ? `human:${humanId(path.dirname(file))}` : generatedActor(), at })
      );
      const lines = stamped.map((result) => `${result.field}\t${rel(io, result.file)}\t${result.by}\t${result.at}`);
      print(io, options.json, stamped, lines.join("\n"));
    });

  command(base, "list [path]", "list every base under a directory").action(
    (dir: string | undefined, options: JsonOption) => {
      const bases = findBases(target(io, dir));
      const lines = bases.map((found) => `${found.name}\t${rel(io, found.docsDir)}`);
      print(io, options.json, bases, lines.join("\n") || "no OKF bases found");
    }
  );

  command(base, "owner <file>", "show which base owns a file").action((filePath: string, options: JsonOption) => {
    const file = path.resolve(io.cwd, filePath);
    const docsDir = ownerBase(file);
    print(io, options.json, { file, docsDir }, docsDir === null ? "no owning base" : rel(io, docsDir));
    if (docsDir === null) exit(1);
  });

  command(base, "log <docsDir> <date> <entries...>", "add entries to a base's log.md under a YYYY-MM-DD date")
    .option("--title <text>", "title for the day section when it has to be opened")
    .action((docsDir: string, date: string, entries: string[], options: JsonOption & { title?: string }) => {
      const logPath = appendLog(path.resolve(io.cwd, docsDir), date, entries, options.title);
      print(io, options.json, { logPath }, `updated ${rel(io, logPath)}`);
    });
}

export function validateEditHook(io: Io, exit: Exit): void {
  const filePath = readHookInput(io)?.tool_input.file_path;
  if (!filePath?.endsWith(".md")) return;
  const file = path.resolve(io.cwd, filePath);
  const docsDir = ownerBase(file);
  if (docsDir === null || !isInside(docsDir, file)) return;
  const { errors } = validateBase(docsDir);
  if (errors.length > 0) {
    const lines = errors.map((err) => `  ${err.file}: ${err.message}`);
    io.err(`globu: ${docsDir} failed validation after this edit:\n${lines.join("\n")}`);
    exit(2);
    return;
  }
  const { warnings } = checkFile(file);
  if (warnings.length === 0) return;
  const lines = warnings.map((warning) => `  ${warning}`);
  const context = `globu: the OKF fields of ${file} have problems. They are warnings and do not block the edit:\n${lines.join("\n")}`;
  io.out(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: context } }));
}
