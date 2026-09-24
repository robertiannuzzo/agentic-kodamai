module Tests

import Recruitment.Example
import ContainerTests
import Recruitment.Adapters.Codec
import Recruitment.Adapters.Transition
import Data.List
import System

%default total

ok : Either DomainError Bool -> Bool
ok (Right True) = True
ok _ = False

fails : String -> Either DomainError a -> Bool
fails expected (Left err) = show err == expected
fails _ _ = False

context : Context
context = MkContext "tester" 10

||| Separation of duties: reviews come from a different actor than submissions.
reviewer : Context
reviewer = MkContext "reviewer" 11

extractor : Extractor
extractor = mockExtractor [(exampleCV, "Idris and SQL experience")]

withAdvert : ((a : Advert) -> Either DomainError Bool) -> Bool
withAdvert test = ok (exampleAdvert >>= test)

workflowTests : List (String, Bool)
workflowTests =
  [ ("reject empty role", fails "invalid-field:role" (newDraft (MkFields " " "D" 1 1 "J")))
  , ("reject empty department", fails "invalid-field:department" (newDraft (MkFields "R" "" 1 1 "J")))
  , ("reject zero headcount", fails "invalid-field:headcount" (newDraft (MkFields "R" "D" 0 1 "J")))
  , ("reject zero budget", fails "invalid-field:budget" (newDraft (MkFields "R" "D" 1 0 "J")))
  , ("reject empty justification", fails "invalid-field:justification" (newDraft (MkFields "R" "D" 1 1 "\n")))
  , ("minimum valid fields", ok (do _ <- newDraft (MkFields "R" "D" 1 1 "J"); Right True))
  , ("submission audit and reference", ok (do
       draft <- newDraft exampleFields
       (r ** pending) <- submit context 42 draft
       let ev = submissionEvidence pending
       Right (r.reference == 42 && r.revision == 0 && ev.reference == 42 &&
              ev.context.actor == "tester" && ev.context.tick == 10 && ev.detail == exampleFields.justification)))
  , ("zero reference refused", ok (do
       draft <- newDraft exampleFields
       Right (fails "invalid-reference" (submit context 0 draft))))
  , ("blank actor refused", fails "invalid-field:actor"
       (start caseRepository (MkContext " " 1) exampleFields emptyCases))
  , ("decline and hold need reasons", ok (do
       draft <- newDraft exampleFields
       (r ** pending) <- submit context 1 draft
       Right (fails "reason-required" (decide r pending reviewer (Decline " ")) &&
              fails "reason-required" (decide r pending reviewer (Hold "\n")))))
  , ("decline audit retained", ok (do
       (row, state) <- start caseRepository context exampleFields emptyCases
       (denied, _) <- review caseRepository row.reference 0 reviewer (Decline "No budget") state
       case denied.stage of
         Rejected r ev => Right (ev.detail == "No budget" && ev.reference == r.reference && length denied.history == 2)
         _ => Right False))
  , ("hold rework same reference new revision and audit", ok (do
       (row, state) <- start caseRepository context exampleFields emptyCases
       (held, state) <- review caseRepository row.reference 0 reviewer (Hold "Reduce budget") state
       (revised, state) <- resubmit caseRepository row.reference held.generation context
                            (MkFields "R" "D" 1 1 "Revised") state
       case revised.stage of
         AwaitingReview r pending => Right (r.reference == row.reference && r.revision == 1 &&
                                     revised.generation == 2 && length revised.history == 4 &&
                                     (submissionEvidence pending).revision == 1)
         _ => Right False))
  , ("stale decision rejected", ok (do
       (row, state) <- start caseRepository context exampleFields emptyCases
       (_, state) <- review caseRepository row.reference 0 reviewer Approve state
       Right (fails "stale-version" (review caseRepository row.reference 0 reviewer (Hold "Late") state))))
  , ("approved cannot be decided again", ok (do
       (row, state) <- start caseRepository context exampleFields emptyCases
       (approved, state) <- review caseRepository row.reference 0 reviewer Approve state
       Right (fails "wrong-stage" (review caseRepository row.reference approved.generation reviewer Approve state))))
  , ("advert before approval refused at use case", ok (do
       (row, state) <- start caseRepository context exampleFields emptyCases
       Right (fails "wrong-stage" (advertise caseRepository row.reference 0 context exampleQuestions exampleSkills state))))
  , ("unknown requisition", fails "not-found" (review caseRepository 99 0 reviewer Approve emptyCases))
  , ("reference allocation unique", ok (do
       (one, state) <- start caseRepository context exampleFields emptyCases
       (two, _) <- start caseRepository context exampleFields state
       Right (one.reference == 1 && two.reference == 2)))
  , ("CAS catches stale adapter write", ok (do
       (row, state) <- start caseRepository context exampleFields emptyCases
       (_, state) <- review caseRepository row.reference 0 reviewer Approve state
       Right (fails "stale-version" (caseRepository.commit (Just 0) row state))))
  ]

schemaTest : List Question -> List Skill -> String -> Bool
schemaTest questions skills expected = ok (do
  draft <- newDraft exampleFields
  (r ** pending) <- submit context 1 draft
  ruling <- decide r pending reviewer Approve
  case ruling of
    Granted approved => Right (fails expected (publish r approved context 1 questions skills))
    _ => Right False)

schemaTests : List (String, Bool)
schemaTests =
  [ ("empty questions", schemaTest [] exampleSkills "invalid-schema:empty")
  , ("empty skills", schemaTest exampleQuestions [] "invalid-schema:empty")
  , ("duplicate question IDs", schemaTest [MkQuestion 1 "A" "yes", MkQuestion 1 "B" "no"] exampleSkills "invalid-schema:duplicate-id")
  , ("duplicate skill IDs", schemaTest exampleQuestions [MkSkill 1 "a" 1 1, MkSkill 1 "b" 1 1] "invalid-schema:duplicate-id")
  , ("zero skill weight", schemaTest exampleQuestions [MkSkill 1 "a" 0 1] "invalid-schema:skill")
  , ("zero target years", schemaTest exampleQuestions [MkSkill 1 "a" 1 0] "invalid-schema:skill")
  , ("empty prompt", schemaTest [MkQuestion 1 " " "yes"] exampleSkills "invalid-schema:question")
  , ("empty expected answer", schemaTest [MkQuestion 1 "A" ""] exampleSkills "invalid-schema:question")
  , ("zero question ID", schemaTest [MkQuestion 0 "A" "yes"] exampleSkills "invalid-schema:question")
  , ("zero skill ID", schemaTest exampleQuestions [MkSkill 0 "a" 1 1] "invalid-schema:skill")
  ]

intakeTests : List (String, Bool)
intakeTests =
  [ ("worked score breakdown", withAdvert (\a => do
       (receipt, state) <- applyAndScore a memoryRepository extractor context exampleRaw empty
       Right (breakdown receipt.score == MkBreakdown 5 18 20 3 && totalScore receipt.score == 46 &&
              entryCount state == 1 && receipt.evidence.reference == (requisitionOf a).reference &&
              receipt.evidence.context.tick == 10)))
  , ("retry bypasses extraction and preserves original audit", withAdvert (\a => do
       (first, state) <- applyAndScore a memoryRepository extractor context exampleRaw empty
       (second, state) <- applyAndScore a memoryRepository failingExtractor (MkContext "retry" 99) exampleRaw state
       Right (breakdown first.score == breakdown second.score &&
              second.evidence.context.actor == "tester" && second.evidence.context.tick == 10 && entryCount state == 1)))
  , ("conflicting key rejected", withAdvert (\a => do
       (_, state) <- applyAndScore a memoryRepository extractor context exampleRaw empty
       let changed = MkRawApplication 1 exampleCV [(1, "no"), (2, "yes")] [(1, 4), (2, 8)]
       Right (fails "idempotency-key-conflict" (applyAndScore a memoryRepository extractor context changed state))))
  , ("changed CV version rejected on retry", withAdvert (\a => do
       (_, state) <- applyAndScore a memoryRepository extractor context exampleRaw empty
       let changed = MkRawApplication 1 (MkCVInput exampleCV.locator "v2") exampleRaw.answers exampleRaw.years
       Right (fails "idempotency-key-conflict" (applyAndScore a memoryRepository extractor context changed state))))
  , ("missing answer", withAdvert (\a => Right (fails "answers-do-not-match-questions"
       (readAnswers (questionsOf a) [(1, "yes")]))))
  , ("reordered answer IDs", withAdvert (\a => Right (fails "answers-do-not-match-questions"
       (readAnswers (questionsOf a) [(2, "yes"), (1, "yes")]))))
  , ("extra answer", withAdvert (\a => Right (fails "answers-do-not-match-questions"
       (readAnswers (questionsOf a) (exampleRaw.answers ++ [(3, "yes")])))))
  , ("duplicate answer ID", withAdvert (\a => Right (fails "answers-do-not-match-questions"
       (readAnswers (questionsOf a) [(1, "yes"), (1, "yes")]))))
  , ("wrong skill ID", withAdvert (\a => Right (fails "experience-does-not-match-skills"
       (readExperience (skillsOf a) [(2, 1), (1, 1)]))))
  , ("missing skill", withAdvert (\a => Right (fails "experience-does-not-match-skills"
       (readExperience (skillsOf a) [(1, 1)]))))
  , ("extraction failure", withAdvert (\a => Right (fails "cv-extraction-failed"
       (applyAndScore a memoryRepository failingExtractor context exampleRaw empty))))
  , ("storage failure", withAdvert (\a => Right (fails "persistence-failed"
       (applyAndScore a unavailableRepository extractor context exampleRaw empty))))
  , ("invalid CV reference", withAdvert (\a => Right (fails "invalid-cv-reference"
       (applyAndScore a memoryRepository failingExtractor context
         (MkRawApplication 1 (MkCVInput "" "v1") exampleRaw.answers exampleRaw.years) empty))))
  , ("invalid input checked before extraction", withAdvert (\a => Right (fails "answers-do-not-match-questions"
       (applyAndScore a memoryRepository failingExtractor context
         (MkRawApplication 1 exampleCV [] exampleRaw.years) empty))))
  , ("zero application ID", withAdvert (\a => Right (fails "invalid-reference"
       (applyAndScore a memoryRepository extractor context
         (MkRawApplication 0 exampleCV exampleRaw.answers exampleRaw.years) empty))))
  , ("empty CV and answers score zero", withAdvert (\a => do
       app <- receive a 1 exampleCV (Extracted "") [(1, ""), (2, " ")] [(1, 0), (2, 0)]
       Right (breakdown (compute a app) == MkBreakdown 0 0 0 0)))
  , ("case and whitespace normalization", withAdvert (\a => do
       app <- receive a 1 exampleCV (Extracted "IDRIS SQL") [(1, " YES "), (2, "Yes")] [(1, 4), (2, 8)]
       Right (breakdown (compute a app) == MkBreakdown 5 18 20 3)))
  , ("keyword repetition counted once", withAdvert (\a => do
       app <- receive a 1 exampleCV (Extracted "idris idris sql sql") exampleRaw.answers exampleRaw.years
       Right ((breakdown (compute a app)).keywords == 5)))
  ]

roundTrip : RawApplication -> Bool
roundTrip raw = case the (Either DomainError RawApplication) (encode raw >>= decode) of
  Right decoded => decoded == raw
  Left _ => False

codecTests : List (String, Bool)
codecTests =
  [ ("wire round trip", roundTrip exampleRaw)
  , ("wire Unicode delimiters newline round trip", roundTrip
       (MkRawApplication 7 (MkCVInput "mock://é:🍀,\n" "v:2,") [(2, "a,:\nbé🍀")] [(4, 0)]))
  , ("wire empty collections round trip", roundTrip (MkRawApplication 0 (MkCVInput "" "") [] []))
  , ("truncated wire rejected", fails "invalid-encoding" (decode "5:abc,"))
  , ("negative length rejected", fails "invalid-encoding" (decode "-1:a,"))
  , ("leading-zero length rejected", fails "invalid-encoding" (decode "01:a,"))
  , ("oversized declared length rejected", fails "invalid-encoding" (decode "100001:a,"))
  , ("unknown version rejected", fails "invalid-encoding" (decode "2:v2,"))
  , ("trailing data rejected", fails "invalid-encoding" (encode exampleRaw >>= (\text => decode (text ++ "1:x,"))))
  , ("malformed wire rejected", fails "invalid-encoding" (decode "garbage"))
  ]

additionalTests : List (String, Bool)
additionalTests =
  [ ("declined requisition cannot publish", ok (do
       (row, state) <- start caseRepository context exampleFields emptyCases
       (denied, state) <- review caseRepository row.reference 0 reviewer (Decline "No budget") state
       Right (fails "wrong-stage" (advertise caseRepository row.reference denied.generation
               context exampleQuestions exampleSkills state))))
  , ("rework only after hold", ok (do
       (row, state) <- start caseRepository context exampleFields emptyCases
       Right (fails "wrong-stage" (resubmit caseRepository row.reference 0 context exampleFields state))))
  , ("publish returns required approval and advert audit history", ok (do
       (row, state) <- start caseRepository context exampleFields emptyCases
       (approved, state) <- review caseRepository row.reference 0 reviewer Approve state
       (published, _) <- advertise caseRepository row.reference approved.generation context
                          exampleQuestions exampleSkills state
       case (approved.stage, published.stage) of
         (Accepted r approved, Advertising a) =>
           Right ((approvalEvidence approved).reference == row.reference &&
                  (advertEvidence a).reference == row.reference && length published.history == 3)
         _ => Right False))
  , ("same requisition cannot publish twice", ok (do
       (row, state) <- start caseRepository context exampleFields emptyCases
       (approved, state) <- review caseRepository row.reference 0 reviewer Approve state
       (published, state) <- advertise caseRepository row.reference approved.generation context
                              exampleQuestions exampleSkills state
       Right (fails "wrong-stage" (advertise caseRepository row.reference published.generation context
               exampleQuestions exampleSkills state))))
  , ("failed extraction can retry cleanly", withAdvert (\a => do
       let failed = applyAndScore a memoryRepository failingExtractor context exampleRaw empty
       (receipt, state) <- applyAndScore a memoryRepository extractor context exampleRaw empty
       Right (fails "cv-extraction-failed" failed && entryCount state == 1 && totalScore receipt.score == 46)))
  , ("distinct application IDs do not share receipts", withAdvert (\a => do
       (_, state) <- applyAndScore a memoryRepository extractor context exampleRaw empty
       let second = MkRawApplication 2 exampleCV [(1, "no"), (2, "no")] [(1, 0), (2, 0)]
       (receipt, state) <- applyAndScore a memoryRepository extractor context second state
       Right (entryCount state == 2 && totalScore receipt.score == 8 &&
              applicationId (scoredApplication receipt.score) == 2)))
  , ("extractor requires exact CV version", withAdvert (\a => Right (fails "cv-extraction-failed"
       (applyAndScore a memoryRepository extractor context
         (MkRawApplication 2 (MkCVInput exampleCV.locator "v2") exampleRaw.answers exampleRaw.years) empty))))
  , ("wire oversized integer refused by encoder", fails "invalid-encoding"
       (encode (MkRawApplication 100000000000000000000 exampleCV [] [])))
  ] ++ map (\(years, expected) =>
       ("experience golden boundary " ++ show years, withAdvert (\a => do
          app <- receive a 1 exampleCV (Extracted "") exampleRaw.answers [(1, years), (2, years)]
          Right ((breakdown (compute a app)).experience == expected))))
       [(0, 0), (1, 5), (3, 15), (4, 18), (5, 21), (6, 21), (100, 21)]

generatedTest : Nat -> (String, Bool)
generatedTest n = ("generated years/round-trip invariant " ++ show n, withAdvert (\a => do
  let raw = MkRawApplication (S n) exampleCV [(1, "yes"), (2, "no")] [(1, n), (2, n)]
  app <- receive a raw.identifier exampleCV (Extracted "Idris SQL") raw.answers raw.years
  more <- receive a raw.identifier exampleCV (Extracted "Idris SQL") raw.answers [(1, S n), (2, S n)]
  let b = breakdown (compute a app)
  let next = breakdown (compute a more)
  Right (b.experience <= 21 && next.experience >= b.experience &&
         (n < 5 || b.experience == next.experience) &&
         b.screening == next.screening && b.keywords == next.keywords &&
         b.completeness == 3 && roundTrip raw)))

submitted : Nat -> Fact
submitted rev = (Submitted ** MkEvidence context 1 rev exampleFields.justification)

approvedBy : Context -> Nat -> Fact
approvedBy c rev = (ApprovedEvent ** MkEvidence c 1 rev "approved")

isAccepted : Stage -> Bool
isAccepted (Accepted r _) = r.revision == 0
isAccepted _ = False

dutyAndReplayTests : List (String, Bool)
dutyAndReplayTests =
  [ ("submitter cannot rule on own submission", ok (do
       draft <- newDraft exampleFields
       (r ** pending) <- submit context 1 draft
       Right (fails "self-review-forbidden" (decide r pending context Approve) &&
              fails "self-review-forbidden" (decide r pending (MkContext " tester " 12) (Hold "x")))))
  , ("self review refused at use case", ok (do
       (row, state) <- start caseRepository context exampleFields emptyCases
       Right (fails "self-review-forbidden" (review caseRepository row.reference 0 context Approve state))))
  , ("replay rebuilds approved stage", ok (do
       (row, state) <- start caseRepository context exampleFields emptyCases
       (approved, _) <- review caseRepository row.reference 0 reviewer Approve state
       stage <- restoreStage row.reference exampleFields approved.history
       Right (isAccepted stage)))
  , ("replay rebuilds reworked revision", ok (do
       (row, state) <- start caseRepository context exampleFields emptyCases
       (held, state) <- review caseRepository row.reference 0 reviewer (Hold "Smaller") state
       let revisedFields = MkFields "R" "D" 1 1 "Revised"
       (revised, _) <- resubmit caseRepository row.reference held.generation context revisedFields state
       stage <- restoreStage row.reference revisedFields revised.history
       case stage of
         AwaitingReview r _ => Right (r.revision == 1)
         _ => Right False))
  , ("replay refuses self-approval history", fails "invalid-history"
       (restoreStage 1 exampleFields [submitted 0, approvedBy context 0]))
  , ("replay refuses approval without submission", fails "invalid-history"
       (restoreStage 1 exampleFields [(DraftCreated ** MkEvidence context 1 0 exampleFields.justification),
                                       approvedBy reviewer 0]))
  , ("replay refuses approval of another revision", fails "invalid-history"
       (restoreStage 1 exampleFields [submitted 0, approvedBy reviewer 1]))
  , ("replay refuses facts about another requisition", fails "invalid-history"
       (restoreStage 2 exampleFields [submitted 0, approvedBy reviewer 0]))
  , ("replay refuses fields that were never submitted", fails "invalid-history"
       (restoreStage 1 (MkFields "R" "D" 1 1 "Swapped") [submitted 0, approvedBy reviewer 0]))
  , ("replay refuses empty history", fails "invalid-history" (restoreStage 1 exampleFields []))
  , ("replay accepts legitimate approval", ok (do
       stage <- restoreStage 1 exampleFields [submitted 0, approvedBy reviewer 0]
       Right (isAccepted stage)))
  ]

transitionTests : List (String, Bool)
transitionTests =
  [ ("transition agent creates requested reference", ok (do
       created <- run transitionAgent (Nothing, CreateDraft 5 context exampleFields)
       Right (created.row.reference == 5 && created.row.generation == 0)))
  , ("transition agent refuses create over existing", ok (do
       created <- run transitionAgent (Nothing, CreateDraft 5 context exampleFields)
       Right (fails "stale-version" (run transitionAgent (Just created.row, CreateDraft 5 context exampleFields)))))
  , ("transition agent refuses missing aggregate", fails "not-found"
       (run transitionAgent (Nothing, Review 5 1 reviewer Approve)))
  , ("transition agent refuses mismatched path reference", ok (do
       created <- run transitionAgent (Nothing, CreateDraft 5 context exampleFields)
       Right (fails "not-found" (run transitionAgent (Just created.row, SubmitDraft 6 0 context)))))
  , ("transition agent routes submit then review", ok (do
       created <- run transitionAgent (Nothing, CreateDraft 5 context exampleFields)
       sent <- run transitionAgent (Just created.row, SubmitDraft 5 0 context)
       decided <- run transitionAgent (Just sent.row, Review 5 1 reviewer Approve)
       Right (decided.row.generation == 2 && isAccepted decided.row.stage &&
              fails "self-review-forbidden" (run transitionAgent (Just sent.row, Review 5 1 context Approve)))))
  ]

hireTests : List (String, Bool)
hireTests =
  [ ("hire returns employee with application provenance", withAdvert (\a => do
       (receipt, _) <- applyAndScore a memoryRepository extractor context exampleRaw empty
       (employee ** _) <- hire a receipt.score reviewer (MkStarter "Ada" 20)
       let (source ** app) = provenanceOf employee
       Right (applicationId app == 1 && advertId source == advertId a &&
              (hireEvidence employee).detail == "advert:1;application:1")))
  , ("hire requires a legal name", withAdvert (\a => do
       (receipt, _) <- applyAndScore a memoryRepository extractor context exampleRaw empty
       Right (fails "invalid-field:legal-name" (hire a receipt.score reviewer (MkStarter " " 20)))))
  ]

covering
main : IO ()
main = do
  let tests = containerTests ++ workflowTests ++ dutyAndReplayTests ++ transitionTests ++ hireTests ++ schemaTests ++ intakeTests ++ codecTests ++ additionalTests ++ map generatedTest [0..100]
  traverse_ (\(name, passed) => putStrLn ((if passed then "PASS " else "FAIL ") ++ name)) tests
  let failures = filter (\(_, passed) => not passed) tests
  putStrLn (show (length tests) ++ " checks, " ++ show (length failures) ++ " failures")
  if null failures then exitSuccess else exitFailure
