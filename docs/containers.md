# Mathematical containers in the recruitment system

## The implemented vocabulary

A container is `MkCont Prompt Reply`, where `Reply : Prompt -> Type`. It specifies which requests may arrive and exactly what response type each request requires. It does not refer to deployment packaging.

A `Handler high low` has two fields:

```idris
delegate : high.Prompt -> low.Prompt
amalgamate : (p : high.Prompt) -> low.Reply (delegate p) -> high.Reply p
```

Control goes down through delegation; replies come back through amalgamation. `compose first second` composes delegation forward and amalgamation backward. `identity` leaves both unchanged.

`One` has one unit prompt and one unit reply. `Agent c = Handler c One` is therefore a direct answerer. `answers` lifts a dependent function into an agent; `run` executes it. The CV extractor is an `Agent ExtractionC`, with replies indexed by the exact versioned CV input.

| Combinator | Prompt | Reply | Interpreter |
|---|---|---|---|
| `Seq c d` | A prompt `p` plus a continuation from its reply to the next prompt | First reply paired dependently with the reply to the prompt it selects | `seqAgent` |
| `Sum c d` | Left or right prompt | That branch's reply type | `sumAgent` |
| `Tensor c d` | Both prompts | Both replies | `tensorAgent` |
| `Product c d` | Both prompts | Either reply | `productAgent` |

Tensor specifies that both results are owed. Its pure interpreter evaluates both; it does not implement a parallel execution scheduler. Product's interpreter receives an explicit selection policy and evaluates the selected branch. Sum routes on the supplied prompt branch. These are distinct operations, matching the papers' four constructions.

## Recruitment composition

The five domain interfaces are `RequisitionC`, `ApprovalC`, `AdvertC`, `ApplicationC`, and `ScoreC`. In particular, an approval reply is `Ruling r` for the requested requisition, an application reply is `Application a` for the requested advert, and a score reply contains `Score a` and mandatory evidence.

```idris
ApplicationTail = Seq ApplicationC (Sum StopC ScoreC)
AdvertTail      = Seq AdvertC      (Sum StopC ApplicationTail)
ApprovalTail    = Seq ApprovalC    (Sum StopC AdvertTail)
Spine           = Seq RequisitionC (Sum StopC ApprovalTail)
```

Each prompt builder supplies a continuation that selects the next request from the preceding response. A granted approval supplies the evidence required by the advert prompt. A declined/held requisition routes to `StopC`, as does a validation failure. A created advert is carried into application construction and then into score construction; the compiler checks the index at both joins.

`spineAgent` interprets this structure with `seqAgent` and `sumAgent`. `recruitmentHandler : Handler RecruitmentC Spine` translates a high-level `Plan` into the composed prompt and summarizes the dependent response into `Outcome`. `recruitmentAgent` is ordinary handler composition with `spineAgent`, not a separately hand-coded five-step interpreter.

`execute plan` returns the full dependent spine response, preserving every intermediate result and its evidence. The summary handler returns the terminal outcome for convenient display. Callers needing the complete audit trace use `execute`; the summary is intentionally lossy. The persistent workflow service separately stores all stage evidence in its case aggregate.

## The live write path

The web application's writes run through containers too. `Adapters.Transition` gives each protected command its own container, with a reply indexed by the requisition it targets and the generation it must reach:

```idris
record Next (ref : Nat) (generation : Nat) where
  row : CaseRecord
  sameCase : row.reference = ref
  advanced : row.generation = generation

ReviewC = MkCont (CaseRecord, Nat, Nat, Context, Decision)
                 (\(_, ref, expected, _, _) => Either DomainError (Next ref (S expected)))

WorkerC = Sum RefuseC (Sum CreateC (Sum UpdateC (Sum SubmitC (Sum ReviewC ResubmitC))))
```

Exactly one command is asked per write, so the worker interface is a sum and `workerAgent` is built with `sumAgent`. `dispatch : Handler TransitionC WorkerC` delegates a `(Maybe CaseRecord, Command)` prompt to its branch (or to `RefuseC` when no aggregate exists, or one exists for a create), and its amalgamation is checked per branch against the high-level reply `Next (target command) (after command)`. `transitionAgent = compose dispatch workerAgent` is what `WorkflowMain` runs for every HTTP mutation. The `Next` evidence is manufactured by a decidable check (`decEq`), which is the design note's Q2 cost made concrete; `WrongAggregate` shows that returning the loaded row unchanged does not compile.

## The kernel and the intake chain

Slice 2 makes the whole Idris executable one container, `KernelC = Sum TransitionC IntakeC`, answered by `kernelAgent leaf = sumAgent transitionAgent (intakeAgent leaf)`. `TransitionC` gains `PublishC` as its sixth branch. `IntakeC`'s reply is `Receipt a` for the advert in the prompt, and it is implemented by a handler into a chain built from the spine's own links:

```idris
IntakeChain = Seq ValidateC (Sum StopC (Seq ExtractionC (Sum StopC ApplicationTail)))
```

`intakeChainAgent` reuses `applicationAgent` and `scoreAgent`, and takes the extraction leaf as a parameter, so the model sits exactly where the papers put it. See [the Slice 2 design](slice-2.md) and ADR 010.

## Hire: the missing morphism

`HireC` is the stage-2 link from the design note, section 4:

```idris
HireC = MkCont (a : Advert ** (Score a, Context, Starter))
  (\(a ** (s, _, _)) => Either DomainError
                          (e : Employee ** provenanceOf e = (a ** scoredApplication s)))
```

The reply owes an employee and a proof of the application it came from. `Employee`'s constructor is private, so `hire` is the only way to produce one. `OnboardingToFollow` shows that the legacy reply (status changes only) is a type error; `WrongProvenance` shows that hiring from one application while claiming another's provenance is too. The CLI demo runs `hireAgent` after the spine and prints the provenance.

## Effects and lifecycle

The `Plan` is a pure demonstration input containing an explicit human decision, validated draft, versioned extracted CV text, schema and application input. It does not invent a hiring decision or invoke a model. The composition root obtains the CV text through the extraction agent before invoking the pure spine.

The mathematical spine shows typed composition in one evaluation. `Workflow` and `Intake` handle the distinct operational concern of actions occurring at separate times with persisted current state and retries. Both paths call the same domain functions; score construction and evidence are shared in `Application.Scoring`. The pure agent can be run repeatedly. Exactly-once persistence belongs to `Repository.commitOnce`, not to container composition.

Tests exercise dependent replies, forward/backward handler composition, identity/associativity examples, sequential continuations, both sum/product branches, tensor's pair, all spine stop paths and the complete successful spine. Additional compiler failures reject a reply for the wrong prompt, an ill-typed sequential continuation, and an amalgamation that owes a different reply type. These tests do not claim a machine-checked proof of every categorical law.
