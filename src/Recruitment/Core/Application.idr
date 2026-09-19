module Recruitment.Core.Application

import public Recruitment.Core.Advert

%default total

public export
data Answers : List Question -> Type where
  NoAnswers : Answers []
  Answer : (q : Question) -> String -> Answers qs -> Answers (q :: qs)

public export
data Experience : List Skill -> Type where
  NoExperience : Experience []
  Years : (s : Skill) -> Nat -> Experience ss -> Experience (s :: ss)

export
readAnswers : (qs : List Question) -> List (Nat, String) -> Either DomainError (Answers qs)
readAnswers [] [] = Right NoAnswers
readAnswers (q :: qs) ((ident, text) :: rest) =
  if ident == q.questionId then do
    tail <- readAnswers qs rest
    Right (Answer q text tail)
  else Left AnswerMismatch
readAnswers _ _ = Left AnswerMismatch

export
readExperience : (ss : List Skill) -> List (Nat, Nat) -> Either DomainError (Experience ss)
readExperience [] [] = Right NoExperience
readExperience (s :: ss) ((ident, years) :: rest) =
  if ident == s.skillId then do
    tail <- readExperience ss rest
    Right (Years s years tail)
  else Left SkillMismatch
readExperience _ _ = Left SkillMismatch

public export
record CVInput where
  constructor MkCVInput
  locator : String
  version : String

||| Content-addressed or immutable versioned locator; no filesystem/network access here.
public export
record CVText (input : CVInput) where
  constructor Extracted
  text : String

export
data Application : Advert -> Type where
  Received : Nat -> (cv : CVInput) -> CVText cv ->
             Answers (questionsOf a) -> Experience (skillsOf a) -> Application a

export
receive : (a : Advert) -> Nat -> (cv : CVInput) -> CVText cv ->
          List (Nat, String) -> List (Nat, Nat) -> Either DomainError (Application a)
receive a ident cv extracted rawAnswers rawYears = do
  if ident == 0 then Left InvalidReference else Right ()
  if nonBlank cv.locator && nonBlank cv.version then Right () else Left InvalidCV
  answers <- readAnswers (questionsOf a) rawAnswers
  years <- readExperience (skillsOf a) rawYears
  Right (Received ident cv extracted answers years)

export
applicationId : Application a -> Nat
applicationId (Received ident _ _ _ _) = ident

export
answersOf : Application a -> Answers (questionsOf a)
answersOf (Received _ _ _ answers _) = answers

export
experienceOf : Application a -> Experience (skillsOf a)
experienceOf (Received _ _ _ _ years) = years

export
cvTextOf : Application a -> String
cvTextOf (Received _ _ extracted _ _) = extracted.text

export
cvOf : Application a -> CVInput
cvOf (Received _ cv _ _ _) = cv
