import type { FormTemplateRow } from "./template-schema";

/**
 * Test-only fixtures mirroring the three M1 platform-seeded rows in `supabase/seed.sql`
 * (AGENTS.md §4.7, plan §15.0). Never imported from production runtime code; runtime reads go
 * through `list_form_templates_v1` and `get_form_template_v1` via `withTenantRpc`.
 */
export const SEEDED_FORM_TEMPLATE_ROWS: readonly FormTemplateRow[] = [
  {
    id: "80000000-0000-4000-8000-000000000001",
    organisation_id: "11111111-1111-4111-8111-111111111111",
    scope: "platform",
    service_key: "uav-compliance",
    name: "UAV pre-flight check (synthetic)",
    description: "Before-flight airframe, battery and weather check, captured as a knowledge record.",
    version: "v1",
    json_schema: {
      type: "object",
      additionalProperties: false,
      required: ["airframe_check", "battery_pct", "weather_notes"],
      properties: {
        airframe_check: { type: "string", maxLength: 500 },
        battery_pct: { type: "number" },
        weather_notes: { type: "string", maxLength: 2000 },
      },
    },
    ui_hints: {
      airframe_check: { order: 1, helpText: "Tether, props and battery latches" },
      battery_pct: { order: 2, unit: "percent" },
      weather_notes: { order: 3, helpText: "Wind, visibility, precipitation" },
    },
    default_collection_id: "51000000-0000-4000-8000-000000000001",
    project_id: null,
    data_class: "public",
    status: "published",
    published_at: "2026-11-01T00:00:00Z",
  },
  {
    id: "80000000-0000-4000-8000-000000000002",
    organisation_id: "11111111-1111-4111-8111-111111111111",
    scope: "platform",
    service_key: "uav-compliance",
    name: "Site A field observation (synthetic)",
    description: "What a crew saw on Site A; confidential, so it stays inside the project audience.",
    version: "v1",
    json_schema: {
      type: "object",
      additionalProperties: false,
      required: ["location", "observation"],
      properties: {
        location: { type: "string", maxLength: 200 },
        observation: { type: "string", maxLength: 4000 },
      },
    },
    ui_hints: {
      location: { order: 1, placeholder: "grid or station" },
      observation: { order: 2, helpText: "One sentence per thing seen" },
    },
    default_collection_id: "51000000-0000-4000-8000-000000000002",
    project_id: "41000000-0000-4000-8000-000000000001",
    data_class: "client_confidential",
    status: "published",
    published_at: "2026-11-01T00:00:00Z",
  },
  {
    id: "80000000-0000-4000-8000-000000000003",
    organisation_id: "22222222-2222-4222-8222-222222222222",
    scope: "platform",
    service_key: "gpr",
    name: "GPR field log (synthetic)",
    description: "One line of a ground-penetrating radar survey: line id and pass count.",
    version: "v1",
    json_schema: {
      type: "object",
      additionalProperties: false,
      required: ["line_id", "passes"],
      properties: {
        line_id: { type: "string", maxLength: 100 },
        passes: { type: "integer" },
      },
    },
    ui_hints: {
      line_id: { order: 1, placeholder: "L-01" },
      passes: { order: 2, helpText: "Number of passes over the line" },
    },
    default_collection_id: "52000000-0000-4000-8000-000000000001",
    project_id: null,
    data_class: "public",
    status: "published",
    published_at: "2026-11-01T00:00:00Z",
  },
];
