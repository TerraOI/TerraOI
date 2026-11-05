import type { CSSProperties, ReactNode } from "react";
import { inter, plexMono } from "./fonts";
import { PoweredBy } from "./powered-by";
import styles from "./sign-in.module.css";
import type { SignInBrand } from "./types";

/** Brand colors reach the page only as CSS custom properties on the root (T-131 rules). */
export function brandVariables(brand: SignInBrand): CSSProperties {
  return {
    "--primary": brand.primary,
    "--on-primary": brand.onPrimary,
    "--accent": brand.accent,
  } as CSSProperties;
}

/** Split layout shared by every sign-in screen: brand panel + form card. */
export function AuthShell({ brand, children }: { brand: SignInBrand; children: ReactNode }) {
  return (
    <div className={`${styles.page} ${inter.className} ${plexMono.className}`} style={brandVariables(brand)}>
      <aside className={styles.brandPanel}>
        <p className={styles.brandName}>{brand.name}</p>
        <p className={styles.tagline}>{brand.tagline}</p>
      </aside>

      <main className={styles.formPanel}>
        <div className={styles.card}>
          {brand.logoUrl && (
            // eslint-disable-next-line @next/next/no-img-element -- tenant logo URL is validated by T-103
            <img className={styles.logo} src={brand.logoUrl} alt={brand.name} />
          )}
          {children}
          <p className={styles.support}>{brand.supportLabel}</p>
          {brand.showPoweredBy && <PoweredBy />}
        </div>
      </main>
    </div>
  );
}
