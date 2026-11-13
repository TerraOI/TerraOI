// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { ROUTED_HOST_HEADER } from "@/platform/tenancy/page-host";

let requestHeaders = new Headers();
let searchParams: { outcome?: string | string[] } = {};

vi.mock("next/headers", () => ({ headers: async () => requestHeaders }));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  },
}));
vi.mock("next/font/google", () => ({
  Inter: () => ({ className: "inter-cls", variable: "inter-var" }),
}));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => {
    throw new Error("no Cloudflare context in tests");
  },
}));

const buildLoginView = vi.fn();
vi.mock("@/platform/identity/login-view", () => ({
  buildLoginView: (...args: unknown[]) => buildLoginView(...args),
}));
vi.mock("@/platform/identity/adapters", () => ({
  buildIdentityPorts: () => ({ mocked: true }),
}));

import LoginPage, { loginPageRequest, renderLoginSurface } from "./page";

afterEach(() => {
  cleanup();
  requestHeaders = new Headers();
  searchParams = {};
  buildLoginView.mockReset();
  vi.unstubAllEnvs();
});

async function renderPage(headers: Record<string, string>, outcome?: string) {
  requestHeaders = new Headers(headers);
  searchParams = outcome === undefined ? {} : { outcome };
  render(await LoginPage({ searchParams: Promise.resolve(searchParams) }));
}

describe("loginPageRequest (ADR-0006 page host)", () => {
  it("builds https URL from the proxy stamp and forwards the cookie", () => {
    const headersList = new Headers({
      [ROUTED_HOST_HEADER]: "company1.terraoi.app",
      cookie: "a=1",
    });
    const request = loginPageRequest(headersList, "/login?outcome=link_sent");
    expect(request.url).toBe("https://company1.terraoi.app/login?outcome=link_sent");
    expect(request.headers.get("cookie")).toBe("a=1");
  });

  it("fails closed to invalid: when the proxy did not stamp a host", () => {
    expect(loginPageRequest(new Headers()).url).toBe("invalid:");
  });
});

describe("/login surface selection", () => {
  it("shows the unknown-address page when the gate says so", async () => {
    buildLoginView.mockResolvedValue({ kind: "unknown_address" });
    await renderPage({ [ROUTED_HOST_HEADER]: "nosuch.terraoi.app" });
    expect(screen.getByRole("heading", { name: "Workspace not found" })).toBeTruthy();
    expect(screen.queryByLabelText("Work email")).toBeNull();
  });

  it("shows the unknown-address page for a suspended tenant", async () => {
    buildLoginView.mockResolvedValue({ kind: "tenant_not_live" });
    await renderPage({ [ROUTED_HOST_HEADER]: "company1.terraoi.app" });
    expect(screen.getByRole("heading", { name: "Workspace not found" })).toBeTruthy();
  });

  it("wires the magic-link form to POST /auth/magic-link with the CSRF token", async () => {
    buildLoginView.mockResolvedValue({
      kind: "sign_in",
      csrfToken: "csrf-test-token",
      outcome: null,
    });
    await renderPage({ [ROUTED_HOST_HEADER]: "company1.terraoi.app" });
    expect(screen.getByRole("heading", { name: /^Sign in to / })).toBeTruthy();
    const form = screen.getByLabelText("Work email").closest("form");
    expect(form?.getAttribute("action")).toBe("/auth/magic-link");
    expect(form?.getAttribute("method")).toBe("post");
    const csrf = form?.querySelector('input[name="csrf_token"]') as HTMLInputElement | null;
    expect(csrf?.value).toBe("csrf-test-token");
  });

  it("hides the magic-link form when CSRF cannot be issued", async () => {
    buildLoginView.mockResolvedValue({ kind: "sign_in", csrfToken: null, outcome: null });
    await renderPage({ [ROUTED_HOST_HEADER]: "company1.terraoi.app" });
    expect(screen.queryByLabelText("Work email")).toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(/temporarily unavailable/i);
  });

  it("shows check-email after a link_sent outcome", async () => {
    buildLoginView.mockResolvedValue({
      kind: "sign_in",
      csrfToken: "csrf-test-token",
      outcome: "link_sent",
    });
    await renderPage({ [ROUTED_HOST_HEADER]: "company1.terraoi.app" }, "link_sent");
    expect(screen.getByRole("heading", { name: "Check your email" })).toBeTruthy();
    expect(screen.queryByLabelText("Work email")).toBeNull();
  });

  it("shows no-access for a non-member session", async () => {
    buildLoginView.mockResolvedValue({ kind: "no_access", reason: "not_a_member" });
    await renderPage({ [ROUTED_HOST_HEADER]: "company1.terraoi.app" });
    expect(screen.getByRole("heading", { name: "No access" })).toBeTruthy();
    expect(screen.queryByLabelText("Work email")).toBeNull();
  });

  it("redirects signed-in members away from /login", async () => {
    await expect(
      renderLoginSurface({ view: { kind: "signed_in" }, host: "company1.terraoi.app" }),
    ).rejects.toThrow("NEXT_REDIRECT:/");
  });

  it("passes the search-param outcome into buildLoginView", async () => {
    buildLoginView.mockResolvedValue({
      kind: "sign_in",
      csrfToken: "csrf-test-token",
      outcome: "rate_limited",
    });
    await renderPage({ [ROUTED_HOST_HEADER]: "company1.terraoi.app" }, "rate_limited");
    expect(buildLoginView).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "rate_limited" }),
    );
    expect(screen.getByRole("status").textContent).toMatch(/Too many requests/i);
  });
});
