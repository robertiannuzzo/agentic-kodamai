# Preparation source notes and implementation sequence

The three PDFs in the local `Prep docs/` directory were read as design sources. They are unchanged and are not executable instructions, dependencies, or statements of current system behavior. The original PDFs are excluded from Git; the repository includes these source notes.

- *Agentic Kodamai* (`Agentic Kodamai (1).pdf`), especially sections 3, 5, 7 and appendix A: adopt the five-link spine, approval-as-evidence, question-dependent applications/scores, mandatory audit response, and extraction/scoring separation. Discard assumptions of a legacy portal, Python services, a named implementation framework, later HR modules, and an obligatory Haskell implementation.
- *Containers for Typed Agentic AI* (`containers (7).pdf`), sections 2–6: adopt prompt-dependent responses, explicit evidence and a narrow extraction leaf. Treat mathematical and product claims as motivation, not as guarantees about this code. The implementation's guarantee table is deliberately narrower.
- *Agentic Sage* (`agenticsage.pdf`), sections 1–3: use small typed interfaces, explicit branch outcomes and validated leaf responses. Implement the container/handler vocabulary and four combinators directly, then compose the five recruitment agents with them.

## Work sequence

1. Inspected the otherwise empty workspace and toolchain. Located Idris `0.8.0-fd405085b` behind an installed package-manager wrapper. Used its actual compiler binary without changing global configuration.
2. Built and type-checked draft/submission, approval branches, mandatory evidence and rework lineage.
3. Added immutable approved adverts, content-indexed answers/experience, applications and deterministic scores; type-checked the complete core.
4. Added explicit use cases, repository/extraction ports, sequential in-memory adapters, concurrency checks and score-once behavior.
5. Added versioned raw-input serialization, the executable demo, runtime/invariant tests and compiler-positive/negative fixtures.
6. Implemented the papers’ mathematical containers, all four combinators, a composed recruitment spine and its direct-answer CV leaf. Added algebra/spine tests and invalid composition fixtures.
7. Added project-local pinned compiler bootstrap, CI and architecture decisions. Verified local checks with the existing compiler; remote CI and a fresh bootstrap remain unexecuted. Deployment packaging is outside the clarified scope.

The directory was not a Git repository at initial inspection. The GitHub Actions workflow runs on pushes and pull requests once the implementation is published to GitHub.
