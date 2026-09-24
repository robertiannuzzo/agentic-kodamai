# Slice 2: advert, application, score

## User outcome

A recruiter picks an approved requisition from a "Ready to advertise" queue and publishes an advert with screening questions, expected answers and weighted skills. The advert is frozen at publication. Candidates see open roles, answer the questions, give years per skill, paste a CV and consent. Each application is validated, has its CV text read through the extraction leaf, is built as an `Application a` for the exact advert, and is scored with its workings. The recruiter sees applications ranked with a breakdown, answers against expected answers, experience against targets, the CV text and the scoring evidence. Candidates are told only that their application was received.

## The kernel is one container

Every call to the Idris executable is one prompt of one container:

```idris
KernelC = Sum TransitionC IntakeC
kernelAgent leaf = sumAgent transitionAgent (intakeAgent leaf)
```

`TransitionC` is the requisition write path from Slice 1, now with a sixth branch, `PublishC`. `IntakeC` is new:

```idris
IntakeC     = MkCont (a : Advert ** Intake) (\(a ** _) => Either DomainError (Receipt a))
IntakeChain = Seq ValidateC (Sum StopC (Seq ExtractionC (Sum StopC ApplicationTail)))
```

`ApplicationTail` is the spine's own `Seq ApplicationC (Sum StopC ScoreC)`, and `intakeChainAgent` reuses the spine's `applicationAgent` and `scoreAgent`. The live application endpoint therefore runs the same agents as the five-link demonstration, composed by the same combinators. `intakeHandler` delegates by building the chained prompt, whose continuations route any failure to the stop branch. Its amalgamation reads `Receipt a` back out of the dependent chain reply, and the type checker confirms it is the receipt for the advert that was asked about. `ReceiptForOtherAdvert.idr` shows the alternative does not compile.

The extraction leaf is supplied by the composition root. In this slice the API stores the pasted CV text immutably, addressed by `cv://tenant/reference/application` and a SHA-256 version, and `storedDocument` answers only for that exact locator and version. Replacing it with a model-backed or PDF extractor is a change to one leaf. `WrongDocument.idr` shows a leaf cannot answer with text for a different document.

## Frozen adverts, three ways

| Layer | What refuses a changed schema |
|---|---|
| Types | `Application a` and `Score a` are indexed by the advert value; `SwapQuestions.idr` and friends do not compile |
| Database | Triggers on `advert_questions` and `advert_skills` abort any `UPDATE` or `DELETE` (`advert-frozen`) |
| Replay | Publication evidence carries a fingerprint of the ordered questions and skills. On every kernel call the advert is rebuilt only by replaying the requisition to `Approved r` and re-running `publish` on the stored schema; a changed schema no longer reproduces the stored evidence and fails as `invalid-history` |

The fingerprint is FNV-1a over a canonical encoding. It detects change; it does not authenticate. Authenticity of stored facts remains the stated ceiling (ADR 008).

## Protocol v3

`recruitment-kernel-v3` frames a `transition` or an `intake`. Case records carry their frozen schema after the audit trail. A `transition` answers `case` with the next aggregate; an `intake` answers `receipt` with the application ID, the four score components, the total, the policy version and the scoring evidence. The executable decodes into one of the two branches and runs `kernelAgent` for both.

## Endpoints

| Method and path | Role | Result |
|---|---|---|
| `POST /api/requisitions/:ref/advert` | recruiter | Publish; question and skill IDs follow their order |
| `GET /api/adverts` | any | Candidate-shaped open adverts: no expected answers, weights, budget or justification |
| `POST /api/adverts/:ref/applications` | candidate | Intake through the kernel, then a write-once commit; answers only `{ status: "received" }` |
| `GET /api/requisitions/:ref/applications` | recruiter | Applications with answers, experience, CV text, breakdown, policy and evidence |

Candidates cannot list requisitions. Applications require consent, are idempotent by key, and a candidate can apply once per advert (`409 already-applied`). Applications and their answers are immutable in the database.

## Scope held back

- No application withdrawal, notes, dispositions, interview stages or closing an advert.
- CV text is pasted; file upload, malware scanning and a model-backed extractor are later slices.
- The candidate identity is a demo email, like the staff role switch.
- Scores are recomputed by nobody after storage: stored receipts are the record, and a new scoring policy would need a new version and migration policy.

## Acceptance coverage

- Idris: advert restored by replay and re-publication; publication evidence fingerprints the schema; changed stored question or weight refused; stored schema without publication refused; publication without approval refused; publish routed through `transitionAgent`, and refused before approval; intake chain golden score 46; kernel routes intake; validation precedes the leaf; the leaf answers only for its document version; blank applicant refused.
- HTTP: publish permissions and freezing, candidate-shaped adverts, consent, idempotent retry, duplicate refusal, mismatched answers, restart then apply (replay of the advertising stage), recruiter ranking and workings, database triggers, and refusal after a trigger is dropped and a question changed.
- Browser: requester → approver → recruiter publishes via the form → two candidates apply → the candidate view hides weights → a returning candidate sees "received" → recruiter sees 46/49 and 20/49 with workings → reload.
