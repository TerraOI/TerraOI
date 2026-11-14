import { AuthShell } from "./auth-shell";
import { MagicLinkForm } from "./magic-link-form";
import { MicrosoftButton } from "./method-buttons";
import { PasswordForm } from "./password-form";
import styles from "./sign-in.module.css";
import { StatusMessage } from "./status-message";
import type { SignInPageProps } from "./types";

export function SignInPage({
  brand,
  enabledMethods,
  status,
  magicLinkAction,
  csrfToken,
  passwordAction,
  microsoftHref,
}: SignInPageProps) {
  // A method renders only when it is enabled AND its wiring was passed in: no disabled buttons.
  const showMicrosoft = enabledMethods.includes("microsoft") && Boolean(microsoftHref);
  const showMagicLink = enabledMethods.includes("magic_link") && Boolean(magicLinkAction);
  const showPassword = enabledMethods.includes("password") && Boolean(passwordAction);
  const showDivider = showMicrosoft && (showMagicLink || showPassword);

  return (
    <AuthShell brand={brand}>
      <h1 className={styles.heading}>Sign in to {brand.name}</h1>

      {showMicrosoft && microsoftHref && <MicrosoftButton href={microsoftHref} />}

      {showDivider && (
        <div className={styles.divider}>
          <span>or</span>
        </div>
      )}

      {showMagicLink && magicLinkAction && (
        <MagicLinkForm action={magicLinkAction} csrfToken={csrfToken} />
      )}

      {showPassword && passwordAction && <PasswordForm action={passwordAction} defaultOpen={status === "invalid_credentials"} />}

      <StatusMessage status={status} />
    </AuthShell>
  );
}
