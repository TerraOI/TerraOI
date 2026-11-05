import type { CSSProperties } from "react";
import { inter, plexMono } from "./fonts";
import { MicrosoftButton } from "./method-buttons";
import styles from "./sign-in.module.css";
import type { SignInBrand, SignInPageProps } from "./types";

/** Brand colors reach the page only as CSS custom properties on the root (T-131 rules). */
export function brandVariables(brand: SignInBrand): CSSProperties {
  return {
    "--primary": brand.primary,
    "--on-primary": brand.onPrimary,
    "--accent": brand.accent,
  } as CSSProperties;
}

export function SignInPage({
  brand,
  enabledMethods,
  magicLinkAction,
  passwordAction,
  microsoftHref,
}: SignInPageProps) {
  // A method renders only when it is enabled AND its wiring was passed in: no disabled buttons.
  const showMicrosoft = enabledMethods.includes("microsoft") && Boolean(microsoftHref);
  const showMagicLink = enabledMethods.includes("magic_link") && Boolean(magicLinkAction);
  const showPassword = enabledMethods.includes("password") && Boolean(passwordAction);
  const showDivider = showMicrosoft && (showMagicLink || showPassword);

  return (
    <div className={`${styles.page} ${inter.className} ${plexMono.className}`} style={brandVariables(brand)}>
      <aside className={styles.brandPanel}>
        <p className={styles.brandName}>{brand.name}</p>
        <p className={styles.tagline}>{brand.tagline}</p>
      </aside>

      <main className={styles.formPanel}>
        <div className={styles.card}>
          {/* eslint-disable-next-line @next/next/no-img-element -- tenant logo URL is validated by T-103 */}
          <img className={styles.logo} src={brand.logoUrl} alt={brand.name} />
          <h1 className={styles.heading}>Sign in to {brand.name}</h1>

          {showMicrosoft && microsoftHref && <MicrosoftButton href={microsoftHref} />}

          {showDivider && (
            <div className={styles.divider}>
              <span>or</span>
            </div>
          )}

          {showMagicLink && (
            <form className={styles.form} action={magicLinkAction}>
              <label className={styles.label} htmlFor="signin-email">
                Work email
              </label>
              <input className={styles.input} id="signin-email" name="email" type="email" required />
              <button className={styles.primary} type="submit">
                Email me a sign-in link
              </button>
            </form>
          )}

          {showPassword && (
            <details className={styles.passwordToggle}>
              <summary className={styles.secondary}>Use a password instead</summary>
              <form className={styles.form} action={passwordAction}>
                <label className={styles.label} htmlFor="signin-password-email">
                  Email
                </label>
                <input className={styles.input} id="signin-password-email" name="email" type="email" required />
                <label className={styles.label} htmlFor="signin-password">
                  Password
                </label>
                <input className={styles.input} id="signin-password" name="password" type="password" required />
                <button className={styles.primary} type="submit">
                  Sign in
                </button>
              </form>
            </details>
          )}

          <p className={styles.support}>{brand.supportLabel}</p>
        </div>
      </main>
    </div>
  );
}
