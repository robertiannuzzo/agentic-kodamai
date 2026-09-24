# Slice 3: the hire, with provenance

The design note's one structural gap in Marie-Claude is that hiring a candidate does not create an employee: "Requisition marked fulfilled, onboarding to follow." Its section 4 asks for a response type in which that sentence cannot be written. Slice 3 puts that type on the live path.

## The kernel's fourth branch

```idris
KernelC   = Sum TransitionC (Sum IntakeC (Sum AssessC HireKC))
HireKC    = MkCont (a : Advert ** Hiring)
              (\(a ** _) => Either DomainError
                 (s : Score a ** (e : Employee ** provenanceOf e = (a ** scoredApplication s))))
HireChain = Seq AssessC (Sum StopC HireC)
```

A hire trusts nothing stored. `hireHandler` delegates to the assess branch, which re-derives the score through the intake chain. It then re-makes the recorded decision with the recorded reviewer and time, and continues only if that reproduces the stored shortlist evidence exactly. That yields `Shortlisted s` for the re-derived score, which the spine's existing `hireAgent` consumes. The reply is an employee plus a proof, checked by the compiler, that it came from that application. A rejected application stops as `not-shortlisted`; a stored decision or score that no longer reproduces stops as `invalid-history`.

`OnboardingToFollow.idr`, `WrongProvenance.idr` and `HireWithoutShortlist.idr` show the three ways to get this wrong do not compile.

## People records

Migration 6 adds `employees`: one row per hire, unique per application, pointing at `(reference, application_id)`. Triggers forbid deleting a people record or changing its provenance. `GET /api/people` returns each person with their provenance: score and policy, the shortlist evidence and the hire evidence. That is the design note's "show me this person's CV and interview notes two years later", subject to the retention rules of Slice 2.1.

## Filling the requisition

A requisition is filled when its hires reach its headcount. Further hires are refused (`requisition-filled`), the advert disappears from new candidates' open roles, and new applications are refused (`advert-closed`). Existing applicants still see the role so they can withdraw. The UI shows the stage as "Filled".

The filled state is derived from the people records rather than being a new typed requisition stage. Making it a typed `Fulfilled` stage with its own replay is a small follow-up; it was left out to keep the hire itself, the design note's point, in focus.

## Endpoints

| Method and path | Role | Result |
|---|---|---|
| `POST /api/requisitions/:ref/applications/:id/hire` | recruiter | `{ legalName, startDate }` → `201` people record; idempotent |
| `GET /api/people` | staff | People records with provenance |

## Acceptance coverage

- Idris: the kernel hire re-makes the shortlist and returns provenance; refuses a rejected application, a shortlist for other workings, altered stored workings, and a blank legal name.
- HTTP: permissions, date validation, not-shortlisted, idempotent retry, requisition filled, advert closed to new candidates, people listing, immutable provenance, refusal after a stored shortlist is altered.
- Browser: the advert journey ends by hiring Ada, the requisition showing "Filled", the provenance chain in the people panel, and a new candidate no longer seeing the role.
