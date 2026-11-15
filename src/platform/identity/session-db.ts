import postgres from "postgres";

import type { SessionStore, SessionTokenReplacement, StoredSession } from "./session-store";
import { SESSION_KEY_SHAPE } from "./session-store";

/**
 * Hyperdrive-backed `SessionStore` (#75 option 1, ADR-0003 amendment).
 *
 * Connects as a login user that is `IN ROLE toi_session_worker`. Calls only the
 * `toi_identity.*_session_v1` functions — never `SELECT` on `toi_identity.sessions`. A leaked
 * `SESSION_DB` credential can authenticate, insert, revoke and rotate sessions, but cannot read
 * tenant data and cannot recover token plaintext (ciphertext stays sealed under `SESSION_TOKEN_KEY`).
 * ADR-0003 §3a fixed that function set at five; T-201 PR-2's `revoke_user_sessions_v1` is the sixth,
 * and widening that grant set is the supervisor's call, named in the PR body.
 *
 * One short-lived client per operation, `prepare: false`, matching the ADR-0002 intake pattern in
 * `src/platform/site/adapters.ts`.
 */

export type SessionDbBinding = { connectionString: string };

/**
 * The two shapes the columns hold this role to. Mirrored from the SQL, not invented here:
 * `20261107024000_session_store.sql:59` (`user_id uuid`) and `:64-68` (the `host` CHECK, including the
 * "at most one subdomain level" rule). Checking them here costs a round trip on a caller bug and turns
 * it into a named local error; the SQL refuses them again, and `revoke_user_sessions_v1` refuses a bad
 * host precisely because a no-match revocation would otherwise report success.
 */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOST_SHAPE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9]))+$/;

/** Narrow surface used by tests: a tagged-template caller that returns rows. */
export type SessionSql = {
  <T extends Record<string, unknown> = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]>;
  end(options?: { timeout?: number }): Promise<void>;
};

export type SessionDbDeps = {
  /** Injected in tests; production builds one from `SESSION_DB`. */
  openSql?: () => SessionSql;
  binding?: SessionDbBinding | null;
};

function assertSessionKey(sessionKey: string): void {
  if (typeof sessionKey !== "string" || !SESSION_KEY_SHAPE.test(sessionKey)) {
    throw new Error("session key must be 43 characters of base64url");
  }
}

function toTimestamptz(epochSeconds: number): Date {
  if (!Number.isSafeInteger(epochSeconds)) {
    throw new Error("session timestamps must be safe integers");
  }
  return new Date(epochSeconds * 1000);
}

function fromTimestamptz(value: unknown): number | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return Math.floor(value.getTime() / 1000);
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);
  }
  return null;
}

function openFromBinding(binding: SessionDbBinding): SessionSql {
  return postgres(binding.connectionString, { prepare: false, max: 1 }) as unknown as SessionSql;
}

function openerFor(deps: SessionDbDeps): (() => SessionSql) | null {
  return deps.openSql ?? (deps.binding ? () => openFromBinding(deps.binding as SessionDbBinding) : null);
}

/** One short-lived client per operation, closed whichever way the operation went. */
async function withSql<T>(openSql: () => SessionSql, run: (sql: SessionSql) => Promise<T>): Promise<T> {
  const sql = openSql();
  try {
    return await run(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function assertUserId(userId: string): void {
  if (typeof userId !== "string" || !UUID_SHAPE.test(userId)) {
    throw new Error("user id must be a uuid");
  }
}

function assertHost(host: string): void {
  // The dot count is part of the SQL rule, not decoration: `20261107024000_session_store.sql:67` allows
  // at most two, and a host with more could never match a stored row.
  const dots = (host.match(/\./g) ?? []).length;
  if (typeof host !== "string" || !HOST_SHAPE.test(host) || dots > 2) {
    throw new Error("host must be a normalized bare hostname");
  }
}

/**
 * Builds the store. Returns `null` when the binding is missing — the honest "unavailable" state —
 * rather than a throwing stub. Callers already treat `sessionStore() === null` as "cannot sign in".
 */
export function createSessionStore(deps: SessionDbDeps): SessionStore | null {
  const openSql = openerFor(deps);
  if (openSql === null) return null;

  return {
    async insert(input: { sessionKey: string; session: StoredSession }): Promise<void> {
      assertSessionKey(input.sessionKey);
      const { session } = input;
      await withSql(openSql, async (sql) => {
        await sql`
          select toi_identity.insert_session_v1(
            ${input.sessionKey},
            ${session.userId}::uuid,
            ${session.host},
            ${toTimestamptz(session.issuedAt)},
            ${toTimestamptz(session.expiresAt)},
            ${session.keyVersion},
            ${session.accessCiphertext},
            ${session.refreshCiphertext},
            ${toTimestamptz(session.tokenExpiresAt)}
          )
        `;
      });
    },

    async find(input: { sessionKey: string; host: string; now: number }): Promise<StoredSession | null> {
      assertSessionKey(input.sessionKey);
      const rows = await withSql(openSql, async (sql) =>
        sql<{
          user_id: string;
          session_created_at: Date | string;
          session_expires_at: Date | string;
          key_version: string;
          access_token_ciphertext: string;
          refresh_token_ciphertext: string;
          token_expires_at: Date | string;
        }>`
          select user_id, session_created_at, session_expires_at, key_version,
                 access_token_ciphertext, refresh_token_ciphertext, token_expires_at
            from toi_identity.authenticate_session_v1(
              ${input.sessionKey},
              ${input.host},
              ${toTimestamptz(input.now)}
            )
        `,
      );
      const row = rows[0];
      if (!row) return null;
      const issuedAt = fromTimestamptz(row.session_created_at);
      const expiresAt = fromTimestamptz(row.session_expires_at);
      const tokenExpiresAt = fromTimestamptz(row.token_expires_at);
      if (issuedAt === null || expiresAt === null || tokenExpiresAt === null) return null;
      return {
        userId: row.user_id,
        host: input.host,
        issuedAt,
        expiresAt,
        revokedAt: null,
        keyVersion: row.key_version,
        accessCiphertext: row.access_token_ciphertext,
        refreshCiphertext: row.refresh_token_ciphertext,
        tokenExpiresAt,
      };
    },

    async revoke(sessionKey: string, at: number): Promise<void> {
      assertSessionKey(sessionKey);
      await withSql(openSql, async (sql) => {
        await sql`select toi_identity.revoke_session_v1(${sessionKey}, ${toTimestamptz(at)})`;
      });
    },

    async replaceTokens(sessionKey: string, replacement: SessionTokenReplacement, now: number): Promise<boolean> {
      assertSessionKey(sessionKey);
      const rows = await withSql(openSql, async (sql) =>
        sql<{ rotated: boolean }>`
          select toi_identity.rotate_session_tokens_v1(
            ${sessionKey},
            ${replacement.keyVersion},
            ${replacement.accessCiphertext},
            ${replacement.refreshCiphertext},
            ${toTimestamptz(replacement.tokenExpiresAt)},
            ${toTimestamptz(now)}
          ) as rotated
        `,
      );
      return rows[0]?.rotated === true;
    },
  };
}

/**
 * The revocation a completed password reset owes — every *other* session this user holds on this host
 * (`docs/tasks/T-201-auth-methods.md`, ADR-0003 §4, and T-201 PR-2's
 * `toi_identity.revoke_user_sessions_v1`).
 *
 * Deliberately **not** a method on `SessionStore`: that interface is the row a cookie addresses, and
 * every one of its operations is keyed by session key. This is a user-wide act triggered by something
 * else entirely — a changed credential — and making it a store method would mean every test fake and
 * every `unresolvedSessionStore()` grew it, which is how a port ends up implemented by callers that
 * never intended to revoke anything. `adapters.ts` installs it only when the carrier exists, so a
 * deployment without `SESSION_DB` has the port **absent** rather than present and throwing, which is
 * what `handlePasswordResetRequest` checks before it dials a provider.
 *
 * The boolean is the SQL's contract, not this module's invention: `true` means the revocation ran, and
 * a user with no other session has nothing to revoke. Anything else — a refused host shape, a dead
 * connection, an answer with no row — is a failure, and it reaches the caller as a throw or a `false`,
 * both of which stop the reset.
 */
export type SessionRevoker = (input: { userId: string; host: string; now: number }) => Promise<boolean>;

/** Returns `null` when the carrier is not bound, exactly as `createSessionStore` does. */
export function createSessionRevoker(deps: SessionDbDeps): SessionRevoker | null {
  const openSql = openerFor(deps);
  if (openSql === null) return null;

  return async ({ userId, host, now }) => {
    assertUserId(userId);
    assertHost(host);
    // The clock is converted with the two shapes above, not inside the query: a caller that passed a
    // fractional or unsafe `now` is a bug on this side of the call, and finding it after opening a
    // Hyperdrive client spends a connection to learn something already known.
    const at = toTimestamptz(now);
    const rows = await withSql(openSql, async (sql) =>
      sql<{ revoked: boolean }>`
        select toi_identity.revoke_user_sessions_v1(
          ${userId}::uuid,
          ${host},
          ${at}
        ) as revoked
      `,
    );
    // No row back is not "nothing to revoke" — the function returns a scalar — it is a call that did not
    // complete, and a reset must not be reported as one.
    return rows[0]?.revoked === true;
  };
}
