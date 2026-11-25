// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EvalReviewCase } from "@/platform/evals/review-queue";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

import { EvalCaseList } from "./case-list";
import { EvalCaseReview } from "./case-review";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  refresh.mockReset();
});

const SV = "71000000-0000-4000-8000-000000000001";
const base: EvalReviewCase = {
  id: "e3030000-0000-4000-8000-000000000001",
  caseKey: "UAV-D001",
  expertKey: "uav-expert",
  status: "drafted",
  origin: "agent_drafted",
  caseType: "answerable",
  question: "Synthetic: below what battery reserve is a second pass flown?",
  dataClass: "client_confidential",
  expectedAnswerPoints: ["Below the reserve threshold for the aircraft type."],
  expectedSource: `SYNTH-UAV-0002 note sourceVersionId:${SV}`,
  locators: [{ sourceVersionId: SV, chunkId: "c-7" }],
  approvedBy: null,
  approvedAt: null,
  updatedAt: "2026-11-25T10:00:00+00:00",
  authorIsCaller: false,
  sourcesValid: true,
  lastDecision: null,
  lastDecidedAt: null,
};

function stubFetch(reply: () => Response) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return reply();
  });
  return calls;
}

describe("EvalCaseReview (T-303)", () => {
  it("shows question, answer points, expected source with locator, case type and data class", () => {
    render(<EvalCaseReview evalCase={base} csrfToken="csrf-1" />);
    expect(screen.getByText(base.question)).toBeTruthy();
    expect(screen.getByText(base.expectedAnswerPoints[0]!)).toBeTruthy();
    expect(screen.getByText(base.expectedSource!)).toBeTruthy();
    expect(screen.getByText(`Source version ${SV}, chunk c-7`)).toBeTruthy();
    expect(screen.getByText("Answerable")).toBeTruthy();
    expect(screen.getByText("Client confidential")).toBeTruthy();
  });

  it("approves with the case id and version token only: no reviewer, no time, no organisation", async () => {
    const calls = stubFetch(() => Response.json({ ok: true, updatedAt: "2026-11-25T10:05:00+00:00" }));
    render(<EvalCaseReview evalCase={base} csrfToken="csrf-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.url).toBe("/evals/decide");
    expect(calls[0]?.body).toEqual({
      csrfToken: "csrf-1",
      caseId: base.id,
      expectedUpdatedAt: base.updatedAt,
      decision: "approve",
    });
    expect((await screen.findByRole("status")).textContent).toContain("Case approved.");
    expect(refresh).toHaveBeenCalled();
  });

  it("an edit sends only the changed fields and says the case returns to pending", async () => {
    const calls = stubFetch(() => Response.json({ ok: true, updatedAt: "2026-11-25T10:06:00+00:00" }));
    render(<EvalCaseReview evalCase={{ ...base, status: "approved", approvedAt: "2026-11-25T09:00:00Z" }} csrfToken="csrf-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Case type"), { target: { value: "must_refuse" } });
    fireEvent.change(screen.getByLabelText("Expected answer points (one per line)"), {
      target: { value: "First point\n\n  Second point  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save edit" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body.decision).toBe("edit");
    expect(calls[0]?.body.edits).toEqual({ caseType: "must_refuse", expectedAnswerPoints: ["First point", "Second point"] });
    expect((await screen.findByRole("status")).textContent).toContain("back in pending review");
  });

  it("an unchanged edit is refused locally without a request", async () => {
    const calls = stubFetch(() => Response.json({ ok: true }));
    render(<EvalCaseReview evalCase={base} csrfToken="csrf-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Save edit" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Change at least one field");
    expect(calls).toHaveLength(0);
  });

  it("surfaces a conflict from the server and does not claim success", async () => {
    stubFetch(() =>
      Response.json(
        { ok: false, code: "conflict", message: "This case changed since you opened it. Reload it and decide again." },
        { status: 409 },
      ),
    );
    render(<EvalCaseReview evalCase={base} csrfToken="csrf-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect((await screen.findByRole("alert")).textContent).toContain("changed since you opened it");
    expect(screen.queryByRole("status")).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("the author gets no decision controls", () => {
    render(<EvalCaseReview evalCase={{ ...base, authorIsCaller: true }} csrfToken="csrf-1" />);
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.getByText("You drafted this case, so another reviewer must decide it.")).toBeTruthy();
  });

  it("a case with a revoked source cannot be approved from the UI and says why", () => {
    render(<EvalCaseReview evalCase={{ ...base, sourcesValid: false }} csrfToken="csrf-1" />);
    expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("note").textContent).toContain("revoked");
  });
});

describe("EvalCaseList (T-303)", () => {
  it("groups by expert, links each case and flags invalid sources", () => {
    render(
      <EvalCaseList
        status="drafted"
        cases={[
          base,
          { ...base, id: "e3030000-0000-4000-8000-000000000002", caseKey: "GPR-D001", expertKey: "gpr-expert", sourcesValid: false },
        ]}
      />,
    );
    expect(screen.getByRole("heading", { name: "gpr-expert" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "uav-expert" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /UAV-D001/ }).getAttribute("href")).toBe(`/evals/${base.id}`);
    expect(screen.getAllByText("Source revoked or unavailable")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Pending" }).getAttribute("aria-current")).toBe("page");
  });

  it("shows an empty state rather than inventing cases", () => {
    render(<EvalCaseList status={null} cases={[]} />);
    expect(screen.getByRole("status").textContent).toBe("No cases to show.");
  });
});
