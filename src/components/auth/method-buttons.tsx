import styles from "./sign-in.module.css";

/** Microsoft's four-square logo, per its sign-in branding guidelines. */
function MicrosoftLogo() {
  return (
    <svg className={styles.msLogo} width="20" height="20" viewBox="0 0 21 21" aria-hidden="true" focusable="false">
      <rect x="1" y="1" width="9" height="9" fill="#F25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
      <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
      <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
    </svg>
  );
}

export function MicrosoftButton({ href }: { href: string }) {
  return (
    <a className={styles.microsoft} href={href}>
      <MicrosoftLogo />
      <span>Sign in with Microsoft</span>
    </a>
  );
}
