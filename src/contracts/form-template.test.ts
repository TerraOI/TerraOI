import { describe, expect, it } from "vitest";

import { FormTemplate, containsUnsafeFormContent } from "./form-template";

// Plan §7.6: versioned JSON-schema templates whose submissions enter the knowledge pipeline.
// Templates cannot contain scripts, custom CSS or remote URLs.
const validTemplate = () => ({
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  version: "2026-11-01",
  scope: "platform" as const,
  serviceKey: "uav",
  name: "UAV pre-flight checklist",
  jsonSchema: {
    type: "object",
    required: ["battery_checked"],
    properties: {
      battery_checked: { type: "boolean" },
      notes: { type: "string", maxLength: 2000 },
    },
    additionalProperties: false,
  },
  uiHints: {
    battery_checked: { order: 1, helpText: "Confirm cells are charged to the pack label." },
    notes: { order: 2, placeholder: "Anything unusual" },
  },
  defaultCollectionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  dataClass: "internal" as const,
  status: "published" as const,
  publishedAt: "2026-11-01T09:00:00Z",
});

describe("FormTemplate (plan §7.6)", () => {
  it("parses a platform-seeded template", () => {
    expect(FormTemplate.parse(validTemplate()).scope).toBe("platform");
  });

  it("a tenant template must name its organization; a platform template must not", () => {
    const orgId = "11111111-1111-4111-8111-111111111111";
    expect(FormTemplate.parse({ ...validTemplate(), scope: "tenant", organisationId: orgId }))
      .toBeDefined();
    expect(() => FormTemplate.parse({ ...validTemplate(), scope: "tenant" })).toThrow();
    expect(() => FormTemplate.parse({ ...validTemplate(), organisationId: orgId })).toThrow();
  });

  it("rejects unknown top-level keys such as customCss or a remote stylesheet", () => {
    for (const extra of [
      { customCss: "body{background:red}" },
      { stylesheetUrl: "https://cdn.example.test/x.css" },
      { onSubmitUrl: "https://example.test/hook" },
      { renderScript: "alert(1)" },
    ]) {
      expect(() => FormTemplate.parse({ ...validTemplate(), ...extra })).toThrow();
    }
  });

  it("rejects scripts, remote references and data: URIs inside the schema", () => {
    expect(() =>
      FormTemplate.parse({
        ...validTemplate(),
        jsonSchema: {
          type: "object",
          properties: { site: { $ref: "https://example.test/evil.json" } },
        },
      }),
    ).toThrow();
    expect(() =>
      FormTemplate.parse({
        ...validTemplate(),
        jsonSchema: { type: "object", properties: { img: { default: "data:text/html,<script>1</script>" } } },
      }),
    ).toThrow();
    expect(() =>
      FormTemplate.parse({
        ...validTemplate(),
        jsonSchema: { type: "object", properties: { script: { type: "string" } }, "x-html": "<b>x</b>" },
      }),
    ).toThrow();
  });

  it("rejects unknown keys inside a field's ui hints", () => {
    expect(() =>
      FormTemplate.parse({
        ...validTemplate(),
        uiHints: { notes: { onclick: "fetch('https://example.test')" } },
      }),
    ).toThrow();
  });

  it("requires a JSON Schema object, not a free-form blob", () => {
    expect(() => FormTemplate.parse({ ...validTemplate(), jsonSchema: "string" })).toThrow();
    expect(() =>
      FormTemplate.parse({ ...validTemplate(), jsonSchema: { type: "string" } }),
    ).toThrow();
  });

  it("does not ingest a restricted form in M1 and flags unsafe content for reviewers", () => {
    expect(() => FormTemplate.parse({ ...validTemplate(), dataClass: "restricted" })).toThrow();
    expect(
      containsUnsafeFormContent({
        type: "object",
        properties: { a: { description: "see https://example.test/doc" } },
      }),
    ).toBe(true);
    expect(
      containsUnsafeFormContent({ type: "object", properties: { a: { description: "see the manual" } } }),
    ).toBe(false);
  });
});
