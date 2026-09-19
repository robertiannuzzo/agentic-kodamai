# ADR 006: Project-local pinned toolchain and CI

Status: accepted.

Pin Idris by full commit and verified source archive SHA-256, with no third-party Idris library dependencies. `make bootstrap` downloads and verifies the source, builds with Chez, and installs under `build/toolchain`. It does not modify global tools. Existing installations can be selected via `IDRIS2`.

GitHub Actions uses a pinned checkout action, installs Linux bootstrap prerequisites, builds that compiler and invokes the same `make test` path used locally. Host OS and Chez packages come from the runner's Ubuntu repositories and are not frozen bit-for-bit; only the Idris compiler and its bundled libraries are pinned. A future reproducible environment can tighten this if needed, without changing mathematical-container semantics.

The matching installed compiler was used for local verification. A fresh bootstrap and remote CI have not been run end-to-end. Source archive checksum and upstream build instructions were checked. The upstream bootstrap requires a whitespace-free checkout path; normal project compilation is tested in a path containing spaces.

No Docker or deployment-container tooling is required or included. Here, containers are the mathematical structures from the preparation papers.

Reference: [upstream installation instructions at the pinned compiler commit](https://github.com/idris-lang/Idris2/blob/fd405085b3cf37ef7b684ccbb7e791d293ed150b/INSTALL.md).
