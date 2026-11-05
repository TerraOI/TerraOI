// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";

vi.mock("next/font/google", () => ({
  Inter: () => ({ className: "inter-cls", variable: "inter-var" }),
  IBM_Plex_Mono: () => ({ className: "mono-cls", variable: "mono-var" }),
}));

import { company1Powered } from "./fixtures";
import { SignInPage } from "./sign-in-page";
import type { SignInBrand, SignInStatus } from "./types";

afterEach(cleanup);

function page(brand: SignInBrand, status: SignInStatus = "idle") {
  return (
    <SignInPage
      brand={brand}
      enabledMethods={["magic_link", "password"]}
      status={status}
      magicLinkAction={() => {}}
      passwordAction={() => {}}
    />
  );
}

describe("sign-in hardening", () => {
  it("drops brand colors that are not #RRGGBB instead of writing them into style", () => {
    const hostile: SignInBrand = {
      ...company1Powered,
      primary: "red;background:url(https://evil.example/x)",
      onPrimary: "url(https://evil.example/y)",
      accent: "#637D99",
    };
    const html = renderToString(page(hostile));
    expect(html).not.toContain("evil.example");
    expect(html).toContain("--accent:#637D99");
  });

  it("renders an empty status for a value outside SignInStatus", () => {
    expect(() => render(page(company1Powered, "__proto__" as SignInStatus))).not.toThrow();
    expect(screen.getByRole("status").textContent).toBe("");
    cleanup();
    render(page(company1Powered, "toString" as SignInStatus));
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("keeps the password form open after invalid credentials", () => {
    const { container } = render(page(company1Powered, "invalid_credentials"));
    expect(container.querySelector("details")!.open).toBe(true);
    cleanup();
    const idle = render(page(company1Powered, "idle"));
    expect(idle.container.querySelector("details")!.open).toBe(false);
  });
});
