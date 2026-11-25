// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { answeredFixture, RUN_ID } from "@/platform/chat/chat-fixtures";

import { AnswerFeedback } from "./feedback";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const answer = answeredFixture(RUN_ID);
const SITE_A = { id: "51000000-0000-4000-8000-000000000002", name: "Site A client data", dataClass: "client_confidential", projectScoped: true };
const PUBLIC = { id: "51000000-0000-4000-8000-000000000001", name: "UAV reference library", dataClass: "public", projectScoped: false };

function stub(routes: Record<string, (body: unknown) => Response>) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const body = init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as unknown);
    calls.push({ url, method: init?.method ?? "GET", body });
    const handler = routes[url];
    return handler === undefined ? new Response("{}", { status: 404 }) : handler(body);
  });
  return calls;
}

describe("AnswerFeedback (T-302)", () => {
  it("a rating posts the run id and kind only, and leaves the answer untouched", async () => {
    const calls = stub({ "/chat/feedback": () => Response.json({ ok: true, message: "Thanks — your feedback was saved." }) });
    render(
      <div>
        <p>{answer.summary}</p>
        <AnswerFeedback answer={answer} />
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Useful" }));
    expect((await screen.findByRole("status")).textContent).toContain("saved");
    expect(calls[0]).toEqual({ url: "/chat/feedback", method: "POST", body: { runId: RUN_ID, kind: "useful" } });
    expect(screen.getByText(answer.summary)).toBeTruthy();
  });

  it("Suggest correction sends its text, then opens a submission draft holding that text — not the answer", async () => {
    const calls = stub({
      "/chat/feedback": () => Response.json({ ok: true, message: "Thanks — your feedback was saved." }),
      "/chat/collections": () => Response.json({ ok: true, collections: [PUBLIC] }),
    });
    render(<AnswerFeedback answer={answer} />);
    fireEvent.click(screen.getByRole("button", { name: "Suggest correction" }));
    fireEvent.change(screen.getByLabelText("Your correction"), { target: { value: "It was flown three times." } });
    fireEvent.click(screen.getByRole("button", { name: "Send correction" }));
    await waitFor(() => expect(screen.getByRole("form", { name: "Save as knowledge" })).toBeTruthy());
    expect(calls[0]?.body).toEqual({ runId: RUN_ID, kind: "suggest_correction", correctionText: "It was flown three times." });
    expect((screen.getByLabelText("Proposed text") as HTMLTextAreaElement).value).toBe("It was flown three times.");
  });

  it("saving requires choosing and confirming an audience, and sends the answer's cited versions and class floor", async () => {
    const calls = stub({
      "/chat/collections": () => Response.json({ ok: true, collections: [PUBLIC, SITE_A] }),
      "/api/knowledge/submissions": () => Response.json({ submissionId: "85c00000-0000-4000-8000-000000000009" }, { status: 201 }),
    });
    render(<AnswerFeedback answer={answer} />);
    fireEvent.click(screen.getByRole("button", { name: "Save as knowledge" }));
    const select = (await screen.findByLabelText("Who will see it (collection)")) as HTMLSelectElement;
    const submit = screen.getByRole("button", { name: "Submit for review" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(select, { target: { value: SITE_A.id } });
    expect(submit.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(screen.getByText(/project members only/, { selector: "span" })).toBeTruthy();
    fireEvent.click(submit);
    expect((await screen.findByRole("status")).textContent).toContain("only if a reviewer approves it");
    const sent = calls.find((c) => c.url === "/api/knowledge/submissions")?.body as Record<string, unknown>;
    const cited = [...new Set(answer.claims.flatMap((c) => c.evidence.flatMap((e) => (e.kind === "chunk" ? [e.sourceVersionId] : []))))];
    expect(sent).toEqual({
      collectionId: SITE_A.id,
      kind: "answer",
      proposedText: answer.summary,
      contextDataClass: answer.dataClass,
      citedSourceVersionIds: cited,
      agentRunId: RUN_ID,
    });
    expect(JSON.stringify(sent)).not.toMatch(/organisation|userId|author/i);
  });

  it("a refused save (revoked source) is shown, not reported as saved", async () => {
    stub({
      "/chat/collections": () => Response.json({ ok: true, collections: [PUBLIC] }),
      "/api/knowledge/submissions": () =>
        Response.json({ error: { code: "tenancy", message: "You do not have permission to perform this action in this workspace." } }, { status: 403 }),
    });
    render(<AnswerFeedback answer={answer} />);
    fireEvent.click(screen.getByRole("button", { name: "Save as knowledge" }));
    fireEvent.change(await screen.findByLabelText("Who will see it (collection)"), { target: { value: PUBLIC.id } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Submit for review" }));
    expect((await screen.findByRole("alert")).textContent).toContain("do not have permission");
    expect(screen.queryByRole("status")).toBeNull();
  });
});
