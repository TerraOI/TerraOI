import { describe, expect, it } from "vitest";

import { SIGNIN_OUTCOMES, safeOutcome } from "./outcomes";

// A query parameter selects which safe message a page shows. Anything else has to fall away rather
// than be echoed, otherwise `?outcome=<anything>` becomes a text injection point on a branded page.
describe("safeOutcome", () => {
  it("accepts only the whitelisted values", () => {
    for (const outcome of SIGNIN_OUTCOMES) {
      expect(safeOutcome(outcome)).toBe(outcome);
    }
  });

  it("drops anything else, including near misses", () => {
    for (const raw of [
      "",
      "LINK_SENT",
      " link_sent",
      "link_sent ",
      "link_sent; redirect",
      "https://company1.terraoi.app",
      "Company1 Geotechnics",
      "toString",
      "__proto__",
      null,
      undefined,
      42,
      { outcome: "link_sent" },
    ]) {
      expect(safeOutcome(raw)).toBeNull();
    }
  });

  it("the enum contains no free-form text and no tenant or host names", () => {
    for (const outcome of SIGNIN_OUTCOMES) {
      expect(outcome).toMatch(/^[a-z_]{3,20}$/);
    }
  });
});
