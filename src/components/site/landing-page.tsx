import Link from "next/link";
import type { ReactNode } from "react";
import { inter } from "@/components/auth/fonts";
import { Footer } from "./footer";
import { Hero } from "./hero";
import { LogoWordmark } from "./logo-wordmark";
import styles from "./site.module.css";
import { Steps } from "./steps";
import { TrustStrip } from "./trust-strip";

/** terraoi.app. `pilotForm` is the slot Task 10 fills with the inquiry form. */
export function LandingPage({ pilotForm }: { pilotForm?: ReactNode }) {
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
        {pilotForm}
      </main>
      <Footer />
    </div>
  );
}
