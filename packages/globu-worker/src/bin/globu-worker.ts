import readline from "node:readline";
import { processIo } from "../../../globu-cli/src/cli/process-io.js";
import { workerMain } from "../cli.js";
import type { Key, ReadKey } from "../start.js";
import { SHOW_CURSOR } from "../tui.js";

const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;

function keyOf(sequence: string | undefined, key: readline.Key | undefined): Key {
  if (key?.ctrl === true && key.name === "c") return "quit";
  const name = key?.name ?? sequence;
  if (name === "up" || name === "k") return "up";
  if (name === "down" || name === "j") return "down";
  if (name === "return" || name === "enter") return "enter";
  if (name === "r") return "refresh";
  if (name === "q" || name === "escape") return "quit";
  return "other";
}

const readKey: ReadKey = () =>
  new Promise((resolve) => {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const ended = () => finish("quit");
    const pressed = (sequence: string | undefined, key: readline.Key | undefined) => finish(keyOf(sequence, key));
    const finish = (key: Key) => {
      process.stdin.off("keypress", pressed);
      process.stdin.off("end", ended);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      resolve(key);
    };
    process.stdin.on("keypress", pressed);
    process.stdin.once("end", ended);
  });

process.on("exit", () => {
  if (interactive) process.stdout.write(SHOW_CURSOR);
});

process.exitCode = await workerMain(process.argv.slice(2), processIo, process.env, {
  signals: process,
  screen: interactive ? process.stdout : undefined,
  readKey: interactive ? readKey : undefined,
  wait: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms).unref();
    }),
  every: (tick, ms) => {
    const timer = setInterval(tick, ms);
    return () => clearInterval(timer);
  }
});
