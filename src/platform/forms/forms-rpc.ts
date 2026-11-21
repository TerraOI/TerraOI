import { z } from "zod";

import type { FormTemplate } from "@/contracts/form-template";
import type { TenantContext } from "@/contracts/tenant-context";
import {
  withTenantRpc,
  type BackendFailureReason,
  type FetchImpl,
  type TenantRpcFailure,
} from "@/platform/tenancy/tenant-rpc";

import { validateFormValues } from "./template-schema";

/**
 * Typed client for the merged T-301 scoped RPCs (`save_form_draft_v1`, `submit_form_v1`).
 *
 * Every call goes through `withTenantRpc` (FAQ-0011, plan §4.3): `p_organisation_id` comes only
 * from `TenantContext`, never from client arguments, and the bearer token is the signed-in user's
 * own Supabase access token (ADR-0003 §7). PostgREST error bodies never reach employee responses.
 */

export interface FormsRpcDeps {
  postgrestBaseUrl?: string;
  fetchImpl?: FetchImpl;
}

export interface SaveFormDraftInput {
  context: TenantContext;
  accessToken: string;
  template: FormTemplate;
  templateVersion: string;
  values: Record<string, unknown>;
  supersedesSubmissionId?: string;
}

export interface SubmitFormInput {
  context: TenantContext;
  accessToken: string;
  submissionId: string;
}

export type FormsRpcFailureKind =
  | "validation"
  | "version_closed"
  | "tenancy"
  | "rejected"
  | "backend_failure"
  | "not_configured";

export type FormsRpcOutcome =
  | { ok: true; submissionId: string }
  | {
      ok: false;
      kind: FormsRpcFailureKind;
      message: string;
      fieldErrors?: Record<string, string>;
      draftSubmissionId?: string;
    };

export interface FormsRpcClient {
  saveDraft(input: SaveFormDraftInput): Promise<FormsRpcOutcome>;
  submitDraft(input: SubmitFormInput): Promise<FormsRpcOutcome>;
  saveAndSubmit(input: SaveFormDraftInput): Promise<FormsRpcOutcome>;
}

/** Fixed employee-safe messages: name no tenant, SQLSTATE, table, host or untrusted value. */
export const SAFE_FORMS_RPC_MESSAGE: Record<FormsRpcFailureKind, string> = {
  validation: "Check the highlighted fields and try again.",
  version_closed: "This template version is no longer open for submissions.",
  tenancy: "You do not have permission to perform this action in this workspace.",
  rejected: "The submission could not be accepted. It may already have been submitted or the template version may have closed.",
  backend_failure: "The service is temporarily unavailable. Please try again.",
  not_configured: "The service is temporarily unavailable. Please try again.",
};

function mapBackendFailure(reason: BackendFailureReason): FormsRpcOutcome {
  switch (reason) {
    case "rejected":
      return { ok: false, kind: "rejected", message: SAFE_FORMS_RPC_MESSAGE.rejected };
    case "transport":
    case "timeout":
    case "server_error":
    case "invalid_response":
      return { ok: false, kind: "backend_failure", message: SAFE_FORMS_RPC_MESSAGE.backend_failure };
    default: {
      const _exhaustive: never = reason;
      void _exhaustive;
      return { ok: false, kind: "backend_failure", message: SAFE_FORMS_RPC_MESSAGE.backend_failure };
    }
  }
}

function mapTenantRpcFailure(failure: TenantRpcFailure): FormsRpcOutcome {
  switch (failure.kind) {
    case "tenancy":
      return { ok: false, kind: "tenancy", message: SAFE_FORMS_RPC_MESSAGE.tenancy };
    case "not_configured":
      return { ok: false, kind: "not_configured", message: SAFE_FORMS_RPC_MESSAGE.not_configured };
    case "backend_failure":
      return mapBackendFailure(failure.reason);
    default: {
      const _exhaustive: never = failure;
      void _exhaustive;
      return { ok: false, kind: "backend_failure", message: SAFE_FORMS_RPC_MESSAGE.backend_failure };
    }
  }
}

function parseUuidReturn(data: unknown): FormsRpcOutcome {
  const parsed = z.uuid().safeParse(data);
  if (!parsed.success) {
    return { ok: false, kind: "backend_failure", message: SAFE_FORMS_RPC_MESSAGE.backend_failure };
  }
  return { ok: true, submissionId: parsed.data };
}

export function createFormsRpcClient(deps: FormsRpcDeps): FormsRpcClient {
  const config = {
    postgrestBaseUrl: deps.postgrestBaseUrl,
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
  };

  async function saveDraft(input: SaveFormDraftInput): Promise<FormsRpcOutcome> {
    const validated = validateFormValues(input.template, input.templateVersion, input.values);
    if (!validated.ok) {
      if (validated.code === "version_closed") {
        return { ok: false, kind: "version_closed", message: validated.message };
      }
      return {
        ok: false,
        kind: "validation",
        message: validated.message,
        fieldErrors: validated.fieldErrors,
      };
    }

    if (
      input.supersedesSubmissionId !== undefined &&
      !z.uuid().safeParse(input.supersedesSubmissionId).success
    ) {
      return { ok: false, kind: "validation", message: "The referenced submission identifier is invalid." };
    }

    const outcome = await withTenantRpc(
      input.context,
      "save_form_draft_v1",
      {
        p_template_id: input.template.id,
        p_template_version: input.templateVersion,
        p_values: validated.values,
        p_supersedes_submission_id: input.supersedesSubmissionId ?? null,
      },
      input.accessToken,
      config,
    );

    if (!outcome.ok) return mapTenantRpcFailure(outcome);
    return parseUuidReturn(outcome.data);
  }

  async function submitDraft(input: SubmitFormInput): Promise<FormsRpcOutcome> {
    if (!z.uuid().safeParse(input.submissionId).success) {
      return { ok: false, kind: "validation", message: "The draft submission identifier is invalid." };
    }

    const outcome = await withTenantRpc(
      input.context,
      "submit_form_v1",
      { p_submission_id: input.submissionId },
      input.accessToken,
      config,
    );

    if (!outcome.ok) return mapTenantRpcFailure(outcome);
    return parseUuidReturn(outcome.data);
  }

  async function saveAndSubmit(input: SaveFormDraftInput): Promise<FormsRpcOutcome> {
    const draft = await saveDraft(input);
    if (!draft.ok) return draft;

    const submitted = await submitDraft({
      context: input.context,
      accessToken: input.accessToken,
      submissionId: draft.submissionId,
    });
    if (!submitted.ok) {
      return { ...submitted, draftSubmissionId: draft.submissionId };
    }
    return submitted;
  }

  return { saveDraft, submitDraft, saveAndSubmit };
}
