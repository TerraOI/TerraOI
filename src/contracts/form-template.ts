import { z } from "zod";

import { DataClass } from "./data-class";
import { ServiceKey, VersionTag } from "./keys";
import { isIngestibleInM1 } from "./provider-route";

/**
 * TerraOI form templates (plan §7.6, TOI-ADR-16).
 *
 * A template is a versioned JSON Schema plus whitelisted UI hints. It can never carry scripts,
 * custom CSS or remote URLs: submissions become immutable source versions in the knowledge
 * pipeline, so a template is untrusted content with a path into retrieval (AGENTS.md §4.8).
 */

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const JsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValue),
    z.record(z.string(), JsonValue),
  ]));

/** Handlers, script/html/style keys, and anything that fetches or embeds a remote resource. */
const UNSAFE_KEY = new RegExp(
  [
    "^on(click|change|input|submit|focus|blur|load|error|mouse|key|wheel|toggle)[a-z]*$",
    "^(script|style|html|css|src|href|url|action|iframe|embed|import|require)$",
    "[-_$.](script|style|html|css|src|href|url|action|iframe|embed|ref)$",
    "^\\$ref$",
  ].join("|"),
  "i",
);
const REMOTE_OR_INLINE = /(https?:\/\/|ftp:\/\/|file:\/\/|data:|javascript:|vbscript:|\/\/[a-z0-9.-]+\/)/i;

/** True when a JSON value contains a key or string an approved template must never hold. */
export function containsUnsafeFormContent(value: unknown): boolean {
  if (typeof value === "string") return REMOTE_OR_INLINE.test(value);
  if (Array.isArray(value)) return value.some(containsUnsafeFormContent);
  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      if (UNSAFE_KEY.test(key)) return true;
      if (containsUnsafeFormContent(nested)) return true;
    }
  }
  return false;
}

/** Whitelisted per-field hints. Unknown keys are rejected, which is what blocks style/script. */
export const FormFieldUiHint = z.strictObject({
  order: z.number().int().min(0).max(999).optional(),
  placeholder: z.string().max(120).optional(),
  helpText: z.string().max(500).optional(),
  unit: z.string().max(30).optional(),
});
export type FormFieldUiHint = z.infer<typeof FormFieldUiHint>;

export const FormTemplate = z
  .strictObject({
    id: z.uuid(),
    version: VersionTag,
    // M1: platform seeds (at least one per expert) plus tenant-published templates (§7.6).
    scope: z.enum(["platform", "tenant"]),
    organisationId: z.uuid().optional(),
    serviceKey: ServiceKey,
    name: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    jsonSchema: z.record(z.string(), JsonValue),
    uiHints: z.record(z.string().min(1).max(128), FormFieldUiHint).default({}),
    defaultCollectionId: z.uuid(),
    dataClass: DataClass,
    projectId: z.uuid().optional(),
    status: z.enum(["draft", "published", "retired"]),
    publishedAt: z.iso.datetime().optional(),
  })
  .superRefine((template, ctx) => {
    if (template.scope === "tenant" && template.organisationId === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["organisationId"],
        message: "a tenant template must name the organization it belongs to (§7.6)",
      });
    }
    if (template.scope === "platform" && template.organisationId !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["organisationId"],
        message: "a platform template must not be bound to one organization (§7.6)",
      });
    }
    const schemaRoot = template.jsonSchema as { [key: string]: JsonValue };
    if (schemaRoot["type"] !== "object") {
      ctx.addIssue({
        code: "custom",
        path: ["jsonSchema"],
        message: "the template schema must be a JSON Schema object at the root",
      });
    }
    if (containsUnsafeFormContent(template.jsonSchema)) {
      ctx.addIssue({
        code: "custom",
        path: ["jsonSchema"],
        message: "templates cannot contain scripts, custom CSS or remote URLs (§7.6)",
      });
    }
    if (containsUnsafeFormContent(template.uiHints)) {
      ctx.addIssue({
        code: "custom",
        path: ["uiHints"],
        message: "ui hints cannot contain scripts, custom CSS or remote URLs (§7.6)",
      });
    }
    if (!isIngestibleInM1(template.dataClass)) {
      ctx.addIssue({
        code: "custom",
        path: ["dataClass"],
        message: "restricted content is not ingested in M1 (§12.4); lifting this needs an ADR",
      });
    }
  });
export type FormTemplate = z.infer<typeof FormTemplate>;
