import { describe, expect, it } from "vitest";
import { HealthResponse } from "./health";

describe("HealthResponse contract", () => {
  it("accepts the minimal health payload", () => {
    expect(HealthResponse.parse({ status: "ok", service: "terraoi-web" })).toEqual({
      status: "ok",
      service: "terraoi-web",
    });
  });

  it("rejects extra fields so nothing tenant-specific can leak through health", () => {
    expect(() =>
      HealthResponse.parse({ status: "ok", service: "terraoi-web", organisationId: "x" }),
    ).toThrow();
  });
});
