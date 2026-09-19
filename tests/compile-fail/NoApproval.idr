module NoApproval
import Recruitment.Core.Advert
%default total

bad : (r : Req) -> Pending r -> Either DomainError Advert
bad r pending = publish r pending (MkContext "publisher" 1) 1
                  [MkQuestion 1 "Question" "yes"] [MkSkill 1 "idris" 3 5]
