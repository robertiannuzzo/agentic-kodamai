module Recruitment.Application.Spine

import public Recruitment.Container
import public Recruitment.Application.Scoring
import public Recruitment.Core.Hire

%default total

public export
ExtractionC : Cont
ExtractionC = MkCont CVInput (\input => Either DomainError (CVText input))

public export
extractionAgent : Extractor -> Agent ExtractionC
extractionAgent extractor = answers extractor.extract

public export
record Plan where
  constructor MkPlan
  draft : Draft
  reference : Nat
  requester : Context
  reviewer : Context
  decision : Decision
  publisher : Context
  advertIdentifier : Nat
  questions : List Question
  skills : List Skill
  applicant : Context
  applicationIdentifier : Nat
  cv : CVInput
  extracted : CVText cv
  answers : List (Nat, String)
  years : List (Nat, Nat)

public export
RequisitionC : Cont
RequisitionC = MkCont (Context, Nat, Draft) (\_ => Either DomainError (r : Req ** Pending r))

public export
ApprovalC : Cont
ApprovalC = MkCont (r : Req ** (Pending r, Context, Decision))
  (\(r ** _) => Either DomainError (Ruling r))

public export
AdvertC : Cont
AdvertC = MkCont (r : Req ** (Approved r, Context, Nat, List Question, List Skill))
  (\_ => Either DomainError Advert)

public export
record ApplicationPrompt where
  constructor MkApplicationPrompt
  advert : Advert
  identifier : Nat
  cv : CVInput
  extracted : CVText cv
  answers : List (Nat, String)
  years : List (Nat, Nat)

public export
ApplicationC : Cont
ApplicationC = MkCont ApplicationPrompt (\p => Either DomainError (Application p.advert))

public export
ScoreC : Cont
ScoreC = MkCont (a : Advert ** (Application a, Context))
  (\(a ** _) => Either DomainError (Receipt a))

public export
requisitionAgent : Agent RequisitionC
requisitionAgent = answers (\(c, ref, draft) => submit c ref draft)

public export
approvalAgent : Agent ApprovalC
approvalAgent = answers (\(r ** (pending, c, choice)) => decide r pending c choice)

public export
advertAgent : Agent AdvertC
advertAgent = answers (\(r ** (approval, c, ident, qs, ss)) => publish r approval c ident qs ss)

public export
applicationAgent : Agent ApplicationC
applicationAgent = answers (\p => receive p.advert p.identifier p.cv p.extracted p.answers p.years)

public export
scoreAgent : Agent ScoreC
scoreAgent = answers (\(a ** (app, c)) => scoreWithEvidence a c app)

public export
data Outcome : Type where
  Failed : DomainError -> Outcome
  Declined : (r : Req) -> Evidence DeclinedEvent -> Outcome
  OnHold : (r : Req) -> Held r -> Outcome
  Finished : (a : Advert) -> Receipt a -> Outcome

public export
StopC : Cont
StopC = MkCont Outcome (\_ => Outcome)

public export
stopAgent : Agent StopC
stopAgent = answers id

public export
ApplicationTail : Cont
ApplicationTail = Seq ApplicationC (Sum StopC ScoreC)

public export
AdvertTail : Cont
AdvertTail = Seq AdvertC (Sum StopC ApplicationTail)

public export
ApprovalTail : Cont
ApprovalTail = Seq ApprovalC (Sum StopC AdvertTail)

||| Five links combined by sequential composition, with explicit stop routing.
public export
Spine : Cont
Spine = Seq RequisitionC (Sum StopC ApprovalTail)

public export
applicationPrompt : Plan -> (a : Advert) -> Prompt ApplicationTail
applicationPrompt plan a =
  (MkApplicationPrompt a plan.applicationIdentifier plan.cv plan.extracted plan.answers plan.years **
    \result => case result of
      Left err => Left (Failed err)
      Right app => Right (a ** (app, plan.applicant)))

public export
advertPrompt : Plan -> (r : Req) -> Approved r -> Prompt AdvertTail
advertPrompt plan r approval =
  ((r ** (approval, plan.publisher, plan.advertIdentifier, plan.questions, plan.skills)) **
    \result => case result of
      Left err => Left (Failed err)
      Right a => Right (applicationPrompt plan a))

public export
approvalPrompt : Plan -> (r : Req) -> Pending r -> Prompt ApprovalTail
approvalPrompt plan r pending =
  ((r ** (pending, plan.reviewer, plan.decision)) **
    \result => case result of
      Left err => Left (Failed err)
      Right (Granted approval) => Right (advertPrompt plan r approval)
      Right (Denied evidence) => Left (Declined r evidence)
      Right (Deferred held) => Left (OnHold r held))

public export
spinePrompt : Plan -> Prompt Spine
spinePrompt plan = ((plan.requester, plan.reference, plan.draft) **
  \result => case result of
    Left err => Left (Failed err)
    Right (r ** pending) => Right (approvalPrompt plan r pending))

public export
spineAgent : Agent Spine
spineAgent = seqAgent requisitionAgent
  (sumAgent stopAgent (seqAgent approvalAgent
    (sumAgent stopAgent (seqAgent advertAgent
      (sumAgent stopAgent (seqAgent applicationAgent (sumAgent stopAgent scoreAgent)))))))

||| The dependent reply retains every intermediate response, including evidence.
export
execute : (plan : Plan) -> Reply Spine (spinePrompt plan)
execute plan = run spineAgent (spinePrompt plan)

finishApplication : (plan : Plan) -> (a : Advert) ->
                    Reply ApplicationTail (applicationPrompt plan a) -> Outcome
finishApplication plan a (Left _ ** stopped) = stopped
finishApplication plan a (Right _ ** Left err) = Failed err
finishApplication plan a (Right _ ** Right receipt) = Finished a receipt

finishAdvert : (plan : Plan) -> (r : Req) -> (approval : Approved r) ->
               Reply AdvertTail (advertPrompt plan r approval) -> Outcome
finishAdvert plan r approval (Left _ ** stopped) = stopped
finishAdvert plan r approval (Right a ** tail) = finishApplication plan a tail

finishApproval : (plan : Plan) -> (r : Req) -> (pending : Pending r) ->
                 Reply ApprovalTail (approvalPrompt plan r pending) -> Outcome
finishApproval plan r pending (Left _ ** stopped) = stopped
finishApproval plan r pending (Right (Granted approval) ** tail) = finishAdvert plan r approval tail
finishApproval plan r pending (Right (Denied _) ** stopped) = stopped
finishApproval plan r pending (Right (Deferred _) ** stopped) = stopped

public export
summarize : (plan : Plan) -> Reply Spine (spinePrompt plan) -> Outcome
summarize plan (Left _ ** stopped) = stopped
summarize plan (Right (r ** pending) ** tail) = finishApproval plan r pending tail

public export
RecruitmentC : Cont
RecruitmentC = MkCont Plan (\_ => Outcome)

||| A high-level request delegates to the composed spine; its reply travels back.
public export
recruitmentHandler : Handler RecruitmentC Spine
recruitmentHandler = MkHandler spinePrompt summarize

public export
recruitmentAgent : Agent RecruitmentC
recruitmentAgent = compose recruitmentHandler spineAgent

||| Stage 2's link: hire consumes a score and must return the employee together
||| with proof of the application it came from.
public export
HireC : Cont
HireC = MkCont (a : Advert ** (Score a, Context, Starter))
  (\(a ** (s, _, _)) => Either DomainError (e : Employee ** provenanceOf e = (a ** scoredApplication s)))

public export
hireAgent : Agent HireC
hireAgent = answers (\(a ** (s, c, starter)) => hire a s c starter)
