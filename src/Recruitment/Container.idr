module Recruitment.Container

%default total

||| A container in the papers' sense: prompts and prompt-dependent replies.
public export
record Cont where
  constructor MkCont
  Prompt : Type
  Reply : Prompt -> Type

public export
record Handler (high : Cont) (low : Cont) where
  constructor MkHandler
  delegate : high.Prompt -> low.Prompt
  amalgamate : (p : high.Prompt) -> low.Reply (delegate p) -> high.Reply p

public export
identity : (c : Cont) -> Handler c c
identity c = MkHandler id (\_, reply => reply)

public export
compose : {a, b, c : Cont} -> Handler a b -> Handler b c -> Handler a c
compose first second = MkHandler
  (\p => second.delegate (first.delegate p))
  (\p, reply => first.amalgamate p (second.amalgamate (first.delegate p) reply))

public export
One : Cont
One = MkCont () (\_ => ())

public export
Agent : Cont -> Type
Agent c = Handler c One

public export
answers : {c : Cont} -> ((p : c.Prompt) -> c.Reply p) -> Agent c
answers answer = MkHandler (\_ => ()) (\p, _ => answer p)

public export
run : {c : Cont} -> Agent c -> (p : c.Prompt) -> c.Reply p
run agent p = agent.amalgamate p ()

public export
Seq : Cont -> Cont -> Cont
Seq c d = MkCont (p : c.Prompt ** (c.Reply p -> d.Prompt))
  (\(p ** next) => (reply : c.Reply p ** d.Reply (next reply)))

public export
sumReply : (c, d : Cont) -> Either c.Prompt d.Prompt -> Type
sumReply c d (Left p) = c.Reply p
sumReply c d (Right p) = d.Reply p

public export
Sum : Cont -> Cont -> Cont
Sum c d = MkCont (Either c.Prompt d.Prompt) (sumReply c d)

||| Both prompts; both replies. This specifies independence, not a scheduler.
public export
Tensor : Cont -> Cont -> Cont
Tensor c d = MkCont (c.Prompt, d.Prompt) (\(p, q) => (c.Reply p, d.Reply q))

||| Both prompts offered; one reply. Distinct from Tensor.
public export
Product : Cont -> Cont -> Cont
Product c d = MkCont (c.Prompt, d.Prompt) (\(p, q) => Either (c.Reply p) (d.Reply q))

public export
seqAgent : {c, d : Cont} -> Agent c -> Agent d -> Agent (Seq c d)
seqAgent first second = answers (\(p ** next) =>
  let reply = run first p in (reply ** run second (next reply)))

public export
sumAgent : {c, d : Cont} -> Agent c -> Agent d -> Agent (Sum c d)
sumAgent first second = answers choose
  where
    choose : (p : Either c.Prompt d.Prompt) -> sumReply c d p
    choose (Left p) = run first p
    choose (Right p) = run second p

public export
tensorAgent : {c, d : Cont} -> Agent c -> Agent d -> Agent (Tensor c d)
tensorAgent first second = answers (\(p, q) => (run first p, run second q))

||| The policy chooses a branch from both offered prompts; only it is evaluated.
public export
productAgent : {c, d : Cont} -> (c.Prompt -> d.Prompt -> Bool) ->
               Agent c -> Agent d -> Agent (Product c d)
productAgent chooseLeft first second = answers (\(p, q) =>
  if chooseLeft p q then Left (run first p) else Right (run second q))
