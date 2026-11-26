import { describe, expect, it } from "vitest";

import { chatPostgrestBase } from "./adapters";

describe("chatPostgrestBase — chat RPCs go to PostgREST, not the project root (R-5)", () => {
  it("appends /rest/v1 to the project URL that Auth also uses", () => {
    expect(chatPostgrestBase({ SUPABASE_URL: "https://ref.supabase.co" })).toBe(
      "https://ref.supabase.co/rest/v1",
    );
    expect(
      chatPostgrestBase({ SUPABASE_URL: "https://ref.supabase.co/" }),
    ).toBe("https://ref.supabase.co/rest/v1");
  });

  it("keeps a URL that already names /rest/v1", () => {
    expect(
      chatPostgrestBase({ SUPABASE_URL: "https://ref.supabase.co/rest/v1" }),
    ).toBe("https://ref.supabase.co/rest/v1");
  });

  it("returns undefined when the binding is missing or blank, so chat stays not-configured", () => {
    expect(chatPostgrestBase({})).toBeUndefined();
    expect(chatPostgrestBase({ SUPABASE_URL: "  " })).toBeUndefined();
  });
});
