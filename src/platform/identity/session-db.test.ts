import { describe, expect, it } from "vitest";

import { createSessionStore, type SessionSql } from "./session-db";
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
