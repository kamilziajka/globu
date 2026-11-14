const HTTP_RE = /^(https?:\/\/[^/@]+)\//i;
const SSH_URL_RE = /^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\//i;
const SCP_RE = /^(?:[\w.-]+@)?([\w.-]+):(?!\/\/)/;

type HttpTarget = { base: string; sshPrefixes: string[] };

function httpTarget(repo: string): HttpTarget | null {
  const http = HTTP_RE.exec(repo);
  if (http) return { base: `${http[1]}/`, sshPrefixes: [] };
  const ssh = SSH_URL_RE.exec(repo);
  if (ssh) return { base: `https://${ssh[1]}/`, sshPrefixes: [ssh[0]] };
  const scp = SCP_RE.exec(repo);
  if (scp) return { base: `https://${scp[1]}/`, sshPrefixes: [scp[0]] };
  return null;
}

export type GitCredentials = { token: string; user?: string };

const GITHUB = "https://github.com/";
let githubToken: string | null = null;

export function useGitHubToken(token: string | null): void {
  githubToken = token;
}

function envCredentials(base: string): GitCredentials | null {
  const token = process.env.GLOBU_GIT_TOKEN;
  if (token) return { token, user: process.env.GLOBU_GIT_USER };
  return githubToken !== null && base.toLowerCase() === GITHUB ? { token: githubToken } : null;
}

export function gitAuthArgs(repo: string | null, given?: GitCredentials): string[] {
  if (repo === null) return [];
  const target = httpTarget(repo);
  if (target === null) return [];
  const credentials = given ?? envCredentials(target.base);
  if (credentials === null) return [];
  const user = credentials.user || "x-access-token";
  const header = `Authorization: Basic ${Buffer.from(`${user}:${credentials.token}`).toString("base64")}`;
  return [
    "-c",
    `http.${target.base}.extraheader=${header}`,
    ...target.sshPrefixes.flatMap((prefix) => ["-c", `url.${target.base}.insteadOf=${prefix}`])
  ];
}
