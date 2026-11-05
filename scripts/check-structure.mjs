#!/usr/bin/env node
// Fails when the repository drifts from docs/REPO-STRUCTURE.md. Checks tracked and new (non-ignored) files.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { checkStructure } from "./structure.mjs";

const paths = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" })
  .split("\n").filter(Boolean)
  .filter((p) => { try { readFileSync(p); return true; } catch { return false; } }); // skip files deleted in the working tree
const problems = checkStructure(paths, (p) => readFileSync(p, "utf8"));
if (problems.length) {
  console.error(`Repository structure check failed (${problems.length}):\n` + problems.map((p) => `- ${p}`).join("\n"));
  process.exit(1);
}
console.log(`Repository structure check passed (${paths.length} files).`);
