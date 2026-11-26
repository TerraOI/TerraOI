/**
 * F29 `routeExpert` — Auto-mode suggestion across the authorized expert list (plan §10.1, #83).
 *
 * Returns one expert key plus the service key that authorized it. Never invents a candidate
 * outside the list the caller already filtered to this tenant's entitlements. The employee's
 * explicit pick always wins when it is authorized. Below the confidence threshold the UI asks
 * the employee; this module never runs retrieval.
 */

export const DEFAULT_ROUTE_CONFIDENCE_THRESHOLD = 0.6;

export interface RouteCandidate {
  readonly expertKey: string;
  readonly serviceKey: string;
}

export type RouteClassifyOutcome =
  | {
      readonly status: "ok";
      readonly expertKey: string;
      readonly confidence: number;
      readonly providerKey: string;
    }
  | { readonly status: "unavailable" };

export type RouteExpertResult =
  | {
      readonly kind: "suggestion";
      readonly expertKey: string;
      readonly serviceKey: string;
      readonly confidence: number;
      readonly via: "keywords" | "route_model" | "explicit";
      readonly providerKey?: string;
    }
  | {
      readonly kind: "ask_employee";
      readonly reason: "below_threshold" | "ambiguous" | "no_candidates";
      readonly via: "keywords" | "route_model" | "none";
    }
  | {
      readonly kind: "refused";
      readonly reason: "not_authorized";
      readonly expertKey: string;
    };

export interface RouteExpertInput {
  readonly question: string;
  /** Already narrowed to this tenant's enabled experts (§8.1 / #83). */
  readonly candidates: readonly RouteCandidate[];
  /** Employee override; wins when present and authorized (§10.1). */
  readonly explicitExpertKey?: string;
  readonly threshold?: number;
  /**
   * Optional cleared `route`-task classifier (no Claude in that chain). When unavailable or
   * absent, keyword rules decide and the fallback is recorded as `via: "keywords"`.
   */
  readonly classify?: (
    question: string,
    candidates: readonly RouteCandidate[],
  ) => Promise<RouteClassifyOutcome>;
}

const UAV_TERMS = [
  "uav",
  "drone",
  "aircraft",
  "flight",
  "pre-flight",
  "preflight",
  "compass",
  "notam",
  "airspace",
  "pilot",
  "rotor",
  "takeoff",
  "take-off",
  "launch",
  "payload capacity",
] as const;

const GPR_TERMS = [
  "gpr",
  "ground penetrating",
  "ground-penetrating",
  "radar",
  "antenna",
  "transect",
  "permittivity",
  "soil",
  "survey line",
  "hyperbola",
] as const;

const SERVICE_TERMS: Record<string, readonly string[]> = {
  "uav-compliance": UAV_TERMS,
  gpr: GPR_TERMS,
  "uav-expert": UAV_TERMS,
  "gpr-expert": GPR_TERMS,
};

function normalizeQuestion(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

function escapeRegExp(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-word (or whole-phrase) match, so "soil" does not hit "soiled" and "uav" needs its own word. */
function hasTerm(question: string, term: string): boolean {
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(term)}($|[^a-z0-9])`).test(
    question,
  );
}

function keywordScore(question: string, candidate: RouteCandidate): number {
  // A Set: the service key and expert key share one term list, and a term must not count twice.
  const terms = new Set([
    ...(SERVICE_TERMS[candidate.serviceKey] ?? []),
    ...(SERVICE_TERMS[candidate.expertKey] ?? []),
  ]);
  let hits = 0;
  for (const term of terms) {
    if (hasTerm(question, term)) hits += 1;
  }
  if (hits === 0) return 0;
  // One generic word ("launch", "soil", "pilot") is not enough to route on: it scores 0.5, below the
  // default threshold, so the employee is asked. Two hits score 0.7 and clear it.
  return Math.min(1, 0.3 + hits * 0.2);
}

function findCandidate(
  candidates: readonly RouteCandidate[],
  expertKey: string,
): RouteCandidate | undefined {
  return candidates.find((c) => c.expertKey === expertKey);
}

function keywordRoute(
  question: string,
  candidates: readonly RouteCandidate[],
  threshold: number,
): RouteExpertResult {
  if (candidates.length === 0) {
    return { kind: "ask_employee", reason: "no_candidates", via: "none" };
  }

  const scored = candidates
    .map((candidate) => ({
      candidate,
      confidence: keywordScore(question, candidate),
    }))
    .sort((a, b) => b.confidence - a.confidence);

  const best = scored[0];
  const second = scored[1];
  if (best === undefined || best.confidence < threshold) {
    return { kind: "ask_employee", reason: "below_threshold", via: "keywords" };
  }
  if (
    second !== undefined &&
    second.confidence >= threshold &&
    second.confidence >= best.confidence - 0.05
  ) {
    return { kind: "ask_employee", reason: "ambiguous", via: "keywords" };
  }

  return {
    kind: "suggestion",
    expertKey: best.candidate.expertKey,
    serviceKey: best.candidate.serviceKey,
    confidence: Number(best.confidence.toFixed(2)),
    via: "keywords",
  };
}

/**
 * Suggest one authorized expert for Auto mode, or ask the employee to choose.
 */
export async function routeExpert(
  input: RouteExpertInput,
): Promise<RouteExpertResult> {
  const threshold = input.threshold ?? DEFAULT_ROUTE_CONFIDENCE_THRESHOLD;
  const candidates = input.candidates;
  const question = normalizeQuestion(input.question);

  if (input.explicitExpertKey !== undefined) {
    const picked = findCandidate(candidates, input.explicitExpertKey);
    if (picked === undefined) {
      return {
        kind: "refused",
        reason: "not_authorized",
        expertKey: input.explicitExpertKey,
      };
    }
    return {
      kind: "suggestion",
      expertKey: picked.expertKey,
      serviceKey: picked.serviceKey,
      confidence: 1,
      via: "explicit",
    };
  }

  if (candidates.length === 0) {
    return { kind: "ask_employee", reason: "no_candidates", via: "none" };
  }

  if (question.length === 0) {
    return { kind: "ask_employee", reason: "below_threshold", via: "keywords" };
  }

  if (input.classify !== undefined) {
    let classified: RouteClassifyOutcome;
    try {
      classified = await input.classify(question, candidates);
    } catch {
      // A failing route provider is the same as an unavailable one: keyword rules decide and the
      // result records `via: "keywords"` (acceptance: fallback recorded, never a thrown request).
      classified = { status: "unavailable" };
    }
    if (classified.status === "ok") {
      const matched = findCandidate(candidates, classified.expertKey);
      const confidence = classified.confidence;
      if (
        matched !== undefined &&
        Number.isFinite(confidence) &&
        confidence <= 1 &&
        confidence >= threshold
      ) {
        return {
          kind: "suggestion",
          expertKey: matched.expertKey,
          serviceKey: matched.serviceKey,
          confidence,
          via: "route_model",
          providerKey: classified.providerKey,
        };
      }
      // Model named someone outside the list or below threshold — fall through to keywords
      // rather than inventing a guess (acceptance: never a silent guess).
    }
  }

  return keywordRoute(question, candidates, threshold);
}
