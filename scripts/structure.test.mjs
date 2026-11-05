import { describe, expect, it } from "vitest";
import { REQUIRED_FILES, checkStructure } from "./structure.mjs";

const read = () => "Status: ready";
const ok = [...REQUIRED_FILES, "src/app/page.tsx", "docs/tasks/T-101-host-resolver.md", "docs/status/2026-W45.md"];

describe("checkStructure", () => {
  it("accepts a well-organized tree", () => expect(checkStructure(ok, read)).toEqual([]));
  it("rejects unknown top-level folders", () =>
    expect(checkStructure([...ok, "misc/notes.txt"], read)[0]).toMatch(/top-level/));
  it("reports missing required files", () =>
    expect(checkStructure(ok.filter((p) => p !== "docs/README.md"), read)[0]).toMatch(/docs\/README.md/));
  it("rejects junk files", () =>
    expect(checkStructure([...ok, "brand/.DS_Store", "src/.env.local"], read)).toHaveLength(2));
  it("allows .env.example", () => expect(checkStructure([...ok, "src/.env.example"], read)).toEqual([]));
  it("enforces naming in docs folders", () => {
    expect(checkStructure([...ok, "docs/tasks/task101.md"], read)[0]).toMatch(/T-123/);
    expect(checkStructure([...ok, "docs/status/week45.md"], read)[0]).toMatch(/YYYY-Www/);
  });
  it("rejects unknown platform modules", () =>
    expect(checkStructure([...ok, "src/platform/misc/x.ts"], read)[0]).toMatch(/unknown platform module/));
  it("requires a status line in task packets", () =>
    expect(checkStructure(ok, () => "no status")[0]).toMatch(/Status/));
  it("skips archived plans", () =>
    expect(checkStructure([...ok, "docs/plan/archive/old-notes.md"], read)).toEqual([]));
});
