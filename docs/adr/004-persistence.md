# ADR 004: Transaction contracts and in-memory adapters first

Status: accepted.

Separate case persistence from advert-scoped receipt persistence. A case transaction stores stage and audit history with an expected generation. The receipt transaction reuses the original result on equal application key/payload, rejects conflicts, or executes and commits new work with required audit evidence.

Provide deterministic sequential immutable-memory implementations and a failing adapter for tests. The port contracts state atomicity, but the type system does not prove a database obeys it or make immutable state linear. The caller must retain returned state.

Only raw application input has a wire codec. Decoding never manufactures approval or score evidence. Durable aggregate storage, checked existential reconstruction, migrations, transaction isolation, crash recovery and multi-process uniqueness are the next persistence increment. Introducing SQL before the core invariants were verified would obscure that boundary.
