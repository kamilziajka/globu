import { describe, expect, it } from "vitest";
import { isMapping, parseFrontmatter, stringifyFrontmatter, textOf } from "./frontmatter.js";

describe("parseFrontmatter", () => {
  it("splits frontmatter from the body", () => {
    expect(parseFrontmatter('---\ntype: "Note"\n---\n\nBody\n')).toEqual({
      data: { type: "Note" },
      body: "\nBody\n",
      hasFrontmatter: true
    });
  });

  it("returns the whole content when there is no frontmatter", () => {
    expect(parseFrontmatter("# Title\n")).toEqual({ data: {}, body: "# Title\n", hasFrontmatter: false });
  });

  it("treats frontmatter that is not a mapping as empty", () => {
    expect(parseFrontmatter("---\n- a\n- b\n---\nBody").data).toEqual({});
  });

  it("ignores a byte order mark before the frontmatter", () => {
    expect(parseFrontmatter('\uFEFF---\nokf_version: "0.2"\n---\nBody')).toEqual({
      data: { okf_version: "0.2" },
      body: "Body",
      hasFrontmatter: true
    });
  });

  it("throws on invalid YAML", () => {
    expect(() => parseFrontmatter("---\nkey: [unclosed\n---\n")).toThrow();
  });
});

describe("stringifyFrontmatter", () => {
  it("round-trips and normalises leading blank lines", () => {
    const text = stringifyFrontmatter({ name: "demo", list: ["a"] }, "\n\n# Title\n");
    expect(text).toBe("---\nname: demo\nlist:\n  - a\n---\n\n# Title\n");
    expect(parseFrontmatter(text).data).toEqual({ name: "demo", list: ["a"] });
  });
});

describe("helpers", () => {
  it("isMapping accepts plain objects only", () => {
    expect(isMapping({})).toBe(true);
    expect(isMapping([])).toBe(false);
    expect(isMapping(null)).toBe(false);
    expect(isMapping("text")).toBe(false);
  });

  it("textOf returns strings and blanks everything else", () => {
    expect(textOf("x")).toBe("x");
    expect(textOf(3)).toBe("");
  });
});
