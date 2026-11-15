import { type Frontmatter, isMapping } from "./frontmatter.js";

export const STATUSES = ["draft", "stable", "deprecated"] as const;
export type Lifecycle = "stale" | "deprecated";

const INSTANT_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(?:(Z)|([+-])(\d{2})(?::?(\d{2}))?)$/;
const ACTOR_RE = /^(?:(?:human|process):\S.*|[^\s/:]+\/\S+)$/;
const FOOTNOTE_RE = /\[\^([^\]\s]+)\]/g;
const FENCE_RE = /^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*$/gm;
const CODE_SPAN_RE = /(`+)[^`]*?\1/g;

const INSTANT_HINT = "an ISO 8601 datetime with an offset, such as 2026-11-05T08:00:00Z";
const ACTOR_HINT = "an actor: <producer>/<version>, human:<id> or process:<id>";

function shown(value: unknown): string {
  return JSON.stringify(value);
}

function inRange(value: number, min: number, max: number): boolean {
  return value >= min && value <= max;
}

export function parseInstant(value: unknown): number | null {
  const match = typeof value === "string" ? INSTANT_RE.exec(value) : null;
  if (match === null) return null;
  const [year, month, day, hour, minute, second, offsetHours, offsetMinutes] = [1, 2, 3, 4, 5, 6, 10, 11].map((group) =>
    Number(match[group] ?? 0)
  );
  const millis = Number((match[7] ?? "").padEnd(3, "0").slice(0, 3));
  const local = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millis));
  const valid =
    local.getUTCFullYear() === year &&
    local.getUTCMonth() === month - 1 &&
    local.getUTCDate() === day &&
    inRange(hour, 0, 23) &&
    inRange(minute, 0, 59) &&
    inRange(second, 0, 59) &&
    inRange(offsetHours, 0, 23) &&
    inRange(offsetMinutes, 0, 59);
  if (!valid) return null;
  const sign = match[9] === "-" ? -1 : 1;
  return local.getTime() - sign * (offsetHours * 60 + offsetMinutes) * 60_000;
}

function instantWarnings(field: string, value: unknown, required: boolean): string[] {
  if (value === undefined) return required ? [`\`${field}\` is missing`] : [];
  return parseInstant(value) === null ? [`\`${field}\` should be ${INSTANT_HINT}, got ${shown(value)}`] : [];
}

function actorWarnings(field: string, value: unknown): string[] {
  if (value === undefined) return [`\`${field}\` is missing`];
  return typeof value === "string" && ACTOR_RE.test(value)
    ? []
    : [`\`${field}\` should be ${ACTOR_HINT}, got ${shown(value)}`];
}

function windowWarnings(field: string, value: unknown): string[] {
  if (value === undefined) return [];
  if (!isMapping(value)) return [`\`${field}\` should be a mapping with \`from\` and \`to\``];
  return [...instantWarnings(`${field}.from`, value.from, true), ...instantWarnings(`${field}.to`, value.to, true)];
}

function sourceWarnings(entry: unknown, index: number): string[] {
  const field = `sources[${index}]`;
  if (!isMapping(entry)) return [`\`${field}\` should be a mapping with a \`resource\``];
  const warnings: string[] = [];
  if (typeof entry.resource !== "string" || entry.resource.trim() === "")
    warnings.push(`\`${field}\` has no \`resource\``);
  if (entry.id !== undefined && typeof entry.id !== "string") warnings.push(`\`${field}.id\` should be a string`);
  return [
    ...warnings,
    ...instantWarnings(`${field}.last_modified`, entry.last_modified, false),
    ...windowWarnings(`${field}.usage_window`, entry.usage_window)
  ];
}

export function footnoteLabels(body: string): string[] {
  const prose = body.replace(FENCE_RE, "").replace(CODE_SPAN_RE, "");
  return [...new Set([...prose.matchAll(FOOTNOTE_RE)].map((match) => match[1]))];
}

function provenanceWarnings(data: Frontmatter, body: string): string[] {
  const warnings = windowWarnings("usage_window", data.usage_window);
  if (data.sources === undefined) return warnings;
  if (!Array.isArray(data.sources)) return [...warnings, "`sources` should be a list of entries with a `resource`"];
  const ids = new Set(data.sources.flatMap((entry) => (isMapping(entry) ? [entry.id] : [])));
  const unmatched = footnoteLabels(body).filter((label) => !ids.has(label));
  return [
    ...warnings,
    ...data.sources.flatMap(sourceWarnings),
    ...unmatched.map((label) => `footnote \`[^${label}]\` matches no \`sources[].id\``)
  ];
}

function generatedWarnings(value: unknown): string[] {
  if (value === undefined) return [];
  if (!isMapping(value)) return ["`generated` should be a mapping with `by` and `at`"];
  return [...actorWarnings("generated.by", value.by), ...instantWarnings("generated.at", value.at, false)];
}

function verificationWarnings(field: string, entry: unknown): string[] {
  if (!isMapping(entry)) return [`\`${field}\` should be a mapping with \`by\` and \`at\``];
  return [...actorWarnings(`${field}.by`, entry.by), ...instantWarnings(`${field}.at`, entry.at, true)];
}

function verifiedWarnings(value: unknown): string[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap((entry, index) => verificationWarnings(`verified[${index}]`, entry));
  if (isMapping(value)) return verificationWarnings("verified", value);
  return [`\`verified\` should be a mapping or a list of \`{ by, at }\`, got ${shown(value)}`];
}

function lifecycleWarnings(data: Frontmatter): string[] {
  const warnings = instantWarnings("stale_after", data.stale_after, false);
  if (data.status === undefined || (STATUSES as readonly unknown[]).includes(data.status)) return warnings;
  return [`\`status\` should be draft, stable or deprecated, got ${shown(data.status)}`, ...warnings];
}

export function fieldWarnings(data: Frontmatter, body: string): string[] {
  return [
    ...provenanceWarnings(data, body),
    ...generatedWarnings(data.generated),
    ...verifiedWarnings(data.verified),
    ...lifecycleWarnings(data)
  ];
}

export function lifecycleOf(data: Frontmatter, now: number): Lifecycle[] {
  const staleAt = parseInstant(data.stale_after);
  return [
    ...(staleAt !== null && staleAt <= now ? ["stale" as const] : []),
    ...(data.status === "deprecated" ? ["deprecated" as const] : [])
  ];
}
