import Link from "next/link";
import styles from "./site.module.css";

export function Footer() {
  return (
    <footer className={styles.footer}>
      <span>TerraOI · Operational Intelligence</span>
      <nav aria-label="Legal">
        <Link href="/privacy">Privacy</Link>
        <a href="#pilot">Contact</a>
      </nav>
    </footer>
  );
}
