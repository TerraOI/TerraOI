// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

let requestHeaders = new Headers();
vi.mock("next/headers", () => ({ headers: async () => requestHeaders }));
vi.mock("next/font/google", () => ({ Inter: () => ({ className: "inter-cls", variable: "inter-var" }) }));

import PrivacyPage from "./page";

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

async function renderFor(host: string | null) {
  requestHeaders = new Headers(host ? { host } : {});
  render(await PrivacyPage());
}

describe("/privacy", () => {
  it("serves the notice on terraoi.app", async () => {
    await renderFor("terraoi.app");
    expect(screen.getByRole("heading", { level: 1, name: "Privacy notice for pilot inquiries" })).toBeTruthy();
  });

  it.each(["company1.terraoi.app", "evil.test", null])("shows the unknown-address page on %s", async (host) => {
    await renderFor(host);
    expect(screen.getByRole("heading", { level: 1, name: "Workspace not found" })).toBeTruthy();
    expect(screen.queryByText(/Privacy notice/)).toBeNull();
  });

  // Builder review of #26, B1: the draft marker was compiled out of every non-dev build, so the
  // unapproved text would have shipped as final. It stays visible until the owner signs off.
  it("marks the text as a draft in production builds too", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await renderFor("terraoi.app");
    expect(screen.getByRole("note").textContent).toBe(
      "Draft: this notice is awaiting owner approval and may change before the form goes live.",
    );
  });
});
