import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Two rules about where an email gets its **host** and its **knowledge of a person**, checked on
 * every commit — the same shape as `branding/branding-boundary.test.ts` and
 * `gateway/provider-boundary.test.ts`, because a rule with no test gets broken by the next caller.
 *
 * 1. **The host comes from the merged tenant resolver and nowhere else** (AGENTS.md §4.1, plan §4.1
 *    step 6, decision #64: "Links are built with the same host resolver, never from a global site
 *    URL"). The resolver lives in `src/platform/tenancy/`; `email.ts` calls it. So nothing in this
 *    module may read a host out of a header, a query string or a cookie, and there is no global
 *    domain constant that could serve as a fallback.
 * 2. **This module cannot know whether an address belongs to anyone** (plan §4.2, §4.3). It has no
 *    database, no session and no tenant context, which is what makes "was this address refused
 *    because it is not a member?" an unanswerable question here — and therefore not something a
 *    magic-link or invite flow can leak through a failure code.
 *
 * The scans run over the module's **code** files (not its tests: the loopback harness legitimately
 * reads the headers of the request it received, and this file has to name the markers it forbids).
 * A module with no code files would pass vacuously, so the last test asserts the files are there.
 */

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const MODULE = "src/platform/notifications";

function moduleFiles(): string[] {
  return readdirSync(join(ROOT, MODULE))
    .filter((name) => /\.ts$/.test(name))
    .map((name) => `${MODULE}/${name}`);
}

const codeFiles = moduleFiles().filter((path) => !path.includes(".test."));

/** Where a host must not come from: request data, or a global URL baked into the transport. */
const HOST_SOURCE_MARKERS = [
  "x-forwarded-host",
  "headers.get",
  "headers[",
  "searchParams",
  "URLSearchParams",
  "cookies(",
  "NEXT_PUBLIC",
  "SITE_URL",
  "APP_ORIGIN",
  "https://terraoi.app",
  "www.terraoi.app",
  "workers.dev",
];

/** A data path that could answer "does this person exist?" is not allowed in this module at all. */
const ACCOUNT_DATA_MARKERS = ["supabase", "createClient(", ".rpc(", "p_organisation_id", "TenantContext", "withTenantRpc", "SERVICE_ROLE"];

/** The one host-validation dependency, named exactly once, in the file that owns the port. */
const TENANCY_IMPORT = "@/platform/tenancy/host";

/** What this module may import: the schema library, its own files, and the two merged helpers. */
const ALLOWED_IMPORTS = new Set(["zod", "./email", TENANCY_IMPORT, "@/platform/identity/email"]);

function importSpecifiers(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+"([^"]+)"/g)) {
    found.push(match[1] as string);
  }
  for (const match of source.matchAll(/\b(?:require|import)\(\s*"([^"]+)"\s*\)/g)) {
    found.push(match[1] as string);
  }
  return found;
}

/** Strip comments so prose that *names* a forbidden thing is not itself a finding. */
function codeOnly(source: string): string {
  const kept: string[] = [];
  let inBlock = false;
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (inBlock) {
      if (trimmed.startsWith("*/")) inBlock = false;
      continue;
    }
    if (trimmed.startsWith("/*")) {
      if (!trimmed.includes("*/")) inBlock = true;
      continue;
    }
    if (trimmed.startsWith("//")) continue;
    kept.push(line);
  }
  return kept.join("\n");
}

/** One string per finding. Exported to the guard test below so the scan's own honesty is testable. */
function violations(path: string, source: string): string[] {
  const findings: string[] = [];
  // Prose is exempt, code is not: this module's comments deliberately *name* the things it refuses
  // (`workers.dev`, the gateway's adapters module), and a guard that fails on documentation teaches
  // people to delete documentation. The honest limit of that choice is stated where the rule is
  // enforced by behaviour instead: `email.test.ts` refuses every foreign-host form of a link, and
  // `parseHost` in `src/platform/tenancy/host.ts` is what rejects a deployment alias outright.
  const code = codeOnly(source);
  const withoutNodeEnv = code.replace(/process\.env\.NODE_ENV/g, "");
  // NODE_ENV is not a secret, and "only outside a deployed runtime" is the house pattern
  // (`tenancy/host.ts`, the gateway adapters). Any other environment read here would be a credential
  // or a global URL, and this packet's contract says the credential arrives as a binding at call time.
  if (/process\.env/.test(withoutNodeEnv)) findings.push(`${path} reads an environment value other than NODE_ENV`);
  if (/\bimport\s+["']/.test(withoutNodeEnv)) findings.push(`${path} has a side-effect import`);
  for (const marker of HOST_SOURCE_MARKERS) {
    if (code.includes(marker)) findings.push(`${path} mentions ${marker}`);
  }
  for (const marker of ACCOUNT_DATA_MARKERS) {
    if (code.includes(marker)) findings.push(`${path} mentions ${marker}`);
  }
  if (code.includes("platform/gateway")) findings.push(`${path} reaches for the model gateway (AGENTS.md §4.3)`);
  for (const specifier of importSpecifiers(code)) {
    if (!ALLOWED_IMPORTS.has(specifier)) findings.push(`${path} imports ${specifier}`);
  }
  return findings;
}

describe("an email's host comes from the tenant resolver, never the request or a global URL", () => {
  it("no file in the module reads a host from request data or carries a global fallback", () => {
    const offenders: string[] = [];
    for (const path of codeFiles) {
      offenders.push(...violations(path, readFileSync(join(ROOT, path), "utf8")));
    }
    expect(offenders).toEqual([]);
  });

  it("the port validates its host with the merged tenancy resolver and imports nothing else cross-module", () => {
    const port = readFileSync(join(ROOT, `${MODULE}/email.ts`), "utf8");
    expect(port).toContain(`from "${TENANCY_IMPORT}"`);
    expect(port).toContain("parseHost(");
    expect(importSpecifiers(port).filter((specifier) => !specifier.startsWith("./") && specifier !== "zod")).toEqual([
      "@/platform/identity/email",
      TENANCY_IMPORT,
    ]);
  });

  it("the transport cannot name a host: only the port composes the sender, from configuration", () => {
    const adapter = readFileSync(join(ROOT, `${MODULE}/postmark-adapter.ts`), "utf8");
    // The provider endpoint is a constant, not a value a caller may steer in a deployed runtime.
    expect(adapter).toContain("resolveEndpoint");
    expect(adapter).toContain("isNonDeployableRuntime");
    expect(adapter).not.toContain("From: options.");
  });
});

describe("the module has no way to ask whether an address belongs to a person", () => {
  it("no code file in the module mentions a database, a session store or a tenant context", () => {
    const offenders: string[] = [];
    for (const path of codeFiles) {
      const source = readFileSync(join(ROOT, path), "utf8");
      for (const marker of ACCOUNT_DATA_MARKERS) {
        if (source.includes(marker)) offenders.push(`${path} mentions ${marker}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("the scans are looking at real text (a guard that saw nothing is not a guard)", () => {
  it("the module actually has the three code files this packet owns", () => {
    expect(codeFiles).toEqual([
      `${MODULE}/email-fixtures.ts`,
      `${MODULE}/email.ts`,
      `${MODULE}/postmark-adapter.ts`,
    ]);
  });

  it("the classifier reports a file that breaks the rules and passes one that does not", () => {
    const clean = 'import { z } from "zod";\nimport { parseHost } from "@/platform/tenancy/host";\n';
    expect(violations("hypothetical.ts", clean)).toEqual([]);

    const broken = [
      'import { z } from "zod";',
      'import { createClient } from "@supabase/supabase-js";',
      "const host = request.headers.get(\"x-forwarded-host\");",
      'const link = `https://${process.env.SITE_URL}/auth/callback`;',
    ].join("\n");
    const reported = violations("hypothetical.ts", broken);
    expect(reported).toContain('hypothetical.ts mentions x-forwarded-host');
    expect(reported).toContain("hypothetical.ts mentions headers.get");
    expect(reported).toContain("hypothetical.ts mentions SITE_URL");
    expect(reported).toContain("hypothetical.ts mentions supabase");
    expect(reported).toContain("hypothetical.ts reads an environment value other than NODE_ENV");
    expect(reported).toContain("hypothetical.ts imports @supabase/supabase-js");

    // The comment exemption is a comment boundary, not a licence: the same marker inside prose is
    // ignored, the same marker on a code line is reported.
    const prose = '// a workers.dev alias is never a fallback\nconst fine = parseHost(host);\n';
    expect(violations("hypothetical.ts", prose)).toEqual([]);
    expect(violations("hypothetical.ts", 'const alias = "https://my-app.workers.dev";')).toContain(
      "hypothetical.ts mentions workers.dev",
    );
  });
});
