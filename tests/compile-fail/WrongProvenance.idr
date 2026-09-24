module WrongProvenance
import Recruitment.Core.Hire
%default total

-- Hire the candidate from one scored application, but claim another's provenance.
bad : (a : Advert) -> (chosen, other : Score a) -> Context -> Starter ->
      Either DomainError (e : Employee ** provenanceOf e = (a ** scoredApplication chosen))
bad a chosen other c starter = hire a other c starter
