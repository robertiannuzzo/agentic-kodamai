module WrongSkill
import Recruitment.Core.Application
%default total

bad : Experience [MkSkill 1 "idris" 3 5] -> Experience [MkSkill 1 "sql" 3 5]
bad original = original
