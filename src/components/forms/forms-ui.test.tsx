// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { SEEDED_FORM_TEMPLATE_ROWS } from "@/platform/forms/seeded-templates";
import { extractFormFields, mapFormTemplateRow } from "@/platform/forms/template-schema";

import { FormRenderer } from "./form-renderer";
import { FormTemplateList } from "./form-template-list";

const uavTemplate = mapFormTemplateRow(SEEDED_FORM_TEMPLATE_ROWS[0]!);
const gprTemplate = mapFormTemplateRow(SEEDED_FORM_TEMPLATE_ROWS[2]!);
const SUBMISSION_ID = "aa000000-0000-4000-8000-000000000001";
const SUPERSEDED_ID = "aa000000-0000-4000-8000-000000000000";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("FormTemplateList", () => {
  it("renders authorized templates with version, service, data class and link", () => {
    render(<FormTemplateList templates={[uavTemplate, gprTemplate]} />);

    expect(screen.getByRole("heading", { name: "Forms" })).toBeTruthy();
    expect(screen.getByText("UAV pre-flight check (synthetic)")).toBeTruthy();
    expect(screen.getByText("GPR field log (synthetic)")).toBeTruthy();

    const links = screen.getAllByRole("link", { name: /Open form/i });
    expect(links.map((el) => el.getAttribute("href"))).toEqual([
      `/forms/${uavTemplate.id}`,
      `/forms/${gprTemplate.id}`,
    ]);
  });

  it("renders an empty state when no templates are available", () => {
    render(<FormTemplateList templates={[]} />);
    expect(screen.getByText(/No forms are available/i)).toBeTruthy();
  });
});

describe("FormRenderer", () => {
  it("renders fields in schema uiHints order and supports saving a draft then submitting", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, state: "draft", submissionId: SUBMISSION_ID }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, state: "submitted", submissionId: SUBMISSION_ID }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <FormRenderer
        template={uavTemplate}
        fields={extractFormFields(uavTemplate)}
        csrfToken="csrf-123"
      />,
    );

    expect(screen.getByRole("heading", { name: uavTemplate.name })).toBeTruthy();
    expect(screen.getByText("Version v1")).toBeTruthy();

    const fieldNames = Array.from(document.querySelectorAll("form textarea, form input[type='number']")).map((el) =>
      el.getAttribute("name"),
    );
    expect(fieldNames).toEqual(["airframe_check", "battery_pct", "weather_notes"]);

    fireEvent.change(screen.getByLabelText(/airframe check/i), { target: { value: "Tether checked" } });
    fireEvent.change(screen.getByLabelText(/battery pct/i), { target: { value: "92" } });
    fireEvent.change(screen.getByLabelText(/weather notes/i), { target: { value: "Wind 4 m/s" } });

    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain("Draft saved");
    });

    const firstBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(firstBody).toEqual({
      action: "draft",
      csrfToken: "csrf-123",
      templateId: uavTemplate.id,
      templateVersion: "v1",
      values: {
        airframe_check: "Tether checked",
        battery_pct: 92,
        weather_notes: "Wind 4 m/s",
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Submit form" }));

    await waitFor(() => {
      expect(screen.getByText(/Form submitted/i)).toBeTruthy();
    });

    const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as Record<string, unknown>;
    expect(secondBody).toMatchObject({
      action: "submit",
      submissionId: SUBMISSION_ID,
      templateId: uavTemplate.id,
      templateVersion: "v1",
    });

    // Once submitted, no in-place edit button; a linked correction link is offered instead.
    expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull();
    const correctionLink = screen.getByRole("link", { name: /Create correction/i });
    expect(correctionLink.getAttribute("href")).toBe(`/forms/${uavTemplate.id}?supersedes=${SUBMISSION_ID}`);
  });

  it("shows correction context and surfaces server errors without clearing entered input", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: false,
          code: "tenancy",
          message: "You do not have permission to submit into this collection.",
        }),
        { status: 403, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <FormRenderer
        template={uavTemplate}
        fields={extractFormFields(uavTemplate)}
        csrfToken="csrf-123"
        supersedesSubmissionId={SUPERSEDED_ID}
      />,
    );

    expect(screen.getByText(new RegExp(SUPERSEDED_ID))).toBeTruthy();

    const airframeInput = screen.getByLabelText(/airframe check/i) as HTMLTextAreaElement;
    fireEvent.change(airframeInput, { target: { value: "Updated check" } });
    fireEvent.change(screen.getByLabelText(/battery pct/i), { target: { value: "88" } });
    fireEvent.change(screen.getByLabelText(/weather notes/i), { target: { value: "Dry" } });

    fireEvent.click(screen.getByRole("button", { name: "Submit form" }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("permission");
    });
    expect(airframeInput.value).toBe("Updated check");
  });
});
