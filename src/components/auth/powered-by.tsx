import styles from "./sign-in.module.css";

/** Attribution line for powered mode only; customer mode must not render it (T-131). */
export function PoweredBy() {
  return <p className={styles.poweredBy}>Powered by TerraOI</p>;
}
