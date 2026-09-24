module Recruitment.Core.Common

import Data.String

%default total

public export
data DomainError = InvalidField String | InvalidReference | InvalidReason
                 | InvalidSchema String | AnswerMismatch | SkillMismatch
                 | InvalidCV | ExtractionFailed | IdempotencyConflict
                 | PersistenceFailed | InvalidEncoding | NotFound | StaleVersion | WrongStage
                 | SelfReview | InvalidHistory

public export
Show DomainError where
  show (InvalidField f) = "invalid-field:" ++ f
  show InvalidReference = "invalid-reference"
  show InvalidReason = "reason-required"
  show (InvalidSchema s) = "invalid-schema:" ++ s
  show AnswerMismatch = "answers-do-not-match-questions"
  show SkillMismatch = "experience-does-not-match-skills"
  show InvalidCV = "invalid-cv-reference"
  show ExtractionFailed = "cv-extraction-failed"
  show IdempotencyConflict = "idempotency-key-conflict"
  show PersistenceFailed = "persistence-failed"
  show InvalidEncoding = "invalid-encoding"
  show NotFound = "not-found"
  show StaleVersion = "stale-version"
  show WrongStage = "wrong-stage"
  show SelfReview = "self-review-forbidden"
  show InvalidHistory = "invalid-history"

public export
nonBlank : String -> Bool
nonBlank s = trim s /= ""

public export
record Context where
  constructor MkContext
  actor : String
  tick : Nat

public export
validContext : Context -> Either DomainError ()
validContext c = if nonBlank c.actor then Right () else Left (InvalidField "actor")

public export
data Event = DraftCreated | DraftUpdated | Submitted | ApprovedEvent | DeclinedEvent | HeldEvent
           | Revised | AdvertCreated | ApplicationScored | ApplicationReviewed | Hired

public export
Show Event where
  show DraftCreated = "draft-created"
  show DraftUpdated = "draft-updated"
  show Submitted = "submitted"
  show ApprovedEvent = "approved"
  show DeclinedEvent = "declined"
  show HeldEvent = "held"
  show Revised = "revised"
  show AdvertCreated = "advert-created"
  show ApplicationScored = "application-scored"
  show ApplicationReviewed = "application-reviewed"
  show Hired = "hired"

||| The event kind is part of the response type. Actor/time authenticity is external.
public export
record Evidence (event : Event) where
  constructor MkEvidence
  context : Context
  reference : Nat
  revision : Nat
  detail : String
