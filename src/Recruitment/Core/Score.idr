module Recruitment.Core.Score

import public Recruitment.Core.Application
import Data.String
import Data.List

%default total

public export
record Breakdown where
  constructor MkBreakdown
  keywords : Nat
  experience : Nat
  screening : Nat
  completeness : Nat

public export
Eq Breakdown where
  x == y = x.keywords == y.keywords && x.experience == y.experience &&
           x.screening == y.screening && x.completeness == y.completeness

public export
Show Breakdown where
  show b = "keywords=" ++ show b.keywords ++ ", experience=" ++ show b.experience ++
           ", screening=" ++ show b.screening ++ ", completeness=" ++ show b.completeness

export
data Score : Advert -> Type where
  Computed : Application a -> Breakdown -> Score a

export
breakdown : Score a -> Breakdown
breakdown (Computed _ b) = b

export
scoredApplication : Score a -> Application a
scoredApplication (Computed app _) = app

export
totalScore : Score a -> Nat
totalScore s = let b = breakdown s in b.keywords + b.experience + b.screening + b.completeness

public export
policyVersion : String
policyVersion = "recruitment-score-v1"

normalise : String -> String
normalise = toLower . trim

screen : Answers qs -> Nat
screen NoAnswers = 0
screen (Answer q answer rest) =
  (if normalise answer == normalise q.expected then 10 else 0) + screen rest

complete : Answers qs -> Nat
complete NoAnswers = 0
complete (Answer _ answer rest) = (if nonBlank answer then 1 else 0) + complete rest

yearsPoints : Experience ss -> Nat
yearsPoints NoExperience = 0
yearsPoints (Years skill years rest) = skill.weight * min years skill.targetYears + yearsPoints rest

keywordPoints : List Skill -> String -> Nat
keywordPoints skills cv = sum (map points skills)
  where
    points : Skill -> Nat
    points s = if isInfixOf (unpack (normalise s.keyword)) (unpack (normalise cv))
                  then s.weight else 0

||| Pure, deterministic policy; use the application boundary for score-once persistence.
export
compute : (a : Advert) -> Application a -> Score a
compute a app = Computed app (MkBreakdown
  (keywordPoints (skillsOf a) (cvTextOf app))
  (yearsPoints (experienceOf app))
  (screen (answersOf app))
  (complete (answersOf app) + if nonBlank (cvTextOf app) then 1 else 0))
