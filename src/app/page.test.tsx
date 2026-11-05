// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

let requestHeaders = new Headers();
vi.mock("next/headers", () => ({ headers: async () => requestHeaders }));
vi.mock("next/font/google", () => ({ Inter: () => ({ className: "inter-cls", variable: "inter-var" }) }));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => {
    throw new Error("no Cloudflare context in tests");
  },
}));

import Home from "./page";

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

async function renderFor(headers: Record<string, string>) {
  requestHeaders = new Headers(headers);
  render(await Home());
}

const landingHeading = () =>
  screen.queryByRole("heading", { level: 1, name: "AI operations for air, surface, and subsurface." });
const unknownHeading = () => screen.queryByRole("heading", { level: 1, name: "Workspace not found" });

describe("/ host gating", () => {
  it.each(["terraoi.app", "www.terraoi.app"])("serves the landing page on %s", async (host) => {
    await renderFor({ host });
    expect(landingHeading()).toBeTruthy();
    expect(unknownHeading()).toBeNull();
  });

  it.each([
    ["a tenant host", { host: "company1.terraoi.app" }],
    ["the admin host", { host: "admin.terraoi.app" }],
    ["an unrelated host", { host: "evil.test" }],
    ["a preview alias", { host: "terraoi.terraoi.workers.dev" }],
    ["an explicit port", { host: "terraoi.app:8443" }],
    ["a missing host", {}],
    ["a spoofed X-Forwarded-Host", { host: "company1.terraoi.app", "x-forwarded-host": "terraoi.app" }],
  ])("shows the unknown-address page for %s", async (_label, headers) => {
    await renderFor(headers);
    expect(unknownHeading()).toBeTruthy();
    expect(landingHeading()).toBeNull();
    expect(document.body.textContent).not.toContain("Talk to us about a pilot");
  });
});
