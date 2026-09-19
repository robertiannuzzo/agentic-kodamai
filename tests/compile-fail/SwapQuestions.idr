module SwapQuestions
import Recruitment.Core.Application
%default total

-- Plausible maintenance bug: publish replacement questions under the same ID,
-- then attempt to retain an existing application's answers unchanged.
bad : (r : Req) -> Approved r -> (old : Advert) -> Application old ->
      Either DomainError (edited : Advert ** Application edited)
bad r approval old existing = do
  edited <- publish r approval (MkContext "editor" 20) (advertId old)
              [MkQuestion 1 "A different question" "no", MkQuestion 2 "Another question" "yes"]
              (skillsOf old)
  Right (edited ** existing)
