import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML, { type Document, isMap, isScalar, isSeq, Scalar } from "yaml";
import { RESERVED_FILENAMES, VERSION } from "./constants.js";
import { isInside, ownerBase } from "./scan.js";

export type StampField = "generated" | "verified";
export type Stamp = { by: string; at: string };
export type StampResult = { file: string; field: StampField } & Stamp;

const HEADER_RE = /^(﻿?---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$)[\s\S]*)$/;

export function stampTime(now: number = Date.now()): string {
  return new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function generatedActor(): string {
  return `globu/${VERSION}`;
}

function gitUserName(dir: string): string {
  try {
    return execFileSync("git", ["-C", dir, "config", "user.name"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return "";
  }
}

function loginName(): string {
  try {
    return os.userInfo().username.trim();
  } catch {
    return "";
  }
}

export function humanId(dir: string): string {
  const id = gitUserName(dir) || loginName();
  if (id === "") throw new Error(`cannot tell who verified: set git user.name in ${dir}`);
  return id;
}

function stampNode(doc: Document, stamp: Stamp) {
  const by = new Scalar(stamp.by);
  by.type = Scalar.QUOTE_DOUBLE;
  return doc.createNode({ by, at: stamp.at }, { flow: true });
}

function applyStamp(doc: Document, file: string, field: StampField, stamp: Stamp): void {
  const node = stampNode(doc, stamp);
  if (field === "generated") {
    doc.set("generated", node);
    return;
  }
  const current = doc.get("verified", true);
  if (current === undefined || (isScalar(current) && current.value === null)) {
    doc.set("verified", doc.createNode([node]));
  } else if (isSeq(current)) {
    current.add(node);
  } else if (isMap(current)) {
    doc.set("verified", doc.createNode([current, node]));
  } else {
    throw new Error(`${file}: \`verified\` is neither a mapping nor a list, fix it before adding a verification`);
  }
}

function conceptDoc(file: string): void {
  const docsDir = ownerBase(file);
  const concept = file.endsWith(".md") && !RESERVED_FILENAMES.has(path.basename(file));
  if (!concept || docsDir === null || !isInside(docsDir, file)) {
    throw new Error(`${file} is not a concept doc of an OKF base`);
  }
}

export function stampedContent(file: string, field: StampField, stamp: Stamp): string {
  conceptDoc(file);
  const raw = fs.readFileSync(file, "utf8");
  const match = HEADER_RE.exec(raw);
  if (match === null) throw new Error(`${file} has no YAML frontmatter block`);
  const doc = YAML.parseDocument(match[2]);
  if (doc.errors.length > 0) throw new Error(`${file}: unparseable YAML frontmatter: ${doc.errors[0].message}`);
  if (!isMap(doc.contents)) throw new Error(`${file}: the frontmatter is not a mapping`);
  applyStamp(doc, file, field, stamp);
  return `${match[1]}${doc.toString({ lineWidth: 0 }).trimEnd()}${match[3]}`;
}

export function stampDocs(files: string[], field: StampField, stampFor: (file: string) => Stamp): StampResult[] {
  const planned = files.map((file) => {
    const stamp = stampFor(file);
    return { file, stamp, content: stampedContent(file, field, stamp) };
  });
  for (const { file, content } of planned) fs.writeFileSync(file, content);
  return planned.map(({ file, stamp }) => ({ file, field, ...stamp }));
}
