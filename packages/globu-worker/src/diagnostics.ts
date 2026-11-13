import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VERSION } from "../../knowledge-base/src/index.js";
import type { Runner } from "./exec.js";
import { redact } from "./logger.js";
import { loadRuns } from "./runs.js";

export type DiagnosticsDeps = { home: string; env: NodeJS.ProcessEnv; run: Runner; secrets: string[] };

const TOOLS = ["claude", "git", "gh"];

export function diagnosticsName(now: Date): string {
  return `globu-worker-diagnostics-${now.toISOString().replace(/[-:]/g, "").slice(0, 15)}Z.tar.gz`;
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

export async function writeDiagnostics(deps: DiagnosticsDeps, out: string): Promise<string[]> {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "globu-diagnostics-"));
  try {
    const included: string[] = [];
    const put = (name: string, content: string) => {
      fs.mkdirSync(path.dirname(path.join(staging, name)), { recursive: true });
      fs.writeFileSync(path.join(staging, name), redact(content, deps.secrets));
      included.push(name);
    };
    const logs = path.join(deps.home, "logs");
    if (fs.existsSync(logs)) {
      for (const name of fs.readdirSync(logs).sort())
        put(`logs/${name}`, fs.readFileSync(path.join(logs, name), "utf8"));
    }
    for (const { dir, record } of loadRuns(deps.home)) {
      put(`runs/${path.basename(dir)}.json`, `${JSON.stringify(record, null, 2)}\n`);
    }
    const config = path.join(deps.home, "worker.yaml");
    if (fs.existsSync(config)) put("worker.yaml", fs.readFileSync(config, "utf8"));
    put("environment.txt", await environment(deps));
    const packed = await deps.run("tar", ["-czf", out, "-C", staging, ...included], { env: deps.env });
    if (packed.code !== 0) throw new Error(`tar failed: ${packed.stderr.trim()}`);
    return included;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
