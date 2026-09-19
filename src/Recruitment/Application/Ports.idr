module Recruitment.Application.Ports

import public Recruitment.Core.Score

%default total

public export
record RawApplication where
  constructor MkRawApplication
  identifier : Nat
  cv : CVInput
  answers : List (Nat, String)
  years : List (Nat, Nat)

public export
Eq RawApplication where
  x == y = x.identifier == y.identifier && x.cv.locator == y.cv.locator &&
           x.cv.version == y.cv.version && x.answers == y.answers && x.years == y.years

public export
record Receipt (a : Advert) where
  constructor MkReceipt
  score : Score a
  evidence : Evidence ApplicationScored

||| The extractor cannot return text indexed by a different input reference.
public export
record Extractor where
  constructor MkExtractor
  extract : (input : CVInput) -> Either DomainError (CVText input)

||| Contract: atomically reuse the receipt on equal key/payload, reject conflicts,
||| otherwise evaluate work once and commit receipt + evidence together.
||| The state is scoped to one immutable advert, including its schema and weights.
public export
record Repository (a : Advert) (state : Type) where
  constructor MkRepository
  commitOnce : RawApplication -> (() -> Either DomainError (Receipt a)) -> state ->
               Either DomainError (Receipt a, state)
