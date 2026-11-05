import type { SignInStatus } from "./types";

/**
 * The only text a status can show. No prop accepts free error text, so a caller cannot leak
 * whether an account exists or which provider failed (T-131 "No account probing").
 */
export const STATUS_COPY: Record<Exclude<SignInStatus, "idle">, string> = {
  link_sent: "If this address can sign in, we've sent a link.",
  invalid_credentials: "Email or password is incorrect.",
  rate_limited: "Too many requests. Try again later.",
  unavailable: "The service is temporarily unavailable. Try again later.",
};
