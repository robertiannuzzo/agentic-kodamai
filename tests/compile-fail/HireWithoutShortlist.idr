module HireWithoutShortlist
import Recruitment.Core.Hire
%default total

-- Hire one scored application using the shortlist decision made for another.
bad : (a : Advert) -> (chosen, other : Score a) -> Shortlisted other -> Context -> Starter ->
      Either DomainError (e : Employee ** provenanceOf e = (a ** scoredApplication chosen))
bad a chosen other decision c starter = hire a chosen decision c starter
