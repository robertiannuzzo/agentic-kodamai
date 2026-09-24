module WorkflowMain

import Data.List
import Data.String
import Recruitment.Adapters.Cases
import System

%default total

data Command
  = CreateDraft Context Fields
  | UpdateDraft Nat Nat Context Fields
  | SubmitDraft Nat Nat Context
  | Review Nat Nat Context Decision
  | Resubmit Nat Nat Context Fields

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
command "create-draft" [actor, tick, role, department, count, budget, justification] = do
  c <- context actor tick
  f <- fields role department count budget justification
  Right (CreateDraft c f)
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

commands : Nat -> List String -> Either DomainError (List Command, List String)
commands Z rest = Right ([], rest)
commands (S count) (kind :: argc :: rest) = do
  size <- natural argc
  (args, tail) <- takeArgs size rest
  current <- command kind args
  (remaining, suffix) <- commands count tail
  Right (current :: remaining, suffix)
commands _ _ = Left InvalidEncoding

decodeCommands : String -> Either DomainError (List Command)
decodeCommands input = do
  if length (unpack input) > 1000000 then Left InvalidEncoding else Right ()
  values <- frames (length (unpack input)) (unpack input)
  case values of
    "recruitment-workflow-command-log-v1" :: count :: rest => do
      size <- natural count
      (result, suffix) <- commands size rest
      if null suffix then Right result else Left InvalidEncoding
    _ => Left InvalidEncoding

apply : Command -> CaseMemory -> Either DomainError (CaseRecord, CaseMemory)
apply (CreateDraft c f) state = createDraft caseRepository c f state
apply (UpdateDraft ref generation c f) state =
  updateDraft caseRepository ref generation c f state
apply (SubmitDraft ref generation c) state =
  submitDraft caseRepository ref generation c state
apply (Review ref generation c decision) state =
  review caseRepository ref generation c decision state
apply (Resubmit ref generation c f) state =
  resubmit caseRepository ref generation c f state

replay : List Command -> CaseMemory -> Either DomainError (Maybe CaseRecord, CaseMemory)
replay [] state = Right (Nothing, state)
replay (current :: remaining) state = do
  (row, updated) <- apply current state
  case remaining of
    [] => Right (Just row, updated)
    _ => replay remaining updated

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

success : Maybe CaseRecord -> CaseMemory -> String
success latest state = encodeFields
  ([ "recruitment-workflow-result-v1"
   , "ok"
   , maybe "" (show . reference) latest
   , show (length (caseRows state))
   ] ++ concatMap caseFields (caseRows state))

failure : DomainError -> String
failure err = encodeFields ["recruitment-workflow-result-v1", "error", show err]

run : String -> String
run input = case decodeCommands input of
  Left err => failure err
  Right values => case replay values emptyCases of
    Left err => failure err
    Right (latest, state) => success latest state

main : IO ()
main = do
  args <- getArgs
  case args of
    [_, input] => putStrLn (run input)
    _ => do
      putStrLn (failure InvalidEncoding)
      exitFailure
