import postgres from "postgres";

import type { SessionStore, SessionTokenReplacement, StoredSession } from "./session-store";
import { SESSION_KEY_SHAPE } from "./session-store";

/**
 * Hyperdrive-backed `SessionStore` (#75 option 1, ADR-0003 amendment).
 *
 * Connects as a login user that is `IN ROLE toi_session_worker`. Calls only the five
 * `toi_identity.*_session_v1` functions — never `SELECT` on `toi_identity.sessions`. A leaked
 * `SESSION_DB` credential can authenticate, insert, revoke and rotate sessions, but cannot read
 * tenant data and cannot recover token plaintext (ciphertext stays sealed under `SESSION_TOKEN_KEY`).
 *
 * One short-lived client per operation, `prepare: false`, matching the ADR-0002 intake pattern in
 * `src/platform/site/adapters.ts`.
 */

export type SessionDbBinding = { connectionString: string };

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

/**
 * Builds the store. Returns `null` when the binding is missing — the honest "unavailable" state —
 * rather than a throwing stub. Callers already treat `sessionStore() === null` as "cannot sign in".
 */
export function createSessionStore(deps: SessionDbDeps): SessionStore | null {
  const open: (() => SessionSql) | null =
    deps.openSql ??
    (deps.binding ? () => openFromBinding(deps.binding as SessionDbBinding) : null);
  if (open === null) return null;
  const openSql = open;

  async function withSql<T>(run: (sql: SessionSql) => Promise<T>): Promise<T> {
    const sql = openSql();
    try {
      return await run(sql);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }

  return {
    async insert(input: { sessionKey: string; session: StoredSession }): Promise<void> {
      assertSessionKey(input.sessionKey);
      const { session } = input;
      await withSql(async (sql) => {
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
      const rows = await withSql(async (sql) =>
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
      await withSql(async (sql) => {
        await sql`select toi_identity.revoke_session_v1(${sessionKey}, ${toTimestamptz(at)})`;
      });
    },

    async replaceTokens(sessionKey: string, replacement: SessionTokenReplacement, now: number): Promise<boolean> {
      assertSessionKey(sessionKey);
      const rows = await withSql(async (sql) =>
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
