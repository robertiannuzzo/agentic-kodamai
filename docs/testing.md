# Verification

Run `make test` with the pinned compiler. The test runner rejects compiler-version drift, treats warnings as errors, uses isolated staged fixtures, checks subprocess exit codes, and imposes timeouts. It never counts a missing compiler, import failure, unsolved hole or unrelated error as a successful negative test.

## Compiler fixtures

`tests/compile-pass/KeepAdvert.idr` checks preservation and scoring against the same advert. The negative manifest requires error context plus diagnostic fragments, not just a nonzero exit status. Every `.idr` fixture must appear in the manifest. Full diagnostics are written to `build/verification/logs/`.

| Invalid fixture | Required refusal |
|---|---|
| `SwapQuestions` | Publish replacement questions under the old ID, then retain `Application old` as `Application edited` |
| `SwapScore` | Retain an old score under changed questions |
| `SwapWeights` | Retain an old score under changed skill weights |
| `SameLengthQuestions` | Relabel answers when the count and numeric ID agree but question text changes |
| `WrongSkill` | Relabel experience under a different skill |
| `NoApproval` | Publish using pending evidence |
| `ForgeApproval` | Call the private approval constructor |
| `ForgeScore` | Call the private score constructor |
| `MissingAudit` | Return unit where required submission evidence is owed |
| `WrongRevision` | Use approval indexed by a different requisition revision |
| `SwapStore` | Reuse a typed in-memory score repository under another advert |
| `WrongContainerReply` | Return a string for a prompt requiring a natural number |
| `BrokenSequence` | Feed a natural-number reply into a string prompt without a conversion |
| `BadAmalgamation` | Return a low-level Boolean where the high-level handler owes a natural number |
| `WrongAggregate` | Answer a review with the loaded aggregate instead of the next one for this reference and generation |
| `OnboardingToFollow` | Reply to a hire with a status change instead of an employee with provenance |
| `WrongProvenance` | Hire from one scored application while claiming another's provenance |
| `ReceiptForOtherAdvert` | Answer an intake with a receipt scored against a different advert |
| `WrongDocument` | An extraction leaf answering with text for a different CV version |
| `HireWithoutShortlist` | Hire one scored application using the shortlist decision made for another |

For example, the final line of `SwapQuestions` yields `Mismatch between: old and edited.` To make it compile, a developer would need to construct new dependent values or supply a valid equality proof; merely keeping the same numeric ID cannot do so.

## Runtime coverage

The 213 checks cover field validation, separation of duties, audit-trail replay (legal trails, self-approval, missing submission, wrong revision, wrong requisition, unsubmitted fields, empty trail), routing through the `transitionAgent` container, hire provenance, all human decision branches, hold/rework lineage, required evidence, unique reference allocation, stale writes, wrong-stage operations, one publication per case, schema errors, request/question/skill mismatches, extraction failures, persistence failures, retries and payload conflicts, exact CV version matching, golden score breakdowns, empty inputs, normalization, keyword repetition, capped experience, and codec round trips/rejections.

Of these, 101 generated cases sweep years 0 through 100 and check monotonicity, saturation, independence of scoring components, and serialization round trips. Separate golden cases exercise boundary totals. This provides reproducible bounded invariant coverage; it is **not** randomized property testing, shrinking, an exhaustive proof of arithmetic correctness, or a substitute for database concurrency tests. Phase 1 deliberately uses only bundled libraries rather than introducing a separately versioned property-testing package.

The demo smoke test compiles the executable, runs it, checks exit success and checks its total, audit payload and hire provenance line. Container-algebra checks exercise dependent replies, handler composition, identity/associativity examples, sequence continuations, sum routing, tensor, product, CV extraction, and successful/stopped five-link compositions.

## Formatting and linting

No third-party Idris formatter is pinned. The dependency-free hygiene check enforces spaces, no trailing whitespace, final newlines, totality defaults, forbidden unsafe escapes/holes, and pure-core import direction. Idris checks syntax, coverage, totality and warnings. Shell entrypoints are syntax-checked by the test runner.

## Observed results

On 2026-09-18, macOS with Idris `0.8.0-fd405085b` and Chez: all 195 runtime checks, one positive fixture, 14 negative fixtures, hygiene checks and executable smoke passed. The direct compiler path was used because the installed package-manager wrapper writes to its global cache.

On 2026-09-23, the Slice 1 integration suite additionally passed the requester-to-approver rework flow, role refusal, stale-generation refusal, Unicode and multiline protocol transport, invalid-field propagation, SQLite restart, and full command-log reconstruction through the Idris worker. The React production bundle and TypeScript API compiled successfully.

On 2026-09-23, Slice 1.1 replaced global command replay with checked single-aggregate transitions. Six HTTP integration tests pass the complete workflow, invalid-field propagation, equal-retry deduplication, conflicting key refusal, tenant/requester isolation, two-process duplicate delivery, durable restart, and in-place migration from the Slice 1 schema. The migration test also verifies ownership derivation and continued reference allocation.

On 2026-09-24, the core suite passed 213 runtime checks, one positive fixture and 17 negative fixtures. Ten HTTP integration tests passed, adding self-review refusal through the role switch and refusal of a directly tampered SQLite row whose forged `held` fact names the submitter as reviewer.

Hardening 3.1 (2026-09-24), after an external review: 24 HTTP tests add a check that no candidate identity survives erasure in any application or people response, an idempotent retry replayed under an exhausted rate limit, impossible calendar dates refused, and every provenance column tested against its trigger. A fourth browser journey delays one candidate's response and proves it cannot overwrite the next candidate's view; it fails when the stale-response guard is removed.

Slice 3 (2026-09-24): 239 runtime checks, 20 negative fixtures; 20 HTTP tests adding hires with provenance, filled requisitions, closed adverts, immutable people records and refusal after a stored shortlist is altered; the advert browser journey ends with a hire and its provenance.

Slice 2.1 (2026-09-24): 234 runtime checks, one positive fixture and 20 negative fixtures; 18 HTTP tests adding recorded decisions, refusal to review altered stored workings, withdrawal, recruiter erasure, erasure-only triggers, retention, idempotency expiry and rate limiting; three Playwright journeys using role, label and test-ID locators, with decisions and withdrawal in the advert journey.

Slice 2 (2026-09-24): 226 runtime checks, one positive fixture and 19 negative fixtures; 13 HTTP tests including publication, candidate-shaped adverts, consent, duplicate refusal, restart-then-apply, recruiter workings, database freeze triggers and refusal after a trigger is bypassed; three Playwright journeys including publish → apply → review.

The same day, two Playwright journeys passed against the production build in Chrome (`make e2e`).

On 2026-09-24 GitHub Actions ran end to end for Slice 1.1, 2 and 2.1: project-local compiler bootstrap from the pinned, checksummed archive on Ubuntu 24.04, `make test`, the production build and Playwright in Chromium on Node 24, all passing in 9–11 minutes. Local runs used the matching installed compiler on macOS with Node 22. There are no deployment-container checks.
