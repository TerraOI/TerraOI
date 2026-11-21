// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { SEEDED_FORM_TEMPLATE_ROWS } from "@/platform/forms/seeded-templates";
import { mapFormTemplateRow } from "@/platform/forms/template-schema";
import { ROUTED_HOST_HEADER } from "@/platform/tenancy/page-host";

let requestHeaders = new Headers();

vi.mock("next/headers", () => ({ headers: async () => requestHeaders }));
vi.mock("next/navigation", () => ({
  redirect: (location: string) => {
    throw new Error(`NEXT_REDIRECT:${location}`);
  },
}));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => {
    throw new Error("no Cloudflare context in tests");
  },
}));

const buildFormsListView = vi.fn();
vi.mock("@/platform/forms/forms-service", async () => {
  const actual = await vi.importActual<typeof import("@/platform/forms/forms-service")>(
    "@/platform/forms/forms-service",
  );
  return {
    ...actual,
    buildFormsListView: (...args: unknown[]) => buildFormsListView(...args),
  };
});

import FormsListPage from "./page";

afterEach(() => {
  cleanup();
  requestHeaders = new Headers();
  buildFormsListView.mockReset();
});

describe("FormsListPage", () => {
  it("resolves host strictly from proxy-stamped header and ignores client host header", async () => {
    const uav = mapFormTemplateRow(SEEDED_FORM_TEMPLATE_ROWS[0]!);
    buildFormsListView.mockResolvedValue({ kind: "ready", host: "company1.terraoi.app", templates: [uav] });
    requestHeaders = new Headers({
      [ROUTED_HOST_HEADER]: "company1.terraoi.app",
      host: "company2.terraoi.app",
    });

    render(await FormsListPage());

    const call = buildFormsListView.mock.calls[0]?.[0] as { request: Request };
    expect(new URL(call.request.url).host).toBe("company1.terraoi.app");
    expect(screen.getByText(uav.name)).toBeTruthy();
  });

  it("redirects to /login when the view requests sign-in", async () => {
    buildFormsListView.mockResolvedValue({ kind: "redirect", location: "/login" });
    requestHeaders = new Headers({ [ROUTED_HOST_HEADER]: "company1.terraoi.app" });

    await expect(FormsListPage()).rejects.toThrow("NEXT_REDIRECT:/login");
  });
});
