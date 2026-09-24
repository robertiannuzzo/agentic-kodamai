# ADR 008: Replay-checked reconstruction and separation of duties

Status: accepted.

## Context

ADR 007 exported `restorePending`, `restoreApproval`, and `restoreHeld`, which rebuilt a private witness from any evidence value naming the same reference and revision. Because `MkEvidence` is public, any module could write `restoreApproval r (MkEvidence intruder r.reference r.revision "fake")` and obtain `Approved r`. The `ForgeApproval` fixture only proved that the `Approval` constructor itself is private. At runtime the worker also trusted the stored stage label and the last audit row alone. Separately, roles came from a header, so one actor could raise and approve the same requisition.

## Decision

- Remove the `restore*` functions. Export one `Requisition.replay`, which walks the complete audit trail through the requisition state machine and rebuilds a witness only for a legal run: every fact targets the requisition and the correct revision, events occur in a permitted order, each ruling comes from an actor other than the submitter of that revision, and the current fields carry the submitted justification.
- `WorkflowMain` compares the stored stage label and revision with the replayed ones and refuses a mismatch as `InvalidHistory`.
- `decide` reads the submitter from `Pending r` and refuses a ruling by the same actor as `SelfReview`. The API maps it to `403 self-review-forbidden`.

## Consequences

- A forged witness now requires fabricating a whole, rule-abiding history with a distinct reviewer. That is exactly the ceiling stated in section 6 of the design note: types guarantee the wiring handled the facts correctly, not that the facts are true. Authenticity of actors and stored rows belongs to identity and the database.
- Replay is proportional to one aggregate's history, which ADR 007 already sends on every write.
- A tampered or corrupted row fails closed with a server error rather than being transitioned.
- Evidence construction remains public so adapters and tests can build facts; tightening that further would need signed evidence or an adapter-only module, which Idris module visibility cannot express directly.
