module WrongRevision
import Recruitment.Core.Advert
%default total

-- Even the same reference cannot use approval for an unrelated revision.
bad : (old, revised : Req) -> Approved old -> Either DomainError Advert
bad old revised approval = publish revised approval (MkContext "publisher" 1) 1
                            [MkQuestion 1 "Question" "yes"] [MkSkill 1 "idris" 3 5]
