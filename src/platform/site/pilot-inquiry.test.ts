import { describe, expect, it } from "vitest";
import { parsePilotInquiry } from "./pilot-inquiry";

const valid = {
  name: "  Dana Reyes ",
  email: "Dana.Reyes@Company1.com",
  company: "Company1",
  role: "Survey lead",
  services: ["uav", "gpr"],
  message: "We fly weekly corridor surveys.",
  privacyAcknowledged: true,
  website: "",
  turnstileToken: "tok-123",
};

describe("parsePilotInquiry", () => {
  it("accepts valid input, lowercases email and trims name", () => {
    const r = parsePilotInquiry(valid);
    expect(r).toEqual({
      ok: true,
      turnstileToken: "tok-123",
      inquiry: {
        name: "Dana Reyes",
        email: "dana.reyes@company1.com",
        company: "Company1",
        role: "Survey lead",
        services: ["uav", "gpr"],
        message: "We fly weekly corridor surveys.",
      },
    });
  });

  it("treats empty optional fields as null and allows website to be absent", () => {
    const rest: Record<string, unknown> = { ...valid };
    delete rest.website;
    const r = parsePilotInquiry({ ...rest, role: " ", message: "" });
    expect(r.ok && r.inquiry.role).toBe(null);
    expect(r.ok && r.inquiry.message).toBe(null);
  });

  it.each([
    ["unknown key", { extra: 1 }],
    ["name 121 chars", { name: "a".repeat(121) }],
    ["blank name", { name: "   " }],
    ["bad email", { email: "not-an-email" }],
    ["email over 254", { email: `${"a".repeat(250)}@x.co` }],
    ["company 161 chars", { company: "c".repeat(161) }],
    ["role 121 chars", { role: "r".repeat(121) }],
    ["empty services", { services: [] }],
    ["unknown service", { services: ["lidar"] }],
    ["duplicate service", { services: ["uav", "uav"] }],
    ["message 2001 chars", { message: "m".repeat(2001) }],
    ["privacy not acknowledged", { privacyAcknowledged: false }],
    ["honeypot filled", { website: "x" }],
    ["missing token", { turnstileToken: "" }],
    ["token over 2048", { turnstileToken: "t".repeat(2049) }],
  ])("rejects %s", (_label, patch) => {
    expect(parsePilotInquiry({ ...valid, ...patch }).ok).toBe(false);
  });

  it("rejects non-object bodies", () => {
    for (const body of [null, "x", 1, []]) expect(parsePilotInquiry(body).ok).toBe(false);
  });

  it("counts a 60-emoji name as within the limit", () => {
    const name = "🛰".repeat(60); // 60 astral code points = 120 UTF-16 units
    expect(name.length).toBe(120);
    expect(parsePilotInquiry({ ...valid, name }).ok).toBe(true);
  });

  it("field errors never echo the submitted value", () => {
    const secret = "SECRET-VALUE-<script>";
    const r = parsePilotInquiry({ ...valid, email: secret, name: secret.repeat(20), services: [secret] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(Object.keys(r.fieldErrors).sort()).toEqual(["email", "name", "services"]);
      expect(JSON.stringify(r.fieldErrors)).not.toContain("SECRET");
    }
  });
});
