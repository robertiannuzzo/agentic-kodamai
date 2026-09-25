/** User-facing text for API error codes. */
const errorMessages: Record<string, string> = {
  "stale-version": "This requisition changed. Reload and try again.",
  "self-review-forbidden": "You submitted this requisition, so someone else must review it.",
  "reason-required": "Give a reason for this decision.",
  "wrong-stage": "That action is not available at this stage.",
  "already-applied": "You have already applied for this role.",
  "answers-do-not-match-questions": "Answer every screening question.",
  "experience-does-not-match-skills": "Give your years of experience for every skill.",
  "privacy-notice-required": "Please confirm you have read the privacy notice.",
  "already-reviewed": "This application already has a recorded decision.",
  "application-erased": "This application's personal data has been erased.",
  "not-shortlisted": "Only a shortlisted application can be hired.",
  "requisition-filled": "Every position on this requisition has been filled.",
  "already-hired": "This candidate has already been hired.",
  "invalid-start-date": "Choose a start date.",
  "invalid-legal-name": "Enter the new starter's legal name.",
  "cv-required": "Upload your CV as a PDF.",
  "cv-not-pdf": "Upload your CV as a PDF.",
  "too-many-cvs": "Upload one CV only.",
  "cv-too-large": "Your CV must be 5 MB or smaller.",
  "cv-too-many-pages": "Your CV must be 20 pages or fewer.",
  "cv-unreadable": "We couldn’t read text from this PDF. Please upload a text-based PDF.",
  "cv-no-text": "We couldn’t read text from this PDF. Please upload a text-based PDF.",
  "cv-text-too-long": "Your CV is too long. Please upload a shorter version.",
  "cover-letter-too-long": "Keep your cover letter to 5,000 characters or fewer.",
  "rate-limited": "Too many attempts. Please wait a few minutes and try again.",
  "invalid-reason": "Give a reason.",
  "internal-server-error": "Something went wrong. Try again, and contact us if it keeps happening."
};

export function describeError(code: string): string {
  return errorMessages[code] ?? code;
}
