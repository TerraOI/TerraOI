import { describe, expect, it } from "vitest";

import { canonicalEmail, emailsMatch, normalizeEmail } from "./email";

// Plan §4.2 "an invite binds to a normalized email"; the database enforces the same canonical
// form in the `profiles.email` CHECK (migrations/20261105060000_tenancy_core.sql:59), so there is
// exactly one normalization in the product and every comparison goes through this module.
describe("canonicalEmail (invite binding, plan §4.2)", () => {
  it("returns the canonical form of a padded, mixed-case address", () => {
    expect(canonicalEmail("  User@Example.test  ")).toBe("user@example.test");
    expect(canonicalEmail("OWNER1@Company1.TEST")).toBe("owner1@company1.test");
  });

  it("never returns a value that is not itself canonical", () => {
    for (const raw of [" User@Example.test ", "A.B@C.DE", "x@y.co.uk"]) {
      const value = canonicalEmail(raw);
      expect(value).not.toBeNull();
      expect(value).toBe(normalizeEmail(value as string));
    }
  });

  it("rejects addresses the database CHECK would reject instead of guessing one", () => {
    for (const raw of [
      "",
      "   ",
      "not-an-email",
      "a@b",
      "a b@example.test",
      "a<b@example.test",
      'a"b@example.test',
      "a,b@example.test",
      "a;b@example.test",
      "a@exa mple.test",
      "@example.test",
      "a@",
      "a@@example.test",
      `a${"x".repeat(250)}@example.test`,
    ]) {
      expect(canonicalEmail(raw)).toBeNull();
    }
  });

  it("trims trailing whitespace instead of rejecting it, matching lower(btrim(email))", () => {
    expect(canonicalEmail("a@example.test ")).toBe("a@example.test");
    expect(canonicalEmail("\tuser@example.test\n")).toBe("user@example.test");
  });

  it("rejects a non-string without coercing it", () => {
    for (const raw of [null, undefined, 42, {}, [], true]) {
      expect(canonicalEmail(raw as unknown)).toBeNull();
    }
  });

  it("rejects an address whose domain is not ASCII-lowercase", () => {
    expect(canonicalEmail("a@Example.TEST")).toBe("a@example.test");
    expect(canonicalEmail("a@exämple.test")).toBeNull();
    expect(canonicalEmail("a@ex_ample.test")).toBeNull();
  });
});

describe("emailsMatch", () => {
  it("matches a case and whitespace variant of the invited address", () => {
    expect(emailsMatch("User@Example.test", "user@example.test")).toBe(true);
    expect(emailsMatch(" user@example.test ", "User@Example.Test")).toBe(true);
  });

  it("does not match different addresses", () => {
    expect(emailsMatch("user@example.test", "user@example2.test")).toBe(false);
    expect(emailsMatch("a.user@example.test", "auser@example.test")).toBe(false);
  });

  it("two invalid addresses never match, so a garbage claim grants nothing", () => {
    expect(emailsMatch("garbage", "garbage")).toBe(false);
    expect(emailsMatch("", "")).toBe(false);
    expect(emailsMatch("garbage", "user@example.test")).toBe(false);
  });
});
