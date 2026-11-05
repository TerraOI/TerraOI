import { describe, expect, it } from "vitest";
import { PASTED_ADDRESS_HINT, workspaceUrl } from "./workspace";

describe("workspaceUrl", () => {
  it("turns a slug into the workspace URL", () => {
    expect(workspaceUrl("company1")).toEqual({ ok: true, url: "https://company1.terraoi.app/" });
    expect(workspaceUrl("a")).toEqual({ ok: true, url: "https://a.terraoi.app/" });
    expect(workspaceUrl("a-1")).toEqual({ ok: true, url: "https://a-1.terraoi.app/" });
  });

  it("accepts a 63-character slug", () => {
    expect(workspaceUrl("a".repeat(63)).ok).toBe(true);
  });

  it("rejects Company1, a.b, -x and a 64-char slug", () => {
    for (const bad of ["Company1", "a.b", "-x", "x-", "a".repeat(64), "", "  ", "comp any"]) {
      expect(workspaceUrl(bad).ok, bad).toBe(false);
    }
  });

  it("explains the expected format for a pasted address", () => {
    expect(PASTED_ADDRESS_HINT).toBe("Enter just the first part of your address, like company1.");
    for (const pasted of ["https://company1.terraoi.app", "company1.terraoi.app", "https://company1.terraoi.app/login"]) {
      expect(workspaceUrl(pasted)).toEqual({ ok: false, hint: PASTED_ADDRESS_HINT });
    }
  });

  it("gives a format hint, never a lookup result, for other invalid input", () => {
    const result = workspaceUrl("Company1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.hint).toBe("Use lowercase letters, numbers and hyphens, like company1.");
      expect(result.hint).not.toMatch(/not found|exist/i);
    }
  });
});
