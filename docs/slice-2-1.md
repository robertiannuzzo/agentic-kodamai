# Slice 2.1: human decisions, erasure and privacy

Slice 2.1 answers the review of Slice 2: the system claimed "a person decides" without recording any decision, and candidate data could never be erased.

## Human review is a typed link

```idris
data Disposition = Shortlist | Reject String

data Shortlisted : Score a -> Type        -- private constructor
data ReviewOutcome : Score a -> Type where
  Advanced    : Shortlisted s -> ReviewOutcome s
  NotAdvanced : Evidence ApplicationReviewed -> ReviewOutcome s

reviewApplication : (a : Advert) -> (s : Score a) -> Context -> Disposition
                 -> Either DomainError (ReviewOutcome s)

hire : (a : Advert) -> (s : Score a) -> Shortlisted s -> Context -> Starter -> ...
```

A decision is indexed by the exact score it was made about. `hire` now requires `Shortlisted s`, so only an application a person shortlisted can be hired; `HireWithoutShortlist.idr` shows a shortlist for another application does not typecheck. Rejections need a reason. Free-text reasons and notes stay out of the evidence so they remain erasable.

## The kernel's third branch

```idris
KernelC     = Sum TransitionC (Sum IntakeC AssessC)
AssessC     = MkCont (a : Advert ** Assessment) (\(a ** _) => Either DomainError (s : Score a ** ReviewOutcome s))
AssessChain = Seq IntakeC (Sum StopC VerdictC)
```

A review does not trust the stored score. `assessHandler` runs the stored inputs back through the *same* intake chain, with the original scoring context, and continues to the verdict link only if the re-derived breakdown and evidence equal what was stored. A changed policy or altered stored workings stops the review (`invalid-history`) instead of recording a decision about numbers the current rules cannot produce.

## Erasure and retention

| Mechanism | What happens |
|---|---|
| Candidate withdrawal | `DELETE /api/adverts/:ref/applications/mine` erases the candidate's own application; they may apply again |
| Recruiter erasure | `POST /api/requisitions/:ref/applications/:id/erase` with a reason, for requests received elsewhere |
| Retention | Applications are anonymised after `APPLICATION_RETENTION_DAYS` (default 180) by maintenance at startup and hourly |

Erasure clears the name, candidate email, CV text and hash, free-text answers, review reason and note, and the candidate's idempotency records (their key is the email). The scoring evidence names the candidate as its actor, so that is replaced with the same `erased:` pseudonym (fixed in 3.1; an external review found it surviving erasure). Erasure also forgets any recruiter's cached review or hire response for that application, since those carry the email, reason and note; migration 8 repairs applications erased before these fixes and drops their cached responses (3.2).

**Documented exception.** A hired candidate's people record is an employment record, kept under the contract of employment rather than the recruitment notice. Withdrawing or erasing the application removes the application's personal data; the people record keeps the legal name, and its provenance points at the anonymised application. The privacy notice says so. The score, the scoring evidence and the review evidence remain, anonymised. The database permits exactly this: `applications_erasure_only` and matching triggers compare every other column and reject any other update, and deletes remain blocked. People records accept no updates at all.

The trade-off is deliberate and one-way: after erasure a stored score can no longer be re-derived, so an erased application cannot be reviewed (`409 application-erased`). Erasure beats reproducibility.

## Privacy notice rather than consent

Recruitment processing usually rests on taking steps at the candidate's request before a contract, not consent. The form now shows what happens to the application, how long it is kept and how to withdraw, and records `notice_acknowledged_at` (`acknowledgedPrivacyNotice` in the API). The retention period shown comes from the server.

## Operational fixes

- Idempotency records expire after 24 hours (Stripe's window), pruned by the same maintenance.
- `POST /api/adverts/:ref/applications` is limited per candidate (5) and per client address (30) per 10 minutes, answering `429 rate-limited` with `Retry-After`. The limit is checked inside the serialised write section, after the idempotency lookup, so a retry or a concurrent duplicate replays the stored result instead of being refused; a refused request therefore waits its turn before the 429.
- Node 24.15+ is the target runtime (`.nvmrc`, `engines`, CI), where `node:sqlite` is a release candidate.
- Browser tests use roles, labels and test IDs instead of CSS classes.

## Still outside this slice

A data protection impact assessment, subject-access export, bias monitoring of score distributions, and hosted-scale concerns (shared rate-limit state, PostgreSQL) are documented rather than built.
