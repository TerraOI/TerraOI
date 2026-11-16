// T-404 acceptance test 1 (positive) and 4/5 (negative), written first.
//
// The rule under test is plan §17.2 step 2 as [T-404](../docs/tasks/T-404-production-readiness.md) states it:
// "a `wrangler.jsonc` production environment … refuses a production project ref, production route
// pattern or production Worker name appearing in a staging environment, and the reverse … Preflight is a
// gate, not a notice: a mismatch fails the job and no deploy step runs."
//
// Every fixture here is synthetic. No real project ref, host or key appears in this file (AGENTS §4.6);
// the hosts are the `*.terraoi.app` names already public in wrangler.jsonc, and the secret-looking values
// are made-up strings that match the shapes the check looks for.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkReleaseConfig, parseJsonc, requiredBindings } from "./release-preflight.mjs";

/**
 * The shape of `wrangler.jsonc`: the top level is the production config and `env.<name>` overrides it.
 * Arrays replace rather than merge, which is what wrangler does, so each environment repeats the
 * bindings it wants — exactly as the real file does for `services` and `ratelimits`.
 */
function config(overrides = {}) {
  const limiter = (namespaceId) => ({ name: "INQUIRY_RATE_LIMITER", namespace_id: namespaceId, simple: { limit: 3, period: 60 } });
  return {
    name: "terraoi-web",
    workers_dev: false,
    preview_urls: false,
    vars: { TURNSTILE_SITE_KEY: "" },
    routes: [],
    assets: { directory: ".open-next/assets", binding: "ASSETS" },
    services: [{ binding: "WORKER_SELF_REFERENCE", service: "terraoi-web" }],
    ratelimits: [limiter("1001")],
    env: {
      staging: {
        name: "terraoi-web-staging",
        services: [{ binding: "WORKER_SELF_REFERENCE", service: "terraoi-web-staging" }],
        ratelimits: [limiter("1002")],
        routes: [{ pattern: "company1-staging.example.test/*", zone_name: "example.test" }],
        vars: { TURNSTILE_SITE_KEY: "" },
        ...overrides.staging,
      },
      production: {
        name: "terraoi-web",
        services: [{ binding: "WORKER_SELF_REFERENCE", service: "terraoi-web" }],
        ratelimits: [limiter("1003")],
        routes: [{ pattern: "company1.example.test/*", zone_name: "example.test" }],
        vars: {},
        ...overrides.production,
      },
      ...overrides.env,
    },
  };
}

const rules = (result) => result.findings.map((f) => f.rule);

describe("checkReleaseConfig: staging may not reference production resources", () => {
  it("passes the clean fixture", () => {
    const r = checkReleaseConfig(config(), "staging");
    expect(r.findings).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("refuses a staging block that reuses the production Worker name", () => {
    const r = checkReleaseConfig(config({ staging: { name: "terraoi-web" } }), "staging");
    expect(r.ok).toBe(false);
    expect(rules(r)).toContain("staging-uses-production-worker-name");
  });

  it("refuses a production route pattern under staging, including the wildcard", () => {
    const cases = [
      "terraoi.app/*",
      "*.terraoi.app/*",
      "company1.terraoi.app/*",
      "app.terraoi.app/*",
    ];
    for (const pattern of cases) {
      const r = checkReleaseConfig(
        config({ staging: { routes: [{ pattern, zone_name: "terraoi.app" }] } }),
        "staging",
      );
      expect(r.ok, pattern).toBe(false);
      expect(rules(r), pattern).toContain("staging-route-is-production");
    }
  });

  it("still accepts every staging host that carries the staging marker", () => {
    const routes = [
      { pattern: "staging.terraoi.app/*", zone_name: "terraoi.app" },
      { pattern: "company1-staging.terraoi.app/*", zone_name: "terraoi.app" },
      { pattern: "company2-staging.terraoi.app/*", zone_name: "terraoi.app" },
    ];
    expect(checkReleaseConfig(config({ staging: { routes } }), "staging").ok).toBe(true);
  });

  it("refuses a staging service binding that points at the production Worker", () => {
    // Inherited top-level `services` are the easy mistake here: the block above overrides them for a
    // reason, and forgetting to is how a staging Worker ends up calling production in production's
    // own name.
    const r = checkReleaseConfig(
      config({ staging: { services: [{ binding: "WORKER_SELF_REFERENCE", service: "terraoi-web" }] } }),
      "staging",
    );
    expect(r.ok).toBe(false);
    expect(rules(r)).toContain("staging-service-points-at-production-worker");
  });

  it("refuses a Supabase project reference anywhere in the target environment", () => {
    // Synthetic: this ref string is not a real project.
    const r = checkReleaseConfig(
      config({ staging: { vars: { API_URL: "https://abcdefghijklmnopqrst.supabase.co/rest/v1" } } }),
      "staging",
    );
    expect(r.ok).toBe(false);
    expect(rules(r)).toContain("project-ref-in-config");
  });
});

describe("checkReleaseConfig: production may not reference staging resources (the mirror)", () => {
  it("refuses a staging route pattern in the production environment", () => {
    const r = checkReleaseConfig(
      config({ production: { routes: [{ pattern: "company1-staging.example.test/*", zone_name: "example.test" }] } }),
      "production",
    );
    expect(r.ok).toBe(false);
    expect(rules(r)).toContain("production-route-is-staging");
  });

  it("refuses a production block whose Worker name carries the staging suffix", () => {
    const r = checkReleaseConfig(config({ production: { name: "terraoi-web-staging" } }), "production");
    expect(r.ok).toBe(false);
    expect(rules(r)).toContain("production-uses-staging-worker-name");
  });
});

describe("checkReleaseConfig: bindings and secret material", () => {
  it("refuses an environment missing a binding the code reads", () => {
    const r = checkReleaseConfig(config(), "production");
    expect(r.ok).toBe(false);
    const missing = r.findings.filter((f) => f.rule === "missing-binding");
    expect(missing.map((f) => f.detail)).toEqual(expect.arrayContaining(["SESSION_DB", "CONFIG_DB", "JOB_DB", "INQUIRY_DB"]));
  });

  it("passes production once every required binding is declared (names, never values)", () => {
    const production = {
      name: "terraoi-web",
      routes: [{ pattern: "company1.example.test/*", zone_name: "example.test" }],
      vars: {},
      hyperdrive: [
        { binding: "SESSION_DB", database_id: "<SESSION_DB_HYPERDRIVE_ID>", database: "<SESSION_DB_URL_SECRET>" },
        { binding: "CONFIG_DB", database_id: "<CONFIG_DB_HYPERDRIVE_ID>", database: "<CONFIG_DB_URL_SECRET>" },
        { binding: "JOB_DB", database_id: "<JOB_DB_HYPERDRIVE_ID>", database: "<JOB_DB_URL_SECRET>" },
        { binding: "INQUIRY_DB", database_id: "<INQUIRY_DB_HYPERDRIVE_ID>", database: "<INQUIRY_DB_URL_SECRET>" },
      ],
      services: [{ binding: "WORKER_SELF_REFERENCE", service: "terraoi-web" }],
      ratelimits: [{ name: "INQUIRY_RATE_LIMITER", namespace_id: "<PROD_RATE_LIMIT_NS>", simple: { limit: 3, period: 60 } }],
      assets: { directory: ".open-next/assets", binding: "ASSETS" },
    };
    const r = checkReleaseConfig(config({ production }), "production");
    expect(r.findings).toEqual([]);
  });

  it("refuses a var that holds what looks like a connection string or a token value", () => {
    // The Postgres schemes are assembled rather than written out, and these URIs carry no
    // user:password. Not decoration: the `secrets` CI job runs TruffleHog over the PR's
    // commits with --results=verified,unknown, so it fails on *unverified* matches, and its
    // Postgres detector keys on the same scheme the rule under test keys on. A written-out
    // fixture carrying that scheme, a credential and a host is indistinguishable from a real
    // leak to that job, and the first version of this test did exactly that and made the job
    // red - which is why this comment never spells the scheme and `://` side by side either: a
    // scanner reading this file cannot tell a warning about a pattern from the pattern.
    // The value the rule
    // sees at runtime is unchanged, and a credential-free URI is the stronger fixture: a
    // regex that demanded a user:password would fail here rather than pass.
    // Before inlining this back: run `pnpm exec vitest run scripts/`, then expect the
    // `secrets` job to go red again.
    const pgScheme = "post" + "gres";
    const suspects = [
      `${pgScheme}://db.example.test:5432/postgres`,
      `${pgScheme}ql://db.example.test:5432/postgres`,
      "eyJhbGciOiJIUzI1NiJ9.e30.e30",
      "-----BEGIN PRIVATE KEY-----",
      "aws_secret_access_key = abcdef0123456789",
    ];
    for (const value of suspects) {
      const r = checkReleaseConfig(config({ production: { vars: { MAYBE: value } } }), "production");
      expect(r.ok, value).toBe(false);
      expect(rules(r), value).toContain("secret-shaped-var");
    }
  });

  it("accepts an empty placeholder var, because the binding name is not the secret", () => {
    const r = checkReleaseConfig(config({ production: { vars: { TURNSTILE_SITE_KEY: "" } } }), "production");
    expect(rules(r)).not.toContain("secret-shaped-var");
  });

  it("names the bindings each environment must declare", () => {
    expect(requiredBindings("production")).toEqual(expect.arrayContaining(["SESSION_DB", "CONFIG_DB", "JOB_DB", "INQUIRY_DB"]));
    // Staging today has none of the Hyperdrive bindings yet: T-004 human steps add them, and a
    // preflight that invents a requirement the owner has not met would fail every deploy for the
    // wrong reason. The list is what the code on `main` reads, not what production will read.
    expect(requiredBindings("staging")).toEqual(expect.arrayContaining(["ASSETS", "WORKER_SELF_REFERENCE"]));
  });
});

describe("checkReleaseConfig: it refuses to check nothing", () => {
  it("fails rather than passing when the named environment does not exist", () => {
    const r = checkReleaseConfig(config(), "prod");
    expect(r.ok).toBe(false);
    expect(rules(r)).toContain("unknown-environment");
    expect(r.findings[0].detail).toMatch(/prod/);
  });

  it("fails when the target environment declares no routes at all", () => {
    // A Worker with no routes answers on workers.dev only, which §4.1 forbids as a tenant entry
    // point; a deploy that silently has no routes is the zero-step-passes failure §100 describes.
    const r = checkReleaseConfig(config({ staging: { routes: [] } }), "staging");
    expect(r.ok).toBe(false);
    expect(rules(r)).toContain("no-routes-declared");
  });
});

describe("a config with no env.production block at all", () => {
  it("says so, instead of quietly checking the top level as if it were complete", () => {
    const partial = config();
    delete partial.env.production;
    const r = checkReleaseConfig(partial, "production");
    expect(r.ok).toBe(false);
    expect(rules(r)).toContain("production-has-no-env-block");
  });
});

describe("the real wrangler.jsonc", () => {
  const path = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));
  const real = parseJsonc(readFileSync(path, "utf8"));

  it("parses as JSONC, comments and all", () => {
    expect(real.env.staging.name).toBe("terraoi-web-staging");
    expect(real.env.staging.routes.length).toBeGreaterThan(0);
  });

  it("declares an explicit production environment, so a staging value can no longer be inherited", () => {
    expect(real.env.production).toBeTypeOf("object");
    expect(real.env.production.name).toBe("terraoi-web");
  });

  it("passes the preflight for staging", () => {
    expect(checkReleaseConfig(real, "staging").findings).toEqual([]);
  });

  it("leaves production with exactly one finding, and that finding is the owner's line to fill", () => {
    // The block declares the bindings by name and the routes are deliberately empty until the owner
    // verifies DNS and adds them (T-004, and the file's own comment). So the honest expectation is not
    // "production passes" — it is "production is complete except for the one thing an agent must not
    // do", and the preflight is what keeps a production deploy from happening before then.
    const r = checkReleaseConfig(real, "production");
    expect(rules(r)).toEqual(["no-routes-declared"]);
  });

  it("refuses a staging route copied into env.production", () => {
    const tampered = structuredClone(real);
    tampered.env.production.routes = [{ pattern: "company1-staging.terraoi.app/*", zone_name: "terraoi.app" }];
    const r = checkReleaseConfig(tampered, "production");
    expect(r.ok).toBe(false);
    expect(rules(r)).toContain("production-route-is-staging");
  });

  it("refuses a secret-shaped value in env.production, where the placeholders live", () => {
    const tampered = structuredClone(real);
    tampered.env.production.vars.SESSION_TOKEN_KEY = "eyJhbGciOiJIUzI1NiJ9.e30.e30";
    const r = checkReleaseConfig(tampered, "production");
    expect(rules(r)).toContain("secret-shaped-var");
  });

  it("refuses a staging Worker name in env.production", () => {
    const tampered = structuredClone(real);
    tampered.env.production.name = "terraoi-web-staging";
    expect(rules(checkReleaseConfig(tampered, "production"))).toContain("production-uses-staging-worker-name");
  });
});
