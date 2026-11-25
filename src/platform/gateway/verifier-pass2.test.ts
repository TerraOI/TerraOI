import { describe, expect, it } from "vitest";

import type { Claim } from "@/contracts/answer";
import type { ProviderKey } from "@/contracts/keys";

import type { AdapterCallOutcome } from "./adapters";
import type { GatewayDeps } from "./call";
import { CircuitBook } from "./circuit";
import {
  answered,
  fakeAdapter,
  failed,
  recordingMeter,
  registryOf,
  RUN_ID,
  syntheticContext,
  testConfiguration,
} from "./gateway-fixtures";
import {
  buildPass2Claims,
  buildPass2Messages,
  createSemanticVerifier,
  pass2PayloadIsClaimSpanOnly,
} from "./verifier-pass2";
import type { RunEvidence } from "./verify-binding";

const VERSION = "11111111-1111-4111-8111-111111111101";

function chunkClaim(id: string, text: string, quoted: string): Claim {
  return {
    id,
    text,
    type: "requirement",
    authority: "manual",
    verificationStatus: "binding_passed",
    limitations: [],
    evidence: [
      {
        kind: "chunk",
        chunkId: "chk-0001",
        sourceVersionId: VERSION,
        span: { startChar: 0, endChar: quoted.length },
        quotedText: quoted,
      },
    ],
  };
}

const EVIDENCE: RunEvidence[] = [
  {
    chunkId: "chk-0001",
    sourceVersionId: VERSION,
    text: "Calibrate the antenna before every survey flight.",
    dataClass: "internal",
  },
];

function harness(
  scripts: Partial<Record<ProviderKey, AdapterCallOutcome[]>>,
): {
  adapters: Map<ProviderKey, ReturnType<typeof fakeAdapter>>;
  deps: GatewayDeps;
} {
  const list = (Object.entries(scripts) as [ProviderKey, AdapterCallOutcome[]][]).map(
    ([key, script]) => fakeAdapter(key, script),
  );
  const adapters = new Map(list.map((a) => [a.providerKey, a]));
  return {
    adapters,
    deps: {
      config: testConfiguration(),
      adapters: registryOf(...list),
      health: new CircuitBook(testConfiguration().circuit),
      meter: recordingMeter(),
      clock: () => 1_700_000_000_000,
    },
  };
}

const META_BASE = {
  context: syntheticContext(),
  runId: RUN_ID,
  maxOutputUnits: 512,
  callTimeoutMs: 5_000,
  stageDeadlineMs: 30_000,
  minVerifierTier: "large" as const,
  composedWith: { providerKey: "local_box" as const, model: "open-weights-alpha" },
};

describe("buildPass2Claims / messages (claim+span only)", () => {
  it("includes only claim text and cited span quotes — never the question or pack", () => {
    const claims = [chunkClaim("c1", "Calibration is required.", "Calibrate the antenna")];
    const built = buildPass2Claims(claims, EVIDENCE);
    expect(built).toEqual([
      {
        claimId: "c1",
        claimText: "Calibration is required.",
        claimType: "requirement",
        spans: [{ chunkId: "chk-0001", quotedText: "Calibrate the antenna" }],
      },
    ]);
    const messages = buildPass2Messages(built);
    expect(pass2PayloadIsClaimSpanOnly(messages)).toBe(true);
    const user = messages.find((m) => m.role === "user")?.text ?? "";
    expect(user).toContain("Calibration is required.");
    expect(user).toContain("Calibrate the antenna");
    expect(user).not.toContain("Question:");
    expect(user).not.toContain("Evidence pack:");
  });
});

describe("createSemanticVerifier", () => {
  it("delivers a supported verdict from claim text + cited spans only", async () => {
    const h = harness({
      claude: [
        answered(
          JSON.stringify({
            verdicts: [{ claimId: "c1", status: "supported", reason: "Span states it." }],
          }),
          "hosted-gamma",
        ),
      ],
    });
    const port = createSemanticVerifier(h.deps, {
      ...META_BASE,
      dataClass: "internal",
      verifyChain: ["claude"],
    });

    const verdicts = await port.verify({
      claims: [chunkClaim("c1", "Calibration is required.", "Calibrate the antenna")],
      evidence: EVIDENCE,
      route: {
        task: "verify",
        dataClass: "internal",
        eligible: [],
        skipped: [],
        matrixRevision: 7,
      },
    });

    const claude = h.adapters.get("claude")!;
    expect(claude.calls).toHaveLength(1);
    const blob = claude.calls[0]!.messages.map((m) => m.text).join("\n");
    expect(blob).not.toContain("Question:");
    expect(blob).not.toContain("Evidence pack:");
    expect(verdicts).toEqual([
      { claimId: "c1", status: "supported", reason: "Span states it." },
    ]);
  });

  it("for verify on client_confidential, Claude runs and DeepSeek/OpenRouter see zero calls", async () => {
    const h = harness({
      claude: [
        answered(JSON.stringify({ verdicts: [{ claimId: "c1", status: "supported" }] }), "hosted-gamma"),
      ],
      deepseek: [failed("connection")],
      openrouter: [failed("connection")],
      local_box: [failed("connection")],
    });

    const port = createSemanticVerifier(h.deps, {
      ...META_BASE,
      dataClass: "client_confidential",
      verifyChain: ["local_box", "claude", "workers_ai", "deepseek", "openrouter"],
    });

    await port.verify({
      claims: [chunkClaim("c1", "Calibration is required.", "Calibrate the antenna")],
      evidence: EVIDENCE,
      route: {
        task: "verify",
        dataClass: "client_confidential",
        eligible: [],
        skipped: [],
        matrixRevision: 7,
      },
    });

    expect(h.adapters.get("claude")!.calls.length).toBeGreaterThanOrEqual(1);
    expect(h.adapters.get("deepseek")!.calls).toHaveLength(0);
    expect(h.adapters.get("openrouter")!.calls).toHaveLength(0);
  });

  it("malformed verifier output fails closed as unsupported (does not crash)", async () => {
    const h = harness({
      claude: [answered("not-json-at-all", "hosted-gamma")],
    });
    const port = createSemanticVerifier(h.deps, {
      ...META_BASE,
      dataClass: "internal",
      verifyChain: ["claude"],
    });

    const verdicts = await port.verify({
      claims: [chunkClaim("c1", "Calibration is required.", "Calibrate the antenna")],
      evidence: EVIDENCE,
      route: {
        task: "verify",
        dataClass: "internal",
        eligible: [],
        skipped: [],
        matrixRevision: 7,
      },
    });
    expect(verdicts[0]?.status).toBe("unsupported");
  });
});
