import type { LintKind, LintWarning, RepoLint } from "../../knowledge-base/src/index.js";

export type LintFormat = "text" | "markdown";
type Rel = (target: string) => string;

const LABELS: Record<LintKind, string> = {
  "broken-link": "broken link",
  orphan: "orphan",
  "index-drift": "index drift"
};

function where(rel: Rel, warning: LintWarning): string {
  return warning.line === null ? rel(warning.file) : `${rel(warning.file)}:${warning.line}`;
}

function count(warnings: LintWarning[], kind: LintKind): number {
  return warnings.filter((warning) => warning.kind === kind).length;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function cell(text: string): string {
  return text.replaceAll("|", "\\|");
}

function textReport(lint: RepoLint, rel: Rel): string {
  if (lint.results.length === 0) return lint.errors.map((err) => `${rel(err.file)}: ${err.message}`).join("\n");
  return lint.results
    .flatMap((result) => [
      `${result.warnings.length === 0 ? "OK  " : "WARN"}  ${rel(result.docsDir)}`,
      ...result.warnings.map((warning) => `      ${where(rel, warning)}: ${LABELS[warning.kind]}: ${warning.message}`)
    ])
    .join("\n");
}

function markdownReport(lint: RepoLint, rel: Rel): string {
  const heading = "## Knowledge lint";
  if (lint.results.length === 0) {
    return [heading, "", ...lint.errors.map((err) => `\`${rel(err.file)}\`: ${err.message}`)].join("\n");
  }
  const totals = lint.results.map(
    (result) =>
      `| \`${rel(result.docsDir)}\` | ${count(result.warnings, "broken-link")} | ${count(result.warnings, "orphan")} | ${count(result.warnings, "index-drift")} |`
  );
  const sections = lint.results
    .filter((result) => result.warnings.length > 0)
    .flatMap((result) => [
      "",
      `### \`${rel(result.docsDir)}\``,
      "",
      "| Where | Check | Finding |",
      "| --- | --- | --- |",
      ...result.warnings.map(
        (warning) => `| \`${cell(where(rel, warning))}\` | ${LABELS[warning.kind]} | ${cell(warning.message)} |`
      )
    ]);
  return [
    heading,
    "",
    `${plural(lint.warnings.length, "warning")} in ${plural(lint.results.length, "base")}. Warnings never fail the job.`,
    "",
    "| Base | Broken links | Orphans | Index drift |",
    "| --- | --: | --: | --: |",
    ...totals,
    ...sections
  ].join("\n");
}

export function lintReport(lint: RepoLint, format: LintFormat, rel: Rel): string {
  return format === "markdown" ? markdownReport(lint, rel) : textReport(lint, rel);
}
