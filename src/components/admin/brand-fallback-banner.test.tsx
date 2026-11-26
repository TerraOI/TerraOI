// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BrandFallbackBanner } from "./brand-fallback-banner";

describe("BrandFallbackBanner (T-202 / #62)", () => {
  it("renders the loader note as a status region without inventing customer data", () => {
    const note = "This workspace has not configured branding yet, so platform branding is shown.";
    render(<BrandFallbackBanner note={note} />);
    expect(screen.getByRole("status").textContent).toContain("Branding fallback");
    expect(screen.getByRole("status").textContent).toContain(note);
    expect(screen.getByRole("status").textContent).not.toMatch(/Company1|postgres|connection/i);
  });
});
