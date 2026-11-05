import Link from "next/link";
import { inter } from "@/components/auth/fonts";
import { Footer } from "./footer";
import { Hero } from "./hero";
import { LogoWordmark } from "./logo-wordmark";
import { PilotForm } from "./pilot-form";
import styles from "./site.module.css";
import { Steps } from "./steps";
import { TrustStrip } from "./trust-strip";

/** terraoi.app. `turnstileSiteKey` comes from the TURNSTILE_SITE_KEY Worker var (server side). */
export function LandingPage({ turnstileSiteKey }: { turnstileSiteKey: string }) {
  return (
    <div className={`${styles.site} ${inter.variable}`}>
      <header className={styles.nav}>
        <Link href="/" className={styles.brand} aria-label="TerraOI home">
          <LogoWordmark height={28} />
        </Link>
        <nav className={styles.navLinks} aria-label="Main">
          <a href="#how-it-works">How it works</a>
          <a href="#security">Security</a>
          <a href="#pilot" className={styles.buttonOutline}>
            Talk to us
          </a>
        </nav>
      </header>
      <main>
        <Hero />
        <Steps />
        <TrustStrip />
        <section className={styles.pilot} id="pilot" aria-labelledby="pilot-title">
          <div className={styles.pilotIntro}>
            <h2 className={styles.pilotTitle} id="pilot-title">
              Talk to us about a pilot
            </h2>
            <p className={styles.cardBody}>
              Tell us what your teams fly, scan or survey. We reply by email.
            </p>
          </div>
          <PilotForm siteKey={turnstileSiteKey} />
        </section>
      </main>
      <Footer />
    </div>
  );
}
