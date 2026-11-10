// Unit tests for scripts/worker-credential.mjs (T-211, #134). No database is touched: the point of
// these assertions is the token/digest discipline and the validation that stops a typo producing a
// credential that leases nothing.
import { describe, expect, it } from "vitest";

import {
  digestOf,
  insertSql,
  newToken,
  parseArgs,
  revokeSql,
} from "./worker-credential.mjs";

describe("worker credential issuance", () => {
  it("issues a token whose shape fits the lease_token/contract bounds and is not a hex-only alphabet", () => {
    const token = newToken();
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(newToken()).not.toBe(token);
  });

  it("stores a lowercase 64-hex sha-256 digest, deterministically", () => {
    const token = newToken();
    const first = digestOf(token);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    // Matches the CHECK on job_api.worker_credentials.token_hash and the digest the RPCs compare.
    expect(digestOf(token)).toBe(first);
    expect(digestOf(token)).not.toBe(token);
  });

  it("refuses to digest something that is not a token, rather than hashing a typo into a credential", () => {
    expect(() => digestOf("short")).toThrow(/43-character/);
    expect(() => digestOf(null)).toThrow(/43-character/);
  });

  it("parses an issue command into exactly the columns the table has", () => {
    const spec = parseArgs([
      "issue",
      "--label",
      "syn-box-company1",
      "--executor",
      "local_box",
      "--org",
      "11111111-1111-4111-8111-111111111111,22222222-2222-4222-8222-222222222222",
    ]);
    expect(spec).toEqual({
      action: "issue",
      label: "syn-box-company1",
      executor: "local_box",
      orgs: [
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
      ],
    });
  });

  it("rejects an executor outside the two the schema allows (#135: one credential, one executor)", () => {
    expect(() =>
      parseArgs(["issue", "--label", "syn-box-1", "--executor", "third_party_ocr", "--org", "x"]),
    ).toThrow(/one credential, one executor/);
  });

  it("rejects a label that would break the column CHECK, an empty org list, an over-long one, and a malformed uuid", () => {
    expect(() => parseArgs(["issue", "--label", "A", "--executor", "local_box", "--org", "x"])).toThrow(
      /must match/,
    );
    expect(() =>
      parseArgs(["issue", "--label", "syn-box-1", "--executor", "local_box"]),
    ).toThrow(/between 1 and 8/);
    const nine = Array.from({ length: 9 }, (_, i) => i + 1).join(",");
    expect(() =>
      parseArgs(["issue", "--label", "syn-box-1", "--executor", "local_box", "--org", nine]),
    ).toThrow(/between 1 and 8/);
    const eight = Array.from({ length: 8 }, (_, i) => i + 1).join(",");
    expect(() =>
      parseArgs(["issue", "--label", "syn-box-1", "--executor", "local_box", "--org", eight]),
    ).toThrow(/not a uuid/);
  });

  it("keeps revoke a one-argument operation, so a revocation cannot be steered by extra flags", () => {
    const spec = parseArgs(["revoke", "--label", "syn-box-company1"]);
    expect(spec.action).toBe("revoke");
    expect(spec.orgs).toEqual([]);
    expect(() =>
      parseArgs(["revoke", "--label", "syn-box-company1", "--executor", "local_box"]),
    ).toThrow(/only --label/);
  });

  it("prints SQL that never contains a token, only the hash placeholder", () => {
    const sql = insertSql({
      label: "syn-box-company1",
      executor: "local_box",
      orgs: ["11111111-1111-4111-8111-111111111111"],
    });
    expect(sql).toContain("job_api.worker_credentials");
    expect(sql).toContain("array['11111111-1111-4111-8111-111111111111'::uuid]::uuid[]");
    expect(sql).toContain("'<64-hex-sha256-of-the-token>'");
    expect(sql).not.toMatch(/[A-Za-z0-9_-]{43}/);
    expect(revokeSql({ label: "syn-box-company1" })).toContain("revoked_at = now()");
    expect(revokeSql({ label: "syn-box-company1" })).toContain("revoked_at is null");
  });
});
