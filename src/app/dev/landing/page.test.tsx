// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("next/font/google", () => ({ Inter: () => ({ className: "inter-cls", variable: "inter-var" }) }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

import DevLandingPage from "./page";

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("/dev/landing", () => {
  it("calls notFound outside development", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => DevLandingPage()).toThrow("NEXT_NOT_FOUND");
  });

  it("renders the landing sections in development", () => {
    vi.stubEnv("NODE_ENV", "development");
    render(DevLandingPage());
    expect(screen.getByRole("heading", { level: 1, name: "AI operations for air, surface, and subsurface." })).toBeTruthy();
    expect(screen.getByText("Operational Intelligence")).toBeTruthy();
    for (const title of ["Your documents, searchable", "Experts per service", "Review, then decide"]) {
      expect(screen.getByRole("heading", { level: 2, name: title })).toBeTruthy();
    }
    expect(screen.getByText("Client data stays with cleared providers")).toBeTruthy();
    expect(screen.getByLabelText("Go to your workspace")).toBeTruthy();
  });
});
