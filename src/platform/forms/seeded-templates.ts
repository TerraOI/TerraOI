import type { FormTemplate } from "@/contracts/form-template";
import type { TenantContext } from "@/contracts/tenant-context";

import { mapFormTemplateRow, type FormTemplateRow } from "./template-schema";

/**
 * M1 platform-seeded form templates mirroring `supabase/seed.sql` (plan §7.6, §15.0, FAQ-0013).
 *
 * `20261120213000_forms.sql` (#197) shipped the write RPCs (`save_form_draft_v1`, `submit_form_v1`)
 * and RLS select policies on `form_templates`, without a scoped read RPC. Until a follow-up SQL PR
 * adds `list_form_templates_v1`, this catalog serves the exact seeded platform templates installed
 * in each tenant, strictly filtered by `TenantContext.organisationId` and `permittedProjectIds`.
 * Every write still goes through `withTenantRpc` into Postgres, which re-enforces template status,
 * version, project membership and RLS.
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

function isVisibleToContext(row: FormTemplateRow, ctx: TenantContext): boolean {
  if (row.organisation_id !== ctx.organisationId) return false;
  if (row.status !== "published") return false;
  if (row.project_id !== null && row.project_id !== undefined) {
    return ctx.permittedProjectIds.includes(row.project_id);
  }
  return true;
}

/** Return only published templates installed in `ctx.organisationId` and visible to the member. */
export function listSeededTemplatesForTenant(ctx: TenantContext): FormTemplate[] {
  return SEEDED_FORM_TEMPLATE_ROWS.filter((row) => isVisibleToContext(row, ctx)).map(mapFormTemplateRow);
}

/** Resolve one published template in `ctx.organisationId`; foreign or unauthorized ids return null. */
export function findSeededTemplateForTenant(ctx: TenantContext, templateId: string): FormTemplate | null {
  const row = SEEDED_FORM_TEMPLATE_ROWS.find((item) => item.id === templateId && isVisibleToContext(item, ctx));
  return row === undefined ? null : mapFormTemplateRow(row);
}
