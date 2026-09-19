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

## Effects and lifecycle

The `Plan` is a pure demonstration input containing an explicit human decision, validated draft, versioned extracted CV text, schema and application input. It does not invent a hiring decision or invoke a model. The composition root obtains the CV text through the extraction agent before invoking the pure spine.

The mathematical spine shows typed composition in one evaluation. `Workflow` and `Intake` handle the distinct operational concern of actions occurring at separate times with persisted current state and retries. Both paths call the same domain functions; score construction and evidence are shared in `Application.Scoring`. The pure agent can be run repeatedly. Exactly-once persistence belongs to `Repository.commitOnce`, not to container composition.

Tests exercise dependent replies, forward/backward handler composition, identity/associativity examples, sequential continuations, both sum/product branches, tensor's pair, all spine stop paths and the complete successful spine. Additional compiler failures reject a reply for the wrong prompt, an ill-typed sequential continuation, and an amalgamation that owes a different reply type. These tests do not claim a machine-checked proof of every categorical law.
