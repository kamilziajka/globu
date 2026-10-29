import path from "node:path";

const SCP_RE = /^(?:[\w.-]+@)?([\w.-]+):(?!\/\/)(.+)$/;
const URL_RE = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i;
const FILE_PREFIX = "file://";

function stripSuffix(value: string): string {
  return value.replace(/\/+$/, "").replace(/\.git$/, "");
}

export function looksLikeRepoUrl(value: string): boolean {
  return /^(file|https?|ssh|git):\/\//i.test(value) || /^[\w.-]+@[\w.-]+:.+/.test(value);
}

export function normalizeRepoUrl(url: string): string {
  const trimmed = url.trim();
  if (trimmed.toLowerCase().startsWith(FILE_PREFIX)) {
    return `file:${stripSuffix(path.resolve(trimmed.slice(FILE_PREFIX.length)))}`;
  }
  const match = URL_RE.exec(trimmed) ?? SCP_RE.exec(trimmed);
  if (!match) return stripSuffix(trimmed).toLowerCase();
  return `${match[1]}/${stripSuffix(match[2])}`.toLowerCase();
}

export function sameRepo(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && normalizeRepoUrl(a) === normalizeRepoUrl(b);
}

export function repoBasename(url: string): string {
  return stripSuffix(url.trim()).split(/[/:]/).at(-1) as string;
}

const FILE_LINK_RE = /^(https?:\/\/[^/]+\/.+?)\/(?:-\/)?(?:blob|raw)\/([^/]+)\/(.+)$/i;
const RAW_GITHUB_RE = /^https?:\/\/raw\.githubusercontent\.com\/([^/]+\/[^/]+)\/([^/]+)\/(.+)$/i;

export type FileLink = { repo: string; ref: string; file: string };

export function splitFileLink(url: string): FileLink | null {
  const trimmed = url.trim();
  const raw = RAW_GITHUB_RE.exec(trimmed);
  if (raw) return { repo: `https://github.com/${raw[1]}`, ref: raw[2], file: raw[3] };
  const link = FILE_LINK_RE.exec(trimmed);
  if (!link) return null;
  return { repo: link[1], ref: link[2], file: link[3].replace(/[?#].*$/, "") };
}
