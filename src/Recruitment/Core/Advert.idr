module Recruitment.Core.Advert

import public Recruitment.Core.Requisition
import Data.List

%default total

public export
record Question where
  constructor MkQuestion
  questionId : Nat
  prompt : String
  expected : String

public export
record Skill where
  constructor MkSkill
  skillId : Nat
  keyword : String
  weight : Nat
  targetYears : Nat

||| Contains the full ordered question and skill values, not just their lengths.
export
data Advert : Type where
  Published : (r : Req) -> Approved r -> Nat -> List Question -> List Skill ->
              Evidence AdvertCreated -> Advert

export
questionsOf : Advert -> List Question
questionsOf (Published _ _ _ qs _ _) = qs

export
skillsOf : Advert -> List Skill
skillsOf (Published _ _ _ _ ss _) = ss

export
advertId : Advert -> Nat
advertId (Published _ _ ident _ _ _) = ident

export
requisitionOf : Advert -> Req
requisitionOf (Published r _ _ _ _ _) = r

export
advertEvidence : Advert -> Evidence AdvertCreated
advertEvidence (Published _ _ _ _ _ ev) = ev

unique : List Nat -> Bool
unique [] = True
unique (x :: xs) = not (elem x xs) && unique xs

export
publish : (r : Req) -> Approved r -> Context -> Nat -> List Question -> List Skill ->
          Either DomainError Advert
publish r approved c ident qs ss = do
  validContext c
  if ident == 0 then Left InvalidReference
    else if null qs || null ss then Left (InvalidSchema "empty")
    else if not (unique (map questionId qs) && unique (map skillId ss))
      then Left (InvalidSchema "duplicate-id")
    else if not (all (\q => q.questionId > 0 && nonBlank q.prompt && nonBlank q.expected) qs)
      then Left (InvalidSchema "question")
    else if not (all (\s => s.skillId > 0 && nonBlank s.keyword && s.weight > 0 && s.targetYears > 0) ss)
      then Left (InvalidSchema "skill")
    else Right (Published r approved ident qs ss
               (MkEvidence c r.reference r.revision ("advert:" ++ show ident)))
