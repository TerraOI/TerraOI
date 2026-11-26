import type { GatewayDeps } from "@/platform/gateway/call";
import {
  createSemanticVerifier,
  type CreateSemanticVerifierInput,
} from "@/platform/gateway/verifier-pass2";

import type { ComposeDeps, SemanticVerifierPort } from "./compose";

/**
 * Meta for default-wiring `createSemanticVerifier` into `ComposeDeps` (T-215 PR-3).
 *
 * `composedWith` is **not** fixed here: `composeAnswer` passes the live composer on each
 * `verify()` call so a material pass-2 failure retry excludes the right model (§12.4 (e)).
 */
export type SemanticVerifierWireMeta = Omit<CreateSemanticVerifierInput, "composedWith">;

/**
 * Gateway-backed {@link SemanticVerifierPort}: builds `createSemanticVerifier` per verify with the
 * composer identity from the call (or fails closed if a caller omits it).
 */
export function createWiredSemanticVerifier(
  gateway: GatewayDeps,
  meta: SemanticVerifierWireMeta,
): SemanticVerifierPort {
  return {
    async verify(input) {
      return createSemanticVerifier(gateway, {
        ...meta,
        composedWith: input.composedWith,
      }).verify(input);
    },
  };
}

/**
 * Returns `ComposeDeps` with `semanticVerifier` default-wired from `createSemanticVerifier`.
 * Callers get pass 2 without hand-injecting the port.
 */
export function createComposeDepsWithSemanticVerifier(
  gateway: GatewayDeps,
  meta: SemanticVerifierWireMeta,
): ComposeDeps {
  return {
    ...gateway,
    semanticVerifier: createWiredSemanticVerifier(gateway, meta),
  };
}

/**
 * Fills `semanticVerifier` when missing; leaves an explicit port alone (tests, overrides).
 */
export function withDefaultSemanticVerifier(
  deps: ComposeDeps,
  meta: SemanticVerifierWireMeta,
): ComposeDeps {
  if (deps.semanticVerifier !== undefined) return deps;
  return createComposeDepsWithSemanticVerifier(deps, meta);
}
