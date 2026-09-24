/** User-facing text for API error codes. */
const errorMessages: Record<string, string> = {
  "stale-version": "This requisition changed. Reload and try again.",
  "self-review-forbidden": "You submitted this requisition, so someone else must review it.",
  "reason-required": "Give a reason for this decision.",
  "wrong-stage": "That action is not available at this stage.",
  "already-applied": "You have already applied for this role.",
  "consent-required": "Please confirm consent before applying.",
  "answers-do-not-match-questions": "Answer every screening question.",
  "experience-does-not-match-skills": "Give your years of experience for every skill.",
  "privacy-notice-required": "Please confirm you have read the privacy notice.",
  "already-reviewed": "This application already has a recorded decision.",
  "application-erased": "This application's personal data has been erased.",
  "rate-limited": "Too many attempts. Please wait a few minutes and try again.",
  "invalid-reason": "Give a reason.",
  "internal-server-error": "Something went wrong. The stored record may no longer match its evidence."
};

export function describeError(code: string): string {
  return errorMessages[code] ?? code;
}
