# ADR 001: Idris 2 domain core

Status: accepted.

The important index is an advert value containing actual questions and weights. Prefer direct dependent types over encodings using phantom IDs or list lengths. Use Idris 2 commit `fd405085b3cf37ef7b684ccbb7e791d293ed150b`; enforce that version and pin its source archive checksum. Use Chez code generation and only bundled prelude/base libraries.

This pays an ecosystem/tooling cost now in exchange for expressing and testing the intended invariant directly. Python is limited to verification orchestration. It does not implement domain behavior. Future toolchain updates require rerunning both successful and expected-failure compiler fixtures.

Reference: [Idris module visibility](https://idris2.readthedocs.io/en/latest/tutorial/modules.html) distinguishes exported abstract types from publicly exported constructors; opaque evidence and score constructors rely on that distinction.
