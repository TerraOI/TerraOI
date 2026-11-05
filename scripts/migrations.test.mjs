import { describe, expect, it } from "vitest";
import { checkMigrations } from "./migrations.mjs";

const base = ["20261110090000_tenancy_core.sql"];
const add = (name) => ({ status: "A", path: `supabase/migrations/${name}` });

describe("checkMigrations", () => {
  it("accepts one new, later, well-named migration", () =>
    expect(checkMigrations(base, [add("20261111080000_knowledge.sql")]).ok).toBe(true));
  it("ignores non-migration changes", () =>
    expect(checkMigrations(base, [{ status: "M", path: "src/app/page.tsx" }]).ok).toBe(true));
  it("rejects editing a merged migration", () =>
    expect(checkMigrations(base, [{ status: "M", path: "supabase/migrations/20261110090000_tenancy_core.sql" }]).ok).toBe(false));
  it("rejects deleting or renaming a merged migration", () => {
    expect(checkMigrations(base, [{ status: "D", path: "supabase/migrations/20261110090000_tenancy_core.sql" }]).ok).toBe(false);
    expect(checkMigrations(base, [{ status: "R", oldPath: "supabase/migrations/20261110090000_tenancy_core.sql", path: "supabase/migrations/20261112000000_x.sql" }]).ok).toBe(false);
  });
  it("rejects a timestamp not later than main", () =>
    expect(checkMigrations(base, [add("20261110085959_late.sql")]).problems[0]).toMatch(/later than/));
  it("rejects bad names", () => expect(checkMigrations(base, [add("2026_Knowledge.sql")]).ok).toBe(false));
  it("rejects more than one migration per PR", () =>
    expect(checkMigrations(base, [add("20261111080000_a.sql"), add("20261111080001_b.sql")]).problems.at(-1)).toMatch(/one migration per PR/));
  it("accepts the first migration when main has none", () =>
    expect(checkMigrations([], [add("20261110090000_tenancy_core.sql")]).ok).toBe(true));
});
