# Typed recruitment containers

A standalone Idris 2 implementation of the papers' **mathematical containers**: a type of prompts, a family of replies depending on each prompt, and composable handlers. The worked system is the five-link recruitment spine: requisition → human approval → advert → application → deterministic score.

`Cont`, `Handler`, `Agent`, sequential composition, sum, tensor and product are implemented directly in [the container module](src/Recruitment/Container.idr). [The recruitment spine](src/Recruitment/Application/Spine.idr) composes actual implementations through those operations, with explicit routing for errors, declines and holds. The CLI runs that composition.

The central domain guarantee is `Application advert` and `Score advert`: the index is the **exact immutable advert**, including ordered question contents and skill weights. Keeping an application's type while substituting a different advert fails compilation. Adverts require approval evidence for the exact requisition revision. Published adverts freeze immediately, before any applications.

## Run

Requires Idris **0.8.0-fd405085b**, Chez Scheme, Make, and Python 3.9+. Only Idris's bundled prelude/base libraries are used; Python runs verification, not recruitment logic.

```sh
make test       # hygiene, totality/type check, compiler fixtures, runtime tests, CLI smoke
make demo       # build and execute the composed five-stage example
make check      # type-check the library
```

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

Expected demo: reference `1`, advert `1`, keywords `5`, experience `18`, screening `20`, completeness `3`, total **46**, and audit evidence naming advert, application and scoring policy. The CLI exits after the example; it is not a web service.

## Verified locally

On 2026-09-18: **195 runtime checks pass**, one positive compiler fixture compiles, and **14 invalid fixtures fail with their expected diagnostics**. The composed CLI builds and starts. Logs are regenerated under `build/verification/logs/` by `make test`.

GitHub Actions is configured to bootstrap the same compiler and run `make test` on Linux. That remote run has not happened here; the project-local bootstrap has not been executed end-to-end because the matching compiler was already installed. No Docker tooling is included: “container” here exclusively means the mathematical abstraction from the papers.

## Layout

| Location | Responsibility |
|---|---|
| `src/Recruitment/Container.idr` | Containers, handlers, agents and four combinators |
| `src/Recruitment/Core/` | Pure domain types, evidence, validation, scoring |
| `src/Recruitment/Application/Spine.idr` | Typed interfaces, atomic agents, composed spine, high-level handler |
| `src/Recruitment/Application/` | Stateful use cases, shared scoring, repository/extraction ports |
| `src/Recruitment/Adapters/` | In-memory repositories, mock CV extraction, versioned wire codec |
| `src/Recruitment/Example.idr`, `src/Main.idr` | Composition root and CLI |
| `tests/` | Runtime/invariant checks and compiler-positive/negative fixtures |
| `docs/` | Architecture, source interpretation, verification and ADRs |

Start with [the container walkthrough](docs/containers.md), [the invalid question edit](tests/compile-fail/SwapQuestions.idr), and [the guarantee boundary](docs/architecture.md).

The system has no legacy integration, named framework dependency, paid API, web UI, or automated hiring decision. Durable transactional persistence and validated reconstruction come before a later authenticated HTTP/UI layer. A real extractor can replace the mock through its existing typed port.
