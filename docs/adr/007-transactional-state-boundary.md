# ADR 007: Transactional state with a single-aggregate Idris boundary

Status: accepted.

## Context

Slice 1 persisted unversioned commands and replayed the complete global log through a new Idris process before every mutation. This demonstrated durable reconstruction, but mutation cost grew with all system history and historical requests would be reinterpreted by future business rules. The transport also placed the complete log in one operating-system argument.

## Decision

Treat persisted requisition state as authoritative and retain audit entries as append-only business facts. On a protected write, load exactly one tenant-scoped aggregate, pass its snapshot and one command through the versioned Idris transition protocol, and atomically compare-and-swap the state while appending new evidence and the idempotent response.

Opaque workflow witnesses remain private. Export only checked reconstruction functions that require persisted evidence to target the same requisition reference and revision. Preserve old Slice 1 commands as `legacy_command_log`, but never execute them under newer rules.

Use ordered SQLite migrations, global monotonic reference allocation, tenant and requester columns, and `(tenant, actor, idempotency key)` uniqueness. Request fingerprints prevent one key from naming different operations or payloads.

## Consequences

- Mutation work is proportional to one aggregate rather than total application history.
- Business-rule changes do not reinterpret historical commands at startup.
- State, audit evidence, optimistic concurrency, and retry results share one transaction.
- The TypeScript/Idris seam remains a runtime trust boundary; protocol conformance is covered by integration tests rather than a cross-language compile-time proof.
- The worker still starts per mutation and serializes a complete aggregate history. Replace it with a persistent process and snapshot-plus-tail protocol if measurements show that aggregate size or process startup is material.
- SQLite remains a local adapter. PostgreSQL must add database-enforced tenant isolation and equivalent transaction semantics before hosted multi-instance deployment.

## Revisit

Reconsider selective event sourcing only for aggregates that need temporal reconstruction beyond the immutable audit record. Add an outbox in the first slice that performs email, job-board publication, calendar work, or another external side effect.
