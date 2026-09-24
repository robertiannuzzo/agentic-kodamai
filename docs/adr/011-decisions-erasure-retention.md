# ADR 011: Typed human decisions, erasure over reproducibility, retention

Status: accepted.

## Context

A review of Slice 2 against UK data protection practice found three gaps: "a person decides" was a sentence rather than a record; applications were immutable with deletes blocked, so erasure and retention were impossible; and the application form asked for consent, which is rarely the right lawful basis in recruitment.

## Decision

- Add `Core.Review`: a `ReviewOutcome s` indexed by the score, with a private `Shortlisted s`. `hire` requires `Shortlisted s`.
- Add a third kernel branch, `AssessC`, implemented by a handler into `Seq IntakeC (Sum StopC VerdictC)`. Reviews re-derive the score through the intake chain and refuse if it differs from what was stored.
- Keep free-text reasons and notes out of evidence; store them in erasable columns.
- Replace blanket immutability with erasure-only triggers: personal fields may be cleared exactly once; scores and evidence may never change.
- Anonymise applications after a configurable retention period; prune idempotency records after 24 hours; erase a candidate's idempotency records with their application.
- Record acknowledgement of a privacy notice instead of consent.

## Consequences

- Hiring now carries two typed facts: a person's shortlist decision and the application's provenance.
- An erased application's score cannot be re-derived or reviewed. That is the intended priority.
- Evidence details contain identifiers and totals, never free text, so they survive erasure without holding personal data.
- Maintenance runs in-process; a multi-instance deployment should move it to a single scheduled job and move rate-limit state to shared storage.
