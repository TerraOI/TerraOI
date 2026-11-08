/**
 * The closed set of results a sign-in surface may show.
 *
 * The outcome travels through a query parameter because a browser form POST and a provider redirect
 * both have to land on a page. A query string is untrusted input, so nothing outside this list is
 * ever rendered, and no free text about why something failed travels with it: the detailed reason
 * stays in the server-side log (plan §8.2, AGENTS.md §4 "safe errors").
 *
 * `not_a_member` renders T-131's `NoAccessPage`; the others map onto T-131's `SignInStatus`. A
 * link-invalid outcome needs a copy value that does not exist in `components/auth/copy.ts` yet, so
 * the flow reports `unavailable` until #44 settles who adds it.
 */
export const SIGNIN_OUTCOMES = [
  "link_sent",
  "rate_limited",
  "unavailable",
  "not_a_member",
] as const;

export type SigninOutcome = (typeof SIGNIN_OUTCOMES)[number];

export function safeOutcome(raw: unknown): SigninOutcome | null {
  if (typeof raw !== "string") return null;
  return (SIGNIN_OUTCOMES as readonly string[]).includes(raw) ? (raw as SigninOutcome) : null;
}
