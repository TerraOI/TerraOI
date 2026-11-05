// Fixed user-facing text for the pilot inquiry (T-130 Global Constraints). Shared by the API
// handler and the browser form; a dependency-free module so the client bundle stays small.
export const INQUIRY_COPY = {
  received: "Thanks. We'll reply by email.",
  verificationFailed: "Verification failed. Try again.",
  rateLimited: "Too many requests. Try again later.",
  unavailable: "The service is temporarily unavailable. Try again later.",
  widgetFailed: "The verification check didn't load. Check your connection or ad blocker, then try again.",
  widgetPending: "Complete the verification check, then send.",
  checkForm: "Check the form and try again.",
  tooLarge: "Your inquiry is too long. Shorten the message and try again.",
} as const;
