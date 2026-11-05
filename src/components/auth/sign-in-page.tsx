import type { CSSProperties } from "react";
import { inter, plexMono } from "./fonts";
import { MagicLinkForm } from "./magic-link-form";
import { MicrosoftButton } from "./method-buttons";
import { PasswordForm } from "./password-form";
import styles from "./sign-in.module.css";
import { StatusMessage } from "./status-message";
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
  status,
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

          {showMagicLink && magicLinkAction && <MagicLinkForm action={magicLinkAction} />}

          {showPassword && passwordAction && <PasswordForm action={passwordAction} />}

          <StatusMessage status={status} />

          <p className={styles.support}>{brand.supportLabel}</p>
        </div>
      </main>
    </div>
  );
}
