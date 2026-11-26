import styles from "./admin.module.css";

export type BrandFallbackBannerProps = {
  /** Admin-visible note from `loadTenantBrand` — never customer PII or raw store errors. */
  note: string;
};

/**
 * Shown on `/admin/*` when the tenant brand fell back to platform branding (T-202 / #62).
 * The note is the loader's fixed copy for the fallback reason class.
 */
export function BrandFallbackBanner({ note }: BrandFallbackBannerProps) {
  return (
    <aside className={styles.fallbackBanner} role="status" aria-live="polite">
      <p className={styles.fallbackTitle}>Branding fallback</p>
      <p className={styles.fallbackNote}>{note}</p>
    </aside>
  );
}
