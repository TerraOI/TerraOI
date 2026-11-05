// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { WorkspaceFinder } from "./workspace-finder";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function submit(value: string) {
  fireEvent.change(screen.getByLabelText("Go to your workspace"), { target: { value } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
}

describe("WorkspaceFinder", () => {
  it("the finder never fetches", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const navigate = vi.fn();
    render(<WorkspaceFinder navigate={navigate} />);
    submit("company1");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith("https://company1.terraoi.app/");
  });

  it("shows the pasted-address hint inline and does not navigate", () => {
    const navigate = vi.fn();
    render(<WorkspaceFinder navigate={navigate} />);
    submit("https://company1.terraoi.app");
    expect(navigate).not.toHaveBeenCalled();
    const input = screen.getByLabelText("Go to your workspace");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText("Enter just the first part of your address, like company1.")).toBeTruthy();
  });
});
