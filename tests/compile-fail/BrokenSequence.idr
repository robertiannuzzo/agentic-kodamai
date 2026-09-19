module BrokenSequence
import Recruitment.Container
%default total

Numeric : Cont
Numeric = MkCont Nat (\_ => Nat)

Textual : Cont
Textual = MkCont String (\_ => String)

bad : Prompt (Seq Numeric Textual)
bad = (3 ** (\reply => reply))
