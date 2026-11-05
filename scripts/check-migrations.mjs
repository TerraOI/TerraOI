#!/usr/bin/env node
// CI: migration ordering and immutability (docs/COORDINATION.md §3).
// Usage: BASE_REF=origin/main node scripts/check-migrations.mjs
import { execFileSync } from "node:child_process";
import { checkMigrations } from "./migrations.mjs";

const base = process.env.BASE_REF || "origin/main";
const git = (...args) => execFileSync("git", args, { encoding: "utf8" });

const baseFiles = git("ls-tree", "--name-only", `${base}`, "supabase/migrations/")
  .split("\n").filter(Boolean).map((p) => p.slice(p.lastIndexOf("/") + 1)).filter((n) => n.endsWith(".sql"));
const changes = git("diff", "--name-status", "-M", `${base}...HEAD`, "--", "supabase/migrations/")
  .split("\n").filter(Boolean).map((line) => {
    const [status, a, b] = line.split("\t");
    return status.startsWith("R") ? { status: "R", oldPath: a, path: b } : { status: status[0], path: a };
  });

const result = checkMigrations(baseFiles, changes);
if (result.ok) {
  console.log(`Migration check passed (${changes.length} migration change(s); ${baseFiles.length} on ${base}).`);
} else {
  console.error("Migration check failed:\n" + result.problems.map((p) => `- ${p}`).join("\n"));
  process.exit(1);
}
