module Recruitment.Example

import public Recruitment.Application.Intake
import public Recruitment.Application.Spine
import public Recruitment.Adapters.Memory
import public Recruitment.Adapters.MockCV
import public Recruitment.Adapters.Cases

%default total

public export
exampleFields : Fields
exampleFields = MkFields "Software engineer" "Engineering" 1 12000000 "Build recruitment tools"

public export
exampleQuestions : List Question
exampleQuestions = [MkQuestion 1 "Can you work in this time zone?" "yes",
                    MkQuestion 2 "Do you use typed programming?" "yes"]

public export
exampleSkills : List Skill
exampleSkills = [MkSkill 1 "idris" 3 5, MkSkill 2 "sql" 2 3]

public export
exampleCV : CVInput
exampleCV = MkCVInput "mock://candidate-1" "v1"

public export
exampleRaw : RawApplication
exampleRaw = MkRawApplication 1 exampleCV [(1, "yes"), (2, "yes")] [(1, 4), (2, 8)]

export
exampleAdvert : Either DomainError Advert
exampleAdvert = do
  (initial, state) <- start caseRepository (MkContext "requester" 1) exampleFields emptyCases
  (approved, state) <- review caseRepository initial.reference initial.generation
                        (MkContext "approver" 2) Approve state
  (published, _) <- advertise caseRepository approved.reference approved.generation
                     (MkContext "recruiter" 3) exampleQuestions exampleSkills state
  case published.stage of
    Advertising a => Right a
    _ => Left WrongStage

export
exampleRun : Either DomainError (a : Advert ** Receipt a)
exampleRun = do
  advert <- exampleAdvert
  (receipt, _) <- applyAndScore advert memoryRepository
    (mockExtractor [(exampleCV, "Idris and SQL experience")])
    (MkContext "candidate-1" 4) exampleRaw empty
  Right (advert ** receipt)

export
examplePlan : Either DomainError Plan
examplePlan = do
  draft <- newDraft exampleFields
  text <- run (extractionAgent (mockExtractor [(exampleCV, "Idris and SQL experience")])) exampleCV
  Right (MkPlan draft 1 (MkContext "requester" 1) (MkContext "approver" 2) Approve
    (MkContext "recruiter" 3) 1 exampleQuestions exampleSkills (MkContext "candidate-1" 4)
    1 exampleCV text exampleRaw.answers exampleRaw.years)

export
containerExample : Either DomainError Outcome
containerExample = do
  plan <- examplePlan
  Right (run recruitmentAgent plan)
