import type { EvalReviewCase } from "@/platform/evals/review-queue";

export const CASE_TYPE_LABEL: Record<EvalReviewCase["caseType"], string> = {
  answerable: "Answerable",
  needs_clarification: "Needs clarification",
  must_refuse: "Must refuse",
  out_of_scope: "Out of scope",
};

export const ORIGIN_LABEL: Record<EvalReviewCase["origin"], string> = {
  agent_drafted: "Agent drafted",
  expert_written: "Expert written",
  pilot: "From pilot feedback",
};

export const STATUS_LABEL: Record<EvalReviewCase["status"], string> = {
  drafted: "Pending review",
  approved: "Approved",
};

export const DATA_CLASS_LABEL: Record<string, string> = {
  public: "Public",
  internal: "Internal",
  client_confidential: "Client confidential",
  restricted: "Restricted",
};
