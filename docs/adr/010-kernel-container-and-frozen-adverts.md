# ADR 010: One kernel container, intake as a composed chain, frozen adverts

Status: accepted.

## Context

Slice 2 adds publication, applications and scoring to the web path. The papers' claim is that interfaces, delegation and workflows *are* containers, handlers and their combinators, and that a model belongs at a leaf. Slice 1 used containers for requisition transitions only, and adverts could not yet be persisted: the only way to obtain an `Advert` is `publish` with `Approved r`.

## Decision

- The Idris executable runs exactly one agent, `kernelAgent : Agent ExtractionC -> Agent KernelC`, where `KernelC = Sum TransitionC IntakeC`. Each process call is one prompt of that sum.
- Publishing is a sixth branch of the transition sum (`PublishC`), using the existing `advertise` use case.
- Intake is `intakeHandler : Handler IntakeC IntakeChain` composed with an agent for `validate ◁ (stop ∨ (extract ◁ (stop ∨ application ◁ (stop ∨ score))))`. It reuses the spine's `ApplicationTail`, `applicationAgent` and `scoreAgent` instead of a second hand-written pipeline.
- The composition root supplies the extraction leaf per call. For pasted CV text it is `storedDocument locator version text`.
- A published advert is persisted as its ordered schema. It is reconstructed only by replaying the requisition to `Approved r` and re-running `publish` with the stored schema and the stored publication context; the result must reproduce the stored `AdvertCreated` fact exactly. Publication evidence includes a content fingerprint of the schema.
- SQLite triggers make advert schemas and applications write-once. Candidate responses are shaped for candidates: no expected answers, weights or scores.

## Consequences

- The live application path and the five-link demonstration share agents and combinators, so a change to scoring or application construction reaches both.
- Swapping the extractor for a model is a local change at the composition root; `WrongDocument` fixes the leaf's contract.
- A changed stored schema is refused by the database, and if forced past it, by replay. A forger must still fabricate a consistent history and schema, which is the ceiling stated in ADR 008.
- Scores are stored receipts, not recomputed on read. A new policy needs a version and a migration policy.
- Each kernel call still starts a process and sends one aggregate. ADR 007's revisit trigger (measured startup or aggregate size) is unchanged.
