// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import AdminHubPage from "./page";

describe("AdminHubPage (T-202 PR-2)", () => {
  it("names the three admin sections without inventing cross-tenant links", () => {
    render(<AdminHubPage />);
    expect(screen.getByRole("heading", { name: "Workspace admin" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Members and roles" }).getAttribute("href")).toBe(
      "/admin/members",
    );
    expect(screen.getByRole("link", { name: "Projects" }).getAttribute("href")).toBe("/admin/projects");
    expect(screen.getByRole("link", { name: "Collections" }).getAttribute("href")).toBe(
      "/admin/collections",
    );
  });
});
