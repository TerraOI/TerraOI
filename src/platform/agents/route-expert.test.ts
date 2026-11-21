import { describe, expect, it } from "vitest";

import { routeExpert, DEFAULT_ROUTE_CONFIDENCE_THRESHOLD } from "./route-expert";

const UAV = { expertKey: "uav-expert", serviceKey: "uav-compliance" } as const;
const GPR = { expertKey: "gpr-expert", serviceKey: "gpr" } as const;

describe("routeExpert (T-311 F29)", () => {
  it("suggests uav-compliance for a UAV-worded question with confidence", async () => {
    const result = await routeExpert({
      question: "What is the pre-flight compass check for our UAV before takeoff?",
      candidates: [UAV, GPR],
    });
    expect(result).toEqual({
      kind: "suggestion",
      expertKey: "uav-expert",
      serviceKey: "uav-compliance",
      confidence: expect.any(Number),
      via: "keywords",
    });
    if (result.kind === "suggestion") {
      expect(result.confidence).toBeGreaterThanOrEqual(DEFAULT_ROUTE_CONFIDENCE_THRESHOLD);
    }
  });

  it("suggests gpr for a GPR field-setup question with confidence", async () => {
    const result = await routeExpert({
      question: "How do I set up the GPR antenna spacing for a soil transect survey?",
      candidates: [UAV, GPR],
    });
    expect(result).toMatchObject({
      kind: "suggestion",
      expertKey: "gpr-expert",
      serviceKey: "gpr",
      via: "keywords",
    });
    if (result.kind === "suggestion") {
      expect(result.confidence).toBeGreaterThanOrEqual(DEFAULT_ROUTE_CONFIDENCE_THRESHOLD);
    }
  });

  it("asks the employee below the confidence threshold and never retrieves", async () => {
    const result = await routeExpert({
      question: "What is the status of the work order?",
      candidates: [UAV, GPR],
    });
    expect(result).toEqual({
      kind: "ask_employee",
      reason: "below_threshold",
      via: "keywords",
    });
  });

  it("records keyword fallback when the route model is unavailable", async () => {
    const result = await routeExpert({
      question: "UAV pre-flight rotor check before launch",
      candidates: [UAV, GPR],
      classify: async () => ({ status: "unavailable" as const }),
    });
    expect(result).toMatchObject({
      kind: "suggestion",
      expertKey: "uav-expert",
      serviceKey: "uav-compliance",
      via: "keywords",
    });
  });

  it("uses the route-model classification when it clears the threshold", async () => {
    const result = await routeExpert({
      question: "Please pick the right expert for this operational question.",
      candidates: [UAV, GPR],
      classify: async () => ({
        status: "ok" as const,
        expertKey: "gpr-expert",
        confidence: 0.91,
        providerKey: "workers_ai",
      }),
    });
    expect(result).toEqual({
      kind: "suggestion",
      expertKey: "gpr-expert",
      serviceKey: "gpr",
      confidence: 0.91,
      via: "route_model",
      providerKey: "workers_ai",
    });
  });

  it("never returns an expert outside the authorized candidate list", async () => {
    const forged = await routeExpert({
      question: "UAV flight check",
      candidates: [GPR],
      classify: async () => ({
        status: "ok" as const,
        expertKey: "uav-expert",
        confidence: 0.99,
        providerKey: "workers_ai",
      }),
    });
    expect(forged).toEqual({
      kind: "ask_employee",
      reason: "below_threshold",
      via: "keywords",
    });

    const onlyGpr = await routeExpert({
      question: "UAV pre-flight rotor and airspace NOTAM check",
      candidates: [GPR],
    });
    expect(onlyGpr.kind).not.toBe("suggestion");
    if (onlyGpr.kind === "suggestion") {
      expect(onlyGpr.expertKey).not.toBe("uav-expert");
    }
  });

  it("refuses a forged explicit pick that is not in the candidate list", async () => {
    const result = await routeExpert({
      question: "anything",
      candidates: [GPR],
      explicitExpertKey: "uav-expert",
    });
    expect(result).toEqual({
      kind: "refused",
      reason: "not_authorized",
      expertKey: "uav-expert",
    });
  });

  it("honours an authorized explicit pick over Auto suggestion", async () => {
    const result = await routeExpert({
      question: "UAV pre-flight compass check",
      candidates: [UAV, GPR],
      explicitExpertKey: "gpr-expert",
    });
    expect(result).toEqual({
      kind: "suggestion",
      expertKey: "gpr-expert",
      serviceKey: "gpr",
      confidence: 1,
      via: "explicit",
    });
  });

  it("resolves no expert when the candidate list is empty (suspended / unentitled)", async () => {
    const result = await routeExpert({
      question: "UAV pre-flight check",
      candidates: [],
    });
    expect(result).toEqual({
      kind: "ask_employee",
      reason: "no_candidates",
      via: "none",
    });
  });
});
