# Agentic Kodamai recruitment

Agentic Kodamai is a local recruitment system built with Idris 2, TypeScript, React and SQLite. The brief was to build a container-based recruitment system for Kodamai. The design note *Agentic Kodamai: Typed containers applied to Marie-Claude* proposes the first unit of work: the five-link recruitment spine as stage 1, and the hire morphism, with provenance, as stage 2. This repository implements both:

```text
requisition -> approval -> advert -> application -> score     stage 1: the five links
                                                   score -> hire      stage 2: the hire morphism
```

Idris enforces the relationships between stages. An advert requires approval for the exact requisition revision. An application and its score belong to the exact published advert. A hire requires a recorded shortlist decision and creates an employee record linked to the source application.

The browser application supports the complete workflow. It is intended for local evaluation and demonstration. It does not provide production authentication or deployment infrastructure.

## Run the application

There are three steps: install the tools, build the pinned Idris compiler inside the checkout (once; it takes a few minutes), then build and start the application.

### 1. Install the tools

You need Node.js 24 (24.15 or later; CI tests Node 24), Make, a C compiler, Python 3.9 or later, curl, Chez Scheme and GMP. `.nvmrc` pins Node 24, so with [nvm](https://github.com/nvm-sh/nvm) run `nvm install` in the checkout.

On macOS with Homebrew:

```sh
xcode-select --install          # Make, a C compiler and Python 3, if not already installed
brew install chezscheme gmp
nvm install                     # Node.js 24, from .nvmrc
```

On Debian or Ubuntu:

```sh
sudo apt-get install chezscheme libgmp-dev build-essential curl python3
nvm install                     # Node.js 24, from .nvmrc
```

### 2. Build the Idris compiler

The project needs Idris 2 `0.8.0-fd405085b`. `make bootstrap` downloads that exact version, checks its checksum and builds it into `build/toolchain/` inside the checkout; nothing is installed globally. It needs network access, and the checkout path must not contain spaces.

On macOS, where Homebrew names the Chez Scheme binary `chez` and keeps GMP's headers outside the default search path:

```sh
CPATH="$(brew --prefix)/include" LIBRARY_PATH="$(brew --prefix)/lib" SCHEME=chez make bootstrap
```

On Debian or Ubuntu:

```sh
make bootstrap
```

If you already have this exact compiler, skip this step and set `IDRIS2=/absolute/path/to/idris2/bin/idris2` for the commands that follow.

### 3. Build and start the application

```sh
npm install
npm run build
npm start
```

Open <http://127.0.0.1:3001>. The application starts empty; [Use the workflow](#use-the-workflow) walks through it. Any text-based PDF works as a CV, for example [`docs/sample-cv.pdf`](docs/sample-cv.pdf).

Local data is stored in `var/recruitment.sqlite`. The following environment variables override the defaults:

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_PATH` | `var/recruitment.sqlite` | SQLite database path |
| `HOST` | `127.0.0.1` | API bind address |
| `PORT` | `3001` | API port |
| `WEB_ROOT` | `build/web` | Compiled web application path |
| `APPLICATION_RETENTION_DAYS` | `180` | Days before application data is anonymised |

For development with automatic rebuilding, run these commands in separate terminals:

```sh
npm run dev:api
npm run dev:web
```

Vite serves the web application and proxies `/api` to port 3001.

## Use the workflow

The header contains a role switch because authentication is not implemented.

1. As **Requester**, create a requisition and submit it.
2. As **Approver**, approve it, decline it or return it for changes. The requester cannot approve their own submission.
3. As **Recruiter**, publish the approved requisition with screening questions and weighted skills.
4. As **Candidate**, enter an email address, answer the questions, provide experience, upload a PDF CV (for example [`docs/sample-cv.pdf`](docs/sample-cv.pdf)) and optionally enter a cover letter.
5. As **Recruiter**, review the ranked applications, score breakdowns, answers, extracted CV text, original PDFs and cover letters.
6. Shortlist or reject the application. A rejection needs a reason; either can carry a private note.
7. Hire a shortlisted candidate. The system creates a people record linked to the application, score and review evidence.

Candidate emails and the selected role are sent as demo identity headers. They provide interface separation for the local application but do not establish identity. Do not use the system with real candidate data until authentication and deployment controls have been added.

## Implemented behaviour

### Requisitions and approval

- Create, edit and submit requisition drafts.
- Approve, decline or request changes with a required reason.
- Revise and resubmit the same requisition after requested changes.
- Prevent self-review, stale writes and transitions from the wrong stage.
- Preserve an append-only audit history.

### Adverts and applications

- Publish one immutable advert from an approved requisition.
- Freeze its screening questions, expected answers, skills and weights.
- Accept one PDF CV of at most 5 MB and 20 pages.
- Extract at most 50,000 characters of text; scanned PDFs are rejected because OCR is not implemented.
- Accept an optional plain-text cover letter of at most 5,000 characters.
- Store the original PDF privately in SQLite.
- Limit duplicate and excessive application requests.

### Scoring and decisions

- Validate answers and experience against the exact advert schema.
- Compute and retain keyword, experience, screening and completeness components.
- Show scores only to recruiters; candidates receive an acknowledgement.
- Require a human shortlist or rejection decision.
- Rebuild and verify the stored score before recording a decision or hire.
- Never include the cover letter in scoring.

The scoring policy is deterministic and intentionally simple. Keyword points come from case-insensitive substring matches in extracted CV text. Experience points are capped at each skill's target. Screening points come from normalised exact matches. Completeness counts nonblank answers and CV text. Scores assist review and never make hiring decisions.

### Hiring, privacy and retention

- Hire only shortlisted candidates.
- Create immutable people records with provenance to the source application.
- Close the advert when its requisition reaches the approved headcount.
- Let candidates withdraw their own applications.
- Let recruiters erase an application with a reason.
- Anonymise applications automatically after the configured retention period.
- Delete the stored PDF and clear the name, email, extracted CV text, cover letter, answers and review notes during erasure.
- Retain non-identifying score and audit evidence.

SQLite uses `secure_delete` and a rollback journal. Any database written before this behaviour was added is vacuumed once at startup, after migrations, to remove recoverable content from free pages. This does not erase external copies, filesystem snapshots, backups or PDFs already downloaded by a recruiter.

## Architecture

```text
React interface
      |
TypeScript HTTP API ---- PDF text extraction
      |                         |
      |                  untrusted text
      v                         v
SQLite <------------ Idris workflow worker
                         |
        TransitionC + IntakeC + AssessC + HireKC
```

The TypeScript API handles HTTP, identity headers, PDF parsing, resource limits and SQLite transactions. Every protected workflow write is checked by the compiled Idris worker before it is committed.

The worker receives one requisition aggregate and one proposed command through the versioned `recruitment-kernel-v5` protocol. It replays the audit history, verifies the current state and routes the command through:

- `TransitionC` for requisition transitions and publication;
- `IntakeC` for application validation, CV extraction input and scoring;
- `AssessC` for recorded human decisions; and
- `HireKC` for hires with application provenance.

SQLite atomically commits state, audit evidence and idempotent responses. Generation checks reject concurrent stale writes. Database constraints and triggers freeze adverts, scores, documents and people records while allowing the defined erasure operation.

The PDF parser runs in the API process. Size, page and request-rate limits reduce resource use, but there is no parser process isolation or hard timeout.

## Compiler-enforced relationships

The core uses mathematical containers, as in *Containers for Typed Agentic AI*: each prompt determines its permitted reply type, and handlers compose through `Seq`, `Sum`, `Tensor` and `Product`.

Examples of enforced relationships:

- `Approved r` is required to publish an advert for requisition `r`.
- `Application a` retains the exact advert `a` and its question and skill definitions.
- `Score a` retains the application scored against advert `a`.
- A transition reply identifies the targeted requisition and its next generation.
- A hire returns an employee together with equality evidence linking it to the scored application.

[`SwapQuestions.idr`](tests/compile-fail/SwapQuestions.idr) demonstrates the central failure case: an application created for one question set cannot be reused after the advert's questions change, even if the numeric advert identifier is unchanged.

The compiler verifies these relationships inside the typed interfaces. It does not verify that stored facts are truthful, that a user is who they claim to be, that a hiring decision is fair or that an adapter correctly implements its contract. Those remain runtime, identity, policy and persistence responsibilities. See [Architecture](docs/architecture.md#compiler-guarantees-and-their-limits).

## Test and verification commands

```sh
make test       # Idris checks, compiler fixtures, CLI smoke test and API integration tests
make e2e        # production build and Playwright browser tests
make demo       # compile and run the command-line example
make check      # type-check the Idris library
make lint       # repository hygiene checks
```

`make demo` should print reference `1`, advert `1`, keywords `5`, experience `18`, screening `20`, completeness `3`, total **46**, audit evidence naming the advert, application and scoring policy, and a hire whose employee record names advert `1`, application `1`.

The current suites contain:

- 243 Idris runtime checks;
- one compiler-positive fixture;
- 20 compiler-negative fixtures checked for their expected diagnostics;
- 42 HTTP integration tests; and
- eight Playwright browser journeys.

Coverage includes workflow transitions, audit replay, self-review, stale and concurrent writes, idempotency, tenant isolation, frozen adverts, scoring, recorded decisions, hires, migrations, PDF validation and retrieval, keyboard interaction, withdrawal, retention and raw-database erasure checks.

Tests use the compiler from [step 2](#2-build-the-idris-compiler), or the one named by `IDRIS2`. They need no network access, external services or credentials. `make e2e` drives your installed Google Chrome; without Chrome, run `npx playwright install chromium` and then `CI=1 make e2e` to use Playwright's Chromium instead.

GitHub Actions runs the same path from a clean checkout on every push and pull request: it builds the pinned compiler from source on Ubuntu 24.04 with Node 24, then runs `make test`, the production build and the Playwright journeys in Chromium.

## Repository layout

| Location | Contents |
|---|---|
| `src/Recruitment/Container.idr` | Container definitions, handlers, agents and combinators |
| `src/Recruitment/Core/` | Pure domain types, validation, evidence, scoring and hiring |
| `src/Recruitment/Application/` | Composed recruitment spine, use cases and ports |
| `src/Recruitment/Adapters/` | Kernel containers, repositories, extraction leaves and wire codec |
| `src/WorkflowMain.idr` | Compiled workflow worker entry point |
| `apps/api/` | TypeScript HTTP server, SQLite adapter and PDF extraction |
| `apps/web/` | React interface |
| `packages/contracts/` | Shared TypeScript request and response types |
| `tests/` | Idris, browser and compiler fixtures |
| `docs/` | Architecture, slice documentation, testing notes and decisions |

Recommended technical references:

- [Container and recruitment-spine walkthrough](docs/containers.md)
- [Architecture and guarantee boundaries](docs/architecture.md)
- [Verification details](docs/testing.md)
- [PDF CV and cover-letter implementation](docs/slice-4.md)
- [Architecture decision records](docs/adr/)

## Current limitations

- No authentication, password management, sessions or identity provider.
- No production public careers deployment.
- No PostgreSQL or database-enforced row-level tenant isolation.
- No email delivery or transactional outbox.
- No OCR or CV formats other than PDF.
- No isolated PDF worker or parser timeout.
- No automatic backup management or erasure of operator-created copies.
- No automated hiring decision.

The design note's deliverables for stage 1 were a Haskell model of the five links, a LaTeX design-decisions document and one worked demonstration of an attempted violation that does not compile. This repository also implements stage 2, persists both stages and runs the whole workflow in a browser. The refused violation is the one the note names, editing a live advert's questions ([`SwapQuestions.idr`](tests/compile-fail/SwapQuestions.idr)). The decisions are kept as Markdown ADRs in [`docs/adr/`](docs/adr/). [ADR 001](docs/adr/001-idris2.md) records the choice of Idris 2 over Haskell, which the note's Q5 left open: applications are indexed by complete advert values, and hire provenance needs dependent equality.
