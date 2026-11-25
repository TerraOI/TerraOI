import { describe, expect, it } from "vitest";

import { createSessionRevoker, type SessionSql } from "./session-db";

const USER = "00000000-0000-4000-8000-0000000000a1";
const HOST = "company1.terraoi.app";
const NOW = 1_730_980_800;

function sqlAnswering(rows: Record<string, unknown>[]) {
  const calls: { sql: string; values: unknown[] }[] = [];
  let ended = 0;
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ sql: strings.join("$").replace(/\s+/g, " ").trim(), values });
    return rows;
  }) as SessionSql;
  sql.end = async () => {
    ended += 1;
  };
  return { sql, calls, ended: () => ended };
}

describe("createSessionRevoker (T-201 PR-2, #182/#183)", () => {
  it("is absent without a carrier, so a reset cannot complete without revoking", () => {
    expect(createSessionRevoker({ binding: null })).toBeNull();
  });

  it("calls revoke_user_sessions_v1 with three bound parameters and passes the SQL's true through", async () => {
    const s = sqlAnswering([{ revoked: true }]);
    const revoke = createSessionRevoker({ openSql: () => s.sql })!;
    await expect(revoke({ userId: USER, host: HOST, now: NOW })).resolves.toBe(true);
    expect(s.calls[0]?.sql).toContain("toi_identity.revoke_user_sessions_v1");
    expect(s.calls[0]?.values.slice(0, 2)).toEqual([USER, HOST]);
    expect(s.ended()).toBe(1);
  });

  it("no row back is a failure, never 'nothing to revoke'", async () => {
    const s = sqlAnswering([]);
    const revoke = createSessionRevoker({ openSql: () => s.sql })!;
    await expect(revoke({ userId: USER, host: HOST, now: NOW })).resolves.toBe(false);
  });

  it("refuses a malformed user or host before opening a connection", async () => {
    let opened = 0;
    const s = sqlAnswering([{ revoked: true }]);
    const revoke = createSessionRevoker({ openSql: () => { opened += 1; return s.sql; } })!;
    await expect(revoke({ userId: "not-a-uuid", host: HOST, now: NOW })).rejects.toThrow(/uuid/);
    await expect(revoke({ userId: USER, host: "Company1.terraoi.app", now: NOW })).rejects.toThrow(/host/);
    expect(opened).toBe(0);
  });
});
