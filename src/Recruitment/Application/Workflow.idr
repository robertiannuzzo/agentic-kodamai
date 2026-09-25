module Recruitment.Application.Workflow

import public Recruitment.Core.Advert

%default total

public export
data Stage : Type where
  Drafting : Fields -> Stage
  AwaitingReview : (r : Req) -> Pending r -> Stage
  Accepted : (r : Req) -> Approved r -> Stage
  NeedsRework : (r : Req) -> Held r -> Stage
  Rejected : (r : Req) -> Evidence DeclinedEvent -> Stage
  Advertising : Advert -> Stage

public export
AuditRow : Type
AuditRow = Fact

public export
record CaseRecord where
  constructor MkCaseRecord
  reference : Nat
  generation : Nat
  stage : Stage
  history : List AuditRow

||| The persisted schema of a published advert, as stored by an adapter.
public export
record StoredAdvert where
  constructor MkStoredAdvert
  questions : List Question
  skills : List Skill

splitLast : List a -> Maybe (List a, a)
splitLast [] = Nothing
splitLast (x :: xs) = case splitLast xs of
  Nothing => Just ([], x)
  Just (front, final) => Just (x :: front, final)

stageOf : Replayed -> Stage
stageOf (InDraft values) = Drafting values
stageOf (InReview r pending) = AwaitingReview r pending
stageOf (InRework r held) = NeedsRework r held
stageOf (IsApproved r approval) = Accepted r approval
stageOf (IsDeclined r declined) = Rejected r declined

sameFact : Evidence event -> Evidence event -> Bool
sameFact x y = x.reference == y.reference && x.revision == y.revision &&
               x.detail == y.detail && x.context.actor == y.context.actor &&
               x.context.tick == y.context.tick

||| Rebuild a persisted stage only by replaying its complete audit trail.
||| A published advert is rebuilt the only way an advert can exist: the trail
||| before publication must replay to `Approved r`, and `publish` is re-run on
||| the stored schema. The result must reproduce the stored publication fact,
||| whose detail fingerprints the exact questions and skills.
export
restoreStage : (ref : Nat) -> Fields -> Maybe StoredAdvert -> List AuditRow ->
               Either DomainError Stage
restoreStage ref f Nothing history = map stageOf (replay ref f history)
restoreStage ref f (Just stored) history = case splitLast history of
  Just (front, (AdvertCreated ** fact)) => do
    replayed <- replay ref f front
    case replayed of
      IsApproved r approval => do
        advert <- publish r approval fact.context ref stored.questions stored.skills
        if sameFact (advertEvidence advert) fact
          then Right (Advertising advert)
          else Left InvalidHistory
      _ => Left InvalidHistory
  _ => Left InvalidHistory

||| commit compares the expected generation and persists the complete aggregate,
||| including its audit trail. Nothing means insert, Just n means compare-and-swap.
public export
record CaseRepository (state : Type) where
  constructor MkCaseRepository
  nextReference : state -> Nat
  load : Nat -> state -> Either DomainError CaseRecord
  commit : Maybe Nat -> CaseRecord -> state -> Either DomainError state

export
start : CaseRepository state -> Context -> Fields -> state ->
        Either DomainError (CaseRecord, state)
start repo c fields state = do
  draft <- newDraft fields
  (r ** pending) <- submit c (repo.nextReference state) draft
  let row = MkCaseRecord r.reference 0 (AwaitingReview r pending)
              [(Submitted ** submissionEvidence pending)]
  updated <- repo.commit Nothing row state
  Right (row, updated)

||| Allocate a stable reference while keeping the requisition editable and unsubmitted.
export
createDraft : CaseRepository state -> Context -> Fields -> state ->
              Either DomainError (CaseRecord, state)
createDraft repo c fields state = do
  _ <- validContext c
  _ <- newDraft fields
  let ref = repo.nextReference state
  if ref == 0 then Left InvalidReference else do
    let evidence = MkEvidence c ref 0 (fieldsSnapshot fields)
    let row = MkCaseRecord ref 0 (Drafting fields)
                [(DraftCreated ** evidence)]
    updated <- repo.commit Nothing row state
    Right (row, updated)

loadCurrent : CaseRepository state -> Nat -> Nat -> state -> Either DomainError CaseRecord
loadCurrent repo ref expected state = do
  row <- repo.load ref state
  if row.generation == expected then Right row else Left StaleVersion

saveNext : CaseRepository state -> CaseRecord -> Stage -> List AuditRow -> state ->
           Either DomainError (CaseRecord, state)
saveNext repo old stage evidence state = do
  let row = MkCaseRecord old.reference (S old.generation) stage (old.history ++ evidence)
  updated <- repo.commit (Just old.generation) row state
  Right (row, updated)

||| Draft edits advance the aggregate generation without creating a requisition revision.
export
updateDraft : CaseRepository state -> Nat -> Nat -> Context -> Fields -> state ->
              Either DomainError (CaseRecord, state)
updateDraft repo ref expected c fields state = do
  row <- loadCurrent repo ref expected state
  _ <- validContext c
  _ <- newDraft fields
  case row.stage of
    Drafting _ => saveNext repo row (Drafting fields)
      [(DraftUpdated ** MkEvidence c ref 0 (fieldsSnapshot fields))] state
    _ => Left WrongStage

||| Submission freezes the current draft as revision zero and sends it to review.
export
submitDraft : CaseRepository state -> Nat -> Nat -> Context -> state ->
              Either DomainError (CaseRecord, state)
submitDraft repo ref expected c state = do
  row <- loadCurrent repo ref expected state
  case row.stage of
    Drafting fields => do
      draft <- newDraft fields
      (r ** pending) <- submit c ref draft
      saveNext repo row (AwaitingReview r pending)
        [(Submitted ** submissionEvidence pending)] state
    _ => Left WrongStage

export
review : CaseRepository state -> Nat -> Nat -> Context -> Decision -> state ->
         Either DomainError (CaseRecord, state)
review repo ref expected c decision state = do
  row <- loadCurrent repo ref expected state
  case row.stage of
    AwaitingReview r pending => do
      ruling <- decide r pending c decision
      case ruling of
        Granted approval => saveNext repo row (Accepted r approval)
                            [(ApprovedEvent ** approvalEvidence approval)] state
        Denied ev => saveNext repo row (Rejected r ev) [(DeclinedEvent ** ev)] state
        Deferred held => saveNext repo row (NeedsRework r held)
                           [(HeldEvent ** holdEvidence held)] state
    _ => Left WrongStage

||| Rework is a revision of the same reference; it returns to review.
export
resubmit : CaseRepository state -> Nat -> Nat -> Context -> Fields -> state ->
           Either DomainError (CaseRecord, state)
resubmit repo ref expected c fields state = do
  row <- loadCurrent repo ref expected state
  case row.stage of
    NeedsRework r held => do
      (draft, revised) <- revise r held c fields
      (newReq ** pending) <- submit c ref draft
      saveNext repo row (AwaitingReview newReq pending)
        [(Revised ** revised), (Submitted ** submissionEvidence pending)] state
    _ => Left WrongStage

||| One advert per requisition in phase 1; its ID is the requisition reference.
export
advertise : CaseRepository state -> Nat -> Nat -> Context -> List Question -> List Skill ->
            state -> Either DomainError (CaseRecord, state)
advertise repo ref expected c questions skills state = do
  row <- loadCurrent repo ref expected state
  case row.stage of
    Accepted r approval => do
      advert <- publish r approval c ref questions skills
      saveNext repo row (Advertising advert)
        [(AdvertCreated ** advertEvidence advert)] state
    _ => Left WrongStage
