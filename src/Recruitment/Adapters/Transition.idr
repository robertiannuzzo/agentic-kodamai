module Recruitment.Adapters.Transition

import public Recruitment.Container
import public Recruitment.Adapters.Cases
import Decidable.Equality

%default total

||| The protected writes the web application may request.
public export
data Command
  = CreateDraft Nat Context Fields
  | UpdateDraft Nat Nat Context Fields
  | SubmitDraft Nat Nat Context
  | Review Nat Nat Context Decision
  | Resubmit Nat Nat Context Fields

||| The requisition a command targets.
public export
target : Command -> Nat
target (CreateDraft ref _ _) = ref
target (UpdateDraft ref _ _ _) = ref
target (SubmitDraft ref _ _) = ref
target (Review ref _ _ _) = ref
target (Resubmit ref _ _ _) = ref

||| The generation the aggregate must reach if the command succeeds.
public export
after : Command -> Nat
after (CreateDraft _ _ _) = 0
after (UpdateDraft _ expected _ _) = S expected
after (SubmitDraft _ expected _) = S expected
after (Review _ expected _ _) = S expected
after (Resubmit _ expected _ _) = S expected

||| The next state of *this* requisition, exactly one generation on. The reply
||| type depends on the prompt, so a handler cannot answer about another case
||| or skip or repeat a generation.
public export
record Next (ref : Nat) (generation : Nat) where
  constructor MkNext
  row : CaseRecord
  sameCase : row.reference = ref
  advanced : row.generation = generation

public export
Answer : Nat -> Nat -> Type
Answer ref generation = Either DomainError (Next ref generation)

||| Manufacture the reply evidence with a decidable check (design note, Q2).
export
next : (ref, generation : Nat) -> CaseRecord -> Answer ref generation
next ref generation row = case decEq row.reference ref of
  No _ => Left InvalidReference
  Yes same => case decEq row.generation generation of
    No _ => Left StaleVersion
    Yes advanced => Right (MkNext row same advanced)

-- One container per command. Each prompt carries the loaded aggregate (where
-- one exists) and each reply is indexed by the target and resulting generation.

public export
CreateC : Cont
CreateC = MkCont (Nat, Context, Fields) (\(ref, _, _) => Answer ref 0)

public export
UpdateC : Cont
UpdateC = MkCont (CaseRecord, Nat, Nat, Context, Fields)
  (\(_, ref, expected, _, _) => Answer ref (S expected))

public export
SubmitC : Cont
SubmitC = MkCont (CaseRecord, Nat, Nat, Context) (\(_, ref, expected, _) => Answer ref (S expected))

public export
ReviewC : Cont
ReviewC = MkCont (CaseRecord, Nat, Nat, Context, Decision)
  (\(_, ref, expected, _, _) => Answer ref (S expected))

public export
ResubmitC : Cont
ResubmitC = MkCont (CaseRecord, Nat, Nat, Context, Fields)
  (\(_, ref, expected, _, _) => Answer ref (S expected))

||| Routing failures (no aggregate, or one where none may exist) answered directly.
public export
RefuseC : Cont
RefuseC = MkCont (Nat, Nat, DomainError) (\(ref, generation, _) => Answer ref generation)

||| The worker's interface: exactly one branch is asked, so it is a sum.
public export
WorkerC : Cont
WorkerC = Sum RefuseC (Sum CreateC (Sum UpdateC (Sum SubmitC (Sum ReviewC ResubmitC))))

||| Load the single-aggregate repository, check the path reference, and run a use case.
existing : {ref : Nat} -> CaseRecord -> (generation : Nat) ->
           (CaseRepository CaseMemory -> CaseMemory -> Either DomainError (CaseRecord, CaseMemory)) ->
           Answer ref generation
existing row generation useCase = do
  if row.reference == ref then Right () else Left NotFound
  state <- transitionCases ref (Just row)
  (updated, _) <- useCase caseRepository state
  next ref generation updated

public export
createAgent : Agent CreateC
createAgent = answers (\(ref, c, f) => do
  state <- transitionCases ref Nothing
  (row, _) <- createDraft caseRepository c f state
  next ref 0 row)

public export
updateAgent : Agent UpdateC
updateAgent = answers (\(row, ref, expected, c, f) =>
  existing row (S expected) (\repo => updateDraft repo ref expected c f))

public export
submitAgent : Agent SubmitC
submitAgent = answers (\(row, ref, expected, c) =>
  existing row (S expected) (\repo => submitDraft repo ref expected c))

public export
reviewAgent : Agent ReviewC
reviewAgent = answers (\(row, ref, expected, c, decision) =>
  existing row (S expected) (\repo => review repo ref expected c decision))

public export
resubmitAgent : Agent ResubmitC
resubmitAgent = answers (\(row, ref, expected, c, f) =>
  existing row (S expected) (\repo => resubmit repo ref expected c f))

public export
refuseAgent : Agent RefuseC
refuseAgent = answers (\(_, _, err) => Left err)

||| The worker agent is assembled by the same combinator that built its interface.
public export
workerAgent : Agent WorkerC
workerAgent = sumAgent refuseAgent (sumAgent createAgent (sumAgent updateAgent
  (sumAgent submitAgent (sumAgent reviewAgent resubmitAgent))))

||| A proposed write: the persisted aggregate (if any) and the command.
public export
Transition : Type
Transition = (Maybe CaseRecord, Command)

||| The high-level interface the TypeScript API calls through the process boundary.
public export
TransitionC : Cont
TransitionC = MkCont Transition (\(_, command) => Answer (target command) (after command))

route : Transition -> Prompt WorkerC
route (Nothing, CreateDraft ref c f) = Right (Left (ref, c, f))
route (Just _, CreateDraft ref _ _) = Left (ref, 0, StaleVersion)
route (Nothing, UpdateDraft ref expected _ _) = Left (ref, S expected, NotFound)
route (Nothing, SubmitDraft ref expected _) = Left (ref, S expected, NotFound)
route (Nothing, Review ref expected _ _) = Left (ref, S expected, NotFound)
route (Nothing, Resubmit ref expected _ _) = Left (ref, S expected, NotFound)
route (Just row, UpdateDraft ref expected c f) = Right (Right (Left (row, ref, expected, c, f)))
route (Just row, SubmitDraft ref expected c) = Right (Right (Right (Left (row, ref, expected, c))))
route (Just row, Review ref expected c d) =
  Right (Right (Right (Right (Left (row, ref, expected, c, d)))))
route (Just row, Resubmit ref expected c f) =
  Right (Right (Right (Right (Right (row, ref, expected, c, f)))))

||| Every branch's reply already is the reply owed, so amalgamation is the identity
||| on each routed case; the type checker confirms that per branch.
answerUp : (t : Transition) -> Reply WorkerC (route t) -> Reply TransitionC t
answerUp (Nothing, CreateDraft _ _ _) reply = reply
answerUp (Just _, CreateDraft _ _ _) reply = reply
answerUp (Nothing, UpdateDraft _ _ _ _) reply = reply
answerUp (Nothing, SubmitDraft _ _ _) reply = reply
answerUp (Nothing, Review _ _ _ _) reply = reply
answerUp (Nothing, Resubmit _ _ _ _) reply = reply
answerUp (Just _, UpdateDraft _ _ _ _) reply = reply
answerUp (Just _, SubmitDraft _ _ _) reply = reply
answerUp (Just _, Review _ _ _ _) reply = reply
answerUp (Just _, Resubmit _ _ _ _) reply = reply

public export
dispatch : Handler TransitionC WorkerC
dispatch = MkHandler route answerUp

||| The agent the workflow executable runs: dispatch composed with the worker.
public export
transitionAgent : Agent TransitionC
transitionAgent = compose dispatch workerAgent
