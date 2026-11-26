// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import { CreateProjectForm } from "./create-project-form";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("CreateProjectForm (T-202 PR-2b)", () => {
  it("posts key, name, visibility and csrf without an organisation id", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return Response.json(
        { ok: true, projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
        { status: 201 },
      );
    });

    render(<CreateProjectForm csrfToken="csrf-token-1" />);
    fireEvent.change(screen.getByLabelText("Key"), { target: { value: "site-alpha" } });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Site Alpha" } });
    fireEvent.change(screen.getByLabelText("Visibility"), { target: { value: "project" } });
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.url).toBe("/admin/projects/create");
    expect(calls[0]?.init?.method).toBe("POST");
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      csrfToken: "csrf-token-1",
      key: "site-alpha",
      name: "Site Alpha",
      visibility: "project",
    });
    expect(JSON.stringify(body)).not.toMatch(/organisation|organization/i);
    expect((await screen.findByRole("status")).textContent).toContain("Project created.");
  });

  it("surfaces the server message on refusal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { ok: false, code: "tenancy", message: "You do not have permission to perform this action in this workspace." },
          { status: 403 },
        ),
      ),
    );

    render(<CreateProjectForm csrfToken="csrf-token-1" />);
    fireEvent.change(screen.getByLabelText("Key"), { target: { value: "site-beta" } });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Site Beta" } });
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "You do not have permission to perform this action in this workspace.",
    );
  });
});
