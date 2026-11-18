// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("next/font/google", () => ({
  Inter: () => ({ className: "inter-cls", variable: "inter-var" }),
}));

import { STATUS_COPY } from "./copy";
import { MagicLinkForm } from "./magic-link-form";
import { PasswordForm } from "./password-form";
import { SignInPage } from "./sign-in-page";
import { company1Powered } from "./fixtures";
import type { SignInStatus } from "./types";

afterEach(cleanup);

function page(status: SignInStatus) {
  return (
    <SignInPage
      brand={company1Powered}
      enabledMethods={["magic_link", "password"]}
      status={status}
      magicLinkAction={() => {}}
      passwordAction={() => {}}
    />
  );
}

describe("sign-in status copy", () => {
  it("uses the fixed, non-enumerating messages", () => {
    expect(STATUS_COPY).toEqual({
      link_sent: "If this address can sign in, we've sent a link.",
      invalid_credentials: "Email or password is incorrect.",
      rate_limited: "Too many requests. Try again later.",
      unavailable: "The service is temporarily unavailable. Try again later.",
    });
  });

  it("link_sent shows the same text regardless of input", () => {
    const texts: string[] = [];
    for (const email of ["known@company1.com", "nobody@example.org"]) {
      render(page("link_sent"));
      fireEvent.change(screen.getByLabelText("Work email"), { target: { value: email } });
      texts.push(screen.getByRole("status").textContent ?? "");
      cleanup();
    }
    expect(texts[0]).toBe(STATUS_COPY.link_sent);
    expect(texts[1]).toBe(texts[0]);
  });

  it("status region is polite", () => {
    render(page("idle"));
    const region = screen.getByRole("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.textContent).toBe("");
  });

  it("rate_limited and unavailable render their generic messages", () => {
    for (const status of ["rate_limited", "unavailable"] as const) {
      render(page(status));
      expect(screen.getByRole("status").textContent).toBe(STATUS_COPY[status]);
      cleanup();
    }
  });
});

describe("sign-in forms", () => {
  it("inputs are labelled and use the right autocomplete", () => {
    render(
      <>
        <MagicLinkForm action={() => {}} />
        <PasswordForm action={() => {}} />
      </>,
    );
    const email = screen.getByLabelText("Work email");
    expect(email.getAttribute("type")).toBe("email");
    expect(email.getAttribute("autocomplete")).toBe("username");
    expect(email.getAttribute("inputmode")).toBe("email");
    const password = screen.getByLabelText("Password");
    expect(password.getAttribute("type")).toBe("password");
    expect(password.getAttribute("autocomplete")).toBe("current-password");
    const passwordEmail = screen.getByLabelText("Email");
    expect(passwordEmail.getAttribute("autocomplete")).toBe("username");
  });

  it("forms post to the provided actions", async () => {
    const magic = vi.fn();
    const pass = vi.fn();
    render(
      <>
        <MagicLinkForm action={magic} />
        <PasswordForm action={pass} />
      </>,
    );
    fireEvent.change(screen.getByLabelText("Work email"), { target: { value: "a@company1.com" } });
    await act(async () => {
      fireEvent.submit(screen.getByLabelText("Work email").closest("form")!);
    });
    expect(magic).toHaveBeenCalledTimes(1);
    expect((magic.mock.calls[0]![0] as FormData).get("email")).toBe("a@company1.com");

    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw" } });
    await act(async () => {
      fireEvent.submit(screen.getByLabelText("Password").closest("form")!);
    });
    expect(pass).toHaveBeenCalledTimes(1);
    expect((pass.mock.calls[0]![0] as FormData).get("password")).toBe("pw");
  });

  it("string action posts to the route with a CSRF hidden field", () => {
    render(<MagicLinkForm action="/auth/magic-link" csrfToken="csrf-abc" />);
    const form = screen.getByLabelText("Work email").closest("form");
    expect(form?.getAttribute("action")).toBe("/auth/magic-link");
    expect(form?.getAttribute("method")).toBe("post");
    expect((form?.querySelector('input[name="csrf_token"]') as HTMLInputElement).value).toBe("csrf-abc");
  });
});
