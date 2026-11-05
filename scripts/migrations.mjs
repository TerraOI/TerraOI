// Migration ordering rules (docs/COORDINATION.md §3, AGENTS.md §6).
export const MIGRATION_RE = /^(\d{14})_[a-z0-9_]+\.sql$/;
const DIR = "supabase/migrations/";

const nameOf = (path) => path.slice(path.lastIndexOf("/") + 1);
const isMigration = (path) => path.startsWith(DIR) && path.endsWith(".sql");

/**
 * baseFiles: migration filenames on the base branch.
 * changes: [{ status: "A"|"M"|"D"|"R", path, oldPath? }] from `git diff --name-status`.
 * Returns { ok, problems: string[] }.
 */
export function checkMigrations(baseFiles, changes) {
  const problems = [];
  const base = new Set(baseFiles);
  const baseMax = baseFiles.map((f) => MIGRATION_RE.exec(f)?.[1]).filter(Boolean).sort().at(-1) ?? "";
  const added = [];

  for (const c of changes) {
    const touched = [c.path, c.oldPath].filter((p) => p && isMigration(p));
    if (touched.length === 0) continue;
    if (c.status !== "A" || touched.some((p) => base.has(nameOf(p)))) {
      problems.push(`${touched.join(" -> ")}: merged migrations must not be edited, renamed or deleted; add a new migration instead`);
      continue;
    }
    added.push(nameOf(c.path));
  }

  for (const name of added) {
    const m = MIGRATION_RE.exec(name);
    if (!m) {
      problems.push(`${name}: name must be YYYYMMDDHHMMSS_short_name.sql (UTC, lowercase)`);
    } else if (m[1] <= baseMax) {
      problems.push(`${name}: timestamp must be later than the newest migration on main (${baseMax}); rebase and rename`);
    }
  }
  if (added.length > 1) problems.push(`one migration per PR; this PR adds ${added.length}: ${added.join(", ")}`);
  return { ok: problems.length === 0, problems };
}
