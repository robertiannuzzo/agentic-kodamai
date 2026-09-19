module Recruitment.Application.Intake

import public Recruitment.Application.Scoring

%default total

||| Retries return the original evidence, including original actor and tick.
export
applyAndScore : (a : Advert) -> Repository a state -> Extractor -> Context ->
                RawApplication -> state -> Either DomainError (Receipt a, state)
applyAndScore a repository extractor c raw state = do
  validContext c
  repository.commitOnce raw (\() => do
    -- Validate request structure before invoking the potentially expensive leaf.
    _ <- readAnswers (questionsOf a) raw.answers
    _ <- readExperience (skillsOf a) raw.years
    if raw.identifier == 0 then Left InvalidReference else Right ()
    if nonBlank raw.cv.locator && nonBlank raw.cv.version then Right () else Left InvalidCV
    text <- extractor.extract raw.cv
    app <- receive a raw.identifier raw.cv text raw.answers raw.years
    scoreWithEvidence a c app) state
