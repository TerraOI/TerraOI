import Link from "next/link";

import type { EvalCaseStatusFilter, EvalReviewCase } from "@/platform/evals/review-queue";

import styles from "./evals.module.css";
import { CASE_TYPE_LABEL, DATA_CLASS_LABEL, ORIGIN_LABEL, STATUS_LABEL } from "./labels";

const FILTERS: { value: EvalCaseStatusFilter; label: string; href: string }[] = [
  { value: "drafted", label: "Pending", href: "/evals?status=drafted" },
  { value: "approved", label: "Approved", href: "/evals?status=approved" },
  { value: null, label: "All", href: "/evals" },
];

/**
 * T-303 case list: only what `list_eval_review_queue_v1` returned, grouped by expert. A case whose
 * expected source was revoked stays listed (the reviewer's work is not hidden) but is flagged.
 */
export function EvalCaseList({ cases, status }: { cases: EvalReviewCase[]; status: EvalCaseStatusFilter }) {
  const experts = [...new Set(cases.map((c) => c.expertKey))].sort();
  return (
    <section className={styles.container} aria-labelledby="evals-heading">
      <header>
        <h1 id="evals-heading" className={styles.title}>
          Evaluation cases
        </h1>
        <p className={styles.subtitle}>
          Approve, edit or reject candidate cases. Only approved cases are scored; you cannot decide a case you drafted.
        </p>
      </header>
      <nav className={styles.filters} aria-label="Case status">
        {FILTERS.map((filter) => (
          <Link
            key={filter.label}
            href={filter.href}
            className={`${styles.filterLink} ${filter.value === status ? styles.filterActive : ""}`}
            aria-current={filter.value === status ? "page" : undefined}
          >
            {filter.label}
          </Link>
        ))}
      </nav>
      {cases.length === 0 ? (
        <p className={styles.note} role="status">
          No cases to show.
        </p>
      ) : (
        experts.map((expert) => (
          <section key={expert} className={styles.group} aria-label={`Cases for ${expert}`}>
            <h2 className={styles.groupTitle}>{expert}</h2>
            <ul className={styles.list}>
              {cases
                .filter((c) => c.expertKey === expert)
                .map((c) => (
                  <li key={c.id} className={styles.item}>
                    <Link className={styles.itemLink} href={`/evals/${c.id}`}>
                      {c.caseKey}: {c.question}
                    </Link>
                    <span className={styles.meta}>
                      <span className={styles.badge}>{STATUS_LABEL[c.status]}</span>
                      <span className={styles.badge}>{CASE_TYPE_LABEL[c.caseType]}</span>
                      <span className={styles.badge}>{ORIGIN_LABEL[c.origin]}</span>
                      <span className={styles.badge}>{DATA_CLASS_LABEL[c.dataClass] ?? c.dataClass}</span>
                      {c.sourcesValid ? null : (
                        <span className={`${styles.badge} ${styles.badgeWarn}`}>Source revoked or unavailable</span>
                      )}
                    </span>
                  </li>
                ))}
            </ul>
          </section>
        ))
      )}
    </section>
  );
}
