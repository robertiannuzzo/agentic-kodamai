# ADR 009: Web stack and Slice 1 platform scope

Status: accepted.

## Context

The delivery plan puts a platform foundation (PostgreSQL, authentication, users and roles, an outbox, a JSON process boundary) before the first vertical slice, then the requisition-and-approval slice itself. Slice 1.1 is a take-home demonstration run on one machine, so each foundation item was either built, deferred with a stated trigger, or replaced by something smaller that keeps the same seam.

## Decision

Use a modular monolith: React and Vite for the UI, a dependency-light Node HTTP server in TypeScript, the compiled Idris workflow executable as the only writer of workflow state, and SQLite through `node:sqlite`. Playwright drives end-to-end journeys against the production build.

| Plan item | Slice 1.1 | Why, and what changes it |
|---|---|---|
| PostgreSQL | SQLite with the same transaction contract (ADR 007) | One-machine demo, no service to install. Switch before multi-instance hosting; add row-level tenant isolation then |
| Authentication, users | Demo actor/role/tenant headers | No identity provider without asking first. Replace with session or SSO claims; the API reads identity in exactly one function |
| Roles and authorization | Requester/approver checks in the API; ownership and tenant scoping; separation of duties in Idris | Complete for this slice |
| Transactional outbox | Not built | No external side effects exist yet. Add in the first slice that sends email or posts to job boards |
| JSON over stdin/stdout | Versioned, length-prefixed frames through a private temp file | Idris base has no JSON library; frames are total to parse in Idris and have no escaping rules. The protocol is versioned, so it can change later |
| Repository layout `services/`, `database/` | `apps/api`, migrations in code | Renaming directories adds nothing to the slice; revisit when a second service or a worker exists |
| Structured logs, configuration | JSON request logs with request IDs; environment variables | Enough for local operation; add metrics and tracing with hosting |

## Consequences

- Slice 1's user-facing scope is complete: draft, edit, submit, approve/decline/request changes with reasons, revise and resubmit, an approver inbox, a detail view with revision and audit timeline, stale-update handling, role permissions, restart recovery, and end-to-end browser tests.
- The deferred items are platform work, not domain work. None of them changes the Idris kernel or the transition protocol's meaning.
