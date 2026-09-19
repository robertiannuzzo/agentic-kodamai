module BadAmalgamation
import Recruitment.Container
%default total

High : Cont
High = MkCont Nat (\_ => Nat)

Low : Cont
Low = MkCont Nat (\_ => Bool)

bad : Handler High Low
bad = MkHandler id (\_, reply => reply)
