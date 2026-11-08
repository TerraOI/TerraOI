import { describe, expect, it } from "vitest";

import {
  SESSION_KEY_SHAPE,
  createTokenCipher,
  sessionStoreKey,
  type TokenCipher,
} from "./session-store";

/**
 * #37 option (b): the browser holds an opaque session id, and the server-side row is keyed by a
 * **hash** of it and holds the user's Supabase tokens **encrypted at rest** with a Worker secret
 * (`SESSION_TOKEN_KEY`, named in the code, value never in the repo — AGENTS.md §4.6).
 *
 * These tests inject a synthetic keyring; nothing here touches a database (the store itself is
 * pgTAP's job in supabase/tests/database/014_identity_session.test.sql, and CI's `database` job
 * is the authority for the SQL).
 */

// Synthetic, not a real key. Same convention as the rest of src/platform/identity/.
const KEY_V1 = "synthetic-keyring-v1-not-a-real-key-0000000000000";
const KEY_V2 = "synthetic-keyring-v2-not-a-real-key-0000000000000";
const KEYRING = { currentVersion: "v1", keys: { v1: KEY_V1, v2: KEY_V2 } };

/** A Supabase-shaped access token: three dot-separated base64url segments, header `{"alg":…}`. */
function fakeJwt(segment: string): string {
  const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64url");
  return `${b64('{"alg":"ES256","typ":"JWT"}')}.${b64(`{"sub":"${segment}"}`)}.ZmFrZS1zaWduYXR1cmU`;
}

function keyring(overrides: Partial<typeof KEYRING> = {}): TokenCipher {
  return createTokenCipher({
    currentVersion: overrides.currentVersion ?? KEYRING.currentVersion,
    keys: overrides.keys ?? KEYRING.keys,
  });
}

describe("sessionStoreKey — the row is keyed by a hash of the id (#37)", () => {
  const id = "Qh7X3m1pL0aZ8sW2kD5vN9tY4bC6rE0uI1oP3qS7wX2"; // 32 bytes, base64url

  it("is deterministic, so the same cookie finds the same row", async () => {
    const first = await sessionStoreKey(id);
    const second = await sessionStoreKey(id);
    expect(first).toBe(second);
  });

  it("is not the id itself, so the row key is never a copy of the credential", async () => {
    const key = await sessionStoreKey(id);
    expect(key).not.toBe(id);
    expect(key).not.toContain(id.slice(0, 8));
  });

  it("is a fixed-shape base64url digest, matching the column check in the migration", async () => {
    const key = await sessionStoreKey(id);
    expect(key).toHaveLength(43);
    expect(key).toMatch(SESSION_KEY_SHAPE);
  });

  it("changes completely when one character of the id changes", async () => {
    const a = await sessionStoreKey(id);
    const b = await sessionStoreKey(`${id.slice(0, -1)}A`);
    expect(a).not.toBe(b);
    const shared = [...a].filter((character, index) => character === b[index]).length;
    expect(shared).toBeLessThan(10);
  });

  it("refuses an id that is not a 32-byte base64url token, so a garbage cookie never becomes a query parameter", async () => {
    for (const garbage of ["", "short", `${id}extra`, `${id}.signature`, "a b", "id=1", "ünïcode"]) {
      await expect(sessionStoreKey(garbage)).rejects.toThrow();
    }
  });
});

describe("createTokenCipher — tokens are encrypted at rest under a named Worker secret", () => {
  it("round-trips a Supabase-shaped token through the real algorithm", async () => {
    const cipher = keyring();
    const token = fakeJwt("owner1");
    const sealed = await cipher.seal(token);
    expect(await cipher.open(sealed)).toBe(token);
  });

  it("never stores the plaintext, and seals differ per call (a fresh IV every time)", async () => {
    const cipher = keyring();
    const token = fakeJwt("owner1");
    const a = await cipher.seal(token);
    const b = await cipher.seal(token);
    expect(a).not.toBe(b);
    for (const sealed of [a, b]) {
      expect(sealed).not.toContain(token);
      expect(sealed).not.toContain(token.split(".")[1] as string);
    }
  });

  it("records the key version it used, so a keyring rotation can be resolved per row", async () => {
    const cipher = keyring();
    const sealed = await cipher.seal("payload");
    expect(sealed.startsWith("v1.")).toBe(true);
  });

  it("refuses to seal an empty token rather than storing something that means nothing", async () => {
    const cipher = keyring();
    await expect(cipher.seal("")).rejects.toThrow();
  });

  it("returns null instead of throwing on tampered ciphertext", async () => {
    const cipher = keyring();
    const sealed = await cipher.seal(fakeJwt("owner1"));
    const tampered = `${sealed.slice(0, -2)}${sealed.endsWith("AA") ? "BB" : "AA"}`;
    expect(await cipher.open(tampered)).toBeNull();
    expect(await cipher.open("not-a-sealed-value")).toBeNull();
    expect(await cipher.open("v1.QWJj")).toBeNull();
  });

  it("returns null for a version the keyring no longer holds, rather than decrypting with the wrong key", async () => {
    const sealer = keyring({ currentVersion: "v2" });
    const sealed = await sealer.seal(fakeJwt("owner1"));
    expect(sealed.startsWith("v2.")).toBe(true);
    const withoutV2 = createTokenCipher({ currentVersion: "v1", keys: { v1: KEY_V1 } });
    expect(await withoutV2.open(sealed)).toBeNull();
  });

  it("opens an older version while that key is still in the keyring, which is the grace window", async () => {
    const old = createTokenCipher({ currentVersion: "v1", keys: { v1: KEY_V1 } });
    const sealed = await old.seal(fakeJwt("owner1"));
    const rotated = keyring({ currentVersion: "v2" });
    expect(rotated.keyVersion).toBe("v2");
    expect(await rotated.open(sealed)).toBe(await old.open(sealed));
  });

  it("does not open a value sealed under a different key even when the version names match", async () => {
    const other = createTokenCipher({ currentVersion: "v1", keys: { v1: `${KEY_V1}-different` } });
    const sealed = await other.seal(fakeJwt("owner1"));
    expect(await keyring().open(sealed)).toBeNull();
  });

  it("fails closed on a missing or short secret: no default key, no development fallback", () => {
    expect(() => createTokenCipher({ currentVersion: "v1", keys: {} })).toThrow();
    expect(() => createTokenCipher({ currentVersion: "v1", keys: { v1: "" } })).toThrow();
    expect(() => createTokenCipher({ currentVersion: "v1", keys: { v1: "short" } })).toThrow();
    expect(() => createTokenCipher({ currentVersion: "v3", keys: { v1: KEY_V1 } })).toThrow();
  });

  it("names the secret it reads so a reviewer can see which binding this is (AGENTS.md §4.6)", () => {
    // The adapter comment in src/platform/identity/adapters.ts must say SESSION_TOKEN_KEY; the
    // cipher itself never logs or returns key material.
    const cipher = keyring();
    expect(JSON.stringify(cipher)).not.toContain(KEY_V1);
    expect(Object.values(cipher)).not.toContain(KEY_V1);
  });
});
