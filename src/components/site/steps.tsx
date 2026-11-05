import styles from "./site.module.css";

const STEPS = [
  { n: "01", label: "Observe", tone: "teal", title: "Your documents, searchable", body: "Upload manuals, SOPs, scans and spreadsheets. Each version is tracked." },
  { n: "02", label: "Plan", tone: "brass", title: "Experts per service", body: "UAV and GPR experts answer from your approved sources only." },
  { n: "03", label: "Act", tone: "teal", title: "Review, then decide", body: "Every claim links to its page. Unknowns are stated, not guessed." },
] as const;

export function Steps() {
  return (
    <section className={styles.steps} id="how-it-works" aria-label="How it works">
      {STEPS.map((s) => (
        <article key={s.n} className={styles.card}>
          {/* Brass stays decorative: the step number is a label, not body text (kit rule). */}
          <p className={s.tone === "brass" ? styles.stepBrass : styles.stepTeal}>
            {s.n} {s.label}
          </p>
          <h2 className={styles.cardTitle}>{s.title}</h2>
          <p className={styles.cardBody}>{s.body}</p>
        </article>
      ))}
    </section>
  );
}
