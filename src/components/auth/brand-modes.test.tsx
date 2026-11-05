// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("next/font/google", () => ({
  Inter: () => ({ className: "inter-cls", variable: "inter-var" }),
  IBM_Plex_Mono: () => ({ className: "mono-cls", variable: "mono-var" }),
}));

import { CheckEmailPage } from "./check-email-page";
import { company1Customer, company1Powered, terraoiBrand } from "./fixtures";
import { NO_ACCESS_COPY, NoAccessPage } from "./no-access-page";
import { SignInPage } from "./sign-in-page";
import type { SignInBrand } from "./types";
import { UnknownAddressPage } from "./unknown-address-page";

afterEach(cleanup);

function signIn(brand: SignInBrand) {
  return (
    <SignInPage
      brand={brand}
      enabledMethods={["microsoft", "magic_link", "password"]}
      status="link_sent"
      magicLinkAction={() => {}}
      passwordAction={() => {}}
      microsoftHref="/auth/microsoft"
    />
  );
}

describe("brand modes", () => {
  it("powered mode shows Powered by TerraOI", () => {
    render(signIn(company1Powered));
    expect(screen.getByText("Powered by TerraOI")).toBeTruthy();
  });

  it("terraoi mode shows no attribution line", () => {
    render(signIn(terraoiBrand));
    expect(screen.getByRole("heading", { name: "Sign in to TerraOI" })).toBeTruthy();
    expect(screen.queryByText(/powered by/i)).toBeNull();
  });

  it("customer mode contains no TerraOI anywhere", () => {
    const pages = [
      () => signIn(company1Customer),
      () => <NoAccessPage brand={company1Customer} />,
      () => <CheckEmailPage brand={company1Customer} />,
    ];
    for (const page of pages) {
      const { container } = render(page());
      expect(/terraoi/i.test(container.innerHTML)).toBe(false);
      cleanup();
    }
  });

  it("logo has the brand name as alt text", () => {
    render(signIn(company1Powered));
    expect(screen.getByRole("img", { name: "Company1" }).getAttribute("src")).toBe(company1Powered.logoUrl);
  });
});

describe("secondary pages", () => {
  it("no-access page uses the T-101 safe message", () => {
    expect(NO_ACCESS_COPY).toBe("You do not have access to this workspace.");
    render(<NoAccessPage brand={company1Powered} />);
    expect(screen.getByText(NO_ACCESS_COPY)).toBeTruthy();
    expect(screen.getByText(company1Powered.supportLabel)).toBeTruthy();
  });

  it("check-email page shows the non-enumerating link text", () => {
    render(<CheckEmailPage brand={company1Powered} />);
    expect(screen.getByText("If this address can sign in, we've sent a link.")).toBeTruthy();
  });

  it("unknown-address page is TerraOI-neutral and names no tenant", () => {
    const { container } = render(<UnknownAddressPage />);
    expect(screen.getByText("This address is not recognized.")).toBeTruthy();
    expect(container.innerHTML).not.toContain("Company1");
  });
});
