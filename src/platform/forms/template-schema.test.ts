import { describe, expect, it } from "vitest";

import { SEEDED_FORM_TEMPLATE_ROWS } from "./seeded-templates";
import {
  extractFormFields,
  mapFormTemplateRow,
  parseFormSubmissionEntries,
  renderSubmissionBodyText,
  validateFormValues,
} from "./template-schema";

const uavTemplate = mapFormTemplateRow(SEEDED_FORM_TEMPLATE_ROWS[0]!);
const gprTemplate = mapFormTemplateRow(SEEDED_FORM_TEMPLATE_ROWS[2]!);

describe("extractFormFields", () => {
  it("orders fields by uiHints.order then field name and preserves hints and constraints", () => {
    const fields = extractFormFields(uavTemplate);
    expect(fields.map((f) => f.name)).toEqual(["airframe_check", "battery_pct", "weather_notes"]);
    expect(fields[0]).toMatchObject({
      name: "airframe_check",
      kind: "string",
      required: true,
      maxLength: 500,
      order: 1,
      helpText: "Tether, props and battery latches",
    });
    expect(fields[1]).toMatchObject({
      name: "battery_pct",
      kind: "number",
      required: true,
      order: 2,
      unit: "percent",
    });
    expect(fields[2]).toMatchObject({
      name: "weather_notes",
      kind: "string",
      required: true,
      maxLength: 2000,
      order: 3,
    });
  });

  it("rejects unsupported JSON Schema field types", () => {
    const badTemplate = {
      ...uavTemplate,
      jsonSchema: {
        type: "object",
        properties: { nested: { type: "array" } },
      },
    };
    expect(() => extractFormFields(badTemplate)).toThrow();
  });
});

describe("validateFormValues", () => {
  it("accepts valid UAV and GPR values against their exact published version", () => {
    const uav = validateFormValues(uavTemplate, "v1", {
      airframe_check: "Props and tether verified",
      battery_pct: 94.5,
      weather_notes: "Wind 4 m/s, clear visibility",
    });
    expect(uav.ok).toBe(true);

    const gpr = validateFormValues(gprTemplate, "v1", {
      line_id: "L-01",
      passes: 2,
    });
    expect(gpr.ok).toBe(true);
  });

  it("refuses a retired or re-versioned template naming the version validated (plan §16)", () => {
    const versionMismatch = validateFormValues(uavTemplate, "v0", {
      airframe_check: "ok",
      battery_pct: 90,
      weather_notes: "clear",
    });
    expect(versionMismatch).toEqual({
      ok: false,
      code: "version_closed",
      templateVersion: "v0",
      message: "Template version v0 is no longer open for submissions.",
    });

    const retired = validateFormValues({ ...uavTemplate, status: "retired" }, "v1", {
      airframe_check: "ok",
      battery_pct: 90,
      weather_notes: "clear",
    });
    expect(retired).toEqual({
      ok: false,
      code: "version_closed",
      templateVersion: "v1",
      message: "Template version v1 is no longer open for submissions.",
    });
  });

  it("refuses missing required fields, unknown fields, wrong scalar types, and oversized strings without echoing values", () => {
    const secretSentinel = "SECRET_UNTRUSTED_VALUE_991";

    const missing = validateFormValues(uavTemplate, "v1", { airframe_check: "ok" });
    expect(missing.ok).toBe(false);
    if (!missing.ok && missing.code === "validation") {
      expect(missing.fieldErrors.battery_pct).toBeDefined();
      expect(missing.fieldErrors.weather_notes).toBeDefined();
    }

    const unknown = validateFormValues(uavTemplate, "v1", {
      airframe_check: "ok",
      battery_pct: 90,
      weather_notes: "clear",
      injected_field: secretSentinel,
    });
    expect(unknown.ok).toBe(false);
    expect(JSON.stringify(unknown)).not.toContain(secretSentinel);

    const badNumber = validateFormValues(uavTemplate, "v1", {
      airframe_check: "ok",
      battery_pct: secretSentinel,
      weather_notes: "clear",
    });
    expect(badNumber.ok).toBe(false);
    expect(JSON.stringify(badNumber)).not.toContain(secretSentinel);

    const nonWholeInteger = validateFormValues(gprTemplate, "v1", {
      line_id: "L-01",
      passes: 2.5,
    });
    expect(nonWholeInteger.ok).toBe(false);

    const oversize = validateFormValues(uavTemplate, "v1", {
      airframe_check: "x".repeat(501),
      battery_pct: 90,
      weather_notes: "clear",
    });
    expect(oversize.ok).toBe(false);
  });
});

describe("parseFormSubmissionEntries", () => {
  it("coerces string inputs into declared scalar types and leaves bad numbers invalid for validation", () => {
    const parsed = parseFormSubmissionEntries(uavTemplate, {
      airframe_check: "Checked",
      battery_pct: "88.5",
      weather_notes: "Calm",
    });
    expect(parsed).toEqual({
      airframe_check: "Checked",
      battery_pct: 88.5,
      weather_notes: "Calm",
    });

    const bad = parseFormSubmissionEntries(uavTemplate, {
      airframe_check: "Checked",
      battery_pct: "not-a-number",
      weather_notes: "Calm",
    });
    expect(validateFormValues(uavTemplate, "v1", bad).ok).toBe(false);
  });
});

describe("renderSubmissionBodyText", () => {
  it("renders deterministic field: value lines in uiHints.order order matching SQL form_submission_body_text", () => {
    const text = renderSubmissionBodyText(uavTemplate, {
      weather_notes: "Wind 4 m/s",
      airframe_check: "Tether checked",
      battery_pct: 92,
    });
    expect(text).toBe("airframe_check: Tether checked\nbattery_pct: 92\nweather_notes: Wind 4 m/s");
  });
});
