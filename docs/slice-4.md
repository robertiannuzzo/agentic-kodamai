# Slice 4: PDF CV upload and an optional cover letter

Until now a candidate pasted the text of their CV. Slice 4 asks for the CV as a PDF, which is how people actually hold one, and adds an optional plain-text cover letter. The recruitment spine, the Idris kernel and the scoring policy do not change. This follows [the revised plan](plan-slice-4-revised.md), which leaves sign-in to a later slice: the demo role switch is still the only identity mechanism.

## Swapping the leaf

The papers put the model, or any other untrusted reader of documents, at a leaf of the container composition. The intake chain already takes its extraction leaf as a parameter:

```idris
IntakeChain = Seq ValidateC (Sum StopC (Seq ExtractionC (Sum StopC ApplicationTail)))
```

and the composition root answers `ExtractionC` with `storedDocument locator version text`, which replies only for that exact document. Slice 4 changes what produces `text`, not how it reaches the kernel:

| | Before | Slice 4 |
|---|---|---|
| Source | Pasted text | Uploaded PDF |
| `text` | The pasted text | Text read from the PDF by `apps/api/src/cv.ts` |
| `version` | SHA-256 of the text | SHA-256 of the PDF bytes |
| `locator` | `cv://tenant/reference/application` | Unchanged |

PDF parsing (`unpdf`, a packaging of Mozilla's pdf.js) runs in the API process on untrusted bytes. Its output is only ever a string handed to the kernel as the stored document's text, so a hostile or odd PDF can at worst produce odd text. It cannot reach scoring except through the same typed path pasted text took. The Ada journey still scores 46 / 49.

## Accepting a CV

`POST /api/adverts/:ref/applications` is now `multipart/form-data` with two parts:

- `cv`: exactly one PDF, at most 5 MB;
- `application`: JSON with `candidateName`, `acknowledgedPrivacyNotice`, `answers`, `years` and an optional `coverLetterText`.

`busboy` parses the upload as it streams in. The 5 MB limit is enforced while reading, and a body whose declared length is already too large is refused before any of it is read. The file is checked by content (it must start with the `%PDF-` signature), not by its name or the browser's MIME type. Text is read before an application number is allocated. Whitespace is normalised, and a PDF with no letters or digits in it is refused, because there is no OCR. So is a PDF of more than 20 pages, or one whose text exceeds the old 50,000-character limit.

| Refusal | Status | Code | Candidate sees |
|---|---|---|---|
| No file | 400 | `cv-required` | Upload your CV as a PDF. |
| Two files | 400 | `too-many-cvs` | Upload one CV only. |
| Not a PDF | 400 | `cv-not-pdf` | Upload your CV as a PDF. |
| Over 5 MB | 413 | `cv-too-large` | Your CV must be 5 MB or smaller. |
| Corrupt | 400 | `cv-unreadable` | We couldn’t read text from this PDF. Please upload a text-based PDF. |
| No text (scanned) | 400 | `cv-no-text` | As above |
| Over 20 pages | 400 | `cv-too-many-pages` | Your CV must be 20 pages or fewer. |
| Cover letter over 5,000 characters | 400 | `cover-letter-too-long` | Keep your cover letter to 5,000 characters or fewer. |

The browser checks type, size and cover-letter length before sending, but the server is the boundary. Errors about the file or cover letter are shown beside those fields.

The idempotency fingerprint covers the `application` JSON and the SHA-256 of the file. A retry with the same key and the same file replays the stored acknowledgement. A retry with the same key and a different file is refused as `idempotency-key-conflict`.

## Storage

Migration 9 adds a private `documents` table (`document_id`, `tenant_id`, `sha256`, `media_type`, `bytes`, `created_at`). The PDF is a BLOB in SQLite rather than a file on disk, so storing and erasing it happen in the same transaction as the application. Identical files from different tenants, or from different candidates, are separate rows: there is no deduplication. Nothing is written to the web root.

`applications` gains `cv_document_id` (unique, referencing `documents`) and `cover_letter_text`. `commitApplication` inserts the document and the application in one transaction, after the kernel has scored the application. A refused upload, a kernel refusal or a replay therefore leaves no document behind.

The immutability triggers carry over:

- `documents_immutable_update`: a stored PDF's bytes never change.
- `applications_erasure_only` now also requires erasure to set `cv_document_id` and `cover_letter_text` to `NULL`, and still forbids any other edit.
- The foreign key refuses to delete a document while an application points at it, so a CV can only be deleted by erasing its application first.

Withdrawal, a recruiter's erasure and the retention sweep all go through `eraseRow`. It clears the cover letter, unlinks the document and deletes its bytes, alongside the existing name, email, CV text and answers. Score and evidence are untouched.

## Reading an application

`ApplicationRecord` gains `coverLetterText: string | null` and `hasCvDocument: boolean`. `cvText` stays: it is the text that was scored, kept for replay.

`GET /api/requisitions/:ref/applications/:id/cv` returns the original PDF to a recruiter in the same tenant. Other roles get `403`; another tenant, an unknown application or an erased one gets `404`. The response is `application/pdf`, `Content-Disposition: inline; filename="cv-<ref>-<id>.pdf"`, `nosniff`, `no-store`, and `Content-Security-Policy: default-src 'none'; sandbox`.

The demo identity travels in request headers, which a plain link cannot send. "View CV" therefore opens a tab, fetches the PDF with the recruiter's headers and shows it from memory. If pop-ups are blocked, the file is downloaded instead. With real sign-in (a session cookie), this becomes an ordinary link.

## Interface

Step 04 of the application form asks for "CV (PDF)" with the help text "PDF only, 5 MB maximum.", shows the chosen file's name and size, and has an optional "Cover letter (optional)" box with a `0 / 5,000` counter. The recruiter's panel has "View CV" beside the CV text, and a "Cover letter" section that says "No cover letter provided." when there is none. After erasure neither appears.

## Limits

- PDF parsing happens inside the API process with no time limit. The page cap, the size cap and the application rate limit (5 per candidate, 30 per address, per 10 minutes) bound the work, but a hosted release should parse in a worker with a timeout.
- A CV opened with "View CV" is named after the browser's in-memory address, not `cv-<ref>-<id>.pdf`, if the recruiter saves it from the viewer.
- Applications made before Slice 4 have pasted text and no document; they show no "View CV".
- Scanned CVs are refused rather than read with OCR.

## Acceptance coverage

- HTTP (`apps/api/src/slice4.test.ts`): upload, extraction and the unchanged score; the stored PDF returned byte for byte with its headers; role and tenant refusals; every refusal above, with no document left behind and no application number used; a kernel refusal, a replay and a changed-file conflict under one key; cover-letter trimming, limits, Unicode length and no effect on score; withdrawal, erasure and retention deleting the PDF and cover letter while keeping score and evidence; the new triggers.
- Browser: the advert journey uploads PDFs, adds Ada's cover letter, checks the recruiter sees it and that "View CV" fetches the PDF and opens a tab, and that erasure removes both. Whether that tab displays the PDF depends on the browser having a viewer: Chrome does, CI's Chromium does not, so it was checked by hand in Chrome. `cv-upload.spec.ts` checks the messages for a wrong type, an oversized file, a textless PDF and an over-long cover letter, then submits successfully.
