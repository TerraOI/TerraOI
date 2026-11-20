import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/font/google", () => ({
  Inter: () => ({ className: "inter-cls", variable: "inter-var" }),
}));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => {
    throw new Error("no Cloudflare context in tests");
  },
}));

import { ROUTED_HOST_HEADER } from "@/platform/tenancy/page-host";

import { shellHost } from "./layout";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("shellHost", () => {
  it("returns the proxy stamp when it is a bare host", () => {
    expect(shellHost(new Headers({ [ROUTED_HOST_HEADER]: "company1.terraoi.app" }))).toBe(
      "company1.terraoi.app",
    );
  });

  it("fails closed on a folded or malformed routed host", () => {
    expect(shellHost(new Headers({ [ROUTED_HOST_HEADER]: "company2.terraoi.app, evil.example" }))).toBeNull();
    expect(shellHost(new Headers())).toBeNull();
  });

  it("ignores TERRAOI_DEV_HOST outside development", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TERRAOI_DEV_HOST", "company1.terraoi.app");
    expect(shellHost(new Headers({ [ROUTED_HOST_HEADER]: "company2.terraoi.app" }))).toBe(
      "company2.terraoi.app",
    );
    expect(shellHost(new Headers())).toBeNull();
  });

  it("uses TERRAOI_DEV_HOST under next dev when the proxy stamp is absent", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("TERRAOI_DEV_HOST", "company1.terraoi.app");
    expect(shellHost(new Headers())).toBe("company1.terraoi.app");
  });
});
