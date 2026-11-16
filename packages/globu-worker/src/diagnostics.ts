import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VERSION } from "../../knowledge-base/src/index.js";
import type { Runner } from "./exec.js";
import { FILED_FILE } from "./filed.js";
import { type Gap, gapText, logGaps } from "./gaps.js";
import { redact } from "./logger.js";
import { MERGED_FILE } from "./merged.js";
import { latestRuns, loadRuns } from "./runs.js";
import { SUBSCRIPTION_FILE } from "./subscription.js";

export type DiagnosticsDeps = { home: string; env: NodeJS.ProcessEnv; run: Runner; secrets: string[] };
export type Diagnostics = { included: string[]; gaps: Gap[] };

const TOOLS = ["claude", "git", "gh"];
export const DIAGNOSTIC_RUNS = 20;

export function diagnosticsName(now: Date): string {
  return `globu-worker-diagnostics-${now.toISOString().replace(/[-:]/g, "").slice(0, 15)}Z.tar.gz`;
}

export function gapLines(gaps: Gap[]): string[] {
  if (gaps.length === 0) return ["gaps\tnone in the logs"];
  return gaps.map(
    (gap) => `gap\tthe worker paused ${gapText(gap)}, the machine was asleep or the worker was suspended`
  );
}

async function environment(deps: DiagnosticsDeps): Promise<string> {
  const lines = [
    `globu-worker ${VERSION}`,
    `node ${process.version}`,
    `os ${os.platform()} ${os.release()} ${os.arch()}`,
    `home ${deps.home}`
  ];
  for (const tool of TOOLS) {
    const result = await deps.run(tool, ["--version"], { env: deps.env });
    const version = result.code === 0 ? result.stdout.trim().split("\n")[0] : `not available (${result.code})`;
    lines.push(`${tool} ${version}`);
  }
  return `${lines.join("\n")}\n`;
}

export async function writeDiagnostics(deps: DiagnosticsDeps, out: string): Promise<Diagnostics> {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "globu-diagnostics-"));
  try {
    const included: string[] = [];
    const put = (name: string, content: string) => {
      fs.mkdirSync(path.dirname(path.join(staging, name)), { recursive: true });
      fs.writeFileSync(path.join(staging, name), redact(content, deps.secrets));
      included.push(name);
    };
    const gaps: Gap[] = [];
    const logs = path.join(deps.home, "logs");
    if (fs.existsSync(logs)) {
      for (const name of fs.readdirSync(logs).sort()) {
        const text = fs.readFileSync(path.join(logs, name), "utf8");
        put(`logs/${name}`, text);
        gaps.push(...logGaps(text));
      }
    }
    const runs = latestRuns(loadRuns(deps.home), DIAGNOSTIC_RUNS).reverse();
    for (const { dir, record } of runs) {
      put(`runs/${path.basename(dir)}.json`, `${JSON.stringify(record, null, 2)}\n`);
    }
    for (const name of ["worker.yaml", MERGED_FILE, SUBSCRIPTION_FILE, FILED_FILE]) {
      const file = path.join(deps.home, name);
      if (fs.existsSync(file)) put(name, fs.readFileSync(file, "utf8"));
    }
    put("environment.txt", await environment(deps));
    put("summary.txt", `${gapLines(gaps).join("\n")}\n`);
    const packed = await deps.run("tar", ["-czf", path.basename(out), "-C", staging, ...included], {
      cwd: path.dirname(out),
      env: deps.env
    });
    if (packed.code !== 0) throw new Error(`tar failed: ${packed.stderr.trim()}`);
    return { included, gaps };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
