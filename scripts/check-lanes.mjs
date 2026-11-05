#!/usr/bin/env node
// CI: fail a PR that edits both build lanes without the 'cross-lane' label (plan §20.1).
// Usage: BASE_REF=origin/main PR_LABELS='["x"]' node scripts/check-lanes.mjs
import { execFileSync } from "node:child_process";
import { checkLanes } from "./lanes.mjs";

const base = process.env.BASE_REF || "origin/main";
const labels = JSON.parse(process.env.PR_LABELS || "[]");
const out = execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], { encoding: "utf8" });
const changed = out.split("\n").filter(Boolean);
const result = checkLanes(changed, labels);
console.log(result.message);
process.exit(result.ok ? 0 : 1);
