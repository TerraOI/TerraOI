import Link from "next/link";

import type { FormTemplate } from "@/contracts/form-template";
import { dataClassLabel } from "@/platform/forms/template-schema";

import styles from "./forms.module.css";

export function FormTemplateList({ templates }: { templates: readonly FormTemplate[] }) {
  return (
    <section className={styles.container} aria-labelledby="forms-heading">
      <header className={styles.header}>
        <h1 id="forms-heading" className={styles.title}>
          Forms
        </h1>
        <p className={styles.subtitle}>
          Select a form template to record field observations or compliance checks. Drafts stay private to you;
          submitted forms enter the workspace knowledge pipeline under collection review policy.
        </p>
      </header>

      {templates.length === 0 ? (
        <p className={styles.empty}>No forms are available for your workspace.</p>
      ) : (
        <ul className={styles.list}>
          {templates.map((template) => (
            <li key={`${template.id}:${template.version}`} className={styles.card}>
              <h2 className={styles.cardTitle}>{template.name}</h2>
              {template.description ? <p className={styles.cardDesc}>{template.description}</p> : null}
              <div className={styles.cardFooter}>
                <div className={styles.metaRow}>
                  <span className={styles.badge}>{template.serviceKey}</span>
                  <span className={styles.badge}>{template.version}</span>
                  <span className={styles.badge}>{dataClassLabel(template.dataClass)}</span>
                </div>
                <Link className={styles.primaryButton} href={`/forms/${template.id}`}>
                  Open form
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
