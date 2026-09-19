module WrongContainerReply
import Recruitment.Container
%default total

Dependent : Cont
Dependent = MkCont Bool (\flag => if flag then Nat else String)

bad : Reply Dependent True
bad = the String "a reply for the wrong prompt"
