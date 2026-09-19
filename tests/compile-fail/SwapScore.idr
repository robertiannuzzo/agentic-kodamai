module SwapScore
import Recruitment.Core.Score
%default total

bad : (r : Req) -> Approved r -> (old : Advert) -> Score old ->
      Either DomainError (edited : Advert ** Score edited)
bad r approval old existing = do
  edited <- publish r approval (MkContext "editor" 20) (advertId old)
              [MkQuestion 1 "Changed question" "no", MkQuestion 2 "Changed too" "yes"]
              (skillsOf old)
  Right (edited ** existing)
