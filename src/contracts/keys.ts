import { z } from "zod";

/**
 * Shared identifier shapes for TerraOI contracts.
 *
 * These are format-only guards: they make a forged or sloppy identifier fail at the boundary.
 * Authorization never comes from the shape of an id (plan §4.1 step 2, AGENTS.md §4.1).
 */

/** Provider key as stored in `model_providers` (plan §6.1), e.g. `local_box`, `workers_ai`. */
export const ProviderKey = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "providerKey must be a lowercase key like 'workers_ai'");
export type ProviderKey = z.infer<typeof ProviderKey>;

export const ServiceKey = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
export type ServiceKey = z.infer<typeof ServiceKey>;

export const ExpertKey = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
export type ExpertKey = z.infer<typeof ExpertKey>;

export const ToolKey = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
export type ToolKey = z.infer<typeof ToolKey>;

/** Version tags for experts, prompts, templates and index generations (immutable once released). */
export const VersionTag = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
export type VersionTag = z.infer<typeof VersionTag>;

/**
 * A normalized, externally routed host (plan §4.1 step 1): lowercase, no scheme, no port, no
 * path, at most one tenant label below the platform domain. Unknown or reserved hosts are
 * rejected by the resolver (F01); a custom customer hostname would relax the label rule and so
 * needs an ADR (plan §5.1).
 */
export const NormalizedHost = z
  .string()
  .regex(
    /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/,
    "host must be a lowercase bare hostname (no scheme, port or path)",
  )
  .refine((host) => host.split(".").length <= 3, "at most one subdomain level below the zone");
export type NormalizedHost = z.infer<typeof NormalizedHost>;

/** Opaque public id used for conversations, evidence references and upload sessions. */
export const OpaqueId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export type OpaqueId = z.infer<typeof OpaqueId>;
