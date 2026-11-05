import type { CSSProperties, ReactNode } from "react";
import { inter, plexMono } from "./fonts";
import { PoweredBy } from "./powered-by";
import styles from "./sign-in.module.css";
import type { SignInBrand } from "./types";

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

// Neutral fallbacks (graphite / white / slate) used when a brand value is not #RRGGBB.
const FALLBACK = { primary: "#17252B", onPrimary: "#FFFFFF", accent: "#52636B" } as const;

function color(value: string, fallback: string): string {
  return HEX_COLOR.test(value) ? value : fallback;
}

/**
 * Brand colors reach the page only as CSS custom properties on the root (T-131 rules).
 * React escapes style values for HTML but not for CSS, so anything other than #RRGGBB could add
 * declarations (e.g. "red;background:url(...)"). Reject it here even though T-103 validates too.
 */
export function brandVariables(brand: SignInBrand): CSSProperties {
  return {
    "--primary": color(brand.primary, FALLBACK.primary),
    "--on-primary": color(brand.onPrimary, FALLBACK.onPrimary),
    "--accent": color(brand.accent, FALLBACK.accent),
  } as CSSProperties;
}

/** Split layout shared by every sign-in screen: brand panel + form card. */
export function AuthShell({ brand, children }: { brand: SignInBrand; children: ReactNode }) {
  return (
    <div className={`${styles.page} ${inter.variable} ${plexMono.variable}`} style={brandVariables(brand)}>
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
