import type { CSSProperties, ReactNode } from "react";

import { PoweredBy } from "@/components/auth/powered-by";
import type { SignInBrand } from "@/components/auth/types";

import styles from "./tenant-shell.module.css";

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const FALLBACK = { primary: "#17252B", onPrimary: "#FFFFFF", accent: "#52636B" } as const;

function color(value: string, fallback: string): string {
  return HEX_COLOR.test(value) ? value : fallback;
}

function brandVariables(brand: SignInBrand): CSSProperties {
  return {
    "--primary": color(brand.primary, FALLBACK.primary),
    "--on-primary": color(brand.onPrimary, FALLBACK.onPrimary),
    "--accent": color(brand.accent, FALLBACK.accent),
  } as CSSProperties;
}

/**
 * Signed-in workspace chrome (plan §9.1). Services and projects stay empty until a permissioned
 * list exists — the shell does not invent experts or projects. Login stays outside this chrome;
 * `TenantFrame` makes that choice.
 */
export function TenantShell({
  brand,
  csrfToken,
  children,
}: {
  brand: SignInBrand;
  csrfToken?: string;
  children: ReactNode;
}) {
  return (
    <div className={styles.shell} style={brandVariables(brand)}>
      <header className={styles.banner} role="banner">
        <div>
          <p className={styles.name}>{brand.name}</p>
          {brand.tagline ? <p className={styles.tagline}>{brand.tagline}</p> : null}
        </div>
        {csrfToken ? (
          <form className={styles.signOut} action="/auth/sign-out" method="post">
            <input type="hidden" name="csrf_token" value={csrfToken} />
            <button className={styles.signOutButton} type="submit">
              Sign out
            </button>
          </form>
        ) : null}
      </header>
      <nav className={styles.nav} aria-label="Workspace">
        <section>
          <h2 className={styles.section}>Services</h2>
          <p className={styles.empty}>No services are available.</p>
        </section>
        <section>
          <h2 className={styles.section}>Projects</h2>
          <p className={styles.empty}>No projects are available.</p>
        </section>
        {brand.showPoweredBy ? <PoweredBy /> : null}
      </nav>
      <main className={styles.main}>{children}</main>
    </div>
  );
}
