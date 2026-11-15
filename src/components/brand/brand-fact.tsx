import type { ReactNode } from "react";

import { BRAND_FACT_MARKERS, type BrandFactKind } from "@/platform/branding/brand-modes";

/**
 * The two islands #65's ruling is built around.
 *
 * The supervisor's answer (2026-11-09) splits what may show the provider in `customer` mode into
 * three categories, and prescribes how the customer-mode test tells them apart:
 *
 * > routing and legal facts are rendered inside elements marked `data-brand-fact="routing"` or
 * > `data-brand-fact="legal"`. The customer-mode test removes those elements, then asserts no
 * > `/terraoi/i` anywhere else ... It also asserts that the routing element exists and shows the
 * > host. The substring check stays strict everywhere except two explicitly marked islands, so a
 * > builder cannot "fix" it by hiding the host.
 *
 * A component rather than a hand-written attribute is the difference between that rule holding and
 * decaying: the marker value comes from `BRAND_FACT_MARKERS`, so a typo (`data-brand-fact="host"`,
 * `brand-fact="routing"`) is a throw at the point of use instead of a surface that silently stops
 * being checked. The attribute is also the only place the two categories are written down - a plain
 * `<span>{host}</span>` is indistinguishable from provider branding to any scan, which is why the
 * scan and the existence assertion have to be a pair ([`brand-fact.test.tsx`](./brand-fact.test.tsx)
 * pins both halves and the two ways each half passes on its own).
 *
 * Not a styling component. It carries no class, so a surface can wrap it however it likes; the only
 * thing it guarantees is the marker and, for a routing fact, that the host is the text.
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
  const marker = (BRAND_FACT_MARKERS as Readonly<Record<string, string | undefined>>)[kind];
  if (marker === undefined) {
    const allowed = Object.values(BRAND_FACT_MARKERS).join(" or ");
    throw new Error(`unknown brand fact "${String(kind)}": data-brand-fact accepts only ${allowed}`);
  }
  return marker;
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
