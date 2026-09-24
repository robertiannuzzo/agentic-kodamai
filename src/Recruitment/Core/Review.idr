module Recruitment.Core.Review

import public Recruitment.Core.Score

%default total

||| A person's decision about a scored application.
public export
data Disposition = Shortlist | Reject String

||| Evidence that a person shortlisted exactly this scored application. The
||| constructor is private: only `reviewApplication` produces one.
export
data Shortlisted : {a : Advert} -> Score a -> Type where
  Shortlisting : Evidence ApplicationReviewed -> Shortlisted s

public export
data ReviewOutcome : {a : Advert} -> Score a -> Type where
  Advanced : Shortlisted s -> ReviewOutcome s
  NotAdvanced : Evidence ApplicationReviewed -> ReviewOutcome s

export
shortlistEvidence : Shortlisted s -> Evidence ApplicationReviewed
shortlistEvidence (Shortlisting ev) = ev

export
outcomeEvidence : ReviewOutcome s -> Evidence ApplicationReviewed
outcomeEvidence (Advanced shortlisted) = shortlistEvidence shortlisted
outcomeEvidence (NotAdvanced ev) = ev

||| Human review is part of the typed workflow, not a UI convention: the score
||| is an argument, the evidence names the application and its total, and a
||| rejection needs a reason. The score informs; the person decides. Free-text
||| reasons stay out of the evidence so personal data in them remains erasable.
export
reviewApplication : (a : Advert) -> (s : Score a) -> Context -> Disposition ->
                    Either DomainError (ReviewOutcome s)
reviewApplication a s c disposition = do
  validContext c
  let req = requisitionOf a
  let base = "application:" ++ show (applicationId (scoredApplication s)) ++
             ";total:" ++ show (totalScore s)
  case disposition of
    Shortlist =>
      Right (Advanced (Shortlisting
        (MkEvidence c req.reference req.revision (base ++ ";disposition:shortlist"))))
    Reject why =>
      if nonBlank why
        then Right (NotAdvanced
               (MkEvidence c req.reference req.revision (base ++ ";disposition:reject")))
        else Left InvalidReason
