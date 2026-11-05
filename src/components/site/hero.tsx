import styles from "./site.module.css";
import { TerrainArt } from "./terrain-art";
import { WorkspaceFinder } from "./workspace-finder";

export function Hero() {
  return (
    <section className={styles.hero} aria-labelledby="hero-title">
      <div>
        <p className={styles.eyebrow}>Operational Intelligence</p>
        <h1 className={styles.heroTitle} id="hero-title">
          AI operations for air, surface, and subsurface.
        </h1>
        <p className={styles.heroCopy}>
          Ask your company&apos;s manuals, procedures and project records. Get answers with page-level citations,
          checked before you see them.
        </p>
        <WorkspaceFinder />
        <a className={styles.pilotLink} href="#pilot">
          Talk to us about a pilot <span aria-hidden="true">→</span>
        </a>
      </div>
      <div className={styles.heroArt}>
        <TerrainArt />
      </div>
    </section>
  );
}
