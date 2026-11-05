import { sameRepo, splitFileLink } from "../../globu-core/src/giturl.js";

export type RefShard = { id: string; repo: string | null };
export type ExtractedRefs = { gating: string[]; informational: string[] };

const TRAILING = /[.,:;)\]}>'"`]+$/;
const LINK = /https?:\/\/[^\s<>()`'"]+/g;
const BACKTICKED = /`([^`\s]+)`/g;
const BARE_FILE = /^[\w-]{2,}\.[a-z0-9]{1,5}$/i;
const PATH_CHARS = /^[\w./-]+$/;

function clean(token: string): string {
  return token.replace(TRAILING, "");
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isBarePath(token: string): boolean {
  return PATH_CHARS.test(token) && !token.startsWith("/") && (token.includes("/") || BARE_FILE.test(token));
}

export function extractRefs(text: string, shards: RefShard[]): ExtractedRefs {
  const gating = new Set<string>();
  const informational = new Set<string>();

  for (const shard of shards) {
    const pattern = new RegExp(`(?<![\\w/.-])${escapeRe(shard.id)}/([\\w./-]+)`, "g");
    for (const match of text.matchAll(pattern)) gating.add(clean(`${shard.id}/${match[1]}`));
  }

  for (const match of text.matchAll(LINK)) {
    const link = splitFileLink(clean(match[0]));
    if (link === null) continue;
    const shard = shards.find((candidate) => sameRepo(candidate.repo, link.repo));
    if (shard !== undefined) gating.add(`${shard.id}/${clean(link.file)}`);
  }

  for (const match of text.matchAll(BACKTICKED)) {
    const token = clean(match[1]).replace(/:\d+$/, "");
    if (shards.some((shard) => token.startsWith(`${shard.id}/`)) || !isBarePath(token)) continue;
    informational.add(token);
  }

  return { gating: [...gating], informational: [...informational].filter((ref) => !gating.has(ref)) };
}
