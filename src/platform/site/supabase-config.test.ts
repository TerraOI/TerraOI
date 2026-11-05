import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// ADR-0002: the intake schema must never be reachable through the Supabase Data API.
// The hosted project's API settings must match this file (human check, see the ADR).
function apiSchemas(toml: string): string[] | null {
  const api = toml.split(/^\[/m).find((section) => section.startsWith("api]"));
  const line = api?.match(/^schemas\s*=\s*(\[.*\])\s*$/m)?.[1];
  return line ? (JSON.parse(line) as string[]) : null;
}

describe("supabase/config.toml", () => {
  it("exposes only public and graphql_public through the API", () => {
    const toml = readFileSync(new URL("../../../supabase/config.toml", import.meta.url), "utf8");
    expect(apiSchemas(toml)).toEqual(["public", "graphql_public"]);
  });

  it("the parser catches an exposed intake schema", () => {
    expect(apiSchemas('[api]\nschemas = ["public", "graphql_public", "intake"]\n')).toContain("intake");
  });
});
