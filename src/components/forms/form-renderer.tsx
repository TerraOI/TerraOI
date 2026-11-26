"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";

import type { FormTemplate } from "@/contracts/form-template";
import {
  dataClassLabel,
  parseFormSubmissionEntries,
  validateFormValues,
  type FormFieldSpec,
} from "@/platform/forms/template-schema";

import styles from "./forms.module.css";

interface ActionResponse {
  ok: boolean;
  state?: "draft" | "submitted";
  submissionId?: string;
  draftSubmissionId?: string;
  code?: string;
  message?: string;
  fieldErrors?: Record<string, string>;
}

function fieldLabel(name: string): string {
  const spaced = name.replaceAll("_", " ").trim();
  return spaced.length === 0 ? name : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function FormRenderer({
  template,
  fields,
  csrfToken,
  supersedesSubmissionId,
}: {
  template: FormTemplate;
  fields: readonly FormFieldSpec[];
  csrfToken: string;
  supersedesSubmissionId?: string;
}) {
  const [rawValues, setRawValues] = useState<Record<string, string | boolean>>(() => {
    const initial: Record<string, string | boolean> = {};
    for (const field of fields) {
      initial[field.name] = field.kind === "boolean" ? false : "";
    }
    return initial;
  });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [draftSubmissionId, setDraftSubmissionId] = useState<string | null>(null);
  const [submittedId, setSubmittedId] = useState<string | null>(null);
  const [pending, setPending] = useState<"draft" | "submit" | null>(null);

  function updateField(name: string, nextValue: string | boolean) {
    setRawValues((prev) => ({ ...prev, [name]: nextValue }));
    setFieldErrors((prev) => {
      if (!(name in prev)) return prev;
      const copy = { ...prev };
      delete copy[name];
      return copy;
    });
    // Submissions are append-only in M1; editing values invalidates any unsaved draft reference.
    if (draftSubmissionId !== null) setDraftSubmissionId(null);
  }

  async function runAction(action: "draft" | "submit") {
    setErrorMessage(null);
    const coerced = parseFormSubmissionEntries(template, rawValues);
    const checked = validateFormValues(template, template.version, coerced);
    if (!checked.ok) {
      setErrorMessage(checked.message);
      setFieldErrors(checked.code === "validation" ? checked.fieldErrors : {});
      return;
    }

    setPending(action);
    try {
      const payload: Record<string, unknown> = {
        action,
        csrfToken,
        templateId: template.id,
        templateVersion: template.version,
        values: checked.values,
        ...(action === "submit" && draftSubmissionId !== null ? { submissionId: draftSubmissionId } : {}),
        ...(supersedesSubmissionId !== undefined ? { supersedesSubmissionId } : {}),
      };

      const response = await fetch("/forms/submit", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(payload),
      });

      let body: ActionResponse;
      try {
        body = (await response.json()) as ActionResponse;
      } catch {
        setErrorMessage("The service returned an unreadable response. Please try again.");
        return;
      }

      if (!response.ok || !body.ok) {
        setErrorMessage(body.message ?? "Could not save this form. Please try again.");
        setFieldErrors(body.fieldErrors ?? {});
        if (typeof body.draftSubmissionId === "string") {
          setDraftSubmissionId(body.draftSubmissionId);
        }
        return;
      }

      setFieldErrors({});
      if (body.state === "draft" && typeof body.submissionId === "string") {
        setDraftSubmissionId(body.submissionId);
      } else if (body.state === "submitted" && typeof body.submissionId === "string") {
        setSubmittedId(body.submissionId);
      }
    } catch {
      setErrorMessage("Could not reach the server. Please try again.");
    } finally {
      setPending(null);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void runAction("submit");
  }

  if (submittedId !== null) {
    return (
      <section className={styles.container} aria-labelledby="form-submitted-heading">
        <Link className={styles.backLink} href="/forms">
          ← Back to forms
        </Link>
        <div className={styles.statusBanner} role="status">
          <h1 id="form-submitted-heading" className={styles.title}>
            Form submitted
          </h1>
          <p className={styles.subtitle}>
            Captured as an immutable knowledge record ({template.version}, submission {submittedId}). Publication
            follows the collection review policy.
          </p>
        </div>
        <div className={styles.actions}>
          <Link className={styles.primaryButton} href={`/forms/${template.id}?supersedes=${submittedId}`}>
            Create correction
          </Link>
          <Link className={styles.secondaryButton} href="/forms">
            Back to forms
          </Link>
        </div>
      </section>
    );
  }

  return (
    <section className={styles.container} aria-labelledby="form-heading">
      <header className={styles.header}>
        <Link className={styles.backLink} href="/forms">
          ← Back to forms
        </Link>
        <h1 id="form-heading" className={styles.title}>
          {template.name}
        </h1>
        {template.description ? <p className={styles.subtitle}>{template.description}</p> : null}
        <div className={styles.metaRow}>
          <span className={styles.badge}>{template.serviceKey}</span>
          <span className={styles.badge}>Version {template.version}</span>
          <span className={styles.badge}>{dataClassLabel(template.dataClass)}</span>
        </div>
      </header>

      <p className={styles.notice}>
        Drafts stay private to you. Submitting captures an immutable record against template version{" "}
        <strong>{template.version}</strong> with data class <strong>{dataClassLabel(template.dataClass)}</strong>.
      </p>

      {supersedesSubmissionId !== undefined ? (
        <p className={styles.notice} role="note">
          Creating a correction linked to submission <code>{supersedesSubmissionId}</code>. The prior submission is
          preserved unchanged.
        </p>
      ) : null}

      {draftSubmissionId !== null ? (
        <p className={styles.statusBanner} role="status">
          Draft saved (ID <code>{draftSubmissionId}</code>). It is private to you until you submit.
        </p>
      ) : null}

      {errorMessage !== null ? (
        <p className={styles.errorBanner} role="alert">
          {errorMessage}
        </p>
      ) : null}

      <form className={styles.form} onSubmit={onSubmit} noValidate>
        <input type="hidden" name="templateVersion" value={template.version} />

        {fields.map((field) => {
          const inputId = `field-${field.name}`;
          const helpId = field.helpText ? `${inputId}-help` : undefined;
          const errorId = fieldErrors[field.name] ? `${inputId}-error` : undefined;
          const describedBy = [helpId, errorId].filter(Boolean).join(" ") || undefined;
          const label = fieldLabel(field.name);
          const value = rawValues[field.name];

          if (field.kind === "boolean") {
            return (
              <div key={field.name} className={styles.field}>
                <label className={styles.checkboxRow} htmlFor={inputId}>
                  <input
                    id={inputId}
                    name={field.name}
                    type="checkbox"
                    checked={value === true}
                    onChange={(event) => updateField(field.name, event.target.checked)}
                    aria-describedby={describedBy}
                  />
                  <span className={styles.label}>{label}</span>
                </label>
                {field.helpText ? (
                  <p id={helpId} className={styles.helpText}>
                    {field.helpText}
                  </p>
                ) : null}
                {fieldErrors[field.name] ? (
                  <p id={errorId} className={styles.fieldError}>
                    {fieldErrors[field.name]}
                  </p>
                ) : null}
              </div>
            );
          }

          const useTextarea = field.kind === "string" && (field.maxLength === undefined || field.maxLength > 200);
          const inputType = field.kind === "string" ? "text" : "number";

          return (
            <div key={field.name} className={styles.field}>
              <label className={styles.label} htmlFor={inputId}>
                {label}
                {field.unit ? <span className={styles.unit}> ({field.unit})</span> : null}
                {field.required ? " *" : ""}
              </label>

              {useTextarea ? (
                <textarea
                  id={inputId}
                  name={field.name}
                  className={styles.textarea}
                  value={typeof value === "string" ? value : ""}
                  onChange={(event) => updateField(field.name, event.target.value)}
                  maxLength={field.maxLength}
                  placeholder={field.placeholder}
                  required={field.required}
                  aria-invalid={errorId !== undefined}
                  aria-describedby={describedBy}
                />
              ) : (
                <input
                  id={inputId}
                  name={field.name}
                  className={styles.input}
                  type={inputType}
                  step={field.kind === "integer" ? 1 : field.kind === "number" ? "any" : undefined}
                  inputMode={field.kind === "integer" ? "numeric" : undefined}
                  value={typeof value === "string" ? value : ""}
                  onChange={(event) => updateField(field.name, event.target.value)}
                  maxLength={field.kind === "string" ? field.maxLength : undefined}
                  placeholder={field.placeholder}
                  required={field.required}
                  aria-invalid={errorId !== undefined}
                  aria-describedby={describedBy}
                />
              )}

              {field.helpText ? (
                <p id={helpId} className={styles.helpText}>
                  {field.helpText}
                </p>
              ) : null}
              {fieldErrors[field.name] ? (
                <p id={errorId} className={styles.fieldError}>
                  {fieldErrors[field.name]}
                </p>
              ) : null}
            </div>
          );
        })}

        <div className={styles.actions}>
          <button
            type="button"
            className={styles.secondaryButton}
            disabled={pending !== null}
            onClick={() => void runAction("draft")}
          >
            {pending === "draft" ? "Saving draft..." : "Save draft"}
          </button>
          <button type="submit" className={styles.primaryButton} disabled={pending !== null}>
            {pending === "submit" ? "Submitting..." : "Submit form"}
          </button>
        </div>
      </form>
    </section>
  );
}
