module Recruitment.Adapters.Kernel

import public Recruitment.Adapters.Transition
import public Recruitment.Application.Spine

%default total

||| A candidate's application to one advert, as received by the API.
public export
record Intake where
  constructor MkIntake
  applicant : Context
  raw : RawApplication

||| The reply depends on the advert in the prompt: a receipt for *that* advert.
public export
IntakeC : Cont
IntakeC = MkCont (a : Advert ** Intake) (\(a ** _) => Either DomainError (Receipt a))

||| Structural checks run before the (potentially expensive) extraction leaf.
public export
ValidateC : Cont
ValidateC = MkCont (a : Advert ** Intake) (\_ => Either DomainError ())

||| Extraction, then the spine's own application-and-score tail.
public export
ExtractTail : Cont
ExtractTail = Seq ExtractionC (Sum StopC ApplicationTail)

||| validate ◁ (stop ∨ (extract ◁ (stop ∨ (application ◁ (stop ∨ score)))))
public export
IntakeChain : Cont
IntakeChain = Seq ValidateC (Sum StopC ExtractTail)

validateIntake : (a : Advert) -> Intake -> Either DomainError ()
validateIntake a i = do
  validContext i.applicant
  if i.raw.identifier == 0 then Left InvalidReference else Right ()
  if nonBlank i.raw.cv.locator && nonBlank i.raw.cv.version then Right () else Left InvalidCV
  _ <- readAnswers (questionsOf a) i.raw.answers
  _ <- readExperience (skillsOf a) i.raw.years
  Right ()

public export
validateAgent : Agent ValidateC
validateAgent = answers (\(a ** i) => validateIntake a i)

scorePrompt : (a : Advert) -> Context -> Either DomainError (Application a) ->
              Prompt (Sum StopC ScoreC)
scorePrompt a c (Left err) = Left (Failed err)
scorePrompt a c (Right app) = Right (a ** (app, c))

afterExtraction : (a : Advert) -> (i : Intake) -> Either DomainError (CVText i.raw.cv) ->
                  Prompt (Sum StopC ApplicationTail)
afterExtraction a i (Left err) = Left (Failed err)
afterExtraction a i (Right text) =
  Right (MkApplicationPrompt a i.raw.identifier i.raw.cv text i.raw.answers i.raw.years **
         scorePrompt a i.applicant)

afterValidation : (a : Advert) -> (i : Intake) -> Either DomainError () ->
                  Prompt (Sum StopC ExtractTail)
afterValidation a i (Left err) = Left (Failed err)
afterValidation a i (Right ()) = Right (i.raw.cv ** afterExtraction a i)

||| Delegation builds the chained prompt; each continuation picks the next link
||| from the previous reply, routing any failure to the stop branch.
intakePrompt : Prompt IntakeC -> Prompt IntakeChain
intakePrompt (a ** i) = ((a ** i) ** afterValidation a i)

||| Amalgamation reads the receipt back out of the dependent chain reply. Its
||| type is checked against `Receipt a` for the advert that was asked about.
intakeReply : (p : Prompt IntakeC) -> Reply IntakeChain (intakePrompt p) -> Reply IntakeC p
intakeReply (a ** i) (Left err ** _) = Left err
intakeReply (a ** i) (Right () ** (Left err ** _)) = Left err
intakeReply (a ** i) (Right () ** (Right _ ** (Left err ** _))) = Left err
intakeReply (a ** i) (Right () ** (Right _ ** (Right _ ** receipt))) = receipt

public export
intakeHandler : Handler IntakeC IntakeChain
intakeHandler = MkHandler intakePrompt intakeReply

||| The chain is interpreted by the same combinators that built it, reusing the
||| spine's application and score agents. Only the extraction leaf is supplied.
public export
intakeChainAgent : Agent ExtractionC -> Agent IntakeChain
intakeChainAgent leaf = seqAgent validateAgent (sumAgent stopAgent
  (seqAgent leaf (sumAgent stopAgent
    (seqAgent applicationAgent (sumAgent stopAgent scoreAgent)))))

public export
intakeAgent : Agent ExtractionC -> Agent IntakeC
intakeAgent leaf = compose intakeHandler (intakeChainAgent leaf)

||| What the adapter persisted when the application was scored.
public export
record StoredReceipt where
  constructor MkStoredReceipt
  breakdown : Breakdown
  evidence : Evidence ApplicationScored

||| A person's decision on one stored application. `intake` carries the stored
||| inputs and the original scoring context, so re-scoring reproduces them.
public export
record Assessment where
  constructor MkAssessment
  intake : Intake
  stored : StoredReceipt
  reviewer : Context
  disposition : Disposition

||| The reply carries the re-derived score and a decision indexed by it.
public export
AssessC : Cont
AssessC = MkCont (a : Advert ** Assessment)
  (\(a ** _) => Either DomainError (s : Score a ** ReviewOutcome s))

||| The decision link: stored workings must equal the re-derived ones.
public export
VerdictC : Cont
VerdictC = MkCont (a : Advert ** (s : Score a ** (StoredReceipt, Context, Disposition)))
  (\(a ** (s ** _)) => Either DomainError (ReviewOutcome s))

||| re-score ◁ (stop ∨ verdict): the intake chain again, then the person.
public export
AssessChain : Cont
AssessChain = Seq IntakeC (Sum StopC VerdictC)

sameReceipt : StoredReceipt -> Receipt a -> Bool
sameReceipt stored receipt =
  stored.breakdown == breakdown receipt.score &&
  stored.evidence.detail == receipt.evidence.detail &&
  stored.evidence.reference == receipt.evidence.reference &&
  stored.evidence.revision == receipt.evidence.revision

||| A stored score that the current policy cannot reproduce is not reviewed:
||| the policy changed or the stored workings were altered.
public export
verdictAgent : Agent VerdictC
verdictAgent = answers (\(a ** (s ** (stored, reviewer, disposition))) =>
  if stored.breakdown == breakdown s
    then reviewApplication a s reviewer disposition
    else Left InvalidHistory)

afterRescore : (a : Advert) -> Assessment -> Either DomainError (Receipt a) ->
               Prompt (Sum StopC VerdictC)
afterRescore a request (Left err) = Left (Failed err)
afterRescore a request (Right receipt) =
  if sameReceipt request.stored receipt
    then Right (a ** (receipt.score ** (request.stored, request.reviewer, request.disposition)))
    else Left (Failed InvalidHistory)

assessPrompt : Prompt AssessC -> Prompt AssessChain
assessPrompt (a ** request) = ((a ** request.intake) ** afterRescore a request)

assessReply : (p : Prompt AssessC) -> Reply AssessChain (assessPrompt p) -> Reply AssessC p
assessReply (a ** request) (Left err ** _) = Left err
assessReply (a ** request) (Right receipt ** decided) with (sameReceipt request.stored receipt)
  assessReply (a ** request) (Right receipt ** decided) | True =
    map (\outcome => (receipt.score ** outcome)) decided
  assessReply (a ** request) (Right receipt ** _) | False = Left InvalidHistory

public export
assessHandler : Handler AssessC AssessChain
assessHandler = MkHandler assessPrompt assessReply

public export
assessAgent : Agent ExtractionC -> Agent AssessC
assessAgent leaf = compose assessHandler (seqAgent (intakeAgent leaf) (sumAgent stopAgent verdictAgent))

||| A hire of one stored, reviewed application. `assessment` carries the stored
||| decision (reviewer, disposition) so re-making it reproduces what was stored.
public export
record Hiring where
  constructor MkHiring
  assessment : Assessment
  review : Evidence ApplicationReviewed
  hirer : Context
  starter : Starter

||| The reply is the re-derived score and an employee with proof of provenance.
public export
HireKC : Cont
HireKC = MkCont (a : Advert ** Hiring)
  (\(a ** _) => Either DomainError
     (s : Score a ** (e : Employee ** provenanceOf e = (a ** scoredApplication s))))

||| assess ◁ (stop ∨ hire): rebuild the decision, then the spine's hire link.
public export
HireChain : Cont
HireChain = Seq AssessC (Sum StopC HireC)

sameReview : Evidence ApplicationReviewed -> Evidence ApplicationReviewed -> Bool
sameReview x y = x.reference == y.reference && x.revision == y.revision &&
                 x.detail == y.detail && x.context.actor == y.context.actor &&
                 x.context.tick == y.context.tick

afterDecision : (a : Advert) -> Hiring -> Either DomainError (s : Score a ** ReviewOutcome s) ->
                Prompt (Sum StopC HireC)
afterDecision a h (Left err) = Left (Failed err)
afterDecision a h (Right (s ** NotAdvanced _)) = Left (Failed NotShortlisted)
afterDecision a h (Right (s ** Advanced shortlisted)) =
  if sameReview (shortlistEvidence shortlisted) h.review
    then Right (a ** (s ** (shortlisted, h.hirer, h.starter)))
    else Left (Failed InvalidHistory)

||| The stored shortlist is re-made by the recorded reviewer, at the recorded
||| time, against the re-derived score. Only if it reproduces the stored
||| evidence does `Shortlisted s` exist for the hire link to consume.
hirePrompt : Prompt HireKC -> Prompt HireChain
hirePrompt (a ** h) =
  ((a ** { reviewer := h.review.context } h.assessment) ** afterDecision a h)

hireReply : (p : Prompt HireKC) -> Reply HireChain (hirePrompt p) -> Reply HireKC p
hireReply (a ** h) (Left err ** _) = Left err
hireReply (a ** h) (Right (s ** NotAdvanced _) ** _) = Left NotShortlisted
hireReply (a ** h) (Right (s ** Advanced shortlisted) ** hired)
  with (sameReview (shortlistEvidence shortlisted) h.review)
  hireReply (a ** h) (Right (s ** Advanced shortlisted) ** hired) | True =
    map (\employee => (s ** employee)) hired
  hireReply (a ** h) (Right (s ** Advanced shortlisted) ** _) | False = Left InvalidHistory

public export
hireHandler : Handler HireKC HireChain
hireHandler = MkHandler hirePrompt hireReply

public export
hireKernelAgent : Agent ExtractionC -> Agent HireKC
hireKernelAgent leaf = compose hireHandler (seqAgent (assessAgent leaf) (sumAgent stopAgent hireAgent))

||| The whole workflow kernel: exactly one of a requisition transition, an
||| application intake, a review or a hire is asked per process call.
public export
KernelC : Cont
KernelC = Sum TransitionC (Sum IntakeC (Sum AssessC HireKC))

||| The composition root chooses the extraction leaf. Replacing it with a
||| model-backed extractor is a local change: nothing above the leaf moves.
public export
kernelAgent : Agent ExtractionC -> Agent KernelC
kernelAgent leaf =
  sumAgent transitionAgent (sumAgent (intakeAgent leaf) (sumAgent (assessAgent leaf) (hireKernelAgent leaf)))

||| Leaf for the web slice: the API stores the candidate's CV text immutably and
||| addresses it by (locator, version). The leaf answers only for that document.
public export
storedDocument : CVInput -> String -> Agent ExtractionC
storedDocument stored text = answers (\input =>
  if input.locator == stored.locator && input.version == stored.version
    then Right (Extracted text)
    else Left ExtractionFailed)
