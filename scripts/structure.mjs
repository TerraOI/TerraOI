// Repository structure rules (docs/REPO-STRUCTURE.md). Adding a top-level entry or platform
// module means editing this file in a PR the supervisor reviews; that is the point.

export const TOP_LEVEL = new Set([
  // config and entry docs
  ".claude", ".cursor", ".github", ".gitignore", ".nvmrc",
  "AGENTS.md", "CLAUDE.md", "README.md",
  "package.json", "pnpm-lock.yaml", "tsconfig.json", "eslint.config.mjs", "vitest.config.ts",
  "next.config.ts", "open-next.config.ts", "wrangler.jsonc",
  // source and assets
  "src", "supabase", "scripts", "docs", "brand", "public",
  // planned by plan §3.3 (allowed before they exist)
  "workers", "localbox", "evals",
]);

export const PLATFORM_MODULES = new Set([
  "tenancy", "identity", "policy", "branding", "services", "chat", "forms", "notifications", "approvals",
  "knowledge", "retrieval", "agents", "gateway", "evals", "budgets", "audit", "connectors",
]);

export const REQUIRED_FILES = [
  "README.md", "AGENTS.md", "CLAUDE.md",
  "docs/README.md", "docs/COORDINATION.md", "docs/REPO-STRUCTURE.md",
  "brand/README.md", "scripts/README.md",
  ".github/CODEOWNERS", ".github/pull_request_template.md",
];

const NAMING = [
  { dir: "docs/tasks/", re: /^(_TEMPLATE|T-\d{3}-[a-z0-9-]+)\.md$/, hint: "T-123-short-name.md" },
  { dir: "docs/decisions/", re: /^(README|\d{4}-[a-z0-9-]+)\.md$/, hint: "0001-short-name.md" },
  { dir: "docs/status/", re: /^\d{4}-W\d{2}\.md$/, hint: "YYYY-Www.md (ISO week)" },
  { dir: "docs/plan/", re: /^TerraOI-plan-v\d+(\.\d+)*\.md$/, hint: "TerraOI-plan-vX.Y.md", skip: "docs/plan/archive/" },
];

const JUNK = [/(^|\/)\.DS_Store$/, /(^|\/)Thumbs\.db$/, /\.log$/, /(^|\/)\.env(\.|$)(?!example)/, /(^|\/)\.dev\.vars/, /(^|\/)node_modules\//];

const PACKET_STATUS = /Status: (ready|in progress|in review|blocked|done)\b/;

/** paths: repo-relative file paths. read(path) -> string. Returns problems[]. */
export function checkStructure(paths, read) {
  const problems = [];
  const set = new Set(paths);

  for (const top of new Set(paths.map((p) => p.split("/")[0]))) {
    if (!TOP_LEVEL.has(top)) problems.push(`${top}: not an allowed top-level entry (see docs/REPO-STRUCTURE.md; new ones need supervisor approval)`);
  }
  for (const f of REQUIRED_FILES) if (!set.has(f)) problems.push(`${f}: required file is missing`);

  for (const p of paths) {
    if (JUNK.some((re) => re.test(p))) problems.push(`${p}: must not be committed`);
    const mod = /^src\/platform\/([^/]+)\//.exec(p)?.[1];
    if (mod && !PLATFORM_MODULES.has(mod)) problems.push(`${p}: unknown platform module '${mod}' (plan §3.3)`);
    for (const rule of NAMING) {
      if (!p.startsWith(rule.dir) || (rule.skip && p.startsWith(rule.skip))) continue;
      const rest = p.slice(rule.dir.length);
      if (rest.includes("/") || !rule.re.test(rest)) problems.push(`${p}: name must match ${rule.hint}`);
    }
    if (/^docs\/tasks\/T-\d{3}-/.test(p) && !PACKET_STATUS.test(read(p))) {
      problems.push(`${p}: packet needs a 'Status: ready|in progress|in review|blocked|done' line`);
    }
  }
  return problems;
}
