// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { ROUTED_HOST_HEADER } from "@/platform/tenancy/page-host";

let requestHeaders = new Headers();
let pathname = "/login";

vi.mock("next/headers", () => ({ headers: async () => requestHeaders }));
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));
vi.mock("next/font/google", () => ({
  Inter: () => ({ className: "inter-cls", variable: "inter-var" }),
}));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => {
    throw new Error("no Cloudflare context in tests");
  },
}));

const loadTenantBrand = vi.fn();
vi.mock("@/platform/branding/load-tenant-brand", () => ({
  loadTenantBrand: (...args: unknown[]) => loadTenantBrand(...args),
}));

import { platformBrand } from "@/platform/branding/kit-brand";
import TenantLayout from "./layout";

afterEach(() => {
  cleanup();
  requestHeaders = new Headers();
  pathname = "/login";
  loadTenantBrand.mockReset();
  vi.unstubAllEnvs();
});

describe("tenant layout brand host", () => {
  it("loads the brand for the proxy-stamped host and ignores a client host header", async () => {
    loadTenantBrand.mockResolvedValue({ brand: platformBrand(), origin: "platform", fallback: null });
    requestHeaders = new Headers({
      [ROUTED_HOST_HEADER]: "company1.terraoi.app",
      host: "company2.terraoi.app",
    });
    render(await TenantLayout({ children: <p>Login child</p> }));
    expect(loadTenantBrand).toHaveBeenCalledWith({ host: "company1.terraoi.app" });
    expect(screen.getByText("Login child")).toBeTruthy();
    expect(screen.queryByText("No services are available.")).toBeNull();
  });

  it("still renders the child when the proxy stamped no host", async () => {
    loadTenantBrand.mockResolvedValue({ brand: platformBrand(), origin: "platform", fallback: null });
    render(await TenantLayout({ children: <p>Login child</p> }));
    expect(loadTenantBrand).toHaveBeenCalledWith({ host: "" });
    expect(screen.getByText("Login child")).toBeTruthy();
  });
});
