// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("next/font/google", () => ({
  Inter: () => ({ className: "inter-cls", variable: "inter-var" }),
  IBM_Plex_Mono: () => ({ className: "mono-cls", variable: "mono-var" }),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

import DevSignInPage from "./page";

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("/dev/sign-in", () => {
  it("calls notFound outside development", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => DevSignInPage()).toThrow("NEXT_NOT_FOUND");
    vi.stubEnv("NODE_ENV", "test");
    expect(() => DevSignInPage()).toThrow("NEXT_NOT_FOUND");
  });

  it("renders all three brand modes in development", () => {
    vi.stubEnv("NODE_ENV", "development");
    render(DevSignInPage());
    expect(screen.getByRole("heading", { name: "Sign in to TerraOI" })).toBeTruthy();
    expect(screen.getAllByRole("heading", { name: "Sign in to Company1" })).toHaveLength(2);
    expect(screen.getAllByText("Powered by TerraOI")).toHaveLength(1);
  });
});
