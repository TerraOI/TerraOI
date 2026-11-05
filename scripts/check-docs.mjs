#!/usr/bin/env node
// Fails if a relative Markdown link in the live docs points to a missing file.
// Archived plans are frozen history and are skipped (plan §19).
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

const SKIP = new Set(["node_modules", ".git", ".next", ".open-next", ".wrangler", "archive"]);
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name.endsWith(".md")) files.push(p);
  }
})(".");

const missing = [];
const linkRe = /\]\(([^)\s]+)\)/g;
for (const file of files) {
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
console.log(`Docs link check passed (${files.length} files).`);
