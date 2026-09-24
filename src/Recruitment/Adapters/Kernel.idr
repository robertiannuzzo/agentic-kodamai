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

||| The whole workflow kernel: exactly one of a requisition transition or an
||| application intake is asked per process call, so it is a sum.
public export
KernelC : Cont
KernelC = Sum TransitionC IntakeC

||| The composition root chooses the extraction leaf. Replacing it with a
||| model-backed extractor is a local change: nothing above the leaf moves.
public export
kernelAgent : Agent ExtractionC -> Agent KernelC
kernelAgent leaf = sumAgent transitionAgent (intakeAgent leaf)

||| Leaf for the web slice: the API stores the candidate's CV text immutably and
||| addresses it by (locator, version). The leaf answers only for that document.
public export
storedDocument : CVInput -> String -> Agent ExtractionC
storedDocument stored text = answers (\input =>
  if input.locator == stored.locator && input.version == stored.version
    then Right (Extracted text)
    else Left ExtractionFailed)
