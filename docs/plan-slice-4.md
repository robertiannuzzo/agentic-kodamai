# Plan: Slice 4 — real sign-in, then PDF CV and cover letter

Status: superseded by [the revised plan](plan-slice-4-revised.md), which dropped sign-in from this slice. Kept as history. Written 2026-09-25 at the end of the Slice 3 / UI / copy work (main at `ea8f5c8`).

## Where the project is

- Idris kernel: one agent for `KernelC = Sum TransitionC (Sum IntakeC (Sum AssessC HireKC))` — requisition transitions, application intake, recorded decisions, hires with provenance. See `docs/containers.md`, `docs/slice-2.md`, `docs/slice-2-1.md`, `docs/slice-3.md`.
- API: `apps/api/src/server.ts` (hand-rolled router), `store.ts` (SQLite, `node:sqlite`), `migrations.ts` (latest is **version 8**), `workflow.ts` (kernel protocol v5).
- Web: React, Kodamai dark theme (`docs/design.md`), split into `App.tsx`, `shell.tsx`, `requisition.tsx`, `recruiting.tsx`, `candidate.tsx`, `stages.ts`, `format.ts`, `messages.ts`.
- Identity today is **demo headers** (`x-demo-actor`, `x-demo-role`, `x-demo-tenant`) set by the "Demo as" switch and the candidate "Applying as" box. Every review has flagged this.
- Tests: `make test` (239 Idris checks, 20 compile-fail fixtures, 27 HTTP tests) and `npm run test:e2e` (6 Playwright journeys). CI runs both on every PR (~11 minutes).

## Part A — real sign-in for the four roles (do first)

### Accounts

Seed four demo accounts in a migration (version 9). Use a non-deliverable demo subdomain so no real mailbox is implied, and label them demo-only in the README:

| Role | Email | Password |
|---|---|---|
| Requester | `requester@demo.kodamai.com` | `requester2026` |
| Approver | `approver@demo.kodamai.com` | `approver2026` |
| Recruiter | `recruiter@demo.kodamai.com` | `recruiter2026` |
| Candidate | `candidate@demo.kodamai.com` | `candidate2026` |

Confirm the domain with the user before seeding (they suggested `@kodamai.com`; the plan recommends `@demo.kodamai.com`).

### Server

- `users` table: `user_id`, `tenant_id`, `email` (unique), `role`, `display_name`, `password_hash`, `created_at`. Hash with `node:crypto` `scrypt` plus a per-user random salt; compare with `timingSafeEqual`. No new dependency.
- `sessions` table: random 32-byte token (store only its SHA-256), `user_id`, `created_at`, `expires_at` (8 hours). Prune expired sessions in the existing `maintain()`.
- Endpoints: `POST /api/session` (email, password → sets cookie, returns `{ email, role, displayName }`), `GET /api/session` (current user or 401), `DELETE /api/session` (sign out).
- Cookie: `kodamai_session`, `HttpOnly`, `SameSite=Strict`, `Path=/`, `Secure` when not on localhost.
- CSRF: `SameSite=Strict` plus require a custom header (`x-kodamai-request: 1`) on every non-GET API call; the web client always sends it.
- Rate-limit login attempts per email and per address with the existing `RateLimiter`.
- `identity()` in `server.ts` reads the session. Keep header identity **only** when the server is started with an explicit test option (for example `allowDemoHeaders: true`, default false; `test-support.ts` passes true) so the 27 HTTP tests keep working without rewriting each one. Add a few new HTTP tests that exercise real sessions: login success, wrong password (same 401 message for unknown email and wrong password), sign-out, expired session, CSRF header required, cookie flags, headers ignored when `allowDemoHeaders` is false.

### Candidates

- A signed-in candidate's application belongs to their account. Remove the "Applying as" header box. Pre-fill the form's email from the account and make it read-only (or remove it and show "Applying as {email}").
- Multiple applicants in demos and tests: e2e can create extra candidates through a test-only seeding route or the HTTP test shortcut; do not add public self-registration in this slice unless the user asks.

### Web

- Login page in the Kodamai style (`docs/design.md`): email, password, "Sign in" (white pill), error text in plain language.
- **One-click demo sign-in** under the form: "Demo accounts" list of the four roles; clicking one performs a real login for that account. This keeps interview demos fast.
- Header: replace "Demo as" with the signed-in user's name and role, plus "Sign out". Keep the settings menu.
- Handle 401 anywhere by returning to the login page.

### Tests

- Playwright: replace `viewAs(page, role)` helpers with a `signInAs(page, role)` helper that uses the demo-account buttons (or the form). Update the six journeys; add a journey for wrong password and sign-out.
- Keep the race-condition tests meaningful (they currently switch candidate identity via the header box; switch accounts via sign-in instead, or drop the identity-switch variant and keep the mutation-guard test).

### Docs

- ADR 012 (sessions, hashing, CSRF, test-only header mode), README "Try it" section with the demo accounts, `docs/slice-1.md` trust-boundary section updated.

## Part B — PDF CV and optional cover letter

### Server

- Upload route or JSON with base64 — prefer `multipart/form-data` parsed by hand-rolled boundary parsing or a tiny dependency (`busboy`). Limits: 5 MB per file, PDF only, verified by the `%PDF-` magic bytes, not the filename or MIME type.
- Store files outside the web root (`var/documents/{sha256}.pdf`) or as a BLOB table `documents(document_id, tenant_id, sha256, kind, bytes, created_at)`. The BLOB table keeps erasure transactional; prefer it.
- Link documents to applications (`cv_document_id`, `cover_letter_document_id`) in migration 10. Keep `cv_text` as the extracted text used for scoring.
- **Extraction leaf:** extract text from the CV PDF (`unpdf` or `pdfjs-dist`), then pass that text to the kernel exactly as the pasted CV text is passed today (`storedDocument` leaf). The Idris kernel does not change — this is the "swap the leaf" point from `docs/containers.md`. A PDF with no text layer is refused with a plain message ("We couldn't read text from this PDF…"); no OCR.
- Cover letter is stored and shown to recruiters, not scored.
- Serving: `GET /api/requisitions/:ref/applications/:id/cv` and `/cover-letter`, recruiter-only, `Content-Type: application/pdf`, `Content-Disposition: inline`, `X-Content-Type-Options: nosniff`, and a CSP that allows the PDF to render.
- **Erasure and retention must delete the documents** (and the trigger in `migrations.ts` must allow exactly that). Add documents to the "no identity survives erasure" hardening test.

### Web

- Application form step 04: "CV (PDF)" file picker (required) and "Cover letter (PDF, optional)"; show the file name and size; plain error messages for wrong type or size.
- Recruiter applicant panel: "View CV" and "View cover letter" buttons opening the PDF in a new tab; the extracted CV text stays visible below.

### Tests

- HTTP: upload success, non-PDF refused, oversized refused, text-less PDF refused, recruiter-only access, erasure deletes documents, retention deletes documents. Generate tiny test PDFs in the test (a minimal valid PDF with one text line).
- Playwright: apply with a PDF using `setInputFiles`, recruiter opens the CV.

### Docs

- `docs/slice-4.md` covering both parts; update `docs/containers.md` (the leaf now reads PDFs), `docs/testing.md`, README feature list.

## Order of work and PRs

1. PR "Slice 4a: real sign-in" — migration 9, sessions, login UI, test rework. CI green, then merge.
2. PR "Slice 4b: PDF CV and cover letter" — migration 10, uploads, extraction leaf, viewer, erasure. CI green, then merge.

## Working conventions for this project

- Branch per change, PR into `main`, wait for CI unless the user says otherwise, merge with a merge commit (not squash). Commit messages end with the Claude co-author line; PR bodies end with the Claude Code line.
- British English. Interface copy must be plain and direct: say what the person should do, never explain how the software works internally (the user's partner proofreads and flags jargon).
- Keep `.claude/` untracked (it is in `.gitignore`); the local preview uses `var/preview.sqlite` on port 3027.
- Verify UI changes in the browser pane and run `make test` and `npx playwright test` before every PR.
