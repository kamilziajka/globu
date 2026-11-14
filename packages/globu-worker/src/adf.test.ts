import { describe, expect, it } from "vitest";
import { type AdfMark, type AdfNode, adfToMarkdown } from "./adf.js";
import { extractRefs } from "./refs.js";

const doc = (...content: AdfNode[]): AdfNode => ({ type: "doc", content });
const text = (value: string, ...marks: AdfMark[]): AdfNode => ({ type: "text", text: value, marks });
const p = (...content: AdfNode[]): AdfNode => ({ type: "paragraph", content });
const item = (...content: AdfNode[]): AdfNode => ({ type: "listItem", content });

describe("adfToMarkdown", () => {
  it("renders nothing for a missing or empty document", () => {
    expect(adfToMarkdown(null)).toBe("");
    expect(adfToMarkdown(undefined)).toBe("");
    expect(adfToMarkdown({ type: "doc" })).toBe("");
    expect(adfToMarkdown(doc(p(), p(text("  "))))).toBe("");
  });

  it("renders headings and paragraphs with marks, links and breaks", () => {
    const markdown = adfToMarkdown(
      doc(
        { type: "heading", attrs: { level: 2 }, content: [text("Description")] },
        { type: "heading", attrs: { level: 9 }, content: [text("Deep")] },
        { type: "heading", content: [text("Plain")] },
        p(
          text("Bold", { type: "strong" }),
          text(" and "),
          text("italic", { type: "em" }),
          text(" and "),
          text("gone", { type: "strike" }),
          text(" and "),
          text("under", { type: "underline" }),
          { type: "hardBreak" },
          text("docs", { type: "link", attrs: { href: "https://example.com/docs" } }),
          text(" "),
          text("bare", { type: "link" })
        )
      )
    );
    expect(markdown).toBe(
      [
        "## Description",
        "",
        "###### Deep",
        "",
        "# Plain",
        "",
        "**Bold** and _italic_ and ~~gone~~ and under\n[docs](https://example.com/docs) [bare]()"
      ].join("\n")
    );
  });

  it("renders inline code so that bare paths become references", () => {
    const markdown = adfToMarkdown(
      doc(
        p(
          text("Change "),
          text("src/app/main.ts", { type: "code" }),
          text(" and "),
          text("a`b", { type: "code" }),
          text(" and "),
          text("README.md", { type: "code" }, { type: "strong" })
        )
      )
    );
    expect(markdown).toBe("Change `src/app/main.ts` and `` a`b `` and **`README.md`**");
    expect(extractRefs(markdown, []).informational).toEqual(["src/app/main.ts", "README.md"]);
  });

  it("renders bullet, ordered, nested, task and decision lists", () => {
    const markdown = adfToMarkdown(
      doc(
        {
          type: "bulletList",
          content: [
            item(p(text("one")), { type: "bulletList", content: [item(p(text("inner")), p(text("more")))] }),
            item(p(text("two")), { type: "codeBlock", content: [text("a\n\nb")] })
          ]
        },
        { type: "orderedList", attrs: { order: 3 }, content: [item(p(text("three"))), item(p(text("four")))] },
        { type: "orderedList", content: [item(p(text("first"))), { type: "listItem" }] },
        {
          type: "taskList",
          content: [
            { type: "taskItem", attrs: { state: "DONE" }, content: [text("done")] },
            { type: "taskItem", attrs: { state: "TODO" }, content: [text("todo")] }
          ]
        },
        { type: "decisionList", content: [{ type: "decisionItem", content: [text("decided")] }] }
      )
    );
    expect(markdown).toBe(
      [
        "- one",
        "  - inner",
        "    more",
        "- two",
        "  ```",
        "  a",
        "",
        "  b",
        "  ```",
        "",
        "3. three",
        "4. four",
        "",
        "1. first",
        "2. ",
        "",
        "- [x] done",
        "- [ ] todo",
        "",
        "- decided"
      ].join("\n")
    );
  });

  it("renders code blocks with their language and a fence longer than the code's", () => {
    expect(
      adfToMarkdown(
        doc(
          { type: "codeBlock", attrs: { language: "ts" }, content: [text("const a = 1;\nconst b = 2;")] },
          { type: "codeBlock", content: [text("```"), { type: "text" }] }
        )
      )
    ).toBe(["```ts", "const a = 1;", "const b = 2;", "```", "", "````", "```", "````"].join("\n"));
  });

  it("renders quotes, panels, rules, expands, cards and media", () => {
    const markdown = adfToMarkdown(
      doc(
        { type: "blockquote", content: [p(text("quoted")), p(text("twice"))] },
        { type: "panel", attrs: { panelType: "info" }, content: [p(text("note"))] },
        { type: "rule" },
        { type: "expand", attrs: { title: "Details" }, content: [p(text("hidden"))] },
        { type: "nestedExpand", content: [p(text("untitled"))] },
        { type: "blockCard", attrs: { url: "https://example.com/a" } },
        { type: "embedCard", attrs: { url: "https://example.com/b" } },
        { type: "mediaSingle", content: [{ type: "media", attrs: { alt: "screen.png" } }] },
        { type: "mediaGroup", content: [{ type: "media", attrs: { id: 7 } }] }
      )
    );
    expect(markdown).toBe(
      [
        "> quoted",
        ">",
        "> twice",
        "",
        "> note",
        "",
        "---",
        "",
        "**Details**",
        "",
        "hidden",
        "",
        "untitled",
        "",
        "https://example.com/a",
        "",
        "https://example.com/b",
        "",
        "(attachment: screen.png)",
        "",
        "(attachment)"
      ].join("\n")
    );
  });

  it("renders mentions, emoji, inline cards, statuses and dates", () => {
    expect(
      adfToMarkdown(
        doc(
          p(
            { type: "mention", attrs: { id: "a1", text: "@Kamil" } },
            text(" "),
            { type: "mention", attrs: { id: "a2", text: "Bot" } },
            text(" "),
            { type: "mention", attrs: { id: "a3" } },
            text(" "),
            { type: "emoji", attrs: { shortName: ":smile:", text: "😄" } },
            { type: "emoji", attrs: { shortName: ":wave:" } },
            text(" "),
            { type: "inlineCard", attrs: { url: "https://example.com/c" } },
            text(" "),
            { type: "status", attrs: { text: "IN PROGRESS" } },
            text(" "),
            { type: "date", attrs: { timestamp: "1762300800000" } },
            text(" "),
            { type: "date", attrs: { timestamp: "soon" } }
          )
        )
      )
    ).toBe("@Kamil @Bot @a3 😄:wave: https://example.com/c [IN PROGRESS] 2025-11-05 soon");
  });

  it("renders tables with the first row as the header and pads short rows", () => {
    const cellOf = (type: string, value: string): AdfNode => ({ type, content: [p(text(value))] });
    const markdown = adfToMarkdown(
      doc(
        {
          type: "table",
          content: [
            { type: "tableRow", content: [cellOf("tableHeader", "File"), cellOf("tableHeader", "Why")] },
            { type: "tableRow", content: [cellOf("tableCell", "a|b.ts"), cellOf("tableCell", "pipes")] },
            {
              type: "tableRow",
              content: [{ type: "tableCell", content: [p(text("two"), { type: "hardBreak" }, text("lines"))] }]
            }
          ]
        },
        { type: "table" }
      )
    );
    expect(markdown).toBe(
      ["| File | Why |", "| --- | --- |", "| a\\|b.ts | pipes |", "| two lines |  |", "", "|  |", "| --- |"].join("\n")
    );
  });

  it("degrades unknown nodes to their text or their content", () => {
    expect(
      adfToMarkdown(
        doc(
          { type: "extension", text: "macro text" },
          { type: "bodiedExtension", content: [p(text("inside")), p(text("blocks"))] },
          p(
            { type: "inlineExtension", content: [text("inline")] },
            { type: "text" },
            { type: "placeholder", text: "hint" }
          ),
          { type: "unknownLeaf" }
        )
      )
    ).toBe(["macro text", "", "inside", "", "blocks", "", "inlinehint"].join("\n"));
  });
});
