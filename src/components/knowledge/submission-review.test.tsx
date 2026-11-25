// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { QueuedSubmission } from "@/platform/knowledge/submission-queue";

import { SubmissionReviewList } from "./submission-review";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const base: QueuedSubmission = {
  id: "85c00000-0000-4000-8000-000000000001",
  collectionName: "UAV reference library",
  kind: "correction",
  proposedText: "Synthetic correction: grid four was flown three times.",
  dataClass: "internal",
  state: "submitted",
  citedCount: 2,
  authorIsCaller: false,
  createdAt: "2026-11-25 09:00:00+00",
};

describe("SubmissionReviewList (T-302)", () => {
  it("shows the proposal with its collection, class and cited count, and approves through the review route", async () => {
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) as unknown });
      return Response.json({ submissionId: base.id });
    });
    render(<SubmissionReviewList submissions={[base]} />);
    expect(screen.getByText(base.proposedText)).toBeTruthy();
    expect(screen.getByText("class internal")).toBeTruthy();
    expect(screen.getByText("2 cited sources")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Reason (optional)"), { target: { value: "Matches the log." } });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect((await screen.findByRole("status")).textContent).toContain("Approved");
    expect(calls[0]).toEqual({ url: `/api/knowledge/submissions/${base.id}/review`, body: { decision: "approve", reason: "Matches the log." } });
  });

  it("the author never gets decision controls on their own submission", () => {
    render(<SubmissionReviewList submissions={[{ ...base, authorIsCaller: true }]} />);
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.getByText(/another reviewer must decide it/)).toBeTruthy();
  });

  it("a server refusal is shown and the item stays undecided", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({ error: { code: "tenancy", message: "You do not have permission to perform this action in this workspace." } }, { status: 403 }),
    );
    render(<SubmissionReviewList submissions={[base]} />);
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect((await screen.findByRole("alert")).textContent).toContain("do not have permission");
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
  });

  it("an empty queue says so", () => {
    render(<SubmissionReviewList submissions={[]} />);
    expect(screen.getByRole("status").textContent).toBe("Nothing is waiting for review.");
  });
});
