import { z } from "zod";

// Field rules from the T-130 packet. Limits use JS string length (UTF-16 units), which is never
// smaller than Postgres char_length (code points), so anything accepted here also passes the
// CHECK constraints in intake.pilot_inquiries: an over-long field is a 400 here, never a 503 there.

export const SERVICES = ["uav", "gpr", "other"] as const;
export type Service = (typeof SERVICES)[number];

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : null));

export const PilotInquiryInput = z.strictObject({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().max(254).pipe(z.email()).transform((v) => v.toLowerCase()),
  company: z.string().trim().min(1).max(160),
  role: optionalText(120),
  services: z
    .array(z.enum(SERVICES))
    .min(1)
    .refine((s) => new Set(s).size === s.length),
  message: optionalText(2000),
  privacyAcknowledged: z.literal(true),
  website: z.literal("").optional(), // honeypot: real people never fill it
  turnstileToken: z.string().min(1).max(2048),
});

export type PilotInquiry = {
  name: string;
  email: string;
  company: string;
  role: string | null;
  services: Service[];
  message: string | null;
};

export type ParsedPilotInquiry =
  | { ok: true; inquiry: PilotInquiry; turnstileToken: string }
  | { ok: false; fieldErrors: Record<string, string> };

// Fixed text per field. Zod's own messages can quote the input, so they never leave this module.
const FIELD_MESSAGES: Record<string, string> = {
  name: "Enter your name (up to 120 characters).",
  email: "Enter a valid work email.",
  company: "Enter your company (up to 160 characters).",
  role: "Keep your role to 120 characters.",
  services: "Choose at least one service.",
  message: "Keep your message to 2,000 characters.",
  privacyAcknowledged: "Confirm you have read the privacy notice.",
  website: "Leave this field empty.",
  turnstileToken: "Verification failed. Try again.",
};
const FORM_MESSAGE = "Check the form and try again.";

export function parsePilotInquiry(body: unknown): ParsedPilotInquiry {
  const result = PilotInquiryInput.safeParse(body);
  if (!result.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of result.error.issues) {
      const key = issue.path[0];
      const field = typeof key === "string" && key in FIELD_MESSAGES ? key : "form";
      fieldErrors[field] ??= FIELD_MESSAGES[field] ?? FORM_MESSAGE;
    }
    return { ok: false, fieldErrors };
  }
  const { name, email, company, role, services, message, turnstileToken } = result.data;
  return { ok: true, inquiry: { name, email, company, role, services, message }, turnstileToken };
}
