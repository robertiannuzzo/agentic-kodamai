# Plan: Slice 4 — PDF CV upload and optional cover-letter text

Status: ready for implementation.

This replaces the scope in `docs/plan-slice-4.md`. Keep that file as historical context, but do **not** implement its sign-in, candidate-account, or cover-letter-upload work as part of this slice.

## Why this slice

The current application flow asks candidates to paste their CV text. That demonstrates the extraction boundary, but it is not how a usable recruitment product should collect a CV.

Slice 4 should replace pasted CV text with a required PDF upload and add a lightweight, optional cover-letter text box. This improves the real application experience without expanding into account management or a second document pipeline. The five-link recruitment spine and scoring rules remain unchanged.

## Goals

1. A candidate can submit one readable PDF CV with an application.
2. The application continues through the existing extraction leaf, kernel intake, scoring, review, withdrawal, erasure, and retention flows.
3. A candidate can optionally include a plain-text cover letter of up to 5,000 characters.
4. A recruiter can view the original CV and read the cover letter alongside the existing application details.
5. Existing security, immutability, privacy, and audit guarantees remain intact.

## Explicit non-goals

- No real sign-in, sessions, passwords, candidate accounts, self-registration, or identity-provider integration.
- Do not remove or redesign the existing demo-identity controls in this slice.
- No cover-letter file upload. The cover letter is plain text only.
- No DOC, DOCX, image, or other CV formats.
- No OCR. Reject PDFs that do not contain readable text.
- No changes to scoring weights or policy. The cover letter is never scored and is never sent to the Idris kernel.
- No email delivery, public careers-site rebuild, or broader application-management work.

## User stories

- As a candidate, I want to upload my CV as a PDF so that I do not have to copy and paste it.
- As a candidate, I want to add an optional cover letter so that I can provide context relevant to the role.
- As a candidate, I want a clear explanation when my file cannot be accepted so that I can correct it.
- As a recruiter, I want to open the original CV and read the optional cover letter while reviewing an application.
- As a candidate, I want withdrawal and retention expiry to erase both documents and text associated with my application.

## Product decisions

### CV

- Exactly one PDF is required.
- Maximum size: 5 MB.
- Validate the file by content, including the PDF signature; do not trust the filename or browser MIME type alone.
- Extract text on the server before the application is committed.
- Reject a corrupt PDF or a PDF with no useful text. Use plain copy such as: “We couldn’t read text from this PDF. Please upload a text-based PDF.”
- Store the original PDF privately and store the extracted text in the existing `cv_text` field.
- The extracted text follows the existing `storedDocument` leaf and scoring path. Do not change the Idris kernel.

### Cover letter

- Optional plain-text multiline field.
- Maximum length: 5,000 characters, enforced on both client and server.
- Show a character counter.
- Trim leading and trailing whitespace. Treat an empty result as absent.
- Store it with the application and show it to recruiters.
- Do not score it, extract from it, or send it to the kernel.

## Implementation plan

### 1. Database migration

Add the next migration after the current latest version.

- Create a private `documents` table containing at least: `document_id`, `tenant_id`, `sha256`, `media_type`, `bytes`, and `created_at`.
- Add `cv_document_id` to `applications` and link it to `documents`.
- Add nullable `cover_letter_text` to `applications`.
- Preserve the existing immutable-application guarantee. Extend the erasure-only trigger so erasure may clear `cover_letter_text` and remove or unlink the CV document without allowing any other application edits.
- Ensure withdrawal and retention erasure remove the stored PDF bytes transactionally and clear the cover letter.
- Do not deduplicate documents across tenants. If content-addressing is used, tenant ownership must remain explicit.

Prefer a BLOB in SQLite for this slice because application erasure can then be transactional. Do not place uploaded files under the web root.

### 2. Application request and validation

Change the application endpoint to accept `multipart/form-data` containing:

- `cv`: required PDF file.
- `application`: JSON for the existing candidate name, privacy acknowledgement, answers, and years, plus optional `coverLetterText`.

Use a small, maintained multipart parser rather than writing a boundary parser by hand. Enforce the 5 MB file limit while reading the request, not after buffering an unlimited body.

Server validation must cover:

- Missing CV.
- More than one CV.
- File larger than 5 MB.
- Incorrect signature or invalid/corrupt PDF.
- PDF with no useful extracted text.
- Cover letter over 5,000 characters.
- All existing application validation.

Do not trust client-side validation as the security boundary.

### 3. PDF extraction and kernel boundary

- Add a server-side PDF text-extraction dependency with a small wrapper owned by the API.
- Keep the wrapper at the extraction leaf so the rest of the workflow receives the same `{ locator, version, text }` shape it receives today.
- Compute the CV version from the original PDF bytes using SHA-256.
- Use a stable private locator such as `cv://{tenant}/{reference}/{applicationId}`.
- Only persist the application and PDF after parsing, validation, kernel intake, and scoring succeed.
- A failed submission must not leave an orphaned document row or consume a usable application result.

### 4. Contracts and storage

- Replace `ApplicationSubmission.cvText` with `coverLetterText?: string` for the browser-facing submission contract; the uploaded CV travels as the multipart file.
- Add `coverLetterText: string | null` and a `hasCvDocument` or CV-view URL indicator to the recruiter-facing `ApplicationRecord`.
- Keep `cvText` in the recruiter-facing record because it is the extracted text used for scoring and audit/replay.
- Update store commit, retrieval, withdrawal, explicit erasure, and retention code together.
- Check idempotency carefully: replaying the same submission must not create duplicate document rows.

### 5. Private CV retrieval

Add a recruiter-only endpoint:

`GET /api/requisitions/:reference/applications/:applicationId/cv`

Requirements:

- Enforce tenant isolation and the recruiter role on the server.
- Return `404` after erasure or when no document exists.
- Return `Content-Type: application/pdf`.
- Return `Content-Disposition: inline` with a safe filename.
- Return `X-Content-Type-Options: nosniff` and a restrictive content security policy suitable for an inline PDF.
- Never expose a raw filesystem path or a public document URL.

### 6. Candidate interface

In step 04 of the application form:

- Replace the CV textarea with a required PDF file input.
- Use the visible label “CV (PDF)”.
- Show the selected filename and human-readable size.
- Provide concise help text: PDF only, maximum 5 MB.
- Add an optional textarea labelled “Cover letter (optional)”.
- Add a visible `current / 5,000` character counter.
- Preserve the privacy notice and acknowledgement.
- Clear errors when the candidate selects a valid replacement file.
- Prevent accidental double submission while the upload is in progress.

Suggested validation copy:

- Wrong format: “Upload your CV as a PDF.”
- Too large: “Your CV must be 5 MB or smaller.”
- Unreadable: “We couldn’t read text from this PDF. Please upload a text-based PDF.”
- Cover letter too long: “Keep your cover letter to 5,000 characters or fewer.”

### 7. Recruiter interface

- Add a “View CV” action to each application review panel. Open the private endpoint in a new tab.
- Keep the extracted CV text visible as it is today.
- Show a “Cover letter” section when text is present.
- When no cover letter was supplied, either omit the section or say “No cover letter provided”; follow the existing panel’s visual language.
- After erasure, do not render the CV action or cover-letter content.

### 8. Tests

#### API and storage

- Successful upload stores the original PDF and extracted text, then produces the same scoring behaviour as pasted text did.
- Missing CV is refused.
- Renamed non-PDF content is refused.
- Oversized PDF is refused without unbounded buffering.
- Corrupt and textless/scanned PDFs are refused.
- Cover letter is optional and is preserved exactly after trimming.
- Cover letter over 5,000 characters is refused server-side.
- Cover-letter text has no effect on the score.
- Recruiters can retrieve a CV; other roles and other tenants cannot.
- Withdrawal, explicit erasure, and retention expiry delete the PDF and clear the cover letter.
- Erasure does not alter the immutable score or audit evidence.
- Failed and idempotently replayed submissions do not create orphaned or duplicate documents.

Use small checked-in or test-generated fixtures: a valid text PDF, a textless PDF, and invalid bytes with a `.pdf` filename.

#### Browser journeys

- Candidate selects a PDF, sees its name, optionally enters a cover letter, acknowledges the notice, and submits successfully.
- Candidate receives useful feedback for a wrong type and oversized file.
- Recruiter sees the cover letter and can open the uploaded CV.
- Existing application, scoring, review, withdrawal, erasure, hiring, and race-condition journeys remain green.

### 9. Documentation

- Create `docs/slice-4.md` describing the completed behaviour and the PDF extraction leaf.
- Update `docs/containers.md` to explain that PDF parsing is an untrusted leaf while typed scoring remains unchanged.
- Update `docs/testing.md` and the README feature list and try-it instructions.
- State clearly that demo headers are still the current identity mechanism and real authentication is deferred.

## Acceptance criteria

- [ ] A candidate cannot submit without one valid, readable PDF CV.
- [ ] A candidate can submit with no cover letter or with up to 5,000 characters of cover-letter text.
- [ ] The original PDF can be viewed only through an authorised recruiter request for the same tenant.
- [ ] Scoring uses extracted CV text and is unaffected by the cover letter.
- [ ] The Idris kernel and scoring policy require no semantic changes.
- [ ] Wrong-type, oversized, corrupt, and textless files produce plain, actionable errors.
- [ ] Withdrawal, explicit erasure, and retention expiry remove the PDF and cover-letter text.
- [ ] No sign-in or account-management work is introduced.
- [ ] `make test` and `npm run test:e2e` pass.
- [ ] The finished candidate and recruiter flows are checked manually in the browser at desktop and narrow widths.

## Suggested delivery order

Implement this as one focused Slice 4 branch/PR:

1. Migration, document storage, PDF validation/extraction, and erasure.
2. Multipart application endpoint and contracts.
3. Candidate form.
4. Recruiter CV viewing and cover-letter display.
5. API, browser, privacy, and regression tests.
6. Documentation and final browser verification.

Do not begin authentication work after completing this plan unless the user separately approves a new scope.

