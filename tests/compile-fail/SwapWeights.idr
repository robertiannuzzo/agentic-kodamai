module SwapWeights
import Recruitment.Core.Score
%default total

bad : (r : Req) -> Approved r -> (old : Advert) -> Score old ->
      Either DomainError (edited : Advert ** Score edited)
bad r approval old existing = do
  edited <- publish r approval (MkContext "editor" 20) (advertId old)
              (questionsOf old) [MkSkill 1 "idris" 99 5, MkSkill 2 "sql" 2 3]
  Right (edited ** existing)
