module WorkflowMain

import Data.List
import Data.String
import Recruitment.Adapters.Transition
import System
import System.File

%default total

frame : String -> String
frame value = show (length (unpack value)) ++ ":" ++ value ++ ","

encodeFields : List String -> String
encodeFields = concat . map frame

natural : String -> Either DomainError Nat
natural value =
  if value == "" || length (unpack value) > 20 || not (all isDigit (unpack value))
    then Left InvalidEncoding
    else case the (Maybe Nat) (parsePositive value) of
      Nothing => Left InvalidEncoding
      Just number => if show number == value then Right number else Left InvalidEncoding

frames : Nat -> List Char -> Either DomainError (List String)
frames _ [] = Right []
frames Z _ = Left InvalidEncoding
frames (S fuel) chars = do
  let (digits, rest) = span isDigit chars
  size <- natural (pack digits)
  if size > 1000000 then Left InvalidEncoding else Right ()
  case rest of
    ':' :: body =>
      let (value, suffix) = splitAt size body in
      if length value /= size then Left InvalidEncoding else
        case suffix of
          ',' :: tail => do
            remaining <- frames fuel tail
            Right (pack value :: remaining)
          _ => Left InvalidEncoding
    _ => Left InvalidEncoding

takeArgs : Nat -> List String -> Either DomainError (List String, List String)
takeArgs count values =
  let selected = take count values
      remaining = drop count values in
  if length selected == count then Right (selected, remaining) else Left InvalidEncoding

context : String -> String -> Either DomainError Context
context actor tick = do
  time <- natural tick
  let result = MkContext actor time
  _ <- validContext result
  Right result

fields : String -> String -> String -> String -> String -> Either DomainError Fields
fields role department count budget justification = do
  headcount <- natural count
  budgetMinor <- natural budget
  let result = MkFields role department headcount budgetMinor justification
  _ <- newDraft result
  Right result

command : String -> List String -> Either DomainError Command
command "create-draft" [ref, actor, tick, role, department, count, budget, justification] = do
  reference <- natural ref
  if reference == 0 then Left InvalidReference else Right ()
  c <- context actor tick
  f <- fields role department count budget justification
  Right (CreateDraft reference c f)
command "update-draft" [ref, generation, actor, tick, role, department, count, budget,
                        justification] = do
  reference <- natural ref
  expected <- natural generation
  c <- context actor tick
  f <- fields role department count budget justification
  Right (UpdateDraft reference expected c f)
command "submit-draft" [ref, generation, actor, tick] = do
  reference <- natural ref
  expected <- natural generation
  c <- context actor tick
  Right (SubmitDraft reference expected c)
command "review" [ref, generation, actor, tick, ruling, reason] = do
  reference <- natural ref
  expected <- natural generation
  c <- context actor tick
  decision <- case ruling of
    "approve" => Right Approve
    "decline" => Right (Decline reason)
    "hold" => Right (Hold reason)
    _ => Left InvalidEncoding
  Right (Review reference expected c decision)
command "resubmit" [ref, generation, actor, tick, role, department, count, budget,
                    justification] = do
  reference <- natural ref
  expected <- natural generation
  c <- context actor tick
  f <- fields role department count budget justification
  Right (Resubmit reference expected c f)
command _ _ = Left InvalidEncoding

auditRow : List String -> Either DomainError (AuditRow, List String)
auditRow (name :: actor :: tick :: ref :: rev :: detail :: rest) = do
  c <- context actor tick
  reference <- natural ref
  revision <- natural rev
  row <- case name of
    "draft-created" => Right (DraftCreated ** MkEvidence c reference revision detail)
    "draft-updated" => Right (DraftUpdated ** MkEvidence c reference revision detail)
    "submitted" => Right (Submitted ** MkEvidence c reference revision detail)
    "approved" => Right (ApprovedEvent ** MkEvidence c reference revision detail)
    "declined" => Right (DeclinedEvent ** MkEvidence c reference revision detail)
    "held" => Right (HeldEvent ** MkEvidence c reference revision detail)
    "revised" => Right (Revised ** MkEvidence c reference revision detail)
    "advert-created" => Right (AdvertCreated ** MkEvidence c reference revision detail)
    "application-scored" => Right (ApplicationScored ** MkEvidence c reference revision detail)
    _ => Left InvalidEncoding
  Right (row, rest)
auditRow _ = Left InvalidEncoding

auditRows : Nat -> List String -> Either DomainError (List AuditRow, List String)
auditRows Z rest = Right ([], rest)
auditRows (S count) values = do
  (row, rest) <- auditRow values
  (rows, suffix) <- auditRows count rest
  Right (row :: rows, suffix)

validReferences : Nat -> List AuditRow -> Bool
validReferences _ [] = True
validReferences ref ((_ ** evidence) :: rest) =
  evidence.reference == ref && validReferences ref rest

record StageView where
  constructor MkStageView
  name : String
  revision : Nat
  fields : Fields

stageView : Stage -> StageView
stageView (Drafting values) = MkStageView "draft" 0 values
stageView (AwaitingReview req _) = MkStageView "awaiting-review" req.revision req.fields
stageView (Accepted req _) = MkStageView "approved" req.revision req.fields
stageView (NeedsRework req _) = MkStageView "needs-rework" req.revision req.fields
stageView (Rejected req _) = MkStageView "declined" req.revision req.fields
stageView (Advertising advert) =
  let req = requisitionOf advert in MkStageView "advertising" req.revision req.fields

caseRecord : List String -> Either DomainError (CaseRecord, List String)
caseRecord (ref :: generation :: stageName :: revision :: role :: department :: count :: budget ::
            justification :: auditCount :: rest) = do
  reference <- natural ref
  if reference == 0 then Left InvalidReference else Right ()
  currentGeneration <- natural generation
  currentRevision <- natural revision
  values <- fields role department count budget justification
  historyCount <- natural auditCount
  (history, suffix) <- auditRows historyCount rest
  if validReferences reference history then Right () else Left InvalidEncoding
  -- The stored stage label and revision are only claims; replay decides.
  currentStage <- restoreStage reference values history
  let view = stageView currentStage
  if view.name == stageName && view.revision == currentRevision
    then Right (MkCaseRecord reference currentGeneration currentStage history, suffix)
    else Left InvalidHistory
caseRecord _ = Left InvalidEncoding

current : String -> List String -> Either DomainError (Maybe CaseRecord, List String)
current "none" rest = Right (Nothing, rest)
current "some" values = do
  (row, rest) <- caseRecord values
  Right (Just row, rest)
current _ _ = Left InvalidEncoding

decodeTransition : String -> Either DomainError (Maybe CaseRecord, Command)
decodeTransition input = do
  if length (unpack input) > 8000000 then Left InvalidEncoding else Right ()
  values <- frames (length (unpack input)) (unpack input)
  case values of
    "recruitment-workflow-transition-v2" :: presence :: rest => do
      (stored, commandValues) <- current presence rest
      case commandValues of
        kind :: argc :: args => do
          size <- natural argc
          (selected, suffix) <- takeArgs size args
          if null suffix then Right () else Left InvalidEncoding
          proposed <- command kind selected
          Right (stored, proposed)
        _ => Left InvalidEncoding
    _ => Left InvalidEncoding

evidenceFields : AuditRow -> List String
evidenceFields (event ** value) =
  [ show event
  , value.context.actor
  , show value.context.tick
  , show value.reference
  , show value.revision
  , value.detail
  ]

caseFields : CaseRecord -> List String
caseFields row =
  let view = stageView row.stage in
  [ show row.reference
  , show row.generation
  , view.name
  , show view.revision
  , view.fields.role
  , view.fields.department
  , show view.fields.headcount
  , show view.fields.budgetMinor
  , view.fields.justification
  , show (length row.history)
  ] ++ concatMap evidenceFields row.history

success : CaseRecord -> String
success row = encodeFields (["recruitment-workflow-transition-result-v2", "ok"] ++ caseFields row)

failure : DomainError -> String
failure err = encodeFields ["recruitment-workflow-transition-result-v2", "error", show err]

respond : String -> String
respond input = case decodeTransition input of
  Left err => failure err
  Right (stored, proposed) => case run transitionAgent (stored, proposed) of
    Left err => failure err
    Right next => success next.row

covering
main : IO ()
main = do
  args <- getArgs
  case args of
    [_, inputPath] => do
      result <- readFile inputPath
      case result of
        Left _ => do
          putStrLn (failure InvalidEncoding)
          exitFailure
        Right input => putStrLn (respond input)
    _ => do
      putStrLn (failure InvalidEncoding)
      exitFailure
