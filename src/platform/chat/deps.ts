import type { TenantContext } from "@/contracts/tenant-context";
import type { DataClass } from "@/contracts/data-class";
import type { ServiceKey } from "@/contracts/keys";
import type { GatewayConfiguration } from "@/platform/gateway/config";
import type { GatewayDeps, MeterPort } from "@/platform/gateway/call";
import type { HealthWriter } from "@/platform/gateway/circuit";
import type { HealthReader } from "@/platform/gateway/route";
import type { EvidencePackEntry } from "@/platform/agents/compose";

/**
 * The seams `run-chat.ts` dials, and the fail-closed defaults for each.
 *
 * T-104 is the walking skeleton at the end of the loop, so it needs three things other packets own:
 * a persistence store (this packet's SQL, `store.ts`), an expert registry (T-113's `expert_versions`
 * and T-102c's `expert_grants`), and a corpus search (T-114's `search_corpus_v1`). Two of those three
 * do not exist yet on `main`, so this module states the port and ships a **closed** default for each:
 * an un-wired seam refuses, and refuses without dialling anything. That is the plan's rule for a
 * degraded search lane made visible rather than hidden (§8.1: reduced search quality is stated, not
 * hidden), and the alternative — inventing a search or an expert table in the wrong lane — is the
 * thing FAQ-0004 and AGENTS.md §6 forbid. Each default is named `NOT_WIRED` so a reader of the
 * production wiring can see what is missing without grepping.
 */

/** The plan §8.2 diagnostics vocabulary for a search that returned nothing, kept closed. */
export type RetrievalDiagnostics =
  | "ok"
  | "no_accessible_evidence"
  | "coverage_unknown"
  | "historical_gap"
  | "index_unavailable"
  | "backend_failure"
  /** This deployment has no corpus search yet (T-114 unmerged): nothing was dialled. */
  | "not_wired";

export interface RetrievalOutcome {
  /** The evidence an answer may be built from, already limited to what this caller may read. */
  packs: readonly EvidencePackEntry[];
  /** Embedding-index generations the packs came from (§9.4 staleness, F15). */
  corpusGenerations: number[];
  /** The degraded lane is labelled, never silently taken (§8.1). */
  mode: "hybrid" | "lexical_only";
  diagnostics: RetrievalDiagnostics;
}

export interface CorpusSearch {
  search(input: {
    context: TenantContext;
    question: string;
    serviceKey: ServiceKey;
    projectId: string | null;
  }): Promise<RetrievalOutcome>;
}

/** An expert this employee may use, with the service that licenses it and any project narrowing. */
export interface ExpertGrant {
  expertKey: string;
  serviceKey: ServiceKey;
  /** Empty means "any project this caller may see"; a list narrows to those project ids. */
  projectIds: readonly string[];
}

/**
 * The permission-to-use-an-expert read (plan §10.1:284: the grant table belongs to T-102c's
 * `expert_grants`). An empty list is the fail-closed answer: no expert, no run (§9.4 F08).
 */
export interface ExpertCatalog {
  grants(context: TenantContext): Promise<readonly ExpertGrant[]>;
}

/**
 * Everything the gateway needs, as reviewed deployment configuration — `model_providers` has no
 * migration yet (gateway/config.ts:6-19), so this bundle is injected, never assembled from a request.
 * `null` means unbound, and an unbound gateway is an `unavailable` answer, not a direct provider call
 * (AGENTS.md §4.3: all model calls go through the gateway or nowhere).
 */
export interface GatewayBundle {
  config: GatewayConfiguration;
  /**
   * The registry the gateway reads (`GatewayDeps["adapters"]` — `get` and `has`), not the routing
   * packet's narrower `AdapterRegistry` (`has` only): the bundle is handed straight to
   * `composeAnswer`, and a `Map<ProviderKey, ProviderAdapter>` satisfies both.
   */
  adapters: GatewayDeps["adapters"];
  health: HealthReader & HealthWriter;
  meter: MeterPort;
}

/** The closed set of refusal reasons the chat surface may render. No free-text reason travels. */
export type ChatRefusalKey =
  | "no_evidence"
  | "out_of_scope"
  | "expert_not_permitted"
  | "withheld"
  | "unavailable";

/** A refusal the caller renders; `key` is closed so the UI never shows a reason string we did not write. */
export interface RefusalNotice {
  key: ChatRefusalKey;
  /** Employee-visible text, from the expert's own refusal template where one exists. */
  message: string;
}

export const NOT_WIRED_SEARCH: CorpusSearch = {
  async search() {
    return { packs: [], corpusGenerations: [], mode: "lexical_only", diagnostics: "not_wired" };
  },
};

export const NOT_WIRED_CATALOG: ExpertCatalog = {
  async grants() {
    return [];
  },
};

/** The data class an employee's own question carries when nothing else raises it (§6.2 floor). */
export const QUESTION_DATA_CLASS: DataClass = "internal";
