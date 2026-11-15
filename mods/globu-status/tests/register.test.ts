import type { On } from "claude-code";
import type { Engine } from "claude-code/testing";
import { expect, mock, test } from "claude-code/testing";

const BAND = {
  plugin: "globu-status",
  component: "AbovePrompt",
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 9 },
    view: {}
  }
} as const;

const world = (
  on: On,
  bases: string[] = [],
  stored: Record<string, unknown> = {},
  commands: string[] = [],
  isRunRefused = false
) => {
  const prompts: string[] = [];
  const toasts: string[] = [];
  const ran: string[] = [];
  const store: Record<string, unknown> = { ...stored };
  const clock = mock.clock(on, { now: 1_000_000 });
  on("store.get", (_$, e) => ({ value: store[e.key] }));
  on("store.set", (_$, e) => {
    store[e.key] = e.value;
    return { value: undefined };
  });
  on("store.delete", (_$, e) => {
    delete store[e.key];
    return { value: undefined };
  });
  const statuses: (string | undefined)[] = [];
  on("ui.status", (_$, e) => {
    statuses.push(e.text);
    return { value: undefined };
  });
  on("tool.call", () => ({ result: {}, text: "ok" }));
  // On Windows the harness resolves /repo/docs/index.md to C:\repo\docs\index.md.
  on("fs.exists", (_$, e) => {
    const posix = e.path.replace(/\\/g, "/").replace(/^[A-Za-z]:/, "");
    return { value: bases.some((base) => posix === `${base}/index.md` || posix === `${base}/log.md`) };
  });
  on("command.list", () => ({
    value: commands.map((name) => ({ name, description: "", source: "plugin" as const, plugin: "globu" }))
  }));
  on("command.run", (_$, e) => {
    if (isRunRefused) throw new Error("busy");
    ran.push(e.command);
    return { text: "" };
  });
  on("turn.start", (_$, e) => ({ turnId: e.turnId }));
  on("turn.complete", (_$, e) => ({ text: e.answer }));
  on("ui.toast", (_$, e) => {
    toasts.push(e.text);
    return { value: undefined };
  });
  on("prompt.submit", (_$, e) => {
    prompts.push(e.text);
    return { text: e.text };
  });
  return { prompts, ran, toasts, clock, store, status: () => statuses[statuses.length - 1] };
};

const edit = ($: Engine, file_path: string) =>
  $.tool.call({ tool: "Edit", file_path, old_string: "a", new_string: "b" });

const bash = ($: Engine, command: string) => $.tool.call({ tool: "Bash", command });

const turn = ($: Engine, turnId = "t", reason: "answer" | "aborted" = "answer", agentId?: string) =>
  $.turn.complete({ reason, answer: "", durationMs: 1, isAborted: reason === "aborted", turnId, agentId });

const band = async ($: Engine, surface: "terminal" | "desktop" = "terminal") => {
  const ui = await $.ui.mount({ ...BAND, surface });
  const text = await ui.find({ type: "Text" });
  const update = await ui.find({ type: "Button", key: "update" });
  await ui.unmount();
  return { text: text?.text, color: text?.props.color, dim: text?.props.dimColor, hasUpdate: update !== undefined };
};

test("edits raise the need, a commit makes it medium and the log command clears it", async ($, on) => {
  const w = world(on);
  on("ui.render", () => ({ type: "Text", props: {}, children: ["engine"] }));
  expect((await band($)).text).toBe("engine");

  await edit($, "/repo/src/a.ts");
  expect((await band($)).text).toBe("◔ Low need to update knowledge (1 edit)");
  expect(w.status()).toBe("◔ low");

  await edit($, "/repo/src/a.ts");
  await edit($, "/repo/src/b.ts");
  await turn($);
  expect((await band($)).text).toBe("◔ Low need to update knowledge (2 edits, 1 turn)");

  await bash($, 'git commit -m "x"');
  expect(w.status()).toBe("◑ medium");
  for (const surface of ["terminal", "desktop"] as const) {
    expect(await band($, surface)).toEqual({
      text: "◑ Medium need to update knowledge (2 edits, 1 commit, 1 turn)",
      color: "warning",
      dim: false,
      hasUpdate: true
    });
  }

  await bash($, 'node x/knowledge-base.mjs log docs 2026-10-08 "entry"');
  expect((await band($)).text).toBe("engine");
  expect(w.status()).toBe("✓ up to date");
});

test("a commit with nothing pending does not count", async ($, on) => {
  const w = world(on);
  await bash($, 'git commit -m "docs"');
  expect(w.status()).toBe("○ nothing to update");
});

test("shell writes count, temporary and failed ones do not", async ($, on) => {
  world(on);
  await bash($, "sed -i '' 's/a/b/' src/x.ts");
  await bash($, "echo hi > /tmp/scratch.txt");
  await edit($, "/private/tmp/scratchpad/x.ts");
  expect((await band($)).text).toBe("◔ Low need to update knowledge (1 edit)");
});

test("an edit in a knowledge base marks the knowledge up to date", async ($, on) => {
  const w = world(on, ["/repo/docs"]);
  await edit($, "/repo/src/a.ts");
  await edit($, "/repo/README.md");
  expect((await band($)).text).toBe("◔ Low need to update knowledge (2 edits)");
  await edit($, "/repo/docs/architecture.md");
  expect(w.status()).toBe("✓ up to date");
  await edit($, "/repo/docs/log.md");
  expect(w.status()).toBe("✓ up to date");
  await edit($, "/repo/src/c.ts");
  expect((await band($)).text).toBe("◔ Low need to update knowledge (1 edit)");
});

test("invoking the update skill clears the need and shows updating until the turn ends", async ($, on) => {
  const w = world(on);
  await edit($, "/repo/src/a.ts");
  await $.tool.call({ tool: "Skill", skill: "globu:save-knowledge" });
  expect((await band($)).text).toBe("Updating knowledge...");
  expect(w.status()).toBe("updating...");
  await turn($);
  expect(w.status()).toBe("✓ up to date");
});

test("the update button runs the update command", async ($, on) => {
  const w = world(on, [], {}, ["globu:register-knowledge-base", "globu:update-knowledge"]);
  await edit($, "/repo/src/a.ts");
  const ui = await $.ui.mount({ ...BAND, surface: "terminal" });
  await ui.press({ key: "update" });
  expect(w.ran).toEqual(["globu:update-knowledge"]);
  expect(w.prompts).toEqual([]);
  await ui.unmount();
});

test("the update button submits a prompt when no update command exists", async ($, on) => {
  const w = world(on);
  await edit($, "/repo/src/a.ts");
  const ui = await $.ui.mount({ ...BAND, surface: "terminal" });
  await ui.press({ key: "update" });
  await ui.unmount();
  expect(w.ran).toEqual([]);
  expect(w.prompts).toEqual(["Update the knowledge base with what this session learned."]);
});

test("mark up to date clears the band", async ($, on) => {
  const w = world(on);
  on("ui.render", () => ({ type: "Text", props: {}, children: ["engine"] }));
  await edit($, "/repo/src/a.ts");
  const ui = await $.ui.mount({ ...BAND, surface: "terminal" });
  await ui.press({ key: "mark" });
  await ui.unmount();
  expect((await band($)).text).toBe("engine");
  expect(w.status()).toBe("✓ up to date");
});

test("pressing update shows updating at once and the band clears when the update turn ends", async ($, on) => {
  const w = world(on, ["/repo/docs"], {}, ["globu:update-knowledge"]);
  on("ui.render", () => ({ type: "Text", props: {}, children: ["engine"] }));
  await edit($, "/repo/src/a.ts");
  const ui = await $.ui.mount({ ...BAND, surface: "terminal" });
  await ui.press({ key: "update" });
  await ui.unmount();
  expect(await band($)).toEqual({ text: "Updating knowledge...", color: undefined, dim: true, hasUpdate: false });
  expect(w.status()).toBe("updating...");

  await $.turn.start({ text: "/globu:update-knowledge", turnId: "u" });
  await edit($, "/repo/docs/architecture.md");
  await edit($, "/repo/CLAUDE.md");
  await bash($, 'git commit -m "docs"');
  await turn($, "sub", "answer", "agent-1");
  expect((await band($)).text).toBe("Updating knowledge...");
  await turn($, "u");
  expect((await band($)).text).toBe("engine");
  expect(w.status()).toBe("✓ up to date");
});

test("an update pressed during a turn waits for its own turn", async ($, on) => {
  const w = world(on, [], {}, ["globu:update-knowledge"]);
  await $.turn.start({ text: "work", turnId: "w" });
  await edit($, "/repo/src/a.ts");
  const ui = await $.ui.mount({ ...BAND, surface: "terminal" });
  await ui.press({ key: "update" });
  await ui.unmount();
  await turn($, "w");
  expect(w.status()).toBe("updating...");
  await $.turn.start({ text: "/globu:update-knowledge", turnId: "u" });
  await turn($, "u");
  expect(w.status()).toBe("✓ up to date");
});

test("an interrupted update brings the need back", async ($, on) => {
  const w = world(on, [], {}, ["globu:update-knowledge"]);
  await edit($, "/repo/src/a.ts");
  const ui = await $.ui.mount({ ...BAND, surface: "terminal" });
  await ui.press({ key: "update" });
  await ui.unmount();
  await turn($, "u", "aborted");
  expect((await band($)).text).toBe("◔ Low need to update knowledge (1 edit)");
  expect(w.status()).toBe("◔ low");
});

test("an update that cannot start says so and keeps the need", async ($, on) => {
  const w = world(on, [], {}, ["globu:update-knowledge"], true);
  await edit($, "/repo/src/a.ts");
  const ui = await $.ui.mount({ ...BAND, surface: "terminal" });
  await ui.press({ key: "update" });
  await ui.unmount();
  expect(w.toasts).toEqual(["Could not start the knowledge update."]);
  expect((await band($)).text).toBe("◔ Low need to update knowledge (1 edit)");
});

test("the band yields to a survey", async ($, on) => {
  world(on);
  on("ui.render", () => ({ type: "Text", props: {}, children: ["survey"] }));
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, hasSurvey: true }, surface: "terminal" });
  expect((await ui.find({ type: "Text" }))?.text).toBe("survey");
  await ui.unmount();
});

test("the slash command reports and resets", async ($, on) => {
  const w = world(on);
  await edit($, "/repo/src/a.ts");
  const run = (args: string) =>
    $.command.run({
      command: "globu-status",
      args,
      origin: { kind: "composer" },
      presentation: { isFullscreen: false, columns: 80 }
    });
  expect((await run("")).text).toContain("Low need");
  expect((await run("reset")).text).toContain("marked up to date");
  expect(w.status()).toBe("✓ up to date");
});

test("hide for a week hides the band, keeps the status and comes back after a week", async ($, on) => {
  const w = world(on);
  on("ui.render", () => ({ type: "Text", props: {}, children: ["engine"] }));
  await edit($, "/repo/src/a.ts");
  const ui = await $.ui.mount({ ...BAND, surface: "terminal" });
  await ui.press({ key: "hide" });
  await ui.unmount();
  expect((await band($)).text).toBe("engine");
  expect(w.status()).toBe("◔ low");
  expect(w.store.hiddenUntil).toBe(1_000_000 + 7 * 24 * 60 * 60 * 1000);

  const run = (args: string) =>
    $.command.run({
      command: "globu-status",
      args,
      origin: { kind: "composer" },
      presentation: { isFullscreen: false, columns: 80 }
    });
  expect((await run("")).text).toContain("hidden until 1970-01-08");

  await w.clock.advance(8 * 24 * 60 * 60 * 1000);
  expect((await band($)).text).toBe("◔ Low need to update knowledge (1 edit)");
});

test("a stored hide is restored at session start and lifted by show", async ($, on) => {
  const w = world(on, [], { hiddenUntil: 2_000_000 });
  on("ui.render", () => ({ type: "Text", props: {}, children: ["engine"] }));
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("command.register", (_$, e) => ({ value: { command: e.name } }));
  await $.session.start({ cwd: "/repo", surface: "terminal", isInteractive: true });
  await edit($, "/repo/src/a.ts");
  expect((await band($)).text).toBe("engine");
  await $.command.run({
    command: "globu-status",
    args: "show",
    origin: { kind: "composer" },
    presentation: { isFullscreen: false, columns: 80 }
  });
  expect((await band($)).text).toBe("◔ Low need to update knowledge (1 edit)");
  expect(w.store.hiddenUntil).toBeUndefined();
  expect(w.status()).toBe("◔ low");
});
