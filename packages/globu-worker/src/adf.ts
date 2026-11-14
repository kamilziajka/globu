export type AdfMark = { type: string; attrs?: Record<string, unknown> };
export type AdfNode = {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
  marks?: AdfMark[];
};

const INLINE = new Set(["text", "hardBreak", "mention", "emoji", "inlineCard", "status", "date", "placeholder"]);

function attr(node: AdfNode | AdfMark, name: string): string {
  const value = node.attrs?.[name];
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function kids(node: AdfNode): AdfNode[] {
  return node.content ?? [];
}

function fence(text: string, min: number): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  return "`".repeat(Math.max(min, longest + 1));
}

function inlineCode(text: string): string {
  if (!text.includes("`")) return `\`${text}\``;
  const ticks = fence(text, 1);
  return `${ticks} ${text} ${ticks}`;
}

function marked(text: string, marks: AdfMark[]): string {
  const code = marks.some((mark) => mark.type === "code");
  let out = code ? inlineCode(text) : text;
  for (const mark of marks) {
    if (mark.type === "strong") out = `**${out}**`;
    else if (mark.type === "em") out = `_${out}_`;
    else if (mark.type === "strike") out = `~~${out}~~`;
  }
  const link = marks.find((mark) => mark.type === "link");
  return link === undefined ? out : `[${out}](${attr(link, "href")})`;
}

function inline(nodes: AdfNode[]): string {
  return nodes.map(inlineNode).join("");
}

function inlineNode(node: AdfNode): string {
  switch (node.type) {
    case "text":
      return marked(node.text ?? "", node.marks ?? []);
    case "hardBreak":
      return "\n";
    case "mention": {
      const name = attr(node, "text") || attr(node, "id");
      return name.startsWith("@") ? name : `@${name}`;
    }
    case "emoji":
      return attr(node, "text") || attr(node, "shortName");
    case "inlineCard":
      return attr(node, "url");
    case "status":
      return `[${attr(node, "text")}]`;
    case "date": {
      const stamp = attr(node, "timestamp");
      return /^\d+$/.test(stamp) ? new Date(Number(stamp)).toISOString().slice(0, 10) : stamp;
    }
    default:
      return node.text ?? children(node);
  }
}

function children(node: AdfNode): string {
  const content = kids(node);
  return content.every((child) => INLINE.has(child.type)) ? inline(content) : blocks(content);
}

function blocks(nodes: AdfNode[], separator = "\n\n"): string {
  return nodes
    .map(block)
    .filter((text) => text !== "")
    .join(separator);
}

function indent(text: string, first: string): string {
  const pad = " ".repeat(first.length);
  return text
    .split("\n")
    .map((line, index) => (index === 0 ? first + line : line === "" ? "" : pad + line))
    .join("\n");
}

function prefixed(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => (line === "" ? prefix.trimEnd() : prefix + line))
    .join("\n");
}

function list(node: AdfNode, bullet: (index: number) => string): string {
  return kids(node)
    .map((item, index) => indent(blocks(kids(item), "\n"), bullet(index)))
    .join("\n");
}

function cell(node: AdfNode): string {
  return blocks(kids(node), " ").replace(/\n/g, " ").replace(/\|/g, "\\|");
}

function table(node: AdfNode): string {
  const rows = kids(node).map((row) => kids(row).map(cell));
  const width = Math.max(1, ...rows.map((row) => row.length));
  const line = (row: string[]) => `| ${Array.from({ length: width }, (_, index) => row[index] ?? "").join(" | ")} |`;
  const [head = [], ...body] = rows;
  return [line(head), line(Array(width).fill("---")), ...body.map(line)].join("\n");
}

function codeBlock(node: AdfNode): string {
  const text = kids(node)
    .map((child) => child.text ?? "")
    .join("");
  const ticks = fence(text, 3);
  return `${ticks}${attr(node, "language")}\n${text}\n${ticks}`;
}

function block(node: AdfNode): string {
  switch (node.type) {
    case "paragraph":
      return inline(kids(node));
    case "heading": {
      const level = Math.min(6, Math.max(1, Number(attr(node, "level")) || 1));
      return `${"#".repeat(level)} ${inline(kids(node))}`;
    }
    case "bulletList":
      return list(node, () => "- ");
    case "orderedList": {
      const start = Number(attr(node, "order")) || 1;
      return list(node, (index) => `${start + index}. `);
    }
    case "taskList":
    case "decisionList":
      return blocks(kids(node), "\n");
    case "taskItem":
      return indent(children(node), attr(node, "state") === "DONE" ? "- [x] " : "- [ ] ");
    case "decisionItem":
      return indent(children(node), "- ");
    case "codeBlock":
      return codeBlock(node);
    case "blockquote":
    case "panel":
      return prefixed(blocks(kids(node)), "> ");
    case "rule":
      return "---";
    case "table":
      return table(node);
    case "expand":
    case "nestedExpand": {
      const title = attr(node, "title");
      const body = blocks(kids(node));
      return title === "" ? body : `**${title}**\n\n${body}`;
    }
    case "blockCard":
    case "embedCard":
      return attr(node, "url");
    case "media": {
      const alt = attr(node, "alt");
      return alt === "" ? "(attachment)" : `(attachment: ${alt})`;
    }
    default:
      return inlineNode(node);
  }
}

export function adfToMarkdown(doc: AdfNode | null | undefined): string {
  return doc == null ? "" : block(doc).trim();
}
