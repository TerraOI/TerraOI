import { describe, expect, it } from "vitest";

import { createSessionRevoker, createSessionStore, type SessionSql } from "./session-db";
import type { StoredSession } from "./session-store";

const KEY = "Qh7X3m1pL0aZ8sW2kD5vN9tY4bC6rE0uI1oP3qS7wX2";
const HOST = "company1.terraoi.app";
const NOW = 1_730_980_800;
const USER = "00000000-0000-4000-8000-0000000000a1";

function session(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    userId: USER,
    host: HOST,
    issuedAt: NOW,
    expiresAt: NOW + 8 * 60 * 60,
    revokedAt: null,
    keyVersion: "v1",
    accessCiphertext: "v1.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    refreshCiphertext: "v1.CCCCCCCCCCCCCCCC.DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
    tokenExpiresAt: NOW + 3600,
    ...overrides,
  };
}

type Call = { sql: string; values: unknown[] };

function recordingSql(handler: (call: Call) => Promise<Record<string, unknown>[]>): {
  sql: SessionSql;
  calls: Call[];
} {
  const calls: Call[] = [];
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.reduce((acc, part, index) => acc + part + (index < values.length ? `$${index + 1}` : ""), "");
    const call = { sql: text.replace(/\s+/g, " ").trim(), values };
    calls.push(call);
    return handler(call);
  }) as SessionSql;
  sql.end = async () => undefined;
  return { sql, calls };
}

describe("createSessionStore — #75 Hyperdrive carrier", () => {
  it("returns null when SESSION_DB is not bound (honest unavailable, not a throwing stub)", () => {
    expect(createSessionStore({})).toBeNull();
    expect(createSessionStore({ binding: null })).toBeNull();
  });

  it("insert calls insert_session_v1 with the sealed pair and never concatenates values into SQL text", async () => {
    const { sql, calls } = recordingSql(async () => []);
    const store = createSessionStore({ openSql: () => sql });
    expect(store).not.toBeNull();
    const row = session();
    await store!.insert({ sessionKey: KEY, session: row });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain("toi_identity.insert_session_v1");
    expect(calls[0]?.sql).not.toContain(KEY);
    expect(calls[0]?.values[0]).toBe(KEY);
    expect(calls[0]?.values[1]).toBe(USER);
    expect(calls[0]?.values[2]).toBe(HOST);
  });

  it("find maps authenticate_session_v1 rows and returns null when the function returns nothing", async () => {
    const row = session();
    const { sql } = recordingSql(async () => [
      {
        user_id: row.userId,
        session_created_at: new Date(row.issuedAt * 1000),
        session_expires_at: new Date(row.expiresAt * 1000),
        key_version: row.keyVersion,
        access_token_ciphertext: row.accessCiphertext,
        refresh_token_ciphertext: row.refreshCiphertext,
        token_expires_at: new Date(row.tokenExpiresAt * 1000),
      },
    ]);
    const store = createSessionStore({ openSql: () => sql })!;
    const found = await store.find({ sessionKey: KEY, host: HOST, now: NOW });
    expect(found).toEqual({ ...row, host: HOST, revokedAt: null });

    const empty = recordingSql(async () => []);
    const miss = createSessionStore({ openSql: () => empty.sql })!;
    expect(await miss.find({ sessionKey: KEY, host: HOST, now: NOW })).toBeNull();
  });

  it("revoke and replaceTokens call the matching RPCs with the Worker clock", async () => {
    const { sql, calls } = recordingSql(async (call) => {
      if (call.sql.includes("rotate_session_tokens_v1")) return [{ rotated: true }];
      return [];
    });
    const store = createSessionStore({ openSql: () => sql })!;
    await store.revoke(KEY, NOW + 10);
    const rotated = await store.replaceTokens(
      KEY,
      {
        keyVersion: "v1",
        accessCiphertext: "v1.a.b",
        refreshCiphertext: "v1.c.d",
        tokenExpiresAt: NOW + 7200,
      },
      NOW + 10,
    );
    expect(rotated).toBe(true);
    expect(calls[0]?.sql).toContain("toi_identity.revoke_session_v1");
    expect(calls[1]?.sql).toContain("toi_identity.rotate_session_tokens_v1");
  });

  it("refuses a malformed session key before dialling the database", async () => {
    let opened = 0;
    const store = createSessionStore({
      openSql: () => {
        opened += 1;
        throw new Error("should not open");
      },
    })!;
    await expect(store.find({ sessionKey: "short", host: HOST, now: NOW })).rejects.toThrow(/session key/);
    await expect(store.revoke("not-a-key", NOW)).rejects.toThrow(/session key/);
    expect(opened).toBe(0);
  });
});

// T-201 PR-2: the bulk revocation a completed password reset owes. Separate from the store on purpose —
// `createSessionStore` is the per-session lifecycle (`insert`/`find`/`revoke`/`replaceTokens`) that
// `signin-completion.ts` and `sign-out.ts` share, and this is the one call that takes a user's sessions
// down by subject and host. Same carrier, same honest `null` when `SESSION_DB` is unbound.
describe("createSessionRevoker — revoke_user_sessions_v1 (T-201 PR-2)", () => {
  it("returns null when SESSION_DB is not bound", () => {
    expect(createSessionRevoker({})).toBeNull();
    expect(createSessionRevoker({ binding: null })).toBeNull();
  });

  it("dials the function with three parameters, none of them concatenated into the text", async () => {
    const { sql, calls } = recordingSql(async () => [{ revoked: true }]);
    const revoke = createSessionRevoker({ openSql: () => sql })!;

    expect(await revoke({ userId: USER, host: HOST, now: NOW })).toBe(true);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain("toi_identity.revoke_user_sessions_v1");
    expect(calls[0]?.values).toEqual([USER, HOST, new Date(NOW * 1000)]);
    // The carrier writes no `update`, counts nothing and adds no second statement: which rows fall and
    // what "it ran" means are the function's business, and slot 012 assertions 57-58 and 66-67 hold it.
    expect(calls[0]?.sql).not.toMatch(/\bupdate\b|\bdelete\b|count\(/i);
  });

  it("answers with the function's own boolean, never with a row count it computed", async () => {
    // The whole reason the boolean is a contract and not a count: a user with no other live session has
    // nothing to revoke, and a reset that read "zero rows" as a failure would lock the first-ever reset
    // out. Equally, an answer this carrier did not receive is not a success it may invent.
    const ran = recordingSql(async () => [{ revoked: true }]);
    expect(await createSessionRevoker({ openSql: () => ran.sql })!({ userId: USER, host: HOST, now: NOW })).toBe(true);

    const refused = recordingSql(async () => [{ revoked: false }]);
    expect(await createSessionRevoker({ openSql: () => refused.sql })!({ userId: USER, host: HOST, now: NOW })).toBe(false);

    const noAnswer = recordingSql(async () => []);
    expect(await createSessionRevoker({ openSql: () => noAnswer.sql })!({ userId: USER, host: HOST, now: NOW })).toBe(false);
  });

  it("refuses a malformed subject, host or clock before opening a client", async () => {
    let opened = 0;
    const revoke = createSessionRevoker({
      openSql: () => {
        opened += 1;
        throw new Error("should not open");
      },
    })!;
    for (const input of [
      { userId: "not-a-uuid", host: HOST, now: NOW },
      { userId: `${USER}a`, host: HOST, now: NOW },
      // Outside the SQL's own host rule (session-store migration:67 allows two dots at most), and a host
      // like this could never match a stored row: the SQL would answer "revoked nothing, ran fine".
      { userId: USER, host: "company1.terraoi.app.evil.test", now: NOW },
      { userId: USER, host: "Company1.terraoi.app", now: NOW },
      { userId: USER, host: "", now: NOW },
      // Not a host anybody routed, whatever its shape: `toTimestamptz` refuses it here rather than after
      // a client is already open.
      { userId: USER, host: HOST, now: 1.5 },
      { userId: USER, host: HOST, now: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      await expect(revoke(input)).rejects.toThrow();
    }
    expect(opened).toBe(0);
  });

  it("closes the client when the function refuses, as it does when it succeeds", async () => {
    // A Hyperdrive pool left open after a refusal is how a rejected reset turns into an outage for the
    // next person. `withSql` closes in a `finally`; this is the half that proves it.
    let ended = 0;
    const failing = recordingSql(async () => {
      throw new Error("22023: host is not a canonical hostname");
    });
    const revoker = createSessionRevoker({ openSql: () => Object.assign(failing.sql, { end: async () => { ended += 1; } }) })!;
    // A well-formed call that the database itself refuses: the client still goes away, and the caller
    // (`handleCallback`'s recovery branch) sees a rejection rather than a silent `false`.
    await expect(revoker({ userId: USER, host: HOST, now: NOW })).rejects.toThrow(/22023/);
    expect(ended).toBe(1);
  });
});
