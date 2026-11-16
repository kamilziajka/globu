import { spawn } from "node:child_process";

export type AwakeCommand = { command: string; args: string[] };
export type KeepAwake = (platform: NodeJS.Platform, onProblem: (problem: string) => void) => () => void;

const CONTINUOUS_AND_SYSTEM_REQUIRED = 2147483649;

function windowsScript(pid: number): string {
  return [
    `$signature = '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'`,
    "$power = Add-Type -MemberDefinition $signature -Name Power -Namespace GlobuWorker -PassThru",
    `if ($power::SetThreadExecutionState([uint32]${CONTINUOUS_AND_SYSTEM_REQUIRED}) -eq 0) { exit 1 }`,
    `Wait-Process -Id ${pid}`
  ].join("\n");
}

export function awakeCommand(platform: NodeJS.Platform, pid: number): AwakeCommand | null {
  if (platform === "darwin") return { command: "caffeinate", args: ["-i", "-w", String(pid)] };
  if (platform !== "win32") return null;
  const encoded = Buffer.from(windowsScript(pid), "utf16le").toString("base64");
  return { command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded] };
}

export function holdAwake(wanted: AwakeCommand | null, onProblem: (problem: string) => void): () => void {
  if (wanted === null) return () => {};
  let released = false;
  const child = spawn(wanted.command, wanted.args, { stdio: "ignore", windowsHide: true });
  child.on("error", (error) => onProblem(`${wanted.command} could not start: ${error.message}`));
  child.on("exit", (code) => {
    if (!released) onProblem(`${wanted.command} ended with ${code === null ? "a signal" : `exit code ${code}`}`);
  });
  child.unref();
  return () => {
    released = true;
    child.kill();
  };
}

export const keepAwake: KeepAwake = (platform, onProblem) => holdAwake(awakeCommand(platform, process.pid), onProblem);
