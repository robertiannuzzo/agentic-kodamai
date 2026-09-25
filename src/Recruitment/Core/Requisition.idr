module Recruitment.Core.Requisition

import public Recruitment.Core.Common
import Data.String

%default total

public export
record Fields where
  constructor MkFields
  role : String
  department : String
  headcount : Nat
  budgetMinor : Nat
  justification : String

||| Complete, unambiguous snapshot. Lengths count Unicode characters, as on
||| the worker boundary. A justification alone cannot bind an approval.
public export
fieldsSnapshot : Fields -> String
fieldsSnapshot f = "requisition-fields-v1:" ++ concat (map framed
  [f.role, f.department, show f.headcount, show f.budgetMinor, f.justification])
  where
    framed : String -> String
    framed value = show (length (unpack value)) ++ ":" ++ value ++ ","

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
    Right (MkReq ref rev f ** Awaiting (MkEvidence c ref rev (fieldsSnapshot f)))

export
submissionEvidence : Pending r -> Evidence Submitted
submissionEvidence (Awaiting ev) = ev

export
approvalEvidence : Approved r -> Evidence ApprovedEvent
approvalEvidence (Approval ev) = ev

export
holdEvidence : Held r -> Evidence HeldEvent
holdEvidence (Rework ev) = ev

||| Separation of duties: whoever submitted this revision may not rule on it.
||| The submitter is read from the `Pending r` evidence, so the check cannot be skipped.
sameActor : Context -> Evidence event -> Bool
sameActor c ev = trim c.actor == trim ev.context.actor

export
decide : (r : Req) -> Pending r -> Context -> Decision -> Either DomainError (Ruling r)
decide r (Awaiting submitted) c decision = do
  validContext c
  if sameActor c submitted then Left SelfReview else Right ()
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

||| One audit fact about a requisition, tagged with its event kind.
public export
Fact : Type
Fact = (event : Event ** Evidence event)

||| What a complete audit trail establishes about one requisition.
public export
data Replayed : Type where
  InDraft : Fields -> Replayed
  InReview : (r : Req) -> Pending r -> Replayed
  InRework : (r : Req) -> Held r -> Replayed
  IsApproved : (r : Req) -> Approved r -> Replayed
  IsDeclined : (r : Req) -> Evidence DeclinedEvent -> Replayed

data Phase
  = Empty
  | Editing String
  | Reviewing Nat (Evidence Submitted)
  | Reworking Nat (Evidence Submitted) (Evidence HeldEvent)
  | Revising Nat
  | Granting Nat (Evidence Submitted) (Evidence ApprovedEvent)
  | Refusing Nat (Evidence Submitted) (Evidence DeclinedEvent)

at : Nat -> Nat -> Evidence event -> Either DomainError ()
at ref rev ev =
  if ev.reference == ref && ev.revision == rev then Right () else Left InvalidHistory

reviewedBy : Evidence Submitted -> Evidence event -> Either DomainError ()
reviewedBy submitted ev =
  if sameActor ev.context submitted then Left InvalidHistory else Right ()

step : Nat -> Phase -> Fact -> Either DomainError Phase
step ref Empty (DraftCreated ** ev) = do at ref 0 ev; Right (Editing ev.detail)
step ref Empty (Submitted ** ev) = do at ref 0 ev; Right (Reviewing 0 ev)
step ref (Editing _) (DraftUpdated ** ev) = do at ref 0 ev; Right (Editing ev.detail)
step ref (Editing _) (Submitted ** ev) = do at ref 0 ev; Right (Reviewing 0 ev)
step ref (Reviewing rev s) (ApprovedEvent ** ev) = do
  at ref rev ev; reviewedBy s ev; Right (Granting rev s ev)
step ref (Reviewing rev s) (DeclinedEvent ** ev) = do
  at ref rev ev; reviewedBy s ev; Right (Refusing rev s ev)
step ref (Reviewing rev s) (HeldEvent ** ev) = do
  at ref rev ev; reviewedBy s ev; Right (Reworking rev s ev)
step ref (Reworking rev _ _) (Revised ** ev) = do at ref (S rev) ev; Right (Revising (S rev))
step ref (Revising rev) (Submitted ** ev) = do at ref rev ev; Right (Reviewing rev ev)
step _ _ _ = Left InvalidHistory

walk : Nat -> Phase -> List Fact -> Either DomainError Phase
walk _ phase [] = Right phase
walk ref phase (fact :: rest) = do
  next <- step ref phase fact
  walk ref next rest

||| Submissions since the full-field snapshot bind all five fields. Earlier
||| submissions recorded only the justification; they are still accepted, with
||| that weaker check, so existing requisitions and their applicants keep working.
submittedAs : Fields -> Evidence Submitted -> Either DomainError ()
submittedAs f s =
  let bound = if isPrefixOf "requisition-fields-v1:" s.detail
                then s.detail == fieldsSnapshot f
                else s.detail == f.justification
  in if bound then Right () else Left InvalidHistory

||| Checked reconstruction for persistence boundaries. Witnesses are rebuilt only
||| when the whole trail is a run of the transitions above: every fact targets this
||| reference and the correct revision, events occur in a legal order, no reviewer
||| ruled on their own submission, and the current fields are the ones submitted.
||| Authenticity of the stored facts themselves remains an external responsibility.
export
replay : (ref : Nat) -> Fields -> List Fact -> Either DomainError Replayed
replay ref f history = do
  if ref == 0 then Left InvalidReference else Right ()
  phase <- walk ref Empty history
  case phase of
    Editing justification =>
      -- Drafts saved before the snapshot recorded only the justification.
      -- Saving or submitting one records the full snapshot from then on.
      if justification == fieldsSnapshot f || justification == f.justification
        then Right (InDraft f) else Left InvalidHistory
    Reviewing rev s => do
      submittedAs f s; Right (InReview (MkReq ref rev f) (Awaiting s))
    Reworking rev s held => do
      submittedAs f s; Right (InRework (MkReq ref rev f) (Rework held))
    Granting rev s approval => do
      submittedAs f s; Right (IsApproved (MkReq ref rev f) (Approval approval))
    Refusing rev s declined => do
      submittedAs f s; Right (IsDeclined (MkReq ref rev f) declined)
    _ => Left InvalidHistory
