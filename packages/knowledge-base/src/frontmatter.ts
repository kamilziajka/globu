import YAML from "yaml";

export type Frontmatter = Record<string, unknown>;
export type ParsedDoc = { data: Frontmatter; body: string; hasFrontmatter: boolean };

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function isMapping(value: unknown): value is Frontmatter {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function parseFrontmatter(raw: string): ParsedDoc {
  const content = raw.replace(/^\uFEFF/, "");
  const match = FRONTMATTER_RE.exec(content);
  if (!match) return { data: {}, body: content, hasFrontmatter: false };
  const parsed: unknown = YAML.parse(match[1]);
  return { data: isMapping(parsed) ? parsed : {}, body: match[2], hasFrontmatter: true };
}

export function stringifyFrontmatter(data: Frontmatter, body: string): string {
  const yamlBlock = YAML.stringify(data, { lineWidth: 0 }).trimEnd();
  return `---\n${yamlBlock}\n---\n\n${body.replace(/^\n+/, "")}`;
}
