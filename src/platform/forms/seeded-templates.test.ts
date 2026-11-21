import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { FormTemplate } from "@/contracts/form-template";
import { createTenantContext } from "@/contracts/tenant-context";

import {
  SEEDED_FORM_TEMPLATE_ROWS,
  findSeededTemplateForTenant,
  listSeededTemplatesForTenant,
} from "./seeded-templates";
import { mapFormTemplateRow } from "./template-schema";

const COMPANY1_ORG_ID = "11111111-1111-4111-8111-111111111111";
const COMPANY2_ORG_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ORG_ID = "33333333-3333-4333-8333-333333333333";
const SITE_A_PROJECT_ID = "41000000-0000-4000-8000-000000000001";

const UAV_TEMPLATE_ID = "80000000-0000-4000-8000-000000000001";
const SITE_A_TEMPLATE_ID = "80000000-0000-4000-8000-000000000002";
const GPR_TEMPLATE_ID = "80000000-0000-4000-8000-000000000003";

const SEEDED_COLLECTIONS = new Map<string, { organisationId: string; projectId: string | null }>([
  ["51000000-0000-4000-8000-000000000001", { organisationId: COMPANY1_ORG_ID, projectId: null }],
  ["51000000-0000-4000-8000-000000000002", { organisationId: COMPANY1_ORG_ID, projectId: SITE_A_PROJECT_ID }],
  ["52000000-0000-4000-8000-000000000001", { organisationId: COMPANY2_ORG_ID, projectId: null }],
]);

function contextFor(organisationId: string, permittedProjectIds: string[] = []) {
  return createTenantContext({
    organisationId,
    host: organisationId === COMPANY2_ORG_ID ? "company2.terraoi.app" : "company1.terraoi.app",
    userId: "00000000-0000-4000-8000-0000000000a2",
    membershipId: "99000000-0000-4000-8000-000000000001",
    membershipStatus: "active",
    roles: ["member"],
    permittedServiceKeys: [],
    permittedProjectIds,
    policyRevision: 1,
    resolvedAt: "2026-11-20T00:00:00Z",
  });
}

describe("seeded form templates (T-301 acceptance)", () => {
  it("parses at least two platform templates, one per seeded service key, each bound to a publishable collection", () => {
    expect(SEEDED_FORM_TEMPLATE_ROWS.length).toBeGreaterThanOrEqual(2);

    const parsed = SEEDED_FORM_TEMPLATE_ROWS.map((row) => mapFormTemplateRow(row));
    for (const template of parsed) {
      expect(() => FormTemplate.parse(template)).not.toThrow();
      expect(template.scope).toBe("platform");
      expect(template.status).toBe("published");
      // FAQ-0013 (#195): platform rows drop organisationId when mapped into FormTemplate.
      expect(template.organisationId).toBeUndefined();
    }

    const serviceKeys = new Set(parsed.map((t) => t.serviceKey));
    expect(serviceKeys.has("uav-compliance")).toBe(true);
    expect(serviceKeys.has("gpr")).toBe(true);

    // Every seeded row must bind to a publishable collection owned by the same organisation
    // and with the matching project audience.
    for (const row of SEEDED_FORM_TEMPLATE_ROWS) {
      const collection = SEEDED_COLLECTIONS.get(row.default_collection_id);
      expect(collection).toBeDefined();
      expect(collection?.organisationId).toBe(row.organisation_id);
      expect(collection?.projectId).toBe(row.project_id);
    }
  });

  it("stays in lockstep with supabase/seed.sql ids and versions", () => {
    const seedSql = readFileSync(resolve(process.cwd(), "supabase/seed.sql"), "utf8");
    for (const row of SEEDED_FORM_TEMPLATE_ROWS) {
      expect(seedSql).toContain(row.id);
      expect(seedSql).toContain(row.default_collection_id);
      expect(seedSql).toContain(row.name);
    }
  });

  it("keeps tenant and project audience isolation when listing and resolving templates", () => {
    const company1Field = contextFor(COMPANY1_ORG_ID, []);
    const company1SiteA = contextFor(COMPANY1_ORG_ID, [SITE_A_PROJECT_ID]);
    const company2Member = contextFor(COMPANY2_ORG_ID, []);
    const unknownTenant = contextFor(OTHER_ORG_ID, []);

    // Company1 member outside Site A sees only tenant-wide UAV pre-flight check.
    expect(listSeededTemplatesForTenant(company1Field).map((t) => t.id)).toEqual([UAV_TEMPLATE_ID]);
    expect(findSeededTemplateForTenant(company1Field, SITE_A_TEMPLATE_ID)).toBeNull();
    expect(findSeededTemplateForTenant(company1Field, GPR_TEMPLATE_ID)).toBeNull();

    // Company1 member inside Site A sees UAV pre-flight and Site A observation, never company2.
    expect(listSeededTemplatesForTenant(company1SiteA).map((t) => t.id)).toEqual([
      UAV_TEMPLATE_ID,
      SITE_A_TEMPLATE_ID,
    ]);
    expect(findSeededTemplateForTenant(company1SiteA, GPR_TEMPLATE_ID)).toBeNull();

    // Company2 member sees only GPR field log.
    expect(listSeededTemplatesForTenant(company2Member).map((t) => t.id)).toEqual([GPR_TEMPLATE_ID]);
    expect(findSeededTemplateForTenant(company2Member, UAV_TEMPLATE_ID)).toBeNull();

    // Unknown tenant fails closed to empty.
    expect(listSeededTemplatesForTenant(unknownTenant)).toEqual([]);
  });

  it("keeps organisationId on tenant-scoped rows and refuses unsafe or restricted templates", () => {
    const baseRow = SEEDED_FORM_TEMPLATE_ROWS[0]!;

    const tenantRow = mapFormTemplateRow({ ...baseRow, scope: "tenant" });
    expect(tenantRow.scope).toBe("tenant");
    expect(tenantRow.organisationId).toBe(baseRow.organisation_id);

    // Unsafe script key
    expect(() =>
      mapFormTemplateRow({
        ...baseRow,
        json_schema: { type: "object", properties: { onclick: { type: "string" } } },
      }),
    ).toThrow();

    // Unsafe $ref
    expect(() =>
      mapFormTemplateRow({
        ...baseRow,
        json_schema: { type: "object", $ref: "#/defs/x", properties: {} },
      }),
    ).toThrow();

    // Unsafe remote URL or data: URI
    expect(() =>
      mapFormTemplateRow({
        ...baseRow,
        ui_hints: { airframe_check: { helpText: "See https://evil.example/a" } },
      }),
    ).toThrow();
    expect(() =>
      mapFormTemplateRow({
        ...baseRow,
        ui_hints: { airframe_check: { helpText: "data:text/html,<script>" } },
      }),
    ).toThrow();

    // Unsafe CSS key in ui_hints
    expect(() =>
      mapFormTemplateRow({
        ...baseRow,
        ui_hints: { airframe_check: { css: "body{display:none}" } },
      }),
    ).toThrow();

    // Restricted data class (plan §12.4)
    expect(() =>
      mapFormTemplateRow({
        ...baseRow,
        data_class: "restricted",
      }),
    ).toThrow();
  });
});
