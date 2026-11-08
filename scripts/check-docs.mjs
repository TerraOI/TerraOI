#!/usr/bin/env node
// Two checks on the live documents, in one step (issue #61 asked for the second to be wired here
// rather than as a step nobody runs):
//   1. a relative Markdown link that points at a missing file, and
//   2. double-encoded UTF-8 - the `Â·` / `â€”` shape a tool leaves behind when it decodes UTF-8 with
//      the console codepage and writes it back. Three packet files on three branches carried it and
//      every other check passed, so this is the check that makes it unmergeable.
// Archived plans are frozen history and are skipped (plan §19).
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import { escapeNonAscii, findMojibake, looksBinary } from "./encoding.mjs";

const SKIP = new Set(["node_modules", ".git", ".next", ".open-next", ".wrangler", "archive"]);

const markdown = [];
const textFiles = [];
// Extensions that are text by contract. Anything else is skipped rather than guessed, and the binary
// sniff below is the backstop for a file with the wrong name.
const TEXT_EXT = /\.(md|markdown|ts|tsx|mts|cts|js|mjs|cjs|json|jsonc|sql|yaml|yml|toml|css|txt|nvmrc)$/i;

(function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      walk(p);
      continue;
    }
    if (name.endsWith(".md")) markdown.push(p);
    if (TEXT_EXT.test(name)) textFiles.push(p);
  }
})(".");

const missing = [];
const linkRe = /\]\(([^)\s]+)\)/g;
for (const file of markdown) {
  const text = readFileSync(file, "utf8").replace(/```[\s\S]*?```/g, "");
  for (const [, raw] of text.matchAll(linkRe)) {
    if (/^(https?:|mailto:|#)/.test(raw)) continue;
    const target = decodeURIComponent(raw.split("#")[0]);
    if (target && !existsSync(resolve(dirname(file), target))) missing.push(`${file} -> ${raw}`);
  }
}
if (missing.length) {
  console.error(`Broken relative links (${missing.length}):\n` + missing.join("\n"));
  process.exit(1);
}

const encoding = [];
let scanned = 0;
for (const file of textFiles) {
  const buffer = readFileSync(file);
  if (looksBinary(buffer)) continue;
  scanned += 1;
  for (const hit of findMojibake(buffer.toString("utf8"))) {
    encoding.push(`${file}:${hit.line}:${hit.column}  ${hit.label}  ${escapeNonAscii(hit.snippet)}`);
  }
}
if (encoding.length) {
  // The offending bytes are escaped in the report: a build log that re-emits them can be piped back
  // into a shell and mangled a second time, which is how this class started.
  console.error(
    `Double-encoded UTF-8 (${encoding.length} places, #61). Repair by checking the file out from ` +
      "`origin/main` and re-applying only the intended edit:\n" +
      encoding.join("\n"),
  );
  process.exit(1);
}

console.log(`Docs link check passed (${markdown.length} files).`);
console.log(`Encoding check passed (${scanned} text files scanned; code spans and fenced blocks exempt).`);
