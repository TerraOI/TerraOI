import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Three rules that only hold if something checks them on every commit:
 *
 * 1. plan §5.1 line 261: the brand mode is "tenant configuration, never an arbitrary public
 *    `?brand=` or cross-customer selector", and AGENTS.md §4.1 keeps the tenant out of headers -
 *    so nothing in `src/platform/branding/` may read a query string, a cookie or a header.
 * 2. brand/README.md rule 1 and FAQ-0001: only `src/platform/branding/` reads the kit sources.
 * 3. The brand is public data (plan §4.4). This module must not reach into identity or session
 *    code, because a surface that renders a brand should never be able to read a session.
 *
 * The scans below are the enforcement. A repository with no `src/platform/branding/` files would
 * pass them vacuously, so the last test asserts the module and its tests actually exist.
 */

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SRC = join(ROOT, "src");
const BRANDING = join(SRC, "platform", "branding");

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      found.push(...sourceFiles(full));
      continue;
    }
    if (/\.(ts|tsx)$/.test(name)) found.push(relative(ROOT, full).split(sep).join("/"));
  }
  return found;
}

const brandingFiles = sourceFiles(BRANDING);
const brandingCode = brandingFiles.filter((p) => !p.includes(".test."));
const allSource = sourceFiles(SRC);

describe("the brand mode never comes from the request (plan §5.1)", () => {
  it.each([
    "searchParams",
    "URLSearchParams",
    "cookies(",
    "headers(",
    "?brand=",
    "brand=",
    "x-tenant",
    "x-org",
    "x-brand",
    "x-organisation",
  ])("does not mention %s anywhere in src/platform/branding", (marker) => {
    for (const file of brandingCode) {
      expect(readFileSync(join(ROOT, file), "utf8"), file).not.toContain(marker);
    }
  });
});

describe("only this module reads the kit (brand/README.md rule 1, FAQ-0001)", () => {
  it("has no import of brand/terraoi-brand-kit outside src/platform/branding", () => {
    for (const file of allSource) {
      if (file.startsWith("src/platform/branding/")) continue;
      const text = readFileSync(join(ROOT, file), "utf8");
      expect(text, file).not.toMatch(/brand\/terraoi-brand-kit/);
    }
  });

  it("reads the kit sources exactly once, through one file", () => {
    const readers = brandingCode.filter((file) => readFileSync(join(ROOT, file), "utf8").includes("brand-config.json"));
    expect(readers).toEqual(["src/platform/branding/kit-brand.ts"]);
  });
});

describe("a surface that renders a brand cannot read a session", () => {
  it("imports nothing from identity, app, components or gateway", () => {
    for (const file of brandingCode) {
      const text = readFileSync(join(ROOT, file), "utf8");
      expect(text, file).not.toMatch(/from "@\/platform\/identity/);
      expect(text, file).not.toMatch(/from "@\/app/);
      expect(text, file).not.toMatch(/from "@\/components/);
      expect(text, file).not.toMatch(/from "@\/platform\/gateway/);
      expect(text, file).not.toMatch(/from "\.\.\/\.\.\/(identity|app|components|gateway)/);
    }
  });

  it("never touches the filesystem or node builtins, because this runs on Workers", () => {
    for (const file of brandingCode) {
      expect(readFileSync(join(ROOT, file), "utf8"), file).not.toMatch(/from "node:/);
    }
  });
});

describe("the module exists", () => {
  it("has implementation files and a test file per rule group", () => {
    expect(brandingCode.length).toBeGreaterThanOrEqual(4);
    expect(brandingFiles.filter((p) => p.includes(".test."))).toHaveLength(7);
  });
});
