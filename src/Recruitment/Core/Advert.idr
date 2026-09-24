module Recruitment.Core.Advert

import public Recruitment.Core.Requisition
import Data.Bits
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

-- FNV-1a (64-bit) over Unicode code points. It binds evidence to content so a
-- changed stored schema no longer matches its publication evidence. It is a
-- fingerprint, not a cryptographic signature: authenticity stays external.
fnvPrime : Bits64
fnvPrime = 1099511628211

fnvOffset : Bits64
fnvOffset = 14695981039346656037

fnv : Bits64 -> List Char -> Bits64
fnv hash [] = hash
fnv hash (c :: cs) = fnv ((hash `xor` cast (ord c)) * fnvPrime) cs

hexDigit : Bits64 -> Char
hexDigit d = if d < 10 then chr (ord '0' + cast d) else chr (ord 'a' + cast d - 10)

hex : Nat -> Bits64 -> List Char -> List Char
hex Z _ acc = acc
hex (S k) value acc = hex k (value `div` 16) (hexDigit (value `mod` 16) :: acc)

field : String -> String
field s = show (length (unpack s)) ++ ":" ++ s ++ ","

canonical : List Question -> List Skill -> String
canonical qs ss =
  concatMap (\q => field (show q.questionId) ++ field q.prompt ++ field q.expected) qs ++ "|" ++
  concatMap (\s => field (show s.skillId) ++ field s.keyword ++ field (show s.weight) ++
                   field (show s.targetYears)) ss

||| Content fingerprint of an ordered question and skill schema.
export
schemaFingerprint : List Question -> List Skill -> String
schemaFingerprint qs ss = pack (hex 16 (fnv fnvOffset (unpack (canonical qs ss))) [])

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
               (MkEvidence c r.reference r.revision
                 ("advert:" ++ show ident ++ ";schema:" ++ schemaFingerprint qs ss)))
