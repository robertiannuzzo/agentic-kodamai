module OnboardingToFollow
import Recruitment.Core.Hire
%default total

-- The legacy hire handler's reply: status changes, then "onboarding to follow".
data Status = RequisitionFulfilled

bad : (a : Advert) -> (s : Score a) ->
      Either DomainError (e : Employee ** provenanceOf e = (a ** scoredApplication s))
bad a s = Right RequisitionFulfilled
