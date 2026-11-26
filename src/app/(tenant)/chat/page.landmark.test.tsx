// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import type { TenantContext } from "@/contracts/tenant-context";

const readChatPageState = vi.fn();

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/platform/chat/adapters", () => ({
  chatEnv: () => ({}),
  DEV_HOST_OPTIONS: {},
  readChatPageState: (...args: unknown[]) => readChatPageState(...args),
}));

import ChatPage from "./page";

const READY_CONTEXT = {
  organisationId: "11111111-1111-4111-8111-111111111111",
  host: "company1.terraoi.app",
  userId: "22222222-2222-4222-8222-222222222222",
  membershipId: "33333333-3333-4333-8333-333333333333",
  membershipStatus: "active",
  roles: ["employee"],
  permittedServiceKeys: [],
  permittedProjectIds: [],
  policyRevision: 1,
  resolvedAt: "2026-11-20T12:00:00.000Z",
} as TenantContext;

afterEach(() => {
  cleanup();
  readChatPageState.mockReset();
});

describe("chat page landmarks (Round-2 B6 / #173)", () => {
  it("renders no main when the surface is ready — the shell owns that landmark", async () => {
    readChatPageState.mockResolvedValue({
      kind: "ready",
      context: READY_CONTEXT,
      accessToken: null,
    });

    const { container } = render(await ChatPage());

    expect(container.querySelector("main")).toBeNull();
    expect(screen.getByRole("region", { name: "Assistant" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Assistant", level: 1 }).id).toBe("chat-heading");
  });

  it("renders no main when the surface is blocked", async () => {
    readChatPageState.mockResolvedValue({
      kind: "blocked",
      reason: "missing_host",
      message: "This workspace could not be opened.",
    });

    const { container } = render(await ChatPage());

    expect(container.querySelector("main")).toBeNull();
    expect(screen.getByRole("region", { name: "Assistant" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("This workspace could not be opened.");
  });
});
