// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import { CreateCollectionForm } from "./create-collection-form";
import { CreateProjectForm } from "./create-project-form";
import { MembershipRoleForm } from "./membership-role-form";

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

describe("CreateCollectionForm (T-202 PR-2c)", () => {
  it("posts collection fields and null projectId without an organisation id", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return Response.json(
        { ok: true, collectionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
        { status: 201 },
      );
    });

    render(<CreateCollectionForm csrfToken="csrf-token-2" />);
    fireEvent.change(screen.getByLabelText("Key"), { target: { value: "uav-ops" } });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "UAV ops" } });
    fireEvent.change(screen.getByLabelText("Service"), { target: { value: "gpr" } });
    fireEvent.change(screen.getByLabelText("Data class"), { target: { value: "public" } });
    fireEvent.click(screen.getByRole("button", { name: "Create collection" }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.url).toBe("/admin/collections/create");
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      csrfToken: "csrf-token-2",
      key: "uav-ops",
      name: "UAV ops",
      service: "gpr",
      dataClass: "public",
      projectId: null,
    });
    expect(JSON.stringify(body)).not.toMatch(/organisation|organization/i);
    expect((await screen.findByRole("status")).textContent).toContain("Collection created.");
  });
});

describe("MembershipRoleForm (T-202 PR-2e)", () => {
  it("posts grant action with user and role ids and no organisation id", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return Response.json({ ok: true, action: "grant" }, { status: 200 });
    });

    render(<MembershipRoleForm csrfToken="csrf-token-3" />);
    fireEvent.change(screen.getByLabelText("User id"), {
      target: { value: "00000000-0000-4000-8000-0000000000a1" },
    });
    fireEvent.change(screen.getByLabelText("Role id"), {
      target: { value: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Grant role" }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.url).toBe("/admin/members/role");
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      csrfToken: "csrf-token-3",
      action: "grant",
      userId: "00000000-0000-4000-8000-0000000000a1",
      roleId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    expect(JSON.stringify(body)).not.toMatch(/organisation|organization/i);
    expect((await screen.findByRole("status")).textContent).toContain("Role granted.");
  });

  it("surfaces last-admin refusal copy from the server", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { ok: false, code: "last_admin", message: "This workspace must keep at least one active admin." },
          { status: 409 },
        ),
      ),
    );

    render(<MembershipRoleForm csrfToken="csrf-token-3" />);
    fireEvent.change(screen.getByLabelText("Action"), { target: { value: "revoke" } });
    fireEvent.change(screen.getByLabelText("User id"), {
      target: { value: "00000000-0000-4000-8000-0000000000a1" },
    });
    fireEvent.change(screen.getByLabelText("Role id"), {
      target: { value: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Revoke role" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "This workspace must keep at least one active admin.",
    );
  });
});
