import { z } from "zod";

import { DataClass } from "@/contracts/data-class";
import { FormTemplate } from "@/contracts/form-template";
import { ServiceKey, VersionTag } from "@/contracts/keys";

/**
 * Pure form template mapping, field extraction, version-pinned validation and deterministic text
 * rendering (plan §7.6, §16, TOI-ADR-16). Mirrors `20261120213000_forms.sql` so invalid input and
 * closed versions are caught at the boundary before any RPC leaves the Worker.
 */

export const MAX_SUBMISSION_JSON_CHARS = 100_000;

export type FormFieldKind = "string" | "number" | "integer" | "boolean";

export interface FormFieldSpec {
  name: string;
  kind: FormFieldKind;
  required: boolean;
  maxLength?: number;
  order: number;
  placeholder?: string;
  helpText?: string;
  unit?: string;
}

export type FormFieldValue = string | number | boolean;
export type FormValues = Record<string, FormFieldValue>;

export type FormValidationOutcome =
  | { ok: true; values: FormValues }
  | { ok: false; code: "version_closed"; templateVersion: string; message: string }
  | { ok: false; code: "validation"; message: string; fieldErrors: Record<string, string> };

const JsonObject = z.record(z.string(), z.unknown());

/**
 * Snake_case projection of `public.form_templates` (`src/contracts/database.types.ts`).
 * `scope = "platform"` rows still carry `organisation_id` in Postgres ("installed in", FAQ-0013 /
 * #195); `mapFormTemplateRow` drops `organisationId` for platform rows so `FormTemplate` stays
 * unchanged with no ADR.
 */
const FormTemplateRowSchema = z.strictObject({
  id: z.uuid(),
  organisation_id: z.uuid(),
  scope: z.enum(["platform", "tenant"]),
  service_key: ServiceKey,
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  version: VersionTag,
  json_schema: JsonObject,
  ui_hints: JsonObject,
  default_collection_id: z.uuid(),
  project_id: z.uuid().nullable().optional(),
  data_class: DataClass,
  status: z.enum(["draft", "published", "retired"]),
  published_at: z.string().nullable().optional(),
});

export type FormTemplateRow = z.infer<typeof FormTemplateRowSchema>;

/** Parse one DB/seed row into the merged `FormTemplate` contract, enforcing unsafe-content rules. */
export function mapFormTemplateRow(row: unknown): FormTemplate {
  const parsed = FormTemplateRowSchema.parse(row);
  return FormTemplate.parse({
    id: parsed.id,
    version: parsed.version,
    scope: parsed.scope,
    ...(parsed.scope === "tenant" ? { organisationId: parsed.organisation_id } : {}),
    serviceKey: parsed.service_key,
    name: parsed.name,
    ...(parsed.description != null ? { description: parsed.description } : {}),
    jsonSchema: parsed.json_schema,
    uiHints: parsed.ui_hints,
    defaultCollectionId: parsed.default_collection_id,
    ...(parsed.project_id != null ? { projectId: parsed.project_id } : {}),
    dataClass: parsed.data_class,
    status: parsed.status,
    ...(parsed.published_at != null ? { publishedAt: parsed.published_at } : {}),
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asFieldKind(raw: unknown): FormFieldKind {
  switch (raw) {
    case "string":
    case "number":
    case "integer":
    case "boolean":
      return raw;
    default:
      throw new Error("Form template declares an unsupported field type.");
  }
}

/**
 * Extract the small JSON Schema subset supported by `save_form_draft_v1` in deterministic display
 * order (`uiHints.order`, then field name).
 */
export function extractFormFields(template: FormTemplate): FormFieldSpec[] {
  const schema = template.jsonSchema;
  const rawProperties = schema["properties"];
  if (rawProperties !== undefined && !isPlainObject(rawProperties)) {
    throw new Error("Form template properties must be an object.");
  }
  const properties = rawProperties ?? {};

  const rawRequired = schema["required"];
  const requiredSet = new Set<string>();
  if (rawRequired !== undefined) {
    if (!Array.isArray(rawRequired)) {
      throw new Error("Form template required list must be an array of field names.");
    }
    for (const key of rawRequired) {
      if (typeof key !== "string") {
        throw new Error("Form template required list must contain only field names.");
      }
      requiredSet.add(key);
    }
  }

  const fields: FormFieldSpec[] = [];
  for (const [name, declaration] of Object.entries(properties)) {
    if (!isPlainObject(declaration)) {
      throw new Error("Form template property declaration must be an object.");
    }
    const kind = asFieldKind(declaration["type"]);
    const rawMax = declaration["maxLength"];
    const maxLength =
      typeof rawMax === "number" && Number.isInteger(rawMax) && rawMax > 0 ? rawMax : undefined;
    const hint = template.uiHints[name];
    fields.push({
      name,
      kind,
      required: requiredSet.has(name),
      ...(maxLength !== undefined ? { maxLength } : {}),
      order: hint?.order ?? 999,
      ...(hint?.placeholder !== undefined ? { placeholder: hint.placeholder } : {}),
      ...(hint?.helpText !== undefined ? { helpText: hint.helpText } : {}),
      ...(hint?.unit !== undefined ? { unit: hint.unit } : {}),
    });
  }

  fields.sort((a, b) => (a.order !== b.order ? a.order - b.order : a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return fields;
}

/**
 * Coerce UI string/boolean inputs into declared scalar types while keeping unknown keys and
 * unparseable numbers so `validateFormValues` reports them cleanly.
 */
export function parseFormSubmissionEntries(
  template: FormTemplate,
  raw: Record<string, string | boolean | undefined>,
): Record<string, unknown> {
  const fields = new Map(extractFormFields(template).map((f) => [f.name, f]));
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(raw)) {
    const field = fields.get(key);
    if (field === undefined) {
      if (value !== undefined) out[key] = value;
      continue;
    }

    switch (field.kind) {
      case "string": {
        if (typeof value === "string" && value.length > 0) {
          out[key] = value;
        }
        break;
      }
      case "number":
      case "integer": {
        if (typeof value === "string") {
          const trimmed = value.trim();
          if (trimmed.length === 0) break;
          const parsed = Number(trimmed);
          out[key] = Number.isFinite(parsed) ? parsed : value;
        } else if (value !== undefined) {
          out[key] = value;
        }
        break;
      }
      case "boolean": {
        if (typeof value === "boolean") {
          out[key] = value;
        } else if (value === "true" || value === "on") {
          out[key] = true;
        } else if (value === "false") {
          out[key] = false;
        } else if (field.required) {
          out[key] = false;
        }
        break;
      }
      default: {
        const _exhaustive: never = field.kind;
        void _exhaustive;
      }
    }
  }

  return out;
}

/**
 * Validate submitted values against one exact published template version (plan §7.6 step 2, §16).
 * Refusal text never echoes untrusted field values (AGENTS.md §4.8).
 */
export function validateFormValues(
  template: FormTemplate,
  expectedVersion: string,
  rawValues: unknown,
): FormValidationOutcome {
  if (template.status !== "published" || template.version !== expectedVersion) {
    return {
      ok: false,
      code: "version_closed",
      templateVersion: expectedVersion,
      message: `Template version ${expectedVersion} is no longer open for submissions.`,
    };
  }

  if (!isPlainObject(rawValues)) {
    return {
      ok: false,
      code: "validation",
      message: "The submission must be a JSON object.",
      fieldErrors: {},
    };
  }

  let fields: FormFieldSpec[];
  try {
    fields = extractFormFields(template);
  } catch {
    return {
      ok: false,
      code: "validation",
      message: "This template declares a field type the platform does not validate.",
      fieldErrors: {},
    };
  }

  const fieldMap = new Map(fields.map((f) => [f.name, f]));
  const fieldErrors: Record<string, string> = {};
  const validated: FormValues = {};

  for (const field of fields) {
    if (!field.required) continue;
    const value = rawValues[field.name];
    if (value === undefined || (field.kind === "string" && typeof value === "string" && value.trim().length === 0)) {
      fieldErrors[field.name] = "This field is required.";
    }
  }

  let hasUnknownField = false;
  for (const [key, value] of Object.entries(rawValues)) {
    const field = fieldMap.get(key);
    if (field === undefined) {
      hasUnknownField = true;
      continue;
    }

    switch (field.kind) {
      case "string": {
        if (typeof value !== "string") {
          fieldErrors[key] = "Enter text for this field.";
        } else if (field.maxLength !== undefined && value.length > field.maxLength) {
          fieldErrors[key] = `Must be at most ${field.maxLength} characters.`;
        } else {
          validated[key] = value;
        }
        break;
      }
      case "number": {
        if (typeof value !== "number" || !Number.isFinite(value)) {
          fieldErrors[key] = "Enter a valid number.";
        } else {
          validated[key] = value;
        }
        break;
      }
      case "integer": {
        if (typeof value !== "number" || !Number.isInteger(value)) {
          fieldErrors[key] = "Enter a whole number.";
        } else {
          validated[key] = value;
        }
        break;
      }
      case "boolean": {
        if (typeof value !== "boolean") {
          fieldErrors[key] = "Select yes or no.";
        } else {
          validated[key] = value;
        }
        break;
      }
      default: {
        const _exhaustive: never = field.kind;
        void _exhaustive;
      }
    }
  }

  if (hasUnknownField) {
    return {
      ok: false,
      code: "validation",
      message: "A value names a field the template does not declare.",
      fieldErrors,
    };
  }

  if (Object.keys(fieldErrors).length > 0) {
    return {
      ok: false,
      code: "validation",
      message: "Check the highlighted fields and try again.",
      fieldErrors,
    };
  }

  if (JSON.stringify(validated).length > MAX_SUBMISSION_JSON_CHARS) {
    return {
      ok: false,
      code: "validation",
      message: "The submission is larger than the platform accepts.",
      fieldErrors: {},
    };
  }

  return { ok: true, values: validated };
}

export function dataClassLabel(dataClass: DataClass): string {
  switch (dataClass) {
    case "public":
      return "Public";
    case "internal":
      return "Internal";
    case "client_confidential":
      return "Client confidential";
    case "restricted":
      return "Restricted";
    default: {
      const _exhaustive: never = dataClass;
      return _exhaustive;
    }
  }
}

/**
 * Deterministic `"field: value"` text representation matching `public.form_submission_body_text`
 * in `20261120213000_forms.sql` (#51 option 1).
 */
export function renderSubmissionBodyText(template: FormTemplate, values: FormValues): string {
  const entries = Object.entries(values).map(([key, value]) => ({
    ord: template.uiHints[key]?.order ?? 999,
    line: `${key}: ${String(value)}`,
  }));
  entries.sort((a, b) => (a.ord !== b.ord ? a.ord - b.ord : a.line < b.line ? -1 : a.line > b.line ? 1 : 0));
  return entries.map((entry) => entry.line).join("\n");
}
