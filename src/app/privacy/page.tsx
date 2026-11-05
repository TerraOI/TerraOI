import type { Metadata } from "next";
import Link from "next/link";
import styles from "@/components/site/site.module.css";
import { inter } from "@/components/auth/fonts";

export const metadata: Metadata = { title: "Privacy notice · TerraOI" };

// DRAFT (T-130 human step 5): the owner approves this text before the form goes live.
export default function PrivacyPage() {
  return (
    <div className={`${styles.site} ${inter.variable}`}>
      <main className={styles.prose}>
        {process.env.NODE_ENV === "development" && (
          <p className={styles.draftNote} role="note">
            Draft, awaiting owner approval (T-130). This note only shows under next dev.
          </p>
        )}
        <h1>Privacy notice for pilot inquiries</h1>
        <p>This notice covers the &ldquo;Talk to us about a pilot&rdquo; form on terraoi.app.</p>

        <h2>What we store</h2>
        <ul>
          <li>Your name, work email, company and, if you give it, your role.</li>
          <li>The services you ticked and your message.</li>
          <li>
            A one-way keyed hash of your IP address, used only to limit abuse. We never store your IP address itself.
          </li>
          <li>The date you sent the form and where we are in replying.</li>
        </ul>

        <h2>Why</h2>
        <p>
          To reply to your inquiry and to discuss a possible pilot with you. We don&apos;t use it for advertising, we
          don&apos;t sell it, and the form loads no tracking or analytics scripts. A spam check from Cloudflare
          (Turnstile) runs when you send the form.
        </p>

        <h2>How long</h2>
        <p>We delete each inquiry automatically 12 months after you send it.</p>

        <h2>Your choices</h2>
        <p>
          To see, correct or delete what you sent before then, reply to any email from us or write to us from the
          address you used, and we&apos;ll act on it.
        </p>

        <p>
          <Link href="/">Back to terraoi.app</Link>
        </p>
      </main>
    </div>
  );
}
