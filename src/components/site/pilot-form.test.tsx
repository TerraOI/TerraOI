// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

type ScriptProps = { src: string; onReady?: () => void; onError?: () => void };
let script: ScriptProps | null = null;
vi.mock("next/script", () => ({
  default: (props: ScriptProps) => {
    script = props;
    return null;
  },
}));

import { PilotForm } from "./pilot-form";

const reset = vi.fn();

beforeEach(() => {
  script = null;
  (window as unknown as { turnstile: unknown }).turnstile = {
    render: (_el: HTMLElement, opts: { callback: (t: string) => void }) => {
      opts.callback("tok-1");
      return "widget-1";
    },
    reset,
  };
});

afterEach(() => {
  cleanup();
  document.head.querySelectorAll("script").forEach((el) => el.remove()); // retry tags the form injected
  vi.restoreAllMocks();
  reset.mockClear();
});

function fill() {
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Dana Reyes" } });
  fireEvent.change(screen.getByLabelText("Work email"), { target: { value: "dana@company1.com" } });
  fireEvent.change(screen.getByLabelText("Company"), { target: { value: "Company1" } });
  fireEvent.click(screen.getByLabelText("UAV"));
  fireEvent.click(screen.getByLabelText(/I have read the privacy notice/));
}

function loadWidget() {
  act(() => script?.onReady?.());
}

function respond(status: number, body: unknown) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(body, { status }));
}

const send = () => screen.getByRole("button", { name: /send/i });

describe("PilotForm", () => {
  it("loads Turnstile explicitly from Cloudflare", () => {
    render(<PilotForm siteKey="site-key" />);
    expect(script?.src).toBe("https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit");
  });

  it("sends one request on a double click", async () => {
    let resolve!: (r: Response) => void;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockReturnValue(new Promise((r) => (resolve = r)));
    render(<PilotForm siteKey="site-key" />);
    loadWidget();
    fill();
    fireEvent.click(send());
    fireEvent.click(send());
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(send().getAttribute("aria-busy")).toBe("true");

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("/api/pilot-inquiry");
    expect(JSON.parse(String(init?.body))).toEqual({
      name: "Dana Reyes",
      email: "dana@company1.com",
      company: "Company1",
      role: "",
      services: ["uav"],
      message: "",
      privacyAcknowledged: true,
      website: "",
      turnstileToken: "tok-1",
    });

    await act(async () => resolve(Response.json({ status: "received" }, { status: 201 })));
    expect(screen.getByText("Thanks. We'll reply by email.")).toBeTruthy();
  });

  it("shows the success message on 201", async () => {
    respond(201, { status: "received" });
    render(<PilotForm siteKey="site-key" />);
    loadWidget();
    fill();
    await act(async () => fireEvent.click(send()));
    expect(screen.getByText("Thanks. We'll reply by email.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /send/i })).toBeNull();
  });

  it("shows field errors next to their inputs on 400", async () => {
    respond(400, { fieldErrors: { email: "Enter a valid work email." } });
    render(<PilotForm siteKey="site-key" />);
    loadWidget();
    fill();
    await act(async () => fireEvent.click(send()));
    const email = screen.getByLabelText("Work email");
    expect(email.getAttribute("aria-invalid")).toBe("true");
    const describedBy = email.getAttribute("aria-describedby")!;
    expect(document.getElementById(describedBy)?.textContent).toBe("Enter a valid work email.");
    expect(reset).toHaveBeenCalled();
  });

  it("shows a form-level alert when a 400 names a field with no visible input", async () => {
    respond(400, { fieldErrors: { turnstileToken: "Verification failed. Try again." } });
    render(<PilotForm siteKey="site-key" />);
    loadWidget();
    fill();
    await act(async () => fireEvent.click(send()));
    expect(screen.getByRole("alert").textContent).toBe("Check the form and try again.");
  });

  it.each([
    [429, "Too many requests. Try again later."],
    [503, "The service is temporarily unavailable. Try again later."],
    [500, "The service is temporarily unavailable. Try again later."],
  ])("shows the %i message verbatim", async (status, text) => {
    respond(status, { error: "proxy said something internal" });
    render(<PilotForm siteKey="site-key" />);
    loadWidget();
    fill();
    await act(async () => fireEvent.click(send()));
    expect(screen.getByRole("alert").textContent).toBe(text);
    expect(document.body.textContent).not.toContain("internal");
    expect((send() as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows the verification message on a Turnstile 400", async () => {
    respond(400, { error: "Verification failed. Try again." });
    render(<PilotForm siteKey="site-key" />);
    loadWidget();
    fill();
    await act(async () => fireEvent.click(send()));
    expect(screen.getByRole("alert").textContent).toBe("Verification failed. Try again.");
  });

  it("shows the unavailable message when the network fails", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
    render(<PilotForm siteKey="site-key" />);
    loadWidget();
    fill();
    await act(async () => fireEvent.click(send()));
    expect(screen.getByRole("alert").textContent).toBe("The service is temporarily unavailable. Try again later.");
  });

  it("shows a retry message when the verification widget fails to load", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    render(<PilotForm siteKey="site-key" />);
    act(() => script?.onError?.());
    const text = "The verification check didn't load. Check your connection or ad blocker, then try again.";
    expect(screen.getByRole("alert").textContent).toBe(text);
    expect((send() as HTMLButtonElement).disabled).toBe(false);
    fill();
    await act(async () => fireEvent.click(send()));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe(text);
  });

  it("retries loading the widget when Send is pressed after a load failure", async () => {
    const fetchSpy = respond(201, { status: "received" });
    render(<PilotForm siteKey="site-key" />);
    act(() => script?.onError?.());
    fill();
    await act(async () => fireEvent.click(send()));
    const retry = [...document.head.querySelectorAll("script")].find((el) => el.src.includes("turnstile/v0/api.js"));
    expect(retry?.src).toMatch(/render=explicit&retry=1$/);
    act(() => {
      retry!.dispatchEvent(new Event("load"));
    });
    expect(screen.getByRole("alert").textContent).toBe("");
    await act(async () => fireEvent.click(send()));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("treats an empty site key as an unavailable widget instead of crashing", () => {
    const renderSpy = vi.fn();
    (window as unknown as { turnstile: unknown }).turnstile = { render: renderSpy, reset };
    render(<PilotForm siteKey="" />);
    loadWidget();
    expect(renderSpy).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe(
      "The verification check didn't load. Check your connection or ad blocker, then try again.",
    );
  });

  it("shows the unavailable message when the widget throws or reports an error", () => {
    (window as unknown as { turnstile: unknown }).turnstile = {
      render: () => {
        throw new Error("Invalid sitekey");
      },
      reset,
    };
    render(<PilotForm siteKey="bad" />);
    expect(() => loadWidget()).not.toThrow();
    expect(screen.getByRole("alert").textContent).toContain("didn't load");
    cleanup();

    let onWidgetError: (() => void) | undefined;
    (window as unknown as { turnstile: unknown }).turnstile = {
      render: (_el: HTMLElement, opts: { "error-callback"?: () => void }) => {
        onWidgetError = opts["error-callback"];
        return "w";
      },
      reset,
    };
    render(<PilotForm siteKey="site-key" />);
    loadWidget();
    act(() => onWidgetError?.());
    expect(screen.getByRole("alert").textContent).toContain("didn't load");
  });

  it("tells the user to shorten an inquiry that is too large", async () => {
    respond(413, {});
    render(<PilotForm siteKey="site-key" />);
    loadWidget();
    fill();
    await act(async () => fireEvent.click(send()));
    expect(screen.getByRole("alert").textContent).toBe("Your inquiry is too long. Shorten the message and try again.");
  });

  it("honeypot is hidden from people and assistive tech", () => {
    const { container } = render(<PilotForm siteKey="site-key" />);
    const input = container.querySelector<HTMLInputElement>('input[name="website"]')!;
    expect(input.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(input.tabIndex).toBe(-1);
    expect(input.getAttribute("autocomplete")).toBe("off");
  });

  it("links the privacy notice from the acknowledgement", () => {
    render(<PilotForm siteKey="site-key" />);
    expect(screen.getByRole("link", { name: "privacy notice" }).getAttribute("href")).toBe("/privacy");
  });
});
