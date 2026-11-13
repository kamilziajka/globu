import { styleText } from "node:util";
import type { Check } from "./check.js";

export type Screen = { write(text: string): void; columns?: number };
export type Every = (tick: () => void, ms: number) => () => void;
export type CheckProgress = { update(check: Check): void; done(): void };

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const SPIN_MS = 80;
export const CLEAR = "\u001b[H\u001b[2J";
export const HIDE_CURSOR = "\u001b[?25l";
export const SHOW_CURSOR = "\u001b[?25h";
const ERASE_LINE = "\u001b[2K";

export const green = (text: string) => styleText("green", text);
export const red = (text: string) => styleText("red", text);
export const gray = (text: string) => styleText("gray", text);

export function widthOf(screen: Screen): number {
  return screen.columns ?? 100;
}

export function clip(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`;
}

export function checkLine(name: string, check: Check | undefined, frame: number, width: number): string {
  if (check === undefined) return `${SPINNER[frame % SPINNER.length]} ${clip(`${name}: checking`, width - 2)}`;
  const text = clip(`${name}: ${check.detail}`, width - 2);
  return check.ok ? `${green("✔")} ${text}` : `${red("✖")} ${red(text)}`;
}

export function checkProgress(screen: Screen, names: string[], every: Every): CheckProgress {
  const results = new Map<string, Check>();
  const width = widthOf(screen);
  let frame = 0;
  let drawn = false;
  const draw = () => {
    const back = drawn ? `\u001b[${names.length}A` : "";
    drawn = true;
    const lines = names.map((name) => `${ERASE_LINE}${checkLine(name, results.get(name), frame, width)}\n`);
    screen.write(`${back}${lines.join("")}`);
  };
  draw();
  const stop = every(() => {
    frame += 1;
    draw();
  }, SPIN_MS);
  return {
    update(check) {
      results.set(check.name, check);
      draw();
    },
    done() {
      stop();
      draw();
    }
  };
}
