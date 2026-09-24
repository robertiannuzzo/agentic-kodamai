# Agentic Kodamai recruitment

A recruitment system built on the **mathematical containers** of *Containers for Typed Agentic AI*: a type of prompts, a reply type that depends on each prompt, and handlers that compose. It types the design note's five-link spine (requisition → approval → advert → application → score) and adds the stage-2 hire morphism. A web app for requisitions and approvals runs on top of it, and every one of its writes goes through a container.

## Start here: the 60-second version

**A plausible bug that does not compile.** The design note's test is to edit a live advert's questions and show the compiler refusing it. [`SwapQuestions.idr`](tests/compile-fail/SwapQuestions.idr) republishes an advert with new questions under the same ID and tries to keep an existing application:

```idris
edited <- publish r approval ctx (advertId old) [MkQuestion 1 "A different question" "no", ...] (skillsOf old)
Right (edited ** existing)   -- Mismatch between: old and edited.
```

It is one of **17 compile-fail fixtures**, each checked for its expected diagnostic. The others include approval without evidence, a forged score, a handler that returns the wrong reply, and a hire that replies "onboarding to follow" instead of an employee with provenance ([`OnboardingToFollow.idr`](tests/compile-fail/OnboardingToFollow.idr)).

**Containers are the architecture, not just the vocabulary.**

- [`Container.idr`](src/Recruitment/Container.idr) implements `Cont`, `Handler`, `Agent`, `Seq`, `Sum`, `Tensor` and `Product`, as in the Agentic Sage appendix.
- [`Spine.idr`](src/Recruitment/Application/Spine.idr) composes the five links with `Seq` and `Sum` and adds `HireC`, whose reply is `(e : Employee ** provenanceOf e = (a ** scoredApplication s))`.
- [`Transition.idr`](src/Recruitment/Adapters/Transition.idr) is the web app's write path: a `dispatch` handler into a `Sum` of per-command containers. Each reply is `Next ref generation`, the next state of *that* requisition exactly one generation on.

**What the types do and do not guarantee.** An advert cannot exist without approval of the exact requisition revision. Applications and scores are indexed by the exact advert, so they cannot be moved to another advert. A reviewer cannot approve their own submission. Persisted approvals are rebuilt only by replaying a legal audit trail. None of this makes the stored facts true: as section 6 of the design note says, the types guarantee the wiring, not that the components are honest. The [guarantee table](docs/architecture.md#compiler-guarantees-and-their-limits) draws the line precisely.

**Try it:** `make test`, then `npm install && npm run build && npm start` and open `http://127.0.0.1:3001`. Raise a requisition as the requester, then switch to the approver role to review it.

## Implemented product slice

Slice 1 adds a usable requester/approver web workflow around the Idris core:

- create and edit a requisition draft;
- submit it for review;
- approve, decline, or request changes with a required reason;
- revise and resubmit the same requisition;
- work an approver inbox of requisitions awaiting review;
- enforce demo requester/approver permissions, separation of duties (no self-review) and optimistic generations;
- scope requisitions by tenant and requester ownership;
- persist authoritative transactional state and append-only audit history in SQLite;
- deduplicate retried mutations with actor-scoped idempotency keys; and
- migrate existing Slice 1 databases through ordered, recorded schema migrations.

Every protected write sends one aggregate snapshot plus the proposed command to the compiled `recruitment-workflow` executable. Idris replays the aggregate's audit trail to rebuild its evidence, refusing any trail that is not a legal, independently reviewed run. It then routes the command through `transitionAgent` and returns the next state and mandatory evidence. SQLite atomically compares the generation and commits state, new audit facts, and the idempotent response. The process boundary uses a versioned length-prefixed protocol and a private temporary input file, so request capacity is not constrained by operating-system argument limits.

The role switch and tenant header are explicitly demo identity mechanisms, not authentication. SQLite is the local adapter; a hosted multi-user release still needs PostgreSQL, real identity claims, database-enforced tenant isolation, an idempotency-retention policy, and an outbox when external side effects arrive.

## Run

Requires Idris **0.8.0-fd405085b**, Chez Scheme, Make, Python 3.9+, and Node.js 22+. Only Idris's bundled prelude/base libraries are used; Python and Node run verification and application boundaries, not the typed recruitment rules.

```sh
make test       # hygiene, totality/type check, compiler fixtures, runtime tests, CLI smoke, HTTP
make e2e        # production build, then browser journeys in Chrome (Playwright)
make demo       # build and execute the composed five-stage example
make check      # type-check the library
```

Install the web dependencies and run the Slice 1 application:

```sh
npm install
npm run build
npm start
```

Then open `http://127.0.0.1:3001`. Persistent local data is written to `var/recruitment.sqlite`. Set `DATABASE_PATH`, `HOST`, or `PORT` to override those defaults. For separate development processes, run `npm run dev:api` and `npm run dev:web`; Vite proxies `/api` to port 3001.

If `idris2` is managed by a wrapper, select its actual compiler directly:

```sh
IDRIS2=/absolute/path/to/idris2/bin/idris2 make test
```

The compiler version must match `toolchain.env`. On Debian/Ubuntu, install bootstrap prerequisites and build a project-local compiler if needed:

```sh
sudo apt-get install chezscheme libgmp-dev build-essential curl python3
make bootstrap
make test
```

The bootstrap uses the pinned compiler commit and verified archive checksum. Use a checkout path without whitespace for the upstream Make build. Existing compiler installations work with this project in paths containing spaces. `scripts/idris` prefers an explicit `IDRIS2`, then `build/toolchain/bin/idris2`, then `idris2` on `PATH`. Initial bootstrap needs network access; tests and the demo do not need network or credentials.

Expected demo: reference `1`, advert `1`, keywords `5`, experience `18`, screening `20`, completeness `3`, total **46**, audit evidence naming advert, application and scoring policy, and a hire whose employee record names advert `1`, application `1`. The CLI exits after the example; it is not a web service.

## Verified locally

Core verification is **213 runtime checks**, one positive compiler fixture, and **17 invalid fixtures** with their expected diagnostics. The 10-test HTTP integration suite covers the complete rework/approval path, stale writes, Unicode and multiline transport, durable restart, Idris transitions, invalid fields, retry idempotency, cross-process duplicate delivery, tenant/owner isolation, migration from a Slice 1 database, self-review refusal, and refusal of a directly tampered database row. Two Playwright journeys drive the built UI in a real browser, from draft through rework to approval and restart, plus a terminal decline. `make test` runs both suites. Logs are regenerated under `build/verification/logs/`.

GitHub Actions is configured to bootstrap the same compiler and run `make test` on Linux. That remote run has not happened here; the project-local bootstrap has not been executed end-to-end because the matching compiler was already installed. No Docker tooling is included: “container” here exclusively means the mathematical abstraction from the papers.

## Layout

| Location | Responsibility |
|---|---|
| `src/Recruitment/Container.idr` | Containers, handlers, agents and four combinators |
| `src/Recruitment/Core/` | Pure domain types, evidence, replay, validation, scoring, hire |
| `src/Recruitment/Application/Spine.idr` | Typed interfaces, atomic agents, composed spine, high-level handler |
| `src/Recruitment/Application/` | Stateful use cases, shared scoring, repository/extraction ports |
| `src/Recruitment/Adapters/` | In-memory repositories, the container-typed write path, mock CV extraction, versioned wire codec |
| `src/WorkflowMain.idr`, `apps/` | Idris worker executable, TypeScript API with SQLite, React UI |
| `src/Recruitment/Example.idr`, `src/Main.idr` | Composition root and CLI |
| `tests/` | Runtime/invariant checks and compiler-positive/negative fixtures |
| `docs/` | Architecture, source interpretation, verification and ADRs |

Start with [the container walkthrough](docs/containers.md), [the invalid question edit](tests/compile-fail/SwapQuestions.idr), and [the guarantee boundary](docs/architecture.md). The design note asked for a Haskell model with a LaTeX decisions document. [ADR 001](docs/adr/001-idris2.md) records the choice of Idris 2, which the note's Q5 left open: the key index is an advert *value*, not a phantom ID, and the hire morphism's provenance equality needs full dependent types as well. The decisions log is kept as Markdown ADRs in [`docs/adr/`](docs/adr/).

The system has no legacy integration, paid API, real authentication, public candidate portal, persisted people record, or automated hiring decision. A real extractor can replace the mock through its existing typed port. Advert, application, and score screens remain future slices even though their typed core already exists.
