import { INDEX_FILENAME, LOG_FILENAME, OKF_SPEC_URL, PLUGIN_NAME } from "./constants.js";

export const AUTHORING_GUIDE_START = `<!-- ${PLUGIN_NAME}:authoring-guide:start -->`;
export const AUTHORING_GUIDE_END = `<!-- ${PLUGIN_NAME}:authoring-guide:end -->`;

const NOT_PROSE = "(?!#|[*+-]\\s|\\d+[.)]\\s|[<|>`])";
const TITLE_AND_INTRO_RE = new RegExp(`^#[^\\n]*\\n(?:\\n${NOT_PROSE}(?:[^\\n]*\\S[^\\n]*\\n)+)?`);

export function authoringGuideBlock(): string {
  return [
    AUTHORING_GUIDE_START,
    "## Before you consider a task done",
    "",
    "If you are an agent that just changed code or behavior in this repo, do not stop at the code change. Check whether anything you did is durable enough to belong here (a decision, an API shape, a gotcha, a root cause) and update this base before calling the task finished.",
    "",
    "## Which base owns what",
    "",
    `A repo can hold more than one base. A base is any directory whose \`${INDEX_FILENAME}\` carries \`okf_version\`, usually \`docs/\`, \`wiki/\` or \`knowledge/\`. Knowledge about a piece of code belongs in the nearest base walking up from that code: a package with its own base owns its knowledge and everything else falls to the base at the repo root.`,
    "",
    "## How to add or update knowledge here",
    "",
    `This is a plain [OKF](${OKF_SPEC_URL}) bundle: Markdown files with YAML frontmatter, versioned in git. No special tool is required to read or edit it. Any agent or person can create, edit or delete files here directly.`,
    "",
    `- **Concept docs** are any \`.md\` file in this directory (or subdirectories) other than \`${INDEX_FILENAME}\` and \`${LOG_FILENAME}\`. Each one must start with frontmatter:`,
    "  ```yaml",
    "  ---",
    '  type: "Note"        # required, a freeform label such as "API Endpoint", "Runbook", "Decision" or "Playbook"',
    '  title: "..."         # recommended',
    '  description: "..."   # recommended, one sentence',
    "  ---",
    "  ```",
    "- **Prefer editing an existing doc** over creating a near-duplicate one. Skim this directory first.",
    "- **Link between docs** with normal Markdown links. Bundle-relative paths (e.g. `/topics/foo.md`) are preferred over `../` relatives.",
    `- **Record changes in \`${LOG_FILENAME}\`**: add a dated, newest-first bullet describing what changed (see that file for the format).`,
    `- **List new docs in \`${INDEX_FILENAME}\`** under Contents so a reader can find them from the entry point.`,
    AUTHORING_GUIDE_END
  ].join("\n");
}

export function upsertAuthoringGuide(body: string): string {
  const trimmed = body.replace(/^\n+/, "");
  const block = authoringGuideBlock();
  const startIdx = trimmed.indexOf(AUTHORING_GUIDE_START);
  const endIdx = trimmed.indexOf(AUTHORING_GUIDE_END);

  if (startIdx !== -1 && endIdx > startIdx) {
    return trimmed.slice(0, startIdx) + block + trimmed.slice(endIdx + AUTHORING_GUIDE_END.length);
  }

  const headingMatch = TITLE_AND_INTRO_RE.exec(trimmed);
  if (!headingMatch) return `${block}\n\n${trimmed}`;
  const idx = headingMatch[0].length;
  return `${trimmed.slice(0, idx)}\n${block}\n\n${trimmed.slice(idx).replace(/^\n+/, "")}`;
}
