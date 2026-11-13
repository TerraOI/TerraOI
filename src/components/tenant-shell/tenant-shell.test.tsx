// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

let pathname = "/";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));
vi.mock("next/font/google", () => ({
  Inter: () => ({ className: "inter-cls", variable: "inter-var" }),
}));

import { company1Customer, company1Powered } from "@/components/auth/fixtures";
import { TenantFrame } from "./tenant-frame";
import { TenantShell } from "./tenant-shell";

afterEach(() => {
  cleanup();
  pathname = "/";
});

describe("TenantShell", () => {
  it("shows only this workspace's brand, with no services or projects invented", () => {
    render(
      <TenantShell brand={company1Customer}>
        <p>Workspace body</p>
      </TenantShell>,
    );
    expect(screen.getByRole("banner").textContent).toContain("Company1");
    expect(screen.getByText("Workspace body")).toBeTruthy();
    expect(screen.getByText("No services are available.")).toBeTruthy();
    expect(screen.getByText("No projects are available.")).toBeTruthy();
    expect(document.body.textContent).not.toContain("TerraOI");
    expect(document.body.textContent).not.toContain("Company2");
  });

  it("shows the powered-by line only when the brand asks for it", () => {
    render(
      <TenantShell brand={company1Powered}>
        <p>Workspace body</p>
      </TenantShell>,
    );
    expect(screen.getByText("Powered by TerraOI")).toBeTruthy();
  });

  it("posts sign-out to the auth route with the issued CSRF token", () => {
    render(
      <TenantShell brand={company1Customer} csrfToken="csrf-shell">
        <p>Workspace body</p>
      </TenantShell>,
    );
    const form = screen.getByRole("button", { name: "Sign out" }).closest("form");
    expect(form?.getAttribute("action")).toBe("/auth/sign-out");
    expect(form?.getAttribute("method")).toBe("post");
    expect((form?.querySelector('input[name="csrf_token"]') as HTMLInputElement).value).toBe("csrf-shell");
  });

  it("omits sign-out when no CSRF token was issued", () => {
    render(
      <TenantShell brand={company1Customer}>
        <p>Workspace body</p>
      </TenantShell>,
    );
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });
});

describe("TenantFrame", () => {
  it("leaves the login page without workspace chrome", () => {
    pathname = "/login";
    render(
      <TenantFrame brand={company1Customer} csrfToken="csrf-shell">
        <h1>Sign in to Company1</h1>
      </TenantFrame>,
    );
    expect(screen.getByRole("heading", { name: "Sign in to Company1" })).toBeTruthy();
    expect(screen.queryByText("No services are available.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });

  it("wraps every other tenant route in the shell", () => {
    pathname = "/chat";
    render(
      <TenantFrame brand={company1Customer}>
        <p>Chat later</p>
      </TenantFrame>,
    );
    expect(screen.getByText("Chat later")).toBeTruthy();
    expect(screen.getByText("No services are available.")).toBeTruthy();
  });
});
