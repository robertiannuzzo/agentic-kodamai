module ContainerTests

import Recruitment.Example

%default total

public export
Dependent : Cont
Dependent = MkCont Bool (\flag => if flag then Nat else String)

dependentAgent : Agent Dependent
dependentAgent = answers respond
  where
    respond : (flag : Bool) -> if flag then Nat else String
    respond True = 7
    respond False = "seven"

Number : Cont
Number = MkCont Nat (\_ => Nat)

increment : Agent Number
increment = answers S

addTen : Agent Number
addTen = answers (+ 10)

firstHandler : Handler Number Number
firstHandler = MkHandler S (\_, reply => reply + 10)

secondHandler : Handler Number Number
secondHandler = MkHandler (* 2) (\_, reply => reply * 3)

withPlan : (Plan -> Bool) -> Bool
withPlan f = case examplePlan of
  Left _ => False
  Right plan => f plan

finishedTotal : Outcome -> Nat
finishedTotal (Finished _ receipt) = totalScore receipt.score
finishedTotal _ = 0

public export
containerTests : List (String, Bool)
containerTests =
  [ ("extractor is a direct-answer container leaf",
       case run (extractionAgent (mockExtractor [(exampleCV, "typed text")])) exampleCV of
         Right text => text.text == "typed text"
         Left _ => False)
  , ("container reply depends on True prompt", run dependentAgent True == 7)
  , ("container reply depends on False prompt", run dependentAgent False == "seven")
  , ("handler delegation forward amalgamation backward",
       run (compose (compose firstHandler secondHandler) (answers id)) 2 == 28)
  , ("handler left identity", run (compose (identity Number) increment) 9 == run increment 9)
  , ("handler right identity", run (compose increment (identity One)) 9 == run increment 9)
  , ("handler composition associativity",
       run (compose (compose firstHandler secondHandler) increment) 2 ==
       run (compose firstHandler (compose secondHandler increment)) 2)
  , ("sequential second prompt depends on first reply",
       let (first ** second) = run (seqAgent increment addTen) (3 ** (\reply => reply * 2))
       in first == 4 && second == 18)
  , ("sum routes left", run (sumAgent increment dependentAgent) (Left 4) == 5)
  , ("sum routes right with dependent reply", run (sumAgent increment dependentAgent) (Right False) == "seven")
  , ("tensor returns both replies", run (tensorAgent increment addTen) (2, 3) == (3, 13))
  , ("product selects only left reply", run (productAgent (\_, _ => True) increment addTen) (2, 3) == Left 3)
  , ("product selects only right reply", run (productAgent (\_, _ => False) increment addTen) (2, 3) == Right 13)
  , ("five-link container composition completes", withPlan (\plan => finishedTotal (run recruitmentAgent plan) == 46))
  , ("composed reply retains intermediate submission evidence", withPlan (\plan =>
       case execute plan of
         (Right (r ** pending) ** _) => (submissionEvidence pending).reference == r.reference
         _ => False))
  , ("handler summary agrees with full composed execution", withPlan (\plan =>
       finishedTotal (summarize plan (execute plan)) == finishedTotal (run recruitmentAgent plan)))
  , ("container route stops on decline", withPlan (\plan =>
       case run recruitmentAgent ({ decision := Decline "Budget" } plan) of
         Declined _ ev => ev.detail == "Budget"
         _ => False))
  , ("container route stops on hold", withPlan (\plan =>
       case run recruitmentAgent ({ decision := Hold "Revise" } plan) of
         OnHold _ held => (holdEvidence held).detail == "Revise"
         _ => False))
  , ("container route stops on submission error", withPlan (\plan =>
       case run recruitmentAgent ({ reference := 0 } plan) of
         Failed InvalidReference => True
         _ => False))
  , ("container route stops on approval error", withPlan (\plan =>
       case run recruitmentAgent ({ decision := Hold "" } plan) of
         Failed InvalidReason => True
         _ => False))
  , ("container route stops on advert error", withPlan (\plan =>
       case run recruitmentAgent ({ questions := [] } plan) of
         Failed (InvalidSchema _) => True
         _ => False))
  , ("container route stops on application error", withPlan (\plan =>
       case run recruitmentAgent ({ answers := [] } plan) of
         Failed AnswerMismatch => True
         _ => False))
  , ("container route stops on scoring context error", withPlan (\plan =>
       case run recruitmentAgent ({ applicant := MkContext "" 1 } plan) of
         Failed (InvalidField "actor") => True
         _ => False))
  ]
