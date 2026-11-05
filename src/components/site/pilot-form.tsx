"use client";

import Link from "next/link";
import Script from "next/script";
import { useCallback, useId, useRef, useState, type FormEvent } from "react";
import { INQUIRY_COPY } from "@/platform/site/inquiry-copy";
import styles from "./site.module.css";

const TURNSTILE_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

type Turnstile = {
  render(
    el: HTMLElement,
    opts: { sitekey: string; callback(token: string): void; "expired-callback"?(): void; "error-callback"?(): void },
  ): string;
  reset(id?: string): void;
};
declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

type FieldErrors = Partial<Record<string, string>>;
type Phase = "idle" | "sending" | "sent";

// Fields with an inline error slot; any other key in fieldErrors falls back to one form alert.
const VISIBLE_FIELDS = new Set(["name", "email", "company", "role", "services", "message", "privacyAcknowledged"]);

const SERVICES = [
  { value: "uav", label: "UAV" },
  { value: "gpr", label: "GPR" },
  { value: "other", label: "Other" },
] as const;

/** Fixed copy per status; the response body's own text is never shown. */
function messageFor(status: number, body: { error?: unknown }): string {
  if (status === 400 && body.error === INQUIRY_COPY.verificationFailed) return INQUIRY_COPY.verificationFailed;
  if (status === 400) return INQUIRY_COPY.checkForm;
  if (status === 413) return INQUIRY_COPY.tooLarge;
  if (status === 429) return INQUIRY_COPY.rateLimited;
  return INQUIRY_COPY.unavailable;
}

export function PilotForm({ siteKey }: { siteKey: string }) {
  const id = useId();
  const [phase, setPhase] = useState<Phase>("idle");
  const [alert, setAlert] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [widgetFailed, setWidgetFailed] = useState(false);
  const token = useRef<string | null>(null);
  const widget = useRef<string | null>(null);
  const widgetEl = useRef<HTMLDivElement>(null);
  // Set synchronously on the first click so a second click in the same tick is ignored.
  const inFlight = useRef(false);
  const retries = useRef(0);
  const retrying = useRef(false);

  const failWidget = useCallback(() => {
    setWidgetFailed(true);
    setAlert(INQUIRY_COPY.widgetFailed);
  }, []);

  const renderWidget = useCallback(() => {
    if (!window.turnstile || !widgetEl.current || widget.current) return;
    // A missing site key (unconfigured environment) or a widget that throws must not crash the page.
    if (!siteKey) return failWidget();
    try {
      widget.current = window.turnstile.render(widgetEl.current, {
        sitekey: siteKey,
        callback: (t) => {
          token.current = t;
        },
        "expired-callback": () => {
          token.current = null;
        },
        "error-callback": failWidget,
      });
    } catch {
      failWidget();
    }
  }, [siteKey, failWidget]);

  // next/script never reloads a src it has seen, so a retry injects a fresh, cache-busted tag.
  function retryWidget() {
    if (retrying.current || !siteKey) return;
    retrying.current = true;
    retries.current += 1;
    const el = document.createElement("script");
    el.src = `${TURNSTILE_SRC}&retry=${retries.current}`;
    el.async = true;
    el.onload = () => {
      retrying.current = false;
      setWidgetFailed(false);
      setAlert(null);
      widget.current = null;
      renderWidget();
    };
    el.onerror = () => {
      retrying.current = false;
      el.remove();
    };
    document.head.appendChild(el);
  }

  function resetWidget() {
    token.current = null;
    window.turnstile?.reset(widget.current ?? undefined);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    if (widgetFailed) {
      setAlert(INQUIRY_COPY.widgetFailed);
      retryWidget();
      return;
    }
    if (!token.current) {
      setAlert(INQUIRY_COPY.widgetPending);
      return;
    }

    const form = new FormData(event.currentTarget);
    const text = (k: string) => String(form.get(k) ?? "");
    const payload = {
      name: text("name"),
      email: text("email"),
      company: text("company"),
      role: text("role"),
      services: form.getAll("services").map(String),
      message: text("message"),
      privacyAcknowledged: form.get("privacyAcknowledged") === "on",
      website: text("website"),
      turnstileToken: token.current,
    };

    inFlight.current = true;
    setPhase("sending");
    setAlert(null);
    setFieldErrors({});
    try {
      const res = await fetch("/api/pilot-inquiry", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.status === 201) {
        setPhase("sent");
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: unknown; fieldErrors?: FieldErrors };
      // Field errors show next to their inputs; anything else gets one fixed alert.
      const errors = res.status === 400 ? body.fieldErrors : undefined;
      setFieldErrors(errors ?? {});
      const hidden = errors && Object.keys(errors).some((k) => !VISIBLE_FIELDS.has(k));
      setAlert(errors && !hidden ? null : messageFor(res.status, body));
      resetWidget(); // a Turnstile token is single-use
      setPhase("idle");
    } catch {
      setAlert(INQUIRY_COPY.unavailable);
      setPhase("idle");
    } finally {
      inFlight.current = false;
    }
  }

  if (phase === "sent") {
    return (
      <p className={styles.formSuccess} role="status">
        {INQUIRY_COPY.received}
      </p>
    );
  }

  const field = (name: string) => {
    const error = fieldErrors[name];
    return {
      id: `${id}-${name}`,
      name,
      "aria-invalid": error ? true : undefined,
      "aria-describedby": error ? `${id}-${name}-error` : undefined,
    } as const;
  };
  const errorFor = (name: string) =>
    fieldErrors[name] ? (
      <p className={styles.fieldError} id={`${id}-${name}-error`}>
        {fieldErrors[name]}
      </p>
    ) : null;

  return (
    <form className={styles.pilotForm} onSubmit={onSubmit} noValidate>
      <Script
        src={TURNSTILE_SRC}
        strategy="afterInteractive"
        // onReady fires after the first load and again on every remount (onLoad fires only once).
        onReady={renderWidget}
        onError={failWidget}
      />

      <div className={styles.formGrid}>
        <div className={styles.formField}>
          <label htmlFor={`${id}-name`}>Name</label>
          <input {...field("name")} autoComplete="name" required maxLength={120} />
          {errorFor("name")}
        </div>
        <div className={styles.formField}>
          <label htmlFor={`${id}-email`}>Work email</label>
          <input {...field("email")} type="email" autoComplete="email" inputMode="email" required maxLength={254} />
          {errorFor("email")}
        </div>
        <div className={styles.formField}>
          <label htmlFor={`${id}-company`}>Company</label>
          <input {...field("company")} autoComplete="organization" required maxLength={160} />
          {errorFor("company")}
        </div>
        <div className={styles.formField}>
          <label htmlFor={`${id}-role`}>
            Role <span className={styles.optional}>(optional)</span>
          </label>
          <input {...field("role")} autoComplete="organization-title" maxLength={120} />
          {errorFor("role")}
        </div>
      </div>

      <fieldset
        className={styles.services}
        aria-invalid={fieldErrors.services ? true : undefined}
        aria-describedby={fieldErrors.services ? `${id}-services-error` : undefined}
      >
        <legend>Services you&apos;re interested in</legend>
        {SERVICES.map((s) => (
          <label key={s.value} className={styles.check}>
            <input type="checkbox" name="services" value={s.value} />
            {s.label}
          </label>
        ))}
        {errorFor("services")}
      </fieldset>

      <div className={styles.formField}>
        <label htmlFor={`${id}-message`}>
          What would you like to do? <span className={styles.optional}>(optional)</span>
        </label>
        <textarea {...field("message")} rows={4} maxLength={2000} />
        {errorFor("message")}
      </div>

      {/* Honeypot: invisible to people and assistive tech; bots that fill it are rejected. */}
      <div className={styles.honeypot} aria-hidden="true">
        <label htmlFor={`${id}-website`}>Website</label>
        <input id={`${id}-website`} name="website" tabIndex={-1} autoComplete="off" />
      </div>

      <label className={styles.check}>
        <input
          type="checkbox"
          name="privacyAcknowledged"
          aria-invalid={fieldErrors.privacyAcknowledged ? true : undefined}
          aria-describedby={fieldErrors.privacyAcknowledged ? `${id}-privacyAcknowledged-error` : undefined}
        />
        <span>
          I have read the <Link href="/privacy">privacy notice</Link>.
        </span>
      </label>
      {errorFor("privacyAcknowledged")}

      <div ref={widgetEl} className={styles.turnstile} />

      <p className={styles.formAlert} role="alert">
        {alert ?? ""}
      </p>

      <button className={styles.buttonPrimary} type="submit" aria-busy={phase === "sending"} disabled={phase === "sending"}>
        {phase === "sending" ? "Sending…" : "Send inquiry"}
      </button>
    </form>
  );
}
