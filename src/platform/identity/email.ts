/**
 * The one normalization for every address in the product.
 *
 * Plan §4.2: "an invite binds to a normalized email". The database already refuses a
 * non-canonical address (`profiles.email` check, migrations/20261105060000_tenancy_core.sql:59:
 * `email = lower(btrim(email))`), so this module is the write-time rule as well as the comparison
 * rule. Nothing anywhere else may compare raw addresses: an invite claimed by `User@Example.test`
 * and one claimed by `user@example.test` have to be the same claim or neither is one.
 */

const EMAIL_MAX_LENGTH = 254;

// Deliberately narrower than RFC 5322 and aligned with what the tenant admin UI (T-202) will accept.
// The domain must be ASCII and dot-separated: `lower()` in Postgres and `toLowerCase()` in JS agree
// on ASCII, and a non-ASCII domain would normalize differently on the two sides (Unicode case
// folding), which is exactly the mismatch an invite bypass would live in.
const DOMAIN_SHAPE = "[A-Za-z0-9]([A-Za-z0-9-]{0,62}[A-Za-z0-9])?(\\.[A-Za-z0-9]([A-Za-z0-9-]{0,62}[A-Za-z0-9])?)+";
const LOCAL_SHAPE = "[^\\s@,;<>\":'\\\\]+";
const EMAIL_SHAPE = new RegExp(`^${LOCAL_SHAPE}@${DOMAIN_SHAPE}$`);

/** lower + trim, the same transformation the `profiles.email` CHECK requires. */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * The canonical form of an address, or null when the input is not an address at all. Never returns
 * a string that is not itself canonical, so a caller cannot pass a raw value through by accident.
 */
export function canonicalEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = normalizeEmail(raw);
  if (value.length === 0 || value.length > EMAIL_MAX_LENGTH) return null;
  if (!EMAIL_SHAPE.test(value)) return null;
  return value;
}

/**
 * The only comparison that may be used for an address. Two invalid inputs never match each other,
 * so a garbage claim grants nothing instead of matching another garbage claim.
 */
export function emailsMatch(left: string, right: string): boolean {
  const a = canonicalEmail(left);
  const b = canonicalEmail(right);
  return a !== null && b !== null && a === b;
}
