import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * ADR-0011 containment, machine-checked: **one place mints a URL, and only the `workers/`
 * deployment ever holds the storage-capable key.**
 *
 * #146 ruled that the object key comes from SQL (`job_api.object_ref_for_lease_v1`, under the same
 * lease compare as every mutating call) and that the extraction deployment signs it for 60 seconds.
 * #135 ruled that the cloud worker and the tenant box are different executors with different
 * clearance, and the box must never receive a service-role key. A rule like that survives refactors
 * only if a test fails when someone "helpfully" signs a URL in an app route or pastes the key into
 * `localbox/`, which is exactly what the supervisor asked to be kept out of the app Worker.
 *
 * This file is deliberately a **static** scan, not a runtime mock: the violation we are guarding
 * against is a line someone adds in the wrong folder, and a runtime test cannot see that file.
 * Idiom borrowed from `src/platform/gateway/provider-boundary.test.ts` (same reason, same shape).
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** The single module allowed to reach Storage. Everything else must import it or nothing. */
const SIGNER = "workers/object-signing.ts";

/** Deployment roots that may hold a storage-capable credential, and the ones that may never. */
const WORKER_ROOT = "workers";
const FORBIDDEN_ROOTS = ["localbox", "src/app", "src/platform", "src/contracts"];

/** Plain `fetch` is the house pattern (the gateway adapters do the same); no Storage SDK is added. */
const STORAGE_PACKAGES = [
  "@supabase/storage-js",
  "@supabase/supabase-js",
  "@aws-sdk/client-s3",
  "@google-cloud/storage",
  "minio",
  "cloudflare:workers", // the Workers binding is a JOB_DB concern, not a storage one
];

const SIGNING_MARKERS = ["createSignedUrl", "create_signed_upload_url", "/object/sign/"];
const SECRET_MARKERS = ["SERVICE_ROLE", "service_role_key", "SUPABASE_SERVICE_ROLE"];

function sourceFiles(dir: string, acc: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return acc; // a folder this PR has not added yet
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".next" || entry === ".open-next") continue;
    const absolute = join(dir, entry);
    if (statSync(absolute).isDirectory()) {
      sourceFiles(absolute, acc);
    } else if (/\.(ts|tsx|js|mjs)$/.test(entry) && !entry.endsWith(".d.ts")) {
      // Implementation files only: this very file names the markers it is hunting for, and a test
      // fixture that pastes a key is a review finding, not something a scan can be trusted to catch.
      if (/\.(test|spec)\.(ts|tsx|js|mjs)$/.test(entry)) continue;
      acc.push(absolute);
    }
  }
  return acc;
}

function read(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

function filesUnder(root: string): string[] {
  return sourceFiles(join(ROOT, root)).map((absolute) => relative(ROOT, absolute).replaceAll("\\", "/"));
}

function filesMentioning(files: string[], needles: string[]): string[] {
  return files.filter((file) => {
    const text = read(file);
    return needles.some((needle) => text.includes(needle));
  });
}

describe("ADR-0011: the object-bytes boundary", () => {
  it("ships the one signing module and the two worker entry points this packet owns", () => {
    for (const path of [SIGNER, "workers/ocr-pull.ts", "localbox/ocr-pull.ts"]) {
      expect(existsSync(join(ROOT, path)), `${path} must exist: ADR-0011 names exactly one signer and `)
        .toBeTruthy();
    }
  });

  it("mints signed URLs in exactly one file in the whole repository", () => {
    const all = filesUnder("src").concat(filesUnder(WORKER_ROOT), filesUnder("localbox"));
    const hits = filesMentioning(all, SIGNING_MARKERS);
    expect(hits, `createSignedUrl belongs in ${SIGNER} and nowhere else, found in: ${hits.join(", ")}`)
      .toEqual([SIGNER]);
  });

  it("keeps the storage-capable key out of every path a browser or a tenant box can reach", () => {
    const forbidden = FORBIDDEN_ROOTS.flatMap(filesUnder);
    const hits = filesMentioning(forbidden, SECRET_MARKERS);
    expect(hits, `a service-role key may appear only in the workers/ deployment, found in: ${hits.join(", ")}`)
      .toEqual([]);
  });

  it("holds the key in the workers deployment only, as a wrangler secret name rather than a value", () => {
    const workerFiles = filesUnder(WORKER_ROOT);
    const hits = filesMentioning(workerFiles, SECRET_MARKERS);
    expect(hits, `the signer is the only worker module that may name the secret: ${hits.join(", ")}`)
      .toEqual([SIGNER]);
    const text = read(SIGNER);
    // An env lookup is a secret *name*; a 40-char JWT-ish literal would be the secret itself.
    expect(text).toMatch(/env\.[A-Z_]*(SERVICE_ROLE|STORAGE)[A-Z_]*/);
    expect(text).not.toMatch(/["']eyJ[A-Za-z0-9_-]{20,}/);
  });

  it("adds no storage SDK anywhere: the one call is plain fetch against the Storage endpoint", () => {
    const manifest = JSON.parse(read("package.json")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const installed = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
    for (const pkg of STORAGE_PACKAGES) {
      expect(installed, `${pkg} must not be a dependency: ADR-0011 keeps the call to one fetch`).not.toContain(pkg);
    }
  });

  it("signs for a short lived window and never writes a URL down", () => {
    const text = read(SIGNER);
    expect(text, "the TTL is a named constant so a reviewer can see the 60-second ruling")
      .toMatch(/(SIGNED_URL_TTL_SECONDS|signedUrlTtlSeconds)\s*=\s*\d+/);
    const ttl = Number(/(SIGNED_URL_TTL_SECONDS|signedUrlTtlSeconds)\s*=\s*(\d+)/.exec(text)?.[2] ?? "0");
    expect(ttl, "a signed URL must be short lived: 0 < ttl <= 300 seconds").toBeGreaterThan(0);
    expect(ttl, "a signed URL must be short lived: 0 < ttl <= 300 seconds").toBeLessThanOrEqual(300);
    expect(text, "the signer writes nothing to the database; SQL never mints a URL (#146)")
      .not.toMatch(/insert into/i);
  });

  it("reaches Storage from the loop through that module and not directly", () => {
    const loops = filesUnder(WORKER_ROOT).filter((file) => file !== SIGNER);
    for (const file of loops) {
      const text = read(file);
      expect(text, `${file} must import the signer rather than calling Storage itself`)
        .not.toMatch(/createSignedUrl/);
    }
    expect(read("workers/ocr-pull.ts")).toMatch(/from\s+["']\.\/object-signing/);
  });
});
