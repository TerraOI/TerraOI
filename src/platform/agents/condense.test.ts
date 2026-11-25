import { describe, expect, it } from "vitest";

import { DEFAULT_TASK_CHAIN_ORDER } from "@/contracts/provider-route";

import {
  answered,
  failed,
  fakeAdapter,
  recordingMeter,
  registryOf,
  RUN_ID,
  syntheticContext,
  testConfiguration,
  type FakeAdapter,
} from "@/platform/gateway/gateway-fixtures";
import { CircuitBook } from "@/platform/gateway/circuit";

import {
  condenseQuery,
  type AuthorizedHistoryTurn,
  type CondenseDeps,
  type CondenseExpertPolicy,
} from "./condense";

const T0 = 1_730_000_000_000;
const OTHER_USER = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const OTHER_PROJECT = "11111111-2222-3333-4444-555555555555";

const EXPERT: CondenseExpertPolicy = {
  key: "uav-doc-expert",
  version: "v1",
  modelChains: { condense: [...DEFAULT_TASK_CHAIN_ORDER.condense] },
  limits: { maxOutputTokens: 128, stageDeadlineMs: 5_000 },
};

function history(
  turns: Array<Pick<AuthorizedHistoryTurn, "role" | "text"> & { userId?: string }>,
  askerId: string,
): AuthorizedHistoryTurn[] {
  return turns.map((turn) => ({
    role: turn.role,
    text: turn.text,
    conversationUserId: turn.userId ?? askerId,
  }));
}

function deps(adapters: FakeAdapter[]): CondenseDeps {
  return {
    config: testConfiguration(),
    adapters: registryOf(...adapters),
    health: new CircuitBook({ openAfterFailures: 3, cooldownMs: 10_000 }),
    meter: recordingMeter(),
    clock: () => T0,
  };
}

describe("condenseQuery (F30)", () => {
  it("rewrites an anaphoric follow-up into a standalone search query naming the prior subject", async () => {
    const context = syntheticContext();
    const result = await condenseQuery(
      {
        context,
        runId: RUN_ID,
        followUp: "and the 120 m one?",
        authorizedHistory: history(
          [
            { role: "user", text: "What is the survey line clearance for the short baseline?" },
            { role: "assistant", text: "The short baseline uses a 60 m survey line clearance." },
          ],
          context.userId,
        ),
        expert: EXPERT,
        dataClass: "internal",
      },
      deps([
        fakeAdapter("local_box", [
          answered("What is the 120 m survey line clearance?", "box-model"),
        ]),
      ]),
    );

    expect(result.status).toBe("condensed");
    if (result.status !== "condensed") return;
    expect(result.originalQuery).toBe("and the 120 m one?");
    expect(result.searchedQuery.toLowerCase()).toMatch(/120\s*m/);
    expect(result.searchedQuery.toLowerCase()).toMatch(/survey|clearance|baseline/);
    expect(result.via).toBe("model");
  });

  it("refuses history from another user and does not call the condense chain", async () => {
    const context = syntheticContext();
    const adapters = [
      fakeAdapter("local_box", [answered("should not run", "box-model")]),
    ];
    const result = await condenseQuery(
      {
        context,
        runId: RUN_ID,
        followUp: "and the 120 m one?",
        authorizedHistory: history(
          [{ role: "user", text: "secret other-user turn", userId: OTHER_USER }],
          context.userId,
        ),
        expert: EXPERT,
        dataClass: "internal",
      },
      deps(adapters),
    );

    expect(result.status).toBe("skipped");
    if (result.status !== "skipped") return;
    expect(result.reason).toBe("unauthorized_history");
    expect(result.searchedQuery).toContain("and the 120 m one?");
    expect(adapters[0]!.calls).toHaveLength(0);
  });

  it("discards a rewrite that invents a project id outside TenantContext.permittedProjectIds", async () => {
    const context = syntheticContext();
    const result = await condenseQuery(
      {
        context,
        runId: RUN_ID,
        followUp: "what about that site?",
        authorizedHistory: history(
          [{ role: "user", text: "Show the Site A clearance." }],
          context.userId,
        ),
        expert: EXPERT,
        dataClass: "internal",
      },
      deps([
        fakeAdapter("local_box", [
          answered(`Site A clearance for project ${OTHER_PROJECT}`, "box-model"),
        ]),
      ]),
    );

    expect(result.status).toBe("skipped");
    if (result.status !== "skipped") return;
    expect(result.reason).toBe("scope_widened");
    expect(result.searchedQuery).toContain("what about that site?");
    expect(result.searchedQuery).not.toContain(OTHER_PROJECT);
  });

  it("falls back to raw question plus last user turn when the condense chain is unavailable", async () => {
    const context = syntheticContext();
    const result = await condenseQuery(
      {
        context,
        runId: RUN_ID,
        followUp: "and the 120 m one?",
        authorizedHistory: history(
          [{ role: "user", text: "What is the short baseline clearance?" }],
          context.userId,
        ),
        expert: EXPERT,
        dataClass: "internal",
      },
      deps([fakeAdapter("local_box", [failed("connection")])]),
    );

    expect(result.status).toBe("skipped");
    if (result.status !== "skipped") return;
    expect(result.reason).toBe("unavailable");
    expect(result.originalQuery).toBe("and the 120 m one?");
    expect(result.searchedQuery).toBe(
      "What is the short baseline clearance?\nand the 120 m one?",
    );
  });

  it("discards empty or oversized condensed output", async () => {
    const context = syntheticContext();
    const empty = await condenseQuery(
      {
        context,
        runId: RUN_ID,
        followUp: "and then?",
        authorizedHistory: history([{ role: "user", text: "Prior turn." }], context.userId),
        expert: EXPERT,
        dataClass: "internal",
      },
      deps([fakeAdapter("local_box", [answered("   ", "box-model")])]),
    );
    expect(empty.status).toBe("skipped");
    if (empty.status === "skipped") expect(empty.reason).toBe("empty");

    const oversized = await condenseQuery(
      {
        context,
        runId: RUN_ID,
        followUp: "and then?",
        authorizedHistory: history([{ role: "user", text: "Prior turn." }], context.userId),
        expert: { ...EXPERT, limits: { maxOutputTokens: 4, stageDeadlineMs: 5_000 } },
        dataClass: "internal",
      },
      deps([fakeAdapter("local_box", [answered("x".repeat(200), "box-model")])]),
    );
    expect(oversized.status).toBe("skipped");
    if (oversized.status === "skipped") expect(oversized.reason).toBe("oversized");
  });

  it("discards a rewrite that invents an entity absent from history and follow-up", async () => {
    const context = syntheticContext();
    const result = await condenseQuery(
      {
        context,
        runId: RUN_ID,
        followUp: "and the 120 m one?",
        authorizedHistory: history(
          [{ role: "user", text: "What is the short baseline clearance?" }],
          context.userId,
        ),
        expert: EXPERT,
        dataClass: "internal",
      },
      deps([
        fakeAdapter("local_box", [
          answered(
            "What is the SYNTH-UAV-MAN-Z99 clearance for the 120 m baseline?",
            "box-model",
          ),
        ]),
      ]),
    );

    expect(result.status).toBe("skipped");
    if (result.status !== "skipped") return;
    expect(result.reason).toBe("invented_entity");
  });
});
