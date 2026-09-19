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

For example, the final line of `SwapQuestions` yields `Mismatch between: old and edited.` To make it compile, a developer would need to construct new dependent values or supply a valid equality proof; merely keeping the same numeric ID cannot do so.

## Runtime coverage

The 195 checks cover field validation, all human decision branches, hold/rework lineage, required evidence, unique reference allocation, stale writes, wrong-stage operations, one publication per case, schema errors, request/question/skill mismatches, extraction failures, persistence failures, retries and payload conflicts, exact CV version matching, golden score breakdowns, empty inputs, normalization, keyword repetition, capped experience, and codec round trips/rejections.

Of these, 101 generated cases sweep years 0 through 100 and check monotonicity, saturation, independence of scoring components, and serialization round trips. Separate golden cases exercise boundary totals. This provides reproducible bounded invariant coverage; it is **not** randomized property testing, shrinking, an exhaustive proof of arithmetic correctness, or a substitute for database concurrency tests. Phase 1 deliberately uses only bundled libraries rather than introducing a separately versioned property-testing package.

The demo smoke test compiles the executable, runs it, checks exit success and checks its total and audit payload. Container-algebra checks exercise dependent replies, handler composition, identity/associativity examples, sequence continuations, sum routing, tensor, product, CV extraction, and successful/stopped five-link compositions.

## Formatting and linting

No third-party Idris formatter is pinned. The dependency-free hygiene check enforces spaces, no trailing whitespace, final newlines, totality defaults, forbidden unsafe escapes/holes, and pure-core import direction. Idris checks syntax, coverage, totality and warnings. Shell entrypoints are syntax-checked by the test runner.

## Observed results

On 2026-09-18, macOS with Idris `0.8.0-fd405085b` and Chez: all 195 runtime checks, one positive fixture, 14 negative fixtures, hygiene checks and executable smoke passed. The direct compiler path was used because the installed package-manager wrapper writes to its global cache.

The project-local compiler bootstrap and GitHub Actions run have not been executed end-to-end here. The pinned source archive checksum was verified; local tests used the matching installed compiler. There are no deployment-container checks.
