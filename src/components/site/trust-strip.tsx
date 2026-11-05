import styles from "./site.module.css";

const POINTS = [
  "A separate workspace per company",
  "Cited, verified answers",
  "Client data stays with cleared providers",
];

export function TrustStrip() {
  return (
    <section className={styles.trust} id="security" aria-label="Security">
      <ul className={styles.trustList}>
        {POINTS.map((p) => (
          <li key={p}>
            <span className={styles.trustDot} aria-hidden="true" />
            {p}
          </li>
        ))}
      </ul>
    </section>
  );
}
