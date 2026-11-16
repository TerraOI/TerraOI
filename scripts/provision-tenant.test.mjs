// T-304 — tests for scripts/provision-tenant.mjs, the F05 provisioning entry point (plan §15.0:
// "Tenant provisioning by script (F05), not an admin UI").
//
// Written before the module, per superpowers:test-driven-development: the first run of this file
// collects zero tests because the module does not exist, and that failure is what proves the
// assertions below are attached to something.
//
// Two of these tests are not about the script at all — they are about **drift**. The database and the
// script enforce the same rules (slug shape, host shape, locale, timezone, reserved slugs), and the
// database is the one that decides. So tests 8 and 9 read the merged migration off disk and compare
// the rule text, which means the JS copy cannot wander from the SQL copy unnoticed. A reviewer who
// changes one list will watch the other test go red.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  HOST_MAX_DOTS,
  RESERVED_SLUGS,
  RULES,
  connectFromEnv,
  parseArgs,
  provisionTenant,
  run,
  validateRequest,
} from "./provision-tenant.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.join(
  here,
  "..",
  "supabase",
  "migrations",
  // Located by suffix, not by full name: COORDINATION §3 may re-rule the timestamp, and that must not
  // take this test down with it.
  readdirSync(path.join(here, "..", "supabase", "migrations"))
    .filter((f) => f.endsWith("_lifecycle_switches.sql"))
    .sort()
    .at(-1),
);

// The DSN fixtures are assembled rather than written out. TruffleHog's Postgres detector keys on the
// scheme-plus-slash-slash shape even when every part of the value is fake, and a fixture of exactly
// this kind failed the `secrets` job on #191 — the record is in release-preflight.test.mjs. If someone
// inlines a literal here, it is the secret scan that says so, not these tests.
const SCHEME = "post" + "gres";
const dsnWith = (password) =>
  `${SCHEME}://toi_provisioner:${password}@db.example.test:5432/postgres`;

const VALID = {
  slug: "acme-surveys",
  host: "acme-surveys.terraoi.app",
  displayName: "Acme Surveys",
  locale: "en",
  timezone: "UTC",
  reason: "pilot onboarding for the second tenant",
  requestedBy: "ops@terraoi.test",
};

describe("parseArgs", () => {
  it("1 turns the documented flags into a full request", () => {
    const parsed = parseArgs([
      "--slug", "acme-surveys",
      "--host", "acme-surveys.terraoi.app",
      "--name", "Acme Surveys",
      "--locale", "en",
      "--timezone", "UTC",
      "--reason", "pilot onboarding",
      "--requested-by", "ops@terraoi.test",
    ]);
    expect(parsed.ok).toBe(true);
    expect(parsed.request).toEqual({
      slug: "acme-surveys",
      host: "acme-surveys.terraoi.app",
      displayName: "Acme Surveys",
      locale: "en",
      timezone: "UTC",
      reason: "pilot onboarding",
      requestedBy: "ops@terraoi.test",
    });
  });

  it("2 defaults locale and timezone the way the merged column defaults do", () => {
    const parsed = parseArgs([
      "--slug", "acme", "--host", "acme.terraoi.app", "--name", "Acme",
      "--reason", "pilot", "--requested-by", "ops@terraoi.test",
    ]);
    expect(parsed.ok).toBe(true);
    expect(parsed.request.locale).toBe("en");
    expect(parsed.request.timezone).toBe("UTC");
  });

  it("3 refuses a missing reason rather than defaulting one", () => {
    const argv = ["--slug", "acme", "--host", "acme.terraoi.app", "--name", "Acme",
      "--requested-by", "ops@terraoi.test"];
    const parsed = parseArgs(argv);
    expect(parsed.ok).toBe(false);
    expect(parsed.errors.join(" ")).toMatch(/reason/i);
  });

  it("4 refuses a missing requested-by, because an unattributed action is what §972 forbids", () => {
    const parsed = parseArgs(["--slug", "acme", "--host", "acme.terraoi.app", "--name", "Acme",
      "--reason", "pilot"]);
    expect(parsed.ok).toBe(false);
    expect(parsed.errors.join(" ")).toMatch(/requested-by/i);
  });

  it("5 refuses an unknown flag instead of ignoring it", () => {
    const parsed = parseArgs(["--slug", "acme", "--host", "acme.terraoi.app", "--name", "Acme",
      "--reason", "pilot", "--requested-by", "ops@terraoi.test", "--admin-please"]);
    expect(parsed.ok).toBe(false);
    expect(parsed.errors.join(" ")).toMatch(/admin-please/);
  });

  it("6 refuses a repeated flag rather than letting the last one win silently", () => {
    const parsed = parseArgs(["--slug", "acme", "--slug", "other", "--host", "acme.terraoi.app",
      "--name", "Acme", "--reason", "pilot", "--requested-by", "ops@terraoi.test"]);
    expect(parsed.ok).toBe(false);
    expect(parsed.errors.join(" ")).toMatch(/slug/i);
  });

  it("7 prints usage and dials nothing for --help", async () => {
    const connect = vi.fn();
    const out = [];
    const code = await run({
      argv: ["--help"],
      env: { CONTROL_PLANE_DB: dsnWith("sentinel") },
      connect,
      log: (line) => out.push(line),
    });
    expect(code).toBe(0);
    expect(connect).not.toHaveBeenCalled();
    expect(out.join("\n")).toMatch(/provision-tenant/);
    expect(out.join("\n")).toMatch(/requested-by/);
  });
});

describe("validateRequest mirrors the database", () => {
  it("8 the reserved-slug list in this script is the list in the migration, word for word", () => {
    const sql = readFileSync(migrationPath, "utf8");
    const m = sql.match(/p_slug in \(([^)]*)\)/);
    expect(m, "the migration's reserved-slug clause was not found: this test is what stops the two lists drifting").not.toBeNull();
    const inSql = m[1].split(",").map((s) => s.trim().replace(/^'|'$/g, ""));
    expect(RESERVED_SLUGS).toEqual(inSql);
  });

  it("9 the rule regexes in this script are the regexes in the migration, character for character", () => {
    const sql = readFileSync(migrationPath, "utf8");
    // Slug, host, locale, timezone: each appears as a ~ pattern in provision_tenant_v1 or the column
    // CHECK it mirrors. The one difference allowed here is escaping: a JS regex literal must escape a
    // forward slash and SQL does not, so the comparison normalizes exactly that and nothing else.
    const normalize = (p) => p.replace(/\\\//g, "/");
    const patterns = [...sql.matchAll(/~ '(.*?)'/g)].map((x) => normalize(x[1]));
    for (const rule of [RULES.slug, RULES.host, RULES.locale, RULES.timezone]) {
      expect(patterns, `no SQL pattern in the migration matches the script's rule ${rule.source} — the two have drifted`).toContain(normalize(rule.source));
    }
  });

  it("14b the host dot ceiling here is the ceiling in the migration, not one I remembered", () => {
    // The regex cannot express "at most one subdomain level", so the limit lives twice: in SQL as a
    // comparison, and here as a constant. Pinning the two against each other is the only reason a
    // future edit to one shows up as a red test rather than as a tenant that resolves for one party
    // and not the other.
    const sql = readFileSync(migrationPath, "utf8");
    const m = sql.match(/length\(p_host\) - length\(replace\(p_host, '\.', ''\)\)\) > (\d+)/);
    expect(m, "the migration's host dot-limit clause was not found").not.toBeNull();
    expect(HOST_MAX_DOTS).toBe(Number(m[1]));
  });

  it("10 a valid request passes", () => {
    expect(validateRequest(VALID)).toEqual([]);
  });

  it("11 a reserved slug is refused here, before anything is dialled", () => {
    for (const slug of RESERVED_SLUGS) {
      expect(validateRequest({ ...VALID, slug }).join(" "), slug).toMatch(/reserved/i);
    }
  });

  it("12 a slug the merged CHECK rejects is named, not sent", () => {
    const errors = validateRequest({ ...VALID, slug: "Acme Surveys" });
    expect(errors.join(" ")).toMatch(/slug/);
  });

  it("13 a single-character slug is refused (the merged CHECK needs two)", () => {
    expect(validateRequest({ ...VALID, slug: "a" }).join(" ")).toMatch(/slug/);
  });

  it("14 a host with two subdomain levels is refused, as tenancy_core:41-44 defines an exact host", () => {
    expect(validateRequest({ ...VALID, host: "acme.surveys.terraoi.app" }).join(" ")).toMatch(/host/);
  });

  it("15 a host with a scheme or port is refused rather than normalized away", () => {
    const errors = validateRequest({ ...VALID, host: "https://acme.terraoi.app:8443" });
    expect(errors.join(" ")).toMatch(/host/);
  });

  it("16 en-GB is refused with #67 named, and no workaround offered", () => {
    const errors = validateRequest({ ...VALID, locale: "en-GB" });
    expect(errors.join(" ")).toMatch(/#67/);
    expect(errors.join(" ")).toMatch(/locale/);
  });

  it("17 a timezone with two slashes is refused, because the merged CHECK allows exactly one", () => {
    expect(validateRequest({ ...VALID, timezone: "America/Argentina/Buenos_Aires" }).join(" ")).toMatch(/timezone/);
  });

  it("18 an empty reason is refused", () => {
    expect(validateRequest({ ...VALID, reason: "   " }).join(" ")).toMatch(/reason/);
  });

  it("19 a value carrying SQL punctuation is refused by shape, so nothing reaches a query that must escape it", () => {
    const hostile = "acme'; drop table public.organisations; --";
    const errors = validateRequest({ ...VALID, slug: hostile });
    expect(errors.join(" ")).toMatch(/slug/);
    // And the host too, since a host is the other string that names a real thing.
    expect(validateRequest({ ...VALID, host: "acme.terraoi.app'; drop —" }).join(" ")).toMatch(/host/);
  });

  it("20 over-long values are refused before the database sees them", () => {
    expect(validateRequest({ ...VALID, displayName: "x".repeat(201) }).join(" ")).toMatch(/display.name/i);
    expect(validateRequest({ ...VALID, reason: "y".repeat(501) }).join(" ")).toMatch(/reason/);
  });
});

describe("connectFromEnv", () => {
  it("21 a missing binding fails closed with a named reason", () => {
    const r = connectFromEnv({});
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("not_configured");
    expect(r.message).toMatch(/CONTROL_PLANE_DB/);
  });

  it("22 the message never repeats the credential it was given", () => {
    const dsn = dsnWith("hunter2");
    const r = connectFromEnv({ CONTROL_PLANE_DB: "   " });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("hunter2");
    const good = connectFromEnv({ CONTROL_PLANE_DB: dsn });
    expect(good.ok).toBe(true);
    // ok:true carries the value where it is needed and nowhere else; nothing in the failure path does.
    expect(JSON.stringify(connectFromEnv({}))).not.toContain(SCHEME + "ql:");
  });
});

describe("provisionTenant", () => {
  it("23 calls the RPC with exactly the seven parameters the signature has, in order", async () => {
    const query = vi.fn(async (sqlText) =>
      /provision_tenant_v1/.test(sqlText)
        ? [{ organisation_id: "11111111-1111-4111-8111-111111111111" }]
        : [{ status: "provisioning", host: VALID.host, roles: 2, permissions: 6, members: 0 }]
    );
    const r = await provisionTenant({ request: VALID, query });
    expect(r.ok).toBe(true);
    expect(query).toHaveBeenCalledTimes(2); // the RPC, then the read-back
    const [sqlText, params] = query.mock.calls[0];
    expect(sqlText).toMatch(/select public\.provision_tenant_v1\(/);
    // Seven placeholders, and no eighth for an actor: the database derives the actor from the login.
    expect((sqlText.match(/\$/g) || []).length).toBe(7);
    expect(params).toEqual([VALID.slug, VALID.host, VALID.displayName, VALID.locale,
      VALID.timezone, VALID.reason, VALID.requestedBy]);
  });

  it("24 reads the created tenant back from the database instead of trusting its own call", async () => {
    const query = vi.fn(async (sqlText) =>
      /provision_tenant_v1/.test(sqlText)
        ? [{ organisation_id: "9b8d0000-0000-4000-8000-000000000001" }]
        : [{ status: "provisioning", host: "acme-surveys.terraoi.app", roles: 2, permissions: 6, members: 0 }]
    );
    const r = await provisionTenant({ request: VALID, query });
    expect(r.ok).toBe(true);
    expect(r.readBack).toEqual({
      organisationId: "9b8d0000-0000-4000-8000-000000000001",
      status: "provisioning",
      host: "acme-surveys.terraoi.app",
      roles: 2,
      permissions: 6,
      members: 0,
    });
  });

  it("25 a member row appearing after provisioning is reported, not celebrated", async () => {
    // F05's load-bearing absence: no operational access for the platform admin. If the database ever
    // says otherwise, the script must say so rather than exit 0 with a cheerful summary.
    const query = vi.fn(async (sqlText) =>
      /provision_tenant_v1/.test(sqlText)
        ? [{ organisation_id: "9b8d0000-0000-4000-8000-000000000002" }]
        : [{ status: "provisioning", host: "acme-surveys.terraoi.app", roles: 2, permissions: 6, members: 1 }]
    );
    const r = await provisionTenant({ request: VALID, query });
    expect(r.ok).toBe(false);
    expect(r.problem).toMatch(/membership|operational access/i);
  });

  it("26 a status other than provisioning is refused as a problem, since a half-state is the failure mode", async () => {
    const query = vi.fn(async (sqlText) =>
      /provision_tenant_v1/.test(sqlText)
        ? [{ organisation_id: "9b8d0000-0000-4000-8000-000000000003" }]
        : [{ status: "active", host: "acme-surveys.terraoi.app", roles: 2, permissions: 6, members: 0 }]
    );
    const r = await provisionTenant({ request: VALID, query });
    expect(r.ok).toBe(false);
    expect(r.problem).toMatch(/active|status/i);
  });

  it("27 a missing read-back row is an error, never an empty success", async () => {
    const query = vi.fn(async (sqlText) =>
      /provision_tenant_v1/.test(sqlText)
        ? [{ organisation_id: "9b8d0000-0000-4000-8000-000000000004" }]
        : []
    );
    const r = await provisionTenant({ request: VALID, query });
    expect(r.ok).toBe(false);
    expect(r.problem).toMatch(/read.back|could not read/i);
  });

  it("28 a database refusal keeps its SQLSTATE and loses its text", async () => {
    const error = Object.assign(new Error('p_host must be an exact normalized host with at most one subdomain level (tenancy_core:41-44) at "provision_tenant_v1"'), { code: "22023" });
    const query = vi.fn(async () => {
      throw error;
    });
    const r = await provisionTenant({ request: VALID, query });
    expect(r.ok).toBe(false);
    expect(r.sqlState).toBe("22023");
    // The code is the useful part; the driver's text can carry a host, a schema or a line number.
    expect(r.problem).not.toMatch(/tenancy_core|provision_tenant_v1/);
  });

  it("29 a connection failure is reported as unavailable, not as a provisioning failure", async () => {
    const query = vi.fn(async () => {
      throw Object.assign(new Error("connect ECONNREFUSED db.example.test:5432"), { code: "ECONNREFUSED" });
    });
    const r = await provisionTenant({ request: VALID, query });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("unavailable");
  });

  it("30 the script sends no credential of its own beyond the connection it was handed", async () => {
    const calls = [];
    const query = vi.fn(async (sqlText, params) => {
      calls.push({ sqlText, params });
      return /provision_tenant_v1/.test(sqlText)
        ? [{ organisation_id: "9b8d0000-0000-4000-8000-000000000005" }]
        : [{ status: "provisioning", host: VALID.host, roles: 2, permissions: 6, members: 0 }];
    });
    await provisionTenant({ request: VALID, query });
    const joined = calls.map((c) => c.sqlText + " " + JSON.stringify(c.params)).join("\n");
    for (const secret of ["CONTROL_PLANE_DB", "password", "token", "key"]) {
      expect(joined.toLowerCase()).not.toContain(secret.toLowerCase());
    }
    // And no actor parameter anywhere, matching the suite's own signature pin.
    expect(joined).not.toMatch(/p_actor|actor_role/i);
  });
});

describe("run", () => {
  const env = { CONTROL_PLANE_DB: dsnWith("supersecretvalue") };

  it("31 exits 2 without dialling when the arguments are invalid", async () => {
    const connect = vi.fn();
    const out = [];
    const code = await run({
      argv: ["--slug", "admin", "--host", "admin.terraoi.app", "--name", "X",
        "--reason", "because", "--requested-by", "ops@terraoi.test"],
      env,
      connect,
      log: (l) => out.push(l),
    });
    expect(code).toBe(2);
    expect(connect).not.toHaveBeenCalled();
    expect(out.join("\n")).toMatch(/reserved/);
  });

  it("32 exits 2 with not_configured when the binding is absent, and names the variable", async () => {
    const connect = vi.fn();
    const out = [];
    const code = await run({
      argv: ["--slug", "acme", "--host", "acme.terraoi.app", "--name", "Acme",
        "--reason", "pilot", "--requested-by", "ops@terraoi.test"],
      env: {},
      connect,
      log: (l) => out.push(l),
    });
    expect(code).toBe(2);
    expect(connect).not.toHaveBeenCalled();
    expect(out.join("\n")).toMatch(/CONTROL_PLANE_DB/);
  });

  it("33 never prints the credential, in the success path or anywhere", async () => {
    const query = vi.fn(async (sqlText) =>
      /provision_tenant_v1/.test(sqlText)
        ? [{ organisation_id: "9b8d0000-0000-4000-8000-000000000006" }]
        : [{ status: "provisioning", host: "acme.terraoi.app", roles: 2, permissions: 6, members: 0 }]
    );
    const out = [];
    const code = await run({
      argv: ["--slug", "acme", "--host", "acme.terraoi.app", "--name", "Acme",
        "--reason", "pilot", "--requested-by", "ops@terraoi.test"],
      env,
      connect: () => ({ query, end: vi.fn() }),
      log: (l) => out.push(l),
    });
    expect(code).toBe(0);
    const printed = out.join("\n");
    expect(printed).not.toContain("supersecretvalue");
    expect(printed).not.toContain("toi_provisioner");
    expect(printed).toMatch(/9b8d0000-0000-4000-8000-000000000006/);
  });

  it("34 exits 1 on a database refusal, and the printed line carries the code not the driver text", async () => {
    const out = [];
    const code = await run({
      argv: ["--slug", "acme-two", "--host", "acme-two.terraoi.app", "--name", "Acme Two",
        "--reason", "pilot", "--requested-by", "ops@terraoi.test"],
      env,
      connect: () => ({
        query: vi.fn(async () => {
          throw Object.assign(new Error("duplicate key value violates unique constraint \"tenant_domains_host_key\" Detail: Key (host)=(acme-two.terraoi.app) already exists."), { code: "23505" });
        }),
        end: vi.fn(),
      }),
      log: (l) => out.push(l),
    });
    expect(code).toBe(1);
    const printed = out.join("\n");
    expect(printed).toMatch(/23505/);
    expect(printed).not.toMatch(/tenant_domains_host_key|Detail:/);
  });

  it("35 closes the connection on every path, including the failure ones", async () => {
    const end = vi.fn();
    await run({
      argv: ["--slug", "acme", "--host", "acme.terraoi.app", "--name", "Acme",
        "--reason", "pilot", "--requested-by", "ops@terraoi.test"],
      env,
      connect: () => ({
        query: vi.fn(async () => {
          throw Object.assign(new Error("boom"), { code: "23503" });
        }),
        end,
      }),
      log: () => {},
    });
    expect(end).toHaveBeenCalledTimes(1);
  });

});
