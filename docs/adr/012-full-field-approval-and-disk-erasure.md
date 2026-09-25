# ADR 012: Full-field approval snapshots, older records, and erasure on disk

Status: accepted.

## Context

A review after Slice 4 found six problems. Two need a recorded decision because they change stored data or its compatibility:

- Replay checked that the current requisition matched what was submitted by comparing the justification only. A row whose title, department, headcount or budget was changed in the database after approval still published and took applications. The public API offers no such edit, but the guarantee in `architecture.md` claimed more than the check did.
- Erasure cleared or deleted personal data logically, but SQLite left the old bytes in free pages and the write-ahead log. A withdrawn candidate's CV text could be read from the database file.

The other four were bugs with no design choice: a truncated upload crashed the API process, an idempotency key reused for a different requisition replayed the first requisition's reply, the Submit button sent a draft's saved values while newer edits sat unsaved on screen, and the applicant panel did not move keyboard focus.

## Decision

- Submission evidence (and draft evidence) records `requisition-fields-v1:` followed by each of the five fields, length-prefixed with Unicode character counts. Replay refuses a trail whose last submission does not match the current fields exactly.
- Submission evidence recorded before this change (the justification alone) is still accepted, checked on the justification. Existing requisitions, adverts and applicants keep working after an upgrade. Nothing is backfilled: writing a snapshot from today's values would certify values that were never approved. A saved or resubmitted older draft records the full snapshot from then on.
- SQLite runs with `secure_delete = ON` and `journal_mode = DELETE` (a rollback journal, not WAL). A database from an earlier release is rebuilt once with `VACUUM`; `PRAGMA user_version = 1` records that only after it succeeds.
- The idempotency fingerprint for requisition commands includes the target reference. The worker is unchanged.

## Consequences

- An older submission's title, department, headcount and budget are not bound by its approval. Rewriting a new-format record back to the old format would also fall back to the weaker check. The snapshot is a consistency check against the stored facts, not protection against someone who can rewrite all of them; that remains the database's and identity's job (ADR 008).
- Retries of requisition commands made just before the upgrade, with keys recorded under the old fingerprint, are refused as `idempotency-key-conflict` rather than replayed. That affects at most the 24-hour idempotency window, and fails safe.
- Without WAL, readers and a writer no longer run concurrently. This suits one local instance. The one-time `VACUUM` rewrites the whole file and needs exclusive access, so it runs before the server accepts requests.
- Erasure removes data from the database's own files only. Filesystem snapshots, unreused disk blocks, backups and downloaded CVs are outside it; `architecture.md` states the backup policy for this demo.
