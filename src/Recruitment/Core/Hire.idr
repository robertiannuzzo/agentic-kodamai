module Recruitment.Core.Hire

import public Recruitment.Core.Review

%default total

||| The new starter's own details, supplied by HR at the point of hire.
public export
record Starter where
  constructor MkStarter
  legalName : String
  startTick : Nat

||| An employee record. Its constructor is private: `hire` is the only way in,
||| so no employee exists without the application it came from.
export
data Employee : Type where
  Onboarded : (a : Advert) -> (app : Application a) -> Starter -> Evidence Hired -> Employee

||| Where a person came from: the exact advert and the application answering it.
public export
Provenance : Type
Provenance = (a : Advert ** Application a)

export
provenanceOf : Employee -> Provenance
provenanceOf (Onboarded a app _ _) = (a ** app)

export
starterOf : Employee -> Starter
starterOf (Onboarded _ _ starter _) = starter

export
hireEvidence : Employee -> Evidence Hired
hireEvidence (Onboarded _ _ _ ev) = ev

||| The missing morphism of the design note, section 4. The handler owes an
||| employee *and* a proof that the employee came from the scored application.
||| "Onboarding to follow" has no inhabitant of this type: there is no reply in
||| which the person does not exist or points at a different application.
||| Requiring `Shortlisted s` means only an application a person shortlisted,
||| after it was scored, can be hired.
export
hire : (a : Advert) -> (s : Score a) -> Shortlisted s -> Context -> Starter ->
       Either DomainError (e : Employee ** provenanceOf e = (a ** scoredApplication s))
hire a s _ c starter = do
  validContext c
  if nonBlank starter.legalName then Right () else Left (InvalidField "legal-name")
  let req = requisitionOf a
  let ev = MkEvidence c req.reference req.revision
             ("advert:" ++ show (advertId a) ++
              ";application:" ++ show (applicationId (scoredApplication s)))
  Right (Onboarded a (scoredApplication s) starter ev ** Refl)
