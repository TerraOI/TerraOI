// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("next/font/google", () => ({
  Inter: () => ({ className: "inter-cls", variable: "inter-var" }),
}));

import { SignInPage } from "./sign-in-page";
import { company1Powered } from "./fixtures";
import type { SignInPageProps } from "./types";

afterEach(cleanup);

const noop = () => {};

function props(overrides: Partial<SignInPageProps> = {}): SignInPageProps {
  return {
    brand: company1Powered,
    enabledMethods: ["microsoft", "magic_link", "password"],
    status: "idle",
    magicLinkAction: noop,
    passwordAction: noop,
    microsoftHref: "/auth/microsoft",
    ...overrides,
  };
}

/** True when a precedes b in document order. */
function precedes(a: Node, b: Node): boolean {
  return Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
}

describe("SignInPage methods", () => {
  it("renders Microsoft, divider, email and password in order when all are enabled", () => {
    render(<SignInPage {...props()} />);
    const microsoft = screen.getByRole("link", { name: "Sign in with Microsoft" });
    const divider = screen.getByText("or");
    const email = screen.getByLabelText("Work email");
    const password = screen.getByText("Use a password instead");
    expect(precedes(microsoft, divider)).toBe(true);
    expect(precedes(divider, email)).toBe(true);
    expect(precedes(email, password)).toBe(true);
  });

  it("hides the divider and Microsoft when only magic link is enabled", () => {
    render(<SignInPage {...props({ enabledMethods: ["magic_link"] })} />);
    expect(screen.queryByText("or")).toBeNull();
    expect(screen.queryByRole("link", { name: "Sign in with Microsoft" })).toBeNull();
    expect(screen.getByLabelText("Work email")).toBeTruthy();
  });

  it("does not render a method whose action is missing", () => {
    render(<SignInPage {...props({ enabledMethods: ["magic_link", "password"], passwordAction: undefined })} />);
    expect(screen.queryByText("Use a password instead")).toBeNull();
    expect(screen.queryByLabelText("Password")).toBeNull();
  });

  it("defines the font variable the stylesheet reads on the page root, and no unused font", () => {
    const { container } = render(<SignInPage {...props()} />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.classList.contains("inter-var")).toBe(true);
    expect(root.classList.contains("mono-var")).toBe(false);
  });

  it("applies brand colors as CSS variables only", () => {
    const { container } = render(<SignInPage {...props()} />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.style.getPropertyValue("--primary")).toBe("#183B66");
    for (const el of container.querySelectorAll<HTMLElement>("*")) {
      expect(el.style.backgroundColor).toBe("");
    }
  });
});
