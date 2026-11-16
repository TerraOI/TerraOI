import { describe, expect, it } from "vitest";

import { evaluateMode, parseArgs } from "./check-ops-alerts.mjs";

/**
 * The CLI is thin on purpose, so these tests are about the three things a thin CLI gets wrong:
 * which modes it accepts, which exit code means which fact, and whether its "proof" can
 * actually fail. A dry-run that always exits 0 is the #180 defect again - a step that cannot
 * fail is not evidence.
 */
describe("argument handling", () => {
  it("asks for usage when nothing is given", () => {
    expect(parseArgs([])).toEqual({ error: expect.stringContaining("usage") });
  });

  it("names an unrecognised flag instead of ignoring it", () => {
    const r = parseArgs(["--dry-run", "--enviro"]);
    expect(r.error).toContain("--enviro");
  });

  it("refuses a dry-run and a facts file together", () => {
    // A dry run invents its own conditions; a facts file is real input. Accepting both would
    // print a verdict whose provenance nobody could tell.
    const r = parseArgs(["--dry-run", "--facts", "x.json"]);
    expect(r.error).toContain("cannot be combined");
  });

  it("refuses an unknown rule id rather than evaluating nothing and calling it green", () => {
    const r = parseArgs(["--dry-run", "--rule", "no_such_rule"]);
    expect(r.error).toContain("no_such_rule");
  });

  it("accepts the three real modes", () => {
    expect(parseArgs(["--dry-run"])).toEqual({ mode: "dry-run", ruleIds: null });
    expect(parseArgs(["--rules"])).toEqual({ mode: "rules", ruleIds: null });
    expect(parseArgs(["--facts", "f.json"])).toEqual({ mode: "evaluate", ruleIds: null, factsFile: "f.json" });
  });
});

describe("dry-run mode: every rule must be shown capable of firing", () => {
  it("prints one line per rule and exits 0 when all eight fire", () => {
    const out = evaluateMode({ mode: "dry-run" });
    expect(out.lines).toHaveLength(8);
    expect(out.code).toBe(0);
    for (const line of out.lines) {
      expect(line).toContain("fired");
    }
  });

  it("carries the synthetic condition on the line, so the verdict can be read", () => {
    const out = evaluateMode({ mode: "dry-run" });
    const line = out.lines.find((l) => l.startsWith("box_offline_too_long"));
    expect(line).toContain("ADR-0005");
  });

  it("exits 1 when a rule cannot be made to fire", () => {
    // The negative that keeps the dry-run honest: a rule whose synthetic condition is too weak
    // must be reported as a failure of the rule, not as a passing check.
    const out = evaluateMode({
      mode: "dry-run",
      rules: [
        {
          id: "never_fires",
          className: "authorization",
          metricIds: ["authz_anomaly_count"],
          thresholdKind: "definitional",
          definition: "anomaly count above one million",
          predicate: ({ values }) => values.authz_anomaly_count > 1_000_000,
          dryRun: { condition: "two anomalies", values: { authz_anomaly_count: 2 }, thresholds: {} },
        },
      ],
    });
    expect(out.code).toBe(1);
    expect(out.lines[0]).toContain("could not be made to fire");
  });

  it("exits 1 when a dry run reports anything other than fired", () => {
    const out = evaluateMode({
      mode: "dry-run",
      rules: [
        {
          id: "needs_a_threshold",
          className: "budget",
          metricIds: ["budget_reservation_failure"],
          thresholdKind: "owner_set",
          thresholdKey: "budget_refusal_count_max",
          definition: "refusals above the ceiling",
          predicate: ({ values, thresholds }) => values.budget_reservation_failure > thresholds.budget_refusal_count_max,
          dryRun: { condition: "no threshold supplied", values: { budget_reservation_failure: 9 }, thresholds: {} },
        },
      ],
    });
    expect(out.code).toBe(1);
    expect(out.lines[0]).toContain("threshold_unset");
  });
});

describe("evaluate mode: real input, three different absences kept apart", () => {
  it("reports not_available with the owning packet, and never a zero", () => {
    const out = evaluateMode({
      mode: "evaluate",
      facts: { tables: ["public.ingestion_jobs"], values: { authz_anomaly_count: 4 } },
      thresholds: { authz_anomaly_count_max: 3 },
    });
    const line = out.lines.find((l) => l.startsWith("authorization_anomalies"));
    // The metric value supplied here is for a table that is not merged, so the honest answer is
    // not_available even though a number was handed in - a value with no source is not a fact.
    expect(line).toContain("not_available");
    expect(line).toContain("T-313");
    expect(out.code).toBe(0);
  });

  it("fires a real alert when the table is present and the threshold is set", () => {
    const out = evaluateMode({
      mode: "evaluate",
      facts: {
        tables: ["public.ingestion_jobs", "public.outbox_events", "public.knowledge_collections"],
        values: { outbox_oldest_lag: 90000, collection_freshness_age: 10 },
      },
      thresholds: { reminder_overdue_max_seconds: 1800, critical_collection_max_age_seconds: 1_000_000 },
    });
    expect(out.lines.find((l) => l.startsWith("stopped_operational_reminders"))).toContain("fired");
    expect(out.lines.find((l) => l.startsWith("stale_critical_collections"))).toContain("ok");
    expect(out.code).toBe(0);
  });

  it("exits 1 if any evaluation errored", () => {
    const out = evaluateMode({
      mode: "evaluate",
      rules: [
        {
          id: "broken",
          className: "authorization",
          metricIds: ["nope_not_a_metric"],
          thresholdKind: "definitional",
          definition: "reads a metric that does not exist",
          predicate: () => false,
          dryRun: { condition: "n/a", values: {}, thresholds: {} },
        },
      ],
    });
    expect(out.code).toBe(1);
    expect(out.lines[0]).toContain("unknown metric");
  });
});

describe("the rules listing", () => {
  it("prints every rule, its class, and what the owner still has to set", () => {
    const out = evaluateMode({ mode: "rules" });
    expect(out.code).toBe(0);
    expect(out.lines).toHaveLength(8);
    const unset = out.lines.filter((l) => l.includes("threshold to set:"));
    expect(unset).toHaveLength(7);
    expect(out.lines.join("\n")).toContain("definitional");
  });
});
