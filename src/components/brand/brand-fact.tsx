import type { ReactNode } from "react";

import { BRAND_FACT_MARKERS, type BrandFactKind } from "@/platform/branding/brand-modes";

/**
 * Marked routing/legal islands for the #65 remove-then-scan pair (ruling cited in `brand-modes.ts`).
 * Marker values come from `BRAND_FACT_MARKERS` so a typo throws instead of silently escaping the
 * check. Not a styling component — only the marker and, for routing, the host as text.
 */

type RoutingFacts = { kind: "routing"; host: string };
type LegalFacts = { kind: "legal"; children: ReactNode };

export type BrandFactProps = RoutingFacts | LegalFacts;

/**
 * Fail closed on an unknown kind. Every other option - render unmarked, render the raw string,
 * fall back to `routing` - produces a page that shows provider identity and escapes the check, which
 * is the exact failure the ruling was written to prevent.
 */
export function brandFactMarker(kind: BrandFactKind): string {
  if (!Object.hasOwn(BRAND_FACT_MARKERS, kind)) {
    const allowed = Object.values(BRAND_FACT_MARKERS).join(" or ");
    throw new Error(`unknown brand fact "${String(kind)}": data-brand-fact accepts only ${allowed}`);
  }
  return BRAND_FACT_MARKERS[kind];
}

export function BrandFact(props: BrandFactProps) {
  const marker = brandFactMarker(props.kind);

  if (props.kind === "routing") {
    // An empty host renders nothing rather than an empty marked element. That is not a loophole: the
    // page-level check asserts a routing island exists and shows the brand's host, so a surface that
    // drops this one fails the assertion instead of passing a substring scan.
    if (props.host.length === 0) return null;
    return <span data-brand-fact={marker}>{props.host}</span>;
  }

  return <span data-brand-fact={marker}>{props.children}</span>;
}
