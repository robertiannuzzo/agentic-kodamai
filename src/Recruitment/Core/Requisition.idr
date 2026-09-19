module Recruitment.Core.Requisition

import public Recruitment.Core.Common

%default total

public export
record Fields where
  constructor MkFields
  role : String
  department : String
  headcount : Nat
  budgetMinor : Nat
  justification : String

public export
record Req where
  constructor MkReq
  reference : Nat
  revision : Nat
  fields : Fields

export
data Draft = NewDraft Fields | RevisedDraft Nat Nat Fields

export
data Pending : Req -> Type where
  Awaiting : Evidence Submitted -> Pending r

export
data Approved : Req -> Type where
  Approval : Evidence ApprovedEvent -> Approved r

export
data Held : Req -> Type where
  Rework : Evidence HeldEvent -> Held r

public export
data Decision = Approve | Decline String | Hold String

public export
data Ruling : Req -> Type where
  Granted : Approved r -> Ruling r
  Denied : Evidence DeclinedEvent -> Ruling r
  Deferred : Held r -> Ruling r

validateFields : Fields -> Either DomainError ()
validateFields f =
  if not (nonBlank f.role) then Left (InvalidField "role")
  else if not (nonBlank f.department) then Left (InvalidField "department")
  else if f.headcount == 0 then Left (InvalidField "headcount")
  else if f.budgetMinor == 0 then Left (InvalidField "budget")
  else if not (nonBlank f.justification) then Left (InvalidField "justification")
  else Right ()

export
newDraft : Fields -> Either DomainError Draft
newDraft f = do validateFields f; Right (NewDraft f)

||| The application boundary allocates the fresh reference. Rework ignores it.
export
submit : Context -> Nat -> Draft -> Either DomainError (r : Req ** Pending r)
submit c fresh draft = do
  validContext c
  let info : (Nat, Nat, Fields) = case draft of
        NewDraft f => (fresh, 0, f)
        RevisedDraft ref rev f => (ref, rev, f)
  let (ref, rev, f) = info
  if ref == 0 then Left InvalidReference else
    Right (MkReq ref rev f ** Awaiting (MkEvidence c ref rev f.justification))

export
submissionEvidence : Pending r -> Evidence Submitted
submissionEvidence (Awaiting ev) = ev

export
approvalEvidence : Approved r -> Evidence ApprovedEvent
approvalEvidence (Approval ev) = ev

export
holdEvidence : Held r -> Evidence HeldEvent
holdEvidence (Rework ev) = ev

export
decide : (r : Req) -> Pending r -> Context -> Decision -> Either DomainError (Ruling r)
decide r _ c decision = do
  validContext c
  case decision of
    Approve => Right (Granted (Approval (MkEvidence c r.reference r.revision "approved")))
    Decline why => if nonBlank why
      then Right (Denied (MkEvidence c r.reference r.revision why))
      else Left InvalidReason
    Hold why => if nonBlank why
      then Right (Deferred (Rework (MkEvidence c r.reference r.revision why)))
      else Left InvalidReason

export
revise : (r : Req) -> Held r -> Context -> Fields ->
         Either DomainError (Draft, Evidence Revised)
revise r held c f = do
  validContext c
  validateFields f
  Right (RevisedDraft r.reference (S r.revision) f,
         MkEvidence c r.reference (S r.revision) (holdEvidence held).detail)
